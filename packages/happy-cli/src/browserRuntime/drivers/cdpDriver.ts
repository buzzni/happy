/**
 * Explicit-target CDP driver (BrowserDriver port) over one raw browser-level
 * WebSocket with flattened sessions.
 *
 * Invariants:
 * - Only tabs this driver created are addressable (TabId → targetId registry).
 *   There is no "active tab" and no fallback of any kind.
 * - Every frame is reached through its own session: the tab's page session for
 *   the main frame and same-process frames, a child session per out-of-process
 *   iframe (Target.setAutoAttach, flatten, recursive).
 * - Page scripts run only in the driver's isolated world.
 * - Refs are bound to {frame, frame stamp, loaderId, backendNodeId, snapshot}.
 *   Anything that no longer matches is STALE_REF; there is no re-matching by
 *   position or label.
 * - Frames whose origin is not allowed contribute no text, refs or pixels.
 */
import { randomBytes } from 'node:crypto'
import {
    BrowserRuntimeError,
    type BrowserDriver,
    type BrowserInstanceId,
    type DriverOptions,
    type DriverTabHandle,
    type ElementRef,
    type Observation,
    type ObservedElement,
    type ObservedFrame,
    type ScreenshotResult,
    type SnapshotId,
    type TabId,
    type WaitPredicate,
} from '../contracts'
import { CdpConnection, CdpProtocolError, connectionClosedError } from './cdpConnection'
import { CHECK_ELEMENT, COLLECT_FRAME, FRAME_HAS_TEXT, HIT_TEST, SELECT_CONTENT, type CollectedFrame, type ElementState } from './pageScripts'

export interface CdpDriverOptions {
    /** Browser-level endpoint from `/json/version` (webSocketDebuggerUrl). */
    browserWsUrl: string
    /** Read from the trusted browser start path; never derived from CDP. */
    browserInstanceIdProvider: () => Promise<BrowserInstanceId>
    /** Test seams. Not for production wiring. */
    testHooks?: {
        afterCapture?: (tabId: TabId) => Promise<void>
    }
}

export interface PopupReport {
    openerTabId: TabId
    targetId: string
    origin: string
    closed: boolean
}

const ISOLATED_WORLD = '__abp_driver__'
const DEFAULT_MAX_ELEMENTS = 200
const DEFAULT_MAX_TEXT_CHARS = 4_000
const WAIT_POLL_MS = 100
const MAX_POPUP_REPORTS = 100
const MAX_CLOSED_TABS = 1_000
const CLOSE_CONFIRM_MS = 2_000

interface RefBinding {
    frameId: string
    sessionId: string
    stamp: number
    loaderId: string
    backendNodeId: number
}

interface TabState {
    tabId: TabId
    targetId: string
    sessionId: string
    /** page session + every attached OOPIF session */
    sessions: Set<string>
    allowedOrigins: string[]
    /** bumps on any frame navigation / attach / detach / child session change */
    generation: number
    /** frameId → generation value of the last event that touched it */
    stamps: Map<string, number>
    frameKeys: Map<string, string>
    nextFrameKey: number
    mainUrl: string
    snapshot?: { snapshotId: SnapshotId; refs: Map<string, RefBinding> }
    worlds: Map<string, { stamp: number; contextId: number }>
    pendingSetups: Set<Promise<unknown>>
    goneListeners: Set<() => void>
}

interface SessionInfo {
    tab: TabState
    targetId: string
    isMain: boolean
}

interface LiveFrame {
    frameId: string
    loaderId: string
    url: string
    origin: string
    sessionId: string
    outOfProcess: boolean
}

class OpContext {
    dispatched = false
    aborted = false

    /** Call immediately before sending anything with a page-visible effect. */
    markDispatch(): void {
        if (this.aborted) throw new BrowserRuntimeError('OUTCOME_UNKNOWN', 'operation aborted before dispatch', false, false)
        this.dispatched = true
    }
}

function staleRef(why: string): BrowserRuntimeError {
    return new BrowserRuntimeError('STALE_REF', `stale ref: ${why}; observe again`, false, false)
}

function originDenied(why: string, retryable = false, mayHaveSideEffects = false): BrowserRuntimeError {
    return new BrowserRuntimeError('ORIGIN_DENIED', why, retryable, mayHaveSideEffects)
}

function targetGone(): BrowserRuntimeError {
    return new BrowserRuntimeError('TARGET_GONE', 'tab is not owned by this driver or no longer exists', false, false)
}

export function originOf(url: string): string {
    try {
        const origin = new URL(url).origin
        return origin === 'null' ? '' : origin
    } catch {
        return ''
    }
}

function frameOrigin(frame: { url: string; securityOrigin?: string }): string {
    const security = frame.securityOrigin
    if (security && security !== 'null' && security !== '://' && /^[a-z][a-z0-9+.-]*:\/\/./i.test(security)) return security
    return originOf(frame.url)
}

function newId(prefix: string): string {
    return `${prefix}-${randomBytes(9).toString('base64url')}`
}

export class CdpDriver implements BrowserDriver {
    private conn?: CdpConnection
    private instanceId?: BrowserInstanceId
    private browserWsUrl: string
    private readonly tabs = new Map<TabId, TabState>()
    private readonly tabsByTarget = new Map<string, TabState>()
    private readonly sessions = new Map<string, SessionInfo>()
    private readonly closedTabs = new Set<TabId>()
    private readonly popups = new Map<string, PopupReport>()
    private readonly disconnectListeners = new Set<() => void>()

    constructor(private readonly options: CdpDriverOptions) {
        this.browserWsUrl = options.browserWsUrl
    }

    // -----------------------------------------------------------------------
    // Connection lifecycle
    // -----------------------------------------------------------------------

    async connect(): Promise<BrowserInstanceId> {
        const conn = await CdpConnection.connect(this.browserWsUrl)
        this.conn = conn
        this.wire(conn)
        conn.onClose(() => {
            if (this.conn !== conn) return
            this.dropAllTabs()
            this.instanceId = undefined
            for (const listener of [...this.disconnectListeners]) listener()
        })
        await conn.send('Target.setDiscoverTargets', { discover: true })
        this.instanceId = await this.options.browserInstanceIdProvider()
        return this.instanceId
    }

    /**
     * Explicit reconnect. Old tabs/refs are NOT re-adopted; the caller decides
     * from the returned instance id whether this is the same browser.
     */
    async reconnect(browserWsUrl?: string): Promise<BrowserInstanceId> {
        if (browserWsUrl) this.browserWsUrl = browserWsUrl
        const old = this.conn
        this.conn = undefined
        this.dropAllTabs()
        old?.close()
        this.instanceId = undefined
        return this.connect()
    }

    /** Called once per lost browser connection (not for an explicit close/reconnect). */
    onDisconnect(listener: () => void): () => void {
        this.disconnectListeners.add(listener)
        return () => this.disconnectListeners.delete(listener)
    }

    isConnected(): boolean {
        return this.conn !== undefined && this.instanceId !== undefined
    }

    browserInstanceId(): BrowserInstanceId {
        if (!this.instanceId) throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'driver is not connected', true, false)
        return this.instanceId
    }

    async close(): Promise<void> {
        const conn = this.conn
        this.conn = undefined
        this.dropAllTabs()
        conn?.close()
    }

    hasTab(tabId: TabId): boolean {
        return !!this.conn && !this.conn.closed && this.tabs.has(tabId)
    }

    /** For leak checks (A12): owned tabs and attached sessions. */
    debugCounts(): { tabs: number; sessions: number } {
        return { tabs: this.tabs.size, sessions: this.sessions.size }
    }

    /** Pages opened by owned tabs. They are never adopted as owned tabs. */
    popupReports(): PopupReport[] {
        return [...this.popups.values()].map((report) => ({ ...report }))
    }

    // -----------------------------------------------------------------------
    // Tabs and navigation
    // -----------------------------------------------------------------------

    openTab(url: string, allowedOrigins: string[], opts: DriverOptions): Promise<DriverTabHandle> {
        return this.run(opts, async (op, conn) => {
            if (!allowedOrigins.includes(originOf(url))) throw originDenied('requested origin is not allowed')
            op.markDispatch()
            const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank', background: true, newWindow: false })
            let tab: TabState | undefined
            try {
                const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true })
                tab = this.registerTab(targetId, sessionId, allowedOrigins)
                await this.setupSession(conn, sessionId, true)
                await this.navigateInternal(conn, tab, url, allowedOrigins, op)
                return { tabId: tab.tabId, targetId }
            } catch (error) {
                await this.discardTarget(conn, targetId, tab)
                throw error
            }
        })
    }

    /** Closes a target we created but will not hand out, and waits for it to be gone. */
    private async discardTarget(conn: CdpConnection, targetId: string, tab: TabState | undefined): Promise<void> {
        const gone = tab
            ? new Promise<void>((resolve) => {
                tab.goneListeners.add(resolve)
                setTimeout(resolve, CLOSE_CONFIRM_MS)
            })
            : Promise.resolve()
        await conn.send('Target.closeTarget', { targetId }).catch(() => undefined)
        await gone
        if (tab) {
            this.closedTabs.delete(tab.tabId)
            this.forgetTab(tab)
        }
    }

    navigate(tabId: TabId, url: string, allowedOrigins: string[], opts: DriverOptions): Promise<{ url: string; documentGeneration: number }> {
        return this.run(opts, async (op, conn) => {
            const tab = this.requireTab(tabId)
            return this.navigateInternal(conn, tab, url, allowedOrigins, op)
        })
    }

    async currentOrigin(tabId: TabId): Promise<string> {
        const conn = this.requireConn()
        const tab = this.requireTab(tabId)
        const { frameTree } = await conn.send('Page.getFrameTree', {}, tab.sessionId).catch((error) => { throw this.mapError(error, false) })
        return frameOrigin(frameTree.frame)
    }

    closeTab(tabId: TabId, opts: DriverOptions): Promise<{ closed: boolean; beforeUnloadBlocked?: boolean }> {
        if (!this.tabs.has(tabId) && this.closedTabs.has(tabId)) return Promise.resolve({ closed: true })
        return this.run(opts, (op, conn) => {
            const tab = this.requireTab(tabId)
            return new Promise<{ closed: boolean; beforeUnloadBlocked?: boolean }>((resolve, reject) => {
                const offDialog = conn.on('Page.javascriptDialogOpening', (params, sessionId) => {
                    if (sessionId !== tab.sessionId || params.type !== 'beforeunload') return
                    cleanup()
                    // Never accept on the user's behalf: dismiss = stay on page.
                    conn.send('Page.handleJavaScriptDialog', { accept: false }, tab.sessionId)
                        .catch(() => undefined)
                        .then(() => resolve({ closed: false, beforeUnloadBlocked: true }))
                })
                const onGone = () => {
                    cleanup()
                    resolve({ closed: true })
                }
                const cleanup = () => {
                    offDialog()
                    tab.goneListeners.delete(onGone)
                }
                tab.goneListeners.add(onGone)
                op.markDispatch()
                conn.send('Page.close', {}, tab.sessionId).catch((error) => {
                    cleanup()
                    reject(error)
                })
            })
        }, true)
    }

    // -----------------------------------------------------------------------
    // Observe
    // -----------------------------------------------------------------------

    observe(
        tabId: TabId,
        allowedOrigins: string[],
        opts: DriverOptions & { maxElements?: number; maxTextChars?: number; scopeRef?: ElementRef },
    ): Promise<Observation> {
        return this.run(opts, async (_op, conn) => {
            const tab = this.requireTab(tabId)
            tab.allowedOrigins = allowedOrigins
            let scope: { binding: RefBinding; objectId: string } | undefined
            if (opts.scopeRef) {
                if (!tab.snapshot) throw staleRef('no snapshot for scopeRef')
                const resolved = await this.resolveRef(conn, tab, opts.scopeRef, tab.snapshot.snapshotId)
                scope = { binding: resolved.binding, objectId: resolved.objectId }
            }
            const documentGeneration = tab.generation
            const frames = await this.collectFrames(conn, tab)
            const main = frames[0]
            if (!main || !allowedOrigins.includes(main.origin)) throw originDenied('top-level origin is not allowed')

            let remainingElements = opts.maxElements ?? DEFAULT_MAX_ELEMENTS
            let remainingText = opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS
            let truncated = false
            let counter = 0
            const snapshotId = newId('snap') as SnapshotId
            const refs = new Map<string, RefBinding>()
            const elements: ObservedElement[] = []
            const observedFrames: ObservedFrame[] = []
            const texts: string[] = []
            let title = ''

            for (const frame of frames) {
                const frameKey = this.frameKey(tab, frame.frameId)
                const allowed = !!frame.origin && allowedOrigins.includes(frame.origin)
                const observed: ObservedFrame = { frameKey, origin: frame.origin, allowed, outOfProcess: frame.outOfProcess }
                observedFrames.push(observed)
                if (!allowed) continue
                if (scope && frame.frameId !== scope.binding.frameId) continue
                const stamp = this.stampOf(tab, frame.frameId)
                let collected: { meta: CollectedFrame; backendNodeIds: number[] }
                try {
                    collected = await this.collectInFrame(conn, tab, frame, stamp, {
                        maxElements: Math.max(0, remainingElements),
                        maxTextChars: Math.max(0, remainingText),
                    }, scope && scope.binding.frameId === frame.frameId ? scope.binding : undefined)
                } catch (error) {
                    if (error instanceof BrowserRuntimeError && error.code === 'STALE_REF') throw error
                    // Frame went away mid-snapshot: report it without content.
                    truncated = true
                    continue
                }
                const { meta, backendNodeIds } = collected
                if (frame === main) title = meta.title
                truncated ||= meta.truncated
                remainingElements -= meta.elements.length
                remainingText -= meta.text.length
                observed.text = meta.text
                if (meta.text) texts.push(meta.text)
                meta.elements.forEach((element, index) => {
                    counter += 1
                    const ref = frame === main ? `@e${counter}` : `@${frameKey}:e${counter}`
                    refs.set(ref, {
                        frameId: frame.frameId,
                        sessionId: frame.sessionId,
                        stamp,
                        loaderId: frame.loaderId,
                        backendNodeId: backendNodeIds[index],
                    })
                    const observedElement: ObservedElement = {
                        ref: ref as ElementRef,
                        role: element.role,
                        name: element.name,
                        visible: element.visible,
                        frameOrigin: frame.origin,
                    }
                    if (element.value !== undefined) observedElement.value = element.value
                    if (element.disabled) observedElement.disabled = true
                    elements.push(observedElement)
                })
            }
            tab.snapshot = { snapshotId, refs }
            return {
                snapshotId,
                tabId,
                url: main.url,
                title,
                documentGeneration,
                elements,
                frames: observedFrames,
                truncated,
                text: texts.join('\n\n'),
            }
        })
    }

    // -----------------------------------------------------------------------
    // Screenshot
    // -----------------------------------------------------------------------

    screenshot(tabId: TabId, allowedOrigins: string[], opts: DriverOptions): Promise<ScreenshotResult> {
        return this.run(opts, async (_op, conn) => {
            const tab = this.requireTab(tabId)
            tab.allowedOrigins = allowedOrigins
            const before = tab.generation
            const frames = await this.collectFrames(conn, tab)
            for (const frame of frames) {
                if (!frame.origin || !allowedOrigins.includes(frame.origin)) {
                    throw originDenied('page contains a frame whose origin is not allowed or cannot be determined')
                }
            }
            const { data } = await conn.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, tab.sessionId)
            await this.options.testHooks?.afterCapture?.(tabId)
            const after = await this.collectFrames(conn, tab).catch(() => undefined)
            const unchanged = !!after
                && tab.generation === before
                && after.length === frames.length
                && after.every((frame, i) => frame.frameId === frames[i].frameId && frame.loaderId === frames[i].loaderId && frame.origin === frames[i].origin)
            if (!unchanged) {
                // The image is dropped here; it was never written anywhere.
                throw originDenied('frame tree changed during capture; image discarded', true)
            }
            return {
                tabId,
                mimeType: 'image/png',
                data,
                documentGeneration: before,
                targetId: tab.targetId,
                capturedAtMs: Date.now(),
            }
        })
    }

    // -----------------------------------------------------------------------
    // Input
    // -----------------------------------------------------------------------

    click(tabId: TabId, ref: ElementRef, snapshotId: SnapshotId, opts: DriverOptions): Promise<void> {
        return this.run(opts, async (op, conn) => {
            const tab = this.requireTab(tabId)
            const { binding, objectId } = await this.resolveRef(conn, tab, ref, snapshotId)
            const point = await this.prepareInput(conn, tab, binding, objectId, false)
            this.assertFresh(tab, binding, snapshotId)
            op.markDispatch()
            const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 }
            await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, binding.sessionId)
            await conn.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 }, binding.sessionId)
            await conn.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 }, binding.sessionId)
        }, true)
    }

    fill(tabId: TabId, ref: ElementRef, snapshotId: SnapshotId, value: string, opts: DriverOptions): Promise<void> {
        return this.run(opts, async (op, conn) => {
            const tab = this.requireTab(tabId)
            const { binding, objectId } = await this.resolveRef(conn, tab, ref, snapshotId, true)
            await this.prepareInput(conn, tab, binding, objectId, true)
            this.assertFresh(tab, binding, snapshotId)
            op.markDispatch()
            await conn.send('DOM.focus', { backendNodeId: binding.backendNodeId }, binding.sessionId)
            await conn.send('Runtime.callFunctionOn', { functionDeclaration: SELECT_CONTENT, objectId }, binding.sessionId)
            if (value) {
                await conn.send('Input.insertText', { text: value }, binding.sessionId)
            } else {
                const key = { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }
                await conn.send('Input.dispatchKeyEvent', { ...key, type: 'keyDown' }, binding.sessionId)
                await conn.send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' }, binding.sessionId)
            }
        }, true)
    }

    // -----------------------------------------------------------------------
    // waitFor
    // -----------------------------------------------------------------------

    waitFor(tabId: TabId, predicate: WaitPredicate, allowedOrigins: string[], opts: DriverOptions): Promise<void> {
        return this.run(opts, async (op, conn) => {
            const tab = this.requireTab(tabId)
            while (!op.aborted) {
                if (!this.tabs.has(tabId)) throw targetGone()
                if (await this.predicateHolds(conn, tab, predicate, allowedOrigins)) return
                await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
            }
        })
    }

    private async predicateHolds(conn: CdpConnection, tab: TabState, predicate: WaitPredicate, allowedOrigins: string[]): Promise<boolean> {
        if (predicate.kind === 'url') return tab.mainUrl.startsWith(predicate.urlPrefix)
        if (predicate.kind === 'ref') {
            if (!tab.snapshot) throw staleRef('no snapshot')
            const { state } = await this.resolveRef(conn, tab, predicate.ref, tab.snapshot.snapshotId)
            return state === 'ok'
        }
        const frames = await this.collectFrames(conn, tab)
        for (const frame of frames) {
            if (!frame.origin || !allowedOrigins.includes(frame.origin)) continue
            try {
                const contextId = await this.isolatedContext(conn, tab, frame.sessionId, frame.frameId, this.stampOf(tab, frame.frameId))
                const { result } = await conn.send('Runtime.callFunctionOn', {
                    functionDeclaration: FRAME_HAS_TEXT,
                    executionContextId: contextId,
                    arguments: [{ value: predicate.text }],
                    returnByValue: true,
                }, frame.sessionId)
                if (result?.value === true) return true
            } catch (error) {
                if (error instanceof CdpProtocolError) continue
                throw error
            }
        }
        return false
    }

    // -----------------------------------------------------------------------
    // Internals: operation wrapper
    // -----------------------------------------------------------------------

    /**
     * Runs one driver operation under its deadline, abort signal and the
     * connection lifetime. Rejects immediately on any of them; the body keeps
     * running in the background but `op.markDispatch()` refuses further
     * page-visible effects once aborted.
     */
    private run<T>(opts: DriverOptions, body: (op: OpContext, conn: CdpConnection) => Promise<T>, sideEffecting = false): Promise<T> {
        const op = new OpContext()
        return new Promise<T>((resolve, reject) => {
            let conn: CdpConnection
            try {
                conn = this.requireConn()
            } catch (error) {
                reject(error)
                return
            }
            let settled = false
            const cleanups: Array<() => void> = []
            const settle = (fn: () => void) => {
                if (settled) return
                settled = true
                for (const cleanup of cleanups) cleanup()
                fn()
            }
            const fail = (error: BrowserRuntimeError) => {
                op.aborted = true
                settle(() => reject(error))
            }
            if (opts.signal?.aborted) {
                fail(this.abortError(opts.signal.reason, false))
                return
            }
            const timer = setTimeout(() => {
                fail(new BrowserRuntimeError('OUTCOME_UNKNOWN', `driver operation timed out after ${opts.timeoutMs}ms`, false, op.dispatched))
            }, opts.timeoutMs)
            cleanups.push(() => clearTimeout(timer))
            if (opts.signal) {
                const signal = opts.signal
                const onAbort = () => fail(this.abortError(signal.reason, op.dispatched))
                signal.addEventListener('abort', onAbort, { once: true })
                cleanups.push(() => signal.removeEventListener('abort', onAbort))
            }
            cleanups.push(conn.onClose(() => {
                fail(new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'browser connection closed', true, op.dispatched))
            }))
            body(op, conn).then(
                (value) => settle(() => resolve(value)),
                (error) => settle(() => reject(this.mapError(error, sideEffecting && op.dispatched))),
            )
        })
    }

    private abortError(reason: unknown, dispatched: boolean): BrowserRuntimeError {
        if (reason instanceof BrowserRuntimeError) return reason
        return new BrowserRuntimeError('OUTCOME_UNKNOWN', 'driver operation aborted', false, dispatched)
    }

    private mapError(error: unknown, dispatched: boolean): BrowserRuntimeError {
        if (error instanceof BrowserRuntimeError) {
            if (dispatched && !error.mayHaveSideEffects && error.code === 'RUNTIME_UNAVAILABLE') {
                return new BrowserRuntimeError(error.code, error.message, error.retryable, true)
            }
            return error
        }
        if (error instanceof CdpProtocolError) {
            if (/No target with given id|Session with given id not found|Target closed/i.test(error.message)) return targetGone()
            return new BrowserRuntimeError('OUTCOME_UNKNOWN', `browser command failed (${error.method})`, false, dispatched)
        }
        return new BrowserRuntimeError('OUTCOME_UNKNOWN', 'driver internal error', false, dispatched)
    }

    private requireConn(): CdpConnection {
        if (!this.conn || this.conn.closed) throw connectionClosedError()
        return this.conn
    }

    private requireTab(tabId: TabId): TabState {
        const tab = this.tabs.get(tabId)
        if (!tab) throw targetGone()
        return tab
    }

    // -----------------------------------------------------------------------
    // Internals: registry and events
    // -----------------------------------------------------------------------

    private registerTab(targetId: string, sessionId: string, allowedOrigins: string[]): TabState {
        const tab: TabState = {
            tabId: newId('tab') as TabId,
            targetId,
            sessionId,
            sessions: new Set([sessionId]),
            allowedOrigins,
            generation: 0,
            stamps: new Map(),
            frameKeys: new Map([[targetId, 'f0']]),
            nextFrameKey: 1,
            mainUrl: 'about:blank',
            worlds: new Map(),
            pendingSetups: new Set(),
            goneListeners: new Set(),
        }
        this.tabs.set(tab.tabId, tab)
        this.tabsByTarget.set(targetId, tab)
        this.sessions.set(sessionId, { tab, targetId, isMain: true })
        return tab
    }

    /** Removes every trace of a tab. Refs die with it. */
    private forgetTab(tab: TabState): void {
        if (this.tabs.get(tab.tabId) !== tab) return
        this.tabs.delete(tab.tabId)
        this.tabsByTarget.delete(tab.targetId)
        for (const sessionId of tab.sessions) this.sessions.delete(sessionId)
        tab.sessions.clear()
        tab.snapshot = undefined
        tab.worlds.clear()
        for (const listener of [...tab.goneListeners]) listener()
        tab.goneListeners.clear()
    }

    /** Lets a retried closeTab of an already-closed owned tab return the same result. */
    private rememberClosed(tabId: TabId): void {
        this.closedTabs.add(tabId)
        if (this.closedTabs.size > MAX_CLOSED_TABS) this.closedTabs.delete(this.closedTabs.values().next().value!)
    }

    private dropAllTabs(): void {
        for (const tab of [...this.tabs.values()]) this.forgetTab(tab)
        this.sessions.clear()
    }

    private async setupSession(conn: CdpConnection, sessionId: string, isMain: boolean): Promise<void> {
        const commands: Array<Promise<unknown>> = [
            conn.send('Page.enable', {}, sessionId),
            conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId),
        ]
        if (isMain) commands.push(conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId))
        await Promise.all(commands)
    }

    private wire(conn: CdpConnection): void {
        const current = () => this.conn === conn
        conn.on('Target.attachedToTarget', (params, parentSessionId) => {
            if (!current()) return
            const parent = parentSessionId ? this.sessions.get(parentSessionId) : undefined
            const childSessionId: string = params.sessionInfo?.sessionId ?? params.sessionId
            const targetInfo = params.targetInfo
            if (!parent || !childSessionId) return
            if (targetInfo.type !== 'iframe') {
                // Workers etc. are not addressable through this driver.
                conn.send('Target.detachFromTarget', { sessionId: childSessionId }).catch(() => undefined)
                return
            }
            const tab = parent.tab
            tab.sessions.add(childSessionId)
            this.sessions.set(childSessionId, { tab, targetId: targetInfo.targetId, isMain: false })
            this.touch(tab, targetInfo.targetId)
            const setup = this.setupSession(conn, childSessionId, false).catch(() => undefined)
            tab.pendingSetups.add(setup)
            setup.finally(() => tab.pendingSetups.delete(setup))
        })
        conn.on('Target.detachedFromTarget', (params) => {
            if (!current()) return
            const info = this.sessions.get(params.sessionId)
            if (!info) return
            if (info.isMain) {
                this.rememberClosed(info.tab.tabId)
                this.forgetTab(info.tab)
                return
            }
            this.sessions.delete(params.sessionId)
            info.tab.sessions.delete(params.sessionId)
            this.touch(info.tab, info.targetId)
        })
        const onTargetEnded = (params: any) => {
            if (!current()) return
            const tab = this.tabsByTarget.get(params.targetId)
            if (tab) {
                this.rememberClosed(tab.tabId)
                this.forgetTab(tab)
            }
            const popup = this.popups.get(params.targetId)
            if (popup) popup.closed = true
        }
        conn.on('Target.targetDestroyed', onTargetEnded)
        conn.on('Target.targetCrashed', onTargetEnded)
        conn.on('Target.targetCreated', (params) => current() && this.onTargetInfo(conn, params.targetInfo))
        conn.on('Target.targetInfoChanged', (params) => current() && this.onTargetInfo(conn, params.targetInfo))

        const frameEvent = (frameId: string, sessionId: string | undefined) => {
            const info = sessionId ? this.sessions.get(sessionId) : undefined
            if (info) this.touch(info.tab, frameId)
            return info
        }
        conn.on('Page.frameNavigated', (params, sessionId) => {
            if (!current()) return
            const info = frameEvent(params.frame.id, sessionId)
            if (info?.isMain && !params.frame.parentId) info.tab.mainUrl = params.frame.url
        })
        conn.on('Page.navigatedWithinDocument', (params, sessionId) => {
            if (!current()) return
            const info = sessionId ? this.sessions.get(sessionId) : undefined
            if (info?.isMain && params.frameId === info.tab.targetId) info.tab.mainUrl = params.url
        })
        conn.on('Page.frameAttached', (params, sessionId) => current() && frameEvent(params.frameId, sessionId))
        conn.on('Page.frameDetached', (params, sessionId) => current() && frameEvent(params.frameId, sessionId))
    }

    /** Pages opened by an owned tab: never adopted; closed if their origin is not allowed. */
    private onTargetInfo(conn: CdpConnection, info: any): void {
        if (info.type !== 'page' || !info.openerId || this.tabsByTarget.has(info.targetId)) return
        const opener = this.tabsByTarget.get(info.openerId)
        if (!opener) return
        const origin = originOf(info.url)
        const report = this.popups.get(info.targetId) ?? { openerTabId: opener.tabId, targetId: info.targetId, origin, closed: false }
        report.origin = origin || report.origin
        this.popups.set(info.targetId, report)
        if (this.popups.size > MAX_POPUP_REPORTS) this.popups.delete(this.popups.keys().next().value!)
        const pending = !info.url || info.url === 'about:blank'
        if (!pending && !report.closed && !opener.allowedOrigins.includes(origin)) {
            report.closed = true
            conn.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined)
        }
    }

    private touch(tab: TabState, frameId: string): void {
        tab.generation += 1
        tab.stamps.set(frameId, tab.generation)
    }

    private stampOf(tab: TabState, frameId: string): number {
        let stamp = tab.stamps.get(frameId)
        if (stamp === undefined) {
            stamp = tab.generation
            tab.stamps.set(frameId, stamp)
        }
        return stamp
    }

    private frameKey(tab: TabState, frameId: string): string {
        let key = tab.frameKeys.get(frameId)
        if (!key) {
            key = `f${tab.nextFrameKey++}`
            tab.frameKeys.set(frameId, key)
        }
        return key
    }

    // -----------------------------------------------------------------------
    // Internals: navigation
    // -----------------------------------------------------------------------

    private async navigateInternal(
        conn: CdpConnection,
        tab: TabState,
        url: string,
        allowedOrigins: string[],
        op: OpContext,
    ): Promise<{ url: string; documentGeneration: number }> {
        if (!allowedOrigins.includes(originOf(url))) throw originDenied('requested origin is not allowed')
        tab.allowedOrigins = allowedOrigins
        let navigated = false
        let offs: Array<() => void> = []
        const loaded = new Promise<void>((resolve, reject) => {
            offs = [
                conn.on('Page.frameNavigated', (params, sessionId) => {
                    if (sessionId !== tab.sessionId || params.frame.parentId) return
                    navigated = true
                    if (!allowedOrigins.includes(frameOrigin(params.frame))) {
                        conn.send('Page.stopLoading', {}, tab.sessionId).catch(() => undefined)
                        reject(originDenied('navigation ended on an origin that is not allowed', false, true))
                    }
                }),
                conn.on('Page.loadEventFired', (_params, sessionId) => {
                    if (sessionId === tab.sessionId && navigated) resolve()
                }),
            ]
        })
        loaded.catch(() => undefined)
        try {
            op.markDispatch()
            const result = await conn.send('Page.navigate', { url }, tab.sessionId)
            if (result.errorText) {
                throw new BrowserRuntimeError('INVALID_REQUEST', `navigation failed: ${result.errorText}`, true, true)
            }
            if (result.loaderId) await loaded
        } finally {
            for (const off of offs) off()
        }
        const { frameTree } = await conn.send('Page.getFrameTree', {}, tab.sessionId)
        if (!allowedOrigins.includes(frameOrigin(frameTree.frame))) {
            await conn.send('Page.stopLoading', {}, tab.sessionId).catch(() => undefined)
            throw originDenied('navigation ended on an origin that is not allowed', false, true)
        }
        tab.mainUrl = frameTree.frame.url
        return { url: frameTree.frame.url, documentGeneration: tab.generation }
    }

    // -----------------------------------------------------------------------
    // Internals: frames, isolated worlds, refs
    // -----------------------------------------------------------------------

    /** Current frame list, main frame first. OOPIF frames are owned by their child session. */
    private async collectFrames(conn: CdpConnection, tab: TabState): Promise<LiveFrame[]> {
        while (tab.pendingSetups.size) await Promise.all([...tab.pendingSetups])
        const sessionIds = [...tab.sessions]
        const trees = await Promise.all(sessionIds.map(async (sessionId) => {
            const { frameTree } = await conn.send('Page.getFrameTree', {}, sessionId)
            return { sessionId, frameTree }
        }))
        const byId = new Map<string, LiveFrame & { owner: boolean }>()
        const order: string[] = []
        for (const { sessionId, frameTree } of trees) {
            const info = this.sessions.get(sessionId)
            const walk = (node: any) => {
                const frame = node.frame
                const owner = frame.id === info?.targetId
                const existing = byId.get(frame.id)
                if (!existing || (owner && !existing.owner)) {
                    if (!existing) order.push(frame.id)
                    byId.set(frame.id, {
                        frameId: frame.id,
                        loaderId: frame.loaderId,
                        url: frame.url,
                        origin: frameOrigin(frame),
                        sessionId,
                        outOfProcess: sessionId !== tab.sessionId,
                        owner,
                    })
                }
                for (const child of node.childFrames ?? []) walk(child)
            }
            walk(frameTree)
        }
        const mainIndex = order.indexOf(tab.targetId)
        if (mainIndex > 0) {
            order.splice(mainIndex, 1)
            order.unshift(tab.targetId)
        }
        return order.map((id) => {
            const { owner: _owner, ...frame } = byId.get(id)!
            return frame
        })
    }

    private async isolatedContext(conn: CdpConnection, tab: TabState, sessionId: string, frameId: string, stamp: number): Promise<number> {
        const key = `${sessionId}|${frameId}`
        const cached = tab.worlds.get(key)
        if (cached && cached.stamp === stamp) return cached.contextId
        const { executionContextId } = await conn.send('Page.createIsolatedWorld', { frameId, worldName: ISOLATED_WORLD, grantUniveralAccess: false }, sessionId)
        tab.worlds.set(key, { stamp, contextId: executionContextId })
        return executionContextId
    }

    private async collectInFrame(
        conn: CdpConnection,
        tab: TabState,
        frame: LiveFrame,
        stamp: number,
        limits: { maxElements: number; maxTextChars: number },
        scope: RefBinding | undefined,
    ): Promise<{ meta: CollectedFrame; backendNodeIds: number[] }> {
        const sessionId = frame.sessionId
        const contextId = await this.isolatedContext(conn, tab, sessionId, frame.frameId, stamp)
        const objectGroup = newId('abp-observe')
        try {
            const args: Array<Record<string, unknown>> = [{ value: limits }]
            if (scope) {
                const { object } = await conn.send('DOM.resolveNode', { backendNodeId: scope.backendNodeId, executionContextId: contextId, objectGroup }, sessionId)
                    .catch(() => { throw staleRef('scope element is gone') })
                args.push({ objectId: object.objectId })
            }
            const evaluated = await conn.send('Runtime.callFunctionOn', {
                functionDeclaration: COLLECT_FRAME,
                executionContextId: contextId,
                arguments: args,
                returnByValue: false,
                objectGroup,
            }, sessionId)
            if (evaluated.exceptionDetails || !evaluated.result?.objectId) throw new CdpProtocolError('collectFrame', 0, 'collector failed')
            const { result: props } = await conn.send('Runtime.getProperties', { objectId: evaluated.result.objectId, ownProperties: true }, sessionId)
            const json = props.find((p: any) => p.name === 'json')?.value?.value
            const nodesId = props.find((p: any) => p.name === 'nodes')?.value?.objectId
            const meta = JSON.parse(json) as CollectedFrame
            const { result: nodeProps } = await conn.send('Runtime.getProperties', { objectId: nodesId, ownProperties: true }, sessionId)
            const indexed = nodeProps
                .filter((p: any) => /^\d+$/.test(p.name) && p.value?.objectId)
                .sort((x: any, y: any) => Number(x.name) - Number(y.name))
            const backendNodeIds = await Promise.all(indexed.map(async (p: any) => {
                const { node } = await conn.send('DOM.describeNode', { objectId: p.value.objectId }, sessionId)
                return node.backendNodeId as number
            }))
            if (backendNodeIds.length !== meta.elements.length) throw new CdpProtocolError('collectFrame', 0, 'node count mismatch')
            return { meta, backendNodeIds }
        } finally {
            conn.send('Runtime.releaseObjectGroup', { objectGroup }, sessionId).catch(() => undefined)
        }
    }

    /** Synchronous checks against the live registry; no browser round-trip. */
    private assertFresh(tab: TabState, binding: RefBinding, snapshotId: SnapshotId): void {
        if (!this.tabs.has(tab.tabId)) throw targetGone()
        if (!tab.snapshot || tab.snapshot.snapshotId !== snapshotId) throw staleRef('snapshot superseded')
        if (!tab.sessions.has(binding.sessionId)) throw staleRef('frame session is gone')
        if (tab.stamps.get(binding.frameId) !== binding.stamp) throw staleRef('frame navigated or detached')
    }

    private async resolveRef(
        conn: CdpConnection,
        tab: TabState,
        ref: ElementRef | string,
        snapshotId: SnapshotId,
        forFill = false,
    ): Promise<{ binding: RefBinding; objectId: string; state: ElementState }> {
        if (!tab.snapshot || tab.snapshot.snapshotId !== snapshotId) throw staleRef('snapshot superseded')
        const binding = tab.snapshot.refs.get(ref)
        if (!binding) throw staleRef('unknown ref')
        this.assertFresh(tab, binding, snapshotId)
        const { frameTree } = await conn.send('Page.getFrameTree', {}, binding.sessionId)
            .catch(() => { throw staleRef('frame session is gone') })
        const frame = findFrame(frameTree, binding.frameId)
        if (!frame || frame.loaderId !== binding.loaderId) throw staleRef('document changed')
        if (!tab.allowedOrigins.includes(frameOrigin(frame))) throw originDenied('frame origin is no longer allowed')
        const contextId = await this.isolatedContext(conn, tab, binding.sessionId, binding.frameId, binding.stamp)
        const resolved = await conn.send('DOM.resolveNode', { backendNodeId: binding.backendNodeId, executionContextId: contextId }, binding.sessionId)
            .catch(() => { throw staleRef('element is gone') })
        const objectId: string = resolved.object.objectId
        const { result } = await conn.send('Runtime.callFunctionOn', {
            functionDeclaration: CHECK_ELEMENT,
            objectId,
            arguments: [{ value: forFill }],
            returnByValue: true,
        }, binding.sessionId)
        const state = result.value as ElementState
        if (state === 'detached') throw staleRef('element was removed from the document')
        this.assertFresh(tab, binding, snapshotId)
        return { binding, objectId, state }
    }

    /** Refuses unusable targets, scrolls into view, hit-tests, returns the dispatch point in the session's viewport. */
    private async prepareInput(conn: CdpConnection, tab: TabState, binding: RefBinding, objectId: string, forFill: boolean): Promise<{ x: number; y: number }> {
        const check = async () => {
            const { result } = await conn.send('Runtime.callFunctionOn', {
                functionDeclaration: CHECK_ELEMENT,
                objectId,
                arguments: [{ value: forFill }],
                returnByValue: true,
            }, binding.sessionId)
            const state = result.value as ElementState
            if (state === 'detached') throw staleRef('element was removed from the document')
            if (state !== 'ok') throw new BrowserRuntimeError('INVALID_REQUEST', `element is ${state}; not interacting`, false, false)
        }
        await check()
        await conn.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: binding.backendNodeId }, binding.sessionId)
        await check()
        const { result: hit } = await conn.send('Runtime.callFunctionOn', { functionDeclaration: HIT_TEST, objectId, returnByValue: true }, binding.sessionId)
        if (hit.value !== true) throw new BrowserRuntimeError('INVALID_REQUEST', 'element is covered by another element; not interacting', true, false)
        const { quads } = await conn.send('DOM.getContentQuads', { backendNodeId: binding.backendNodeId }, binding.sessionId)
        const quad: number[] | undefined = quads?.[0]
        if (!quad) throw new BrowserRuntimeError('INVALID_REQUEST', 'element has no box; not interacting', false, false)
        return {
            x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
            y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
        }
    }
}

function findFrame(node: any, frameId: string): any | undefined {
    if (node.frame.id === frameId) return node.frame
    for (const child of node.childFrames ?? []) {
        const found = findFrame(child, frameId)
        if (found) return found
    }
    return undefined
}
