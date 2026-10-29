/**
 * The real BrowserRuntime with the real CdpDriver against a scripted CDP endpoint, so a test can hold
 * one browser answer and fence the task meanwhile: nothing more is sent after the fence, and what
 * was already sent stays an unknown outcome. Protocol-level evidence only (no browser behind it).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { FakeClock } from './clock'
import type { AgentGrant, BrowserDriver, InteractiveCapability, ProfileId, RequestId, TabId } from './contracts'
import { CdpDriver } from './drivers/cdpDriver'
import { CHECK_ELEMENT, COLLECT_FRAME, DESCRIBE_ELEMENT, LABEL_OF, SELECT_CONTENT, SUBMIT_GUARD } from './drivers/pageScripts'
import { BrowserRuntime } from './runtime'
import { TaskStore } from './taskStore'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'

const ORIGIN = 'https://fixture.test'
type Command = { id: number; method: string; params: any; sessionId?: string }

/** A CDP endpoint answering just enough for adopt/observe/click/fill/navigate on one page per session. */
class ScriptedBrowser {
    readonly commands: Command[] = []
    readonly targets = new Map<string, string>()
    private socket?: WebSocket
    private holdRule?: { match: (command: Command) => boolean; entered: () => void }
    private held?: object
    /** Page.navigate: a document request to a disallowed origin pauses before the answer (a blocked redirect) */
    blockNavigation = false
    /** The button submits a form (describeRef and the click's expectation see it), so a click arms the submission guard */
    formButton = false
    url = ''
    private constructor(private readonly server: WebSocketServer) {
        server.on('connection', (socket) => {
            this.socket = socket
            socket.on('message', (data) => this.answer(JSON.parse(data.toString())))
        })
    }
    static async start(): Promise<ScriptedBrowser> {
        const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
        await new Promise<void>((resolve) => server.once('listening', () => resolve()))
        const browser = new ScriptedBrowser(server)
        browser.url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser/scripted`
        return browser
    }
    /** Keeps the answer to the next matching command until `release`. */
    hold(match: (command: Command) => boolean): Promise<void> {
        return new Promise((entered) => { this.holdRule = { match, entered } })
    }
    release(): void {
        const held = this.held
        this.held = undefined
        if (held) this.send(held)
    }
    /** Commands that change browser or page state (not reads), from `index` on. */
    stateChangesSince(index: number): string[] {
        return this.commands.slice(index).filter(changesState).map((command) => `${command.method}${command.params.type ? `:${command.params.type}` : ''}`)
    }
    inputsSince(index: number): string[] {
        return this.commands.slice(index).filter((command) => command.method.startsWith('Input.') || command.method === 'Page.navigate')
            .map((command) => `${command.method}${command.params.type ? `:${command.params.type}` : ''}`)
    }
    async close(): Promise<void> {
        for (const client of this.server.clients) client.terminate()
        await new Promise<void>((resolve) => this.server.close(() => resolve()))
    }
    private send(message: object): void {
        this.socket?.send(JSON.stringify(message))
    }
    private answer(command: Command): void {
        this.commands.push(command)
        const target = (command.sessionId && this.targets.get(command.sessionId)) || 'unknown-target'
        const label = (objectId: string) => objectId === 'node-2'
            ? { role: 'textbox', name: 'Name', tag: 'input' } : { role: 'button', name: 'Continue', tag: 'button' }
        let result: any = {}
        switch (command.method) {
            case 'Target.attachToTarget':
                result = { sessionId: [...this.targets].find(([, id]) => id === command.params.targetId)?.[0] }
                break
            case 'Target.getTargets':
                result = { targetInfos: [...this.targets.values()].map((targetId) => ({ targetId, type: 'page', url: `${ORIGIN}/start` })) }
                break
            case 'Page.getFrameTree':
                result = { frameTree: { frame: { id: target, loaderId: 'loader', url: `${ORIGIN}/start`, securityOrigin: ORIGIN } } }
                break
            case 'Page.createIsolatedWorld':
                result = { executionContextId: 1 }
                break
            case 'DOM.resolveNode':
                result = { object: { objectId: `node-${command.params.backendNodeId}` } }
                break
            case 'DOM.describeNode':
                result = { node: { backendNodeId: Number(String(command.params.objectId).split('-')[1]) } }
                break
            case 'DOM.getContentQuads':
                result = { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] }
                break
            case 'Runtime.callFunctionOn': {
                const fn = command.params.functionDeclaration
                const form = this.formButton && command.params.objectId === 'node-1' ? { submitsForm: true, form: { action: `${ORIGIN}/next`, method: 'get',
                    enctype: 'application/x-www-form-urlencoded', target: '', fields: [], opaque: false,
                    submitter: { name: '', value: '', formaction: null, formmethod: null, formenctype: null } } } : {}
                const value = fn === CHECK_ELEMENT ? 'ok' : fn === LABEL_OF ? label(command.params.objectId)
                    : fn === DESCRIBE_ELEMENT ? { ...label(command.params.objectId), pageUrl: `${ORIGIN}/start`, formValues: {}, ...form } : true
                result = fn === COLLECT_FRAME ? { result: { objectId: 'collection' } } : { result: { value } }
                break
            }
            case 'Runtime.getProperties':
                result = { result: command.params.objectId === 'collection'
                    ? [{ name: 'json', value: { value: JSON.stringify({ url: `${ORIGIN}/start`, title: 'fixture', text: 'fixture', truncated: false,
                        elements: [{ ...label('node-1'), visible: true }, { ...label('node-2'), visible: true, value: 'old' }] }) } },
                    { name: 'nodes', value: { objectId: 'nodes' } }]
                    : [{ name: '0', value: { objectId: 'node-1' } }, { name: '1', value: { objectId: 'node-2' } }] }
                break
            case 'Page.navigate':
                if (this.blockNavigation) {
                    this.send({ method: 'Fetch.requestPaused', sessionId: command.sessionId, params: { requestId: 'redirect', frameId: target,
                        resourceType: 'Document', request: { url: 'https://denied.test/away', method: 'GET' } } })
                    result = { errorText: 'net::ERR_BLOCKED_BY_CLIENT' }
                }
                break
        }
        const reply = { id: command.id, sessionId: command.sessionId, result }
        if (this.holdRule?.match(command)) {
            const { entered } = this.holdRule
            this.holdRule = undefined
            this.held = reply
            entered()
            return
        }
        this.send(reply)
    }
}

function changesState(c: Command): boolean {
    return c.method.startsWith('Input.') || ['DOM.scrollIntoViewIfNeeded', 'DOM.focus', 'Page.navigate', 'Runtime.addBinding'].includes(c.method)
        || c.method === 'Runtime.callFunctionOn' && [SELECT_CONTENT, SUBMIT_GUARD].includes(c.params.functionDeclaration)
}
/** The check right before the first scroll of a click: after describeRef, the click's ref resolution check, then this one. */
function checkBeforeScroll(): (c: Command) => boolean {
    let described = false
    let checks = 0
    return (c) => {
        if (c.method !== 'Runtime.callFunctionOn') return false
        if (c.params.functionDeclaration === DESCRIBE_ELEMENT) described = true
        else if (described && c.params.functionDeclaration === CHECK_ELEMENT) checks += 1
        return checks === 2
    }
}
const pressed = (c: Command) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed'
const keyDown = (c: Command) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'keyDown'
const lastReadBeforeInput = (c: Command) => c.method === 'Runtime.callFunctionOn' && c.params.functionDeclaration === LABEL_OF

describe('Runtime + CdpDriver input boundary (scripted CDP endpoint)', () => {
    let browser: ScriptedBrowser
    const cleanups: Array<() => Promise<void>> = []
    let serial = 0

    beforeAll(async () => { browser = await ScriptedBrowser.start() })
    afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined) })
    afterAll(async () => { await browser.close() })

    /** A task whose tab is opened with a fake driver, then adopted by a real CdpDriver of the same browser identity. */
    async function harness(gated = true) {
        const n = ++serial
        const dir = await mkdtemp(join(tmpdir(), 'abp-cdp-boundary-'))
        const store = await TaskStore.open(dir)
        const fake = new FakeBrowserDriver()
        const profileId = `profile-${n}` as ProfileId
        const driver = new CdpDriver({ browserWsUrl: browser.url, browserInstanceIdProvider: async () => fake.browserInstanceId() })
        if (!gated) Object.defineProperty(driver, 'gatesInputOnValidateDispatch', { value: undefined })
        const drivers = new Map<ProfileId, BrowserDriver>([[profileId, fake]])
        const runtime = new BrowserRuntime({ store, clock: new FakeClock(100), drivers, sites: fixtureSitePolicies([ORIGIN]) })
        cleanups.push(async () => { await driver.close(); await store.close(); await rm(dir, { recursive: true, force: true }) })
        const auth = { verifiedAtMs: 100, credential: { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never,
            machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: [ORIGIN],
            operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'subscribe', 'cancel', 'observe', 'resume'],
            taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 } satisfies AgentGrant }
        const uiAuth = { verifiedAtMs: 100, credential: { kind: 'interactive', capabilityId: 'ui', principalId: 'p' as never, workspaceId: 'w' as never,
            machineId: 'm' as never, viewerSessionId: 'viewer', profileId, operations: ['takeOver', 'releaseControl'], issuedAtMs: 0, expiresAtMs: 3_600_000 } satisfies InteractiveCapability }
        const space = await runtime.createSpace(auth, { profileId, requestId: 'space' as RequestId })
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task' as RequestId })
        const tab = await runtime.openPage(auth, { taskId: task.taskId, url: `${ORIGIN}/start`, requestId: 'open' as RequestId })
        browser.targets.set(`session-${n}`, `target-${n}`)
        await driver.connect()
        expect(await driver.adoptTab(tab.tabId, `target-${n}`, [ORIGIN], { timeoutMs: 1_000 })).toBe(true)
        drivers.set(profileId, driver)
        const obs = await runtime.observe(auth, { taskId: task.taskId, tabId: tab.tabId })
        const actionId = `act-${n}`
        const step = (kind: 'click' | 'fill' | 'navigate', extra: object) => ({ kind, stepId: 'step' as never, actionId: actionId as never,
            tabId: tab.tabId, timeoutMs: 5_000, ...extra })
        const click = () => step('click', { ref: obs.elements[0].ref, snapshotId: obs.snapshotId })
        const clear = () => step('fill', { ref: obs.elements[1].ref, snapshotId: obs.snapshotId, value: '' })
        const submit = async (s: ReturnType<typeof step>) => runtime.submitBatch(auth, { taskId: task.taskId,
            expectedVersion: (await runtime.getTask(auth, { taskId: task.taskId })).stateVersion, requestId: `batch-${n}` as RequestId, steps: [s as never] }, { waitMs: 7_000 })
        const takeOver = (tabId: TabId) => runtime.takeOver(uiAuth, { taskId: task.taskId, tabId,
            expectedEpoch: runtime.leases.owner(tabId, profileId).leaseEpoch, requestId: 'take' as RequestId })
        const cancel = () => runtime.cancel(auth, { taskId: task.taskId, requestId: 'cancel' as RequestId })
        return { runtime, store, profileId, taskId: task.taskId, tabId: tab.tabId, actionId, step, click, clear, submit, takeOver, cancel }
    }

    /** Lets a held answer arrive and anything the driver still sends because of it reach the endpoint. */
    async function releaseHeld() {
        browser.release()
        await new Promise((resolve) => setTimeout(resolve, 150))
    }

    describe('a press or key-down already sent: the rest of the input is never sent after the fence, and the outcome stays unknown', () => {
        it.each([
            ['click', 'takeover', pressed, 'Input.dispatchMouseEvent:mouseReleased'],
            ['clear', 'takeover', keyDown, 'Input.dispatchKeyEvent:keyUp'],
            ['click', 'cancel', pressed, 'Input.dispatchMouseEvent:mouseReleased'],
            ['clear', 'cancel', keyDown, 'Input.dispatchKeyEvent:keyUp'],
        ] as const)('%s, %s while the first input\'s answer is held', async (write, fence, firstInput, rest) => {
            const h = await harness()
            const entered = browser.hold(firstInput)
            const batch = h.submit(write === 'click' ? h.click() : h.clear())
            await entered
            if (fence === 'takeover') await h.takeOver(h.tabId)
            else await h.cancel()
            const result = (await batch).result
            // The driver call has settled (the held answer has not arrived): a takeover is complete, the user owns input.
            if (fence === 'takeover') expect(h.runtime.leases.owner(h.tabId, h.profileId).owner.kind).toBe('user')
            const mark = browser.commands.length
            await releaseHeld()
            expect(browser.inputsSince(mark)).not.toContain(rest)
            expect(browser.inputsSince(mark)).toEqual([])
            expect(result).toMatchObject({ outcome: 'uncertain', mayHaveSideEffects: true })
            const stored = h.store.getTask(h.taskId)!
            expect(stored.actions[h.actionId].state).toBe('uncertain')
            expect(stored.uncertainActions).toContain(h.actionId)
            expect(stored).toMatchObject(fence === 'takeover' ? { status: 'paused', pauseReason: 'user-control' }
                : { status: 'paused', pauseReason: 'cancelled-with-unknown-effect' })
        })
    })

    describe('a preparation step held, then the task fenced: no further scroll, hover, focus or selection, and no unknown outcome', () => {
        it.each([
            ['click', 'takeover', 'the check before the scroll'],
            ['click', 'cancel', 'the check before the scroll'],
            ['click', 'cancel', 'the scroll'],
            ['click', 'takeover', 'the hover'],
            ['clear', 'takeover', 'the focus'],
            ['clear', 'cancel', 'the focus'],
        ] as const)('%s, %s while %s is answered late', async (write, fence, point) => {
            const h = await harness()
            const match = point === 'the check before the scroll' ? checkBeforeScroll()
                : point === 'the scroll' ? (c: Command) => c.method === 'DOM.scrollIntoViewIfNeeded'
                    : point === 'the hover' ? (c: Command) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseMoved'
                        : (c: Command) => c.method === 'DOM.focus'
            const entered = browser.hold(match)
            const batch = h.submit(write === 'click' ? h.click() : h.clear())
            await entered
            if (fence === 'takeover') await h.takeOver(h.tabId)
            else await h.cancel()
            await batch
            const mark = browser.commands.length
            await releaseHeld()
            expect(browser.stateChangesSince(mark)).toEqual([])
            expect(h.store.getTask(h.taskId)).toMatchObject({ uncertainActions: [], ...(fence === 'takeover'
                ? { status: 'paused', pauseReason: 'user-control' } : { status: 'cancelled' }) })
        })
    })

    describe('the submission guard of a form click', () => {
        afterEach(() => { browser.formButton = false })

        it('is installed before the press (the path these cases hold)', async () => {
            const h = await harness()
            browser.formButton = true
            const mark = browser.commands.length
            expect((await h.submit(h.click())).result?.outcome).toBe('succeeded')
            const changes = browser.stateChangesSince(mark)
            expect(changes.indexOf('Runtime.addBinding')).toBeGreaterThanOrEqual(0)
            expect(changes.indexOf('Runtime.callFunctionOn')).toBeGreaterThan(changes.indexOf('Runtime.addBinding'))
            expect(changes.indexOf('Input.dispatchMouseEvent:mousePressed')).toBeGreaterThan(changes.indexOf('Runtime.callFunctionOn'))
        })

        it.each(['takeover', 'cancel'] as const)('%s while it is being installed: not installed afterwards, nothing sent, no unknown outcome', async (fence) => {
            const h = await harness()
            browser.formButton = true
            const entered = browser.hold((c) => c.method === 'Runtime.enable')
            const batch = h.submit(h.click())
            await entered
            if (fence === 'takeover') await h.takeOver(h.tabId)
            else await h.cancel()
            await batch
            const mark = browser.commands.length
            await releaseHeld()
            expect(browser.stateChangesSince(mark)).toEqual([])
            expect(h.store.getTask(h.taskId)).toMatchObject({ uncertainActions: [], ...(fence === 'takeover'
                ? { status: 'paused', pauseReason: 'user-control' } : { status: 'cancelled' }) })
        })
    })

    it('a takeover while the last read before the press is held: no input at all afterwards, and no unknown outcome', async () => {
        const h = await harness()
        const entered = browser.hold(lastReadBeforeInput)
        const batch = h.submit(h.click())
        await entered
        await h.takeOver(h.tabId)
        await batch
        const mark = browser.commands.length
        await releaseHeld()
        expect(browser.inputsSince(mark)).toEqual([])
        expect(h.store.getTask(h.taskId)).toMatchObject({ status: 'paused', pauseReason: 'user-control', uncertainActions: [] })
    })

    describe('origin denial', () => {
        it('after the navigation was sent (its redirect blocked): the request is still stopped, and the outcome is unknown', async () => {
            const h = await harness()
            browser.blockNavigation = true
            const mark = browser.commands.length
            const result = (await h.submit(h.step('navigate', { url: `${ORIGIN}/redirect` }))).result
            browser.blockNavigation = false
            expect(browser.commands.slice(mark).some((c) => c.method === 'Fetch.failRequest' && c.params.requestId === 'redirect')).toBe(true)
            expect(result).toMatchObject({ outcome: 'uncertain', mayHaveSideEffects: true })
            expect(result?.steps[0]).toMatchObject({ outcome: 'uncertain', error: { code: 'ORIGIN_DENIED', mayHaveSideEffects: true }, receipt: { input: 'sent' } })
            const stored = h.store.getTask(h.taskId)!
            expect(stored).toMatchObject({ status: 'paused', pauseReason: 'outcome-unknown', uncertainActions: [h.actionId] })
            expect(stored.actions[h.actionId].state).toBe('uncertain')
        })

        it('before anything was sent (a disallowed destination): refused without side effects, nothing navigates', async () => {
            const h = await harness()
            const mark = browser.commands.length
            const result = (await h.submit(h.step('navigate', { url: 'https://denied.test/away' }))).result
            expect(browser.inputsSince(mark)).toEqual([])
            expect(result).toMatchObject({ outcome: 'failed', mayHaveSideEffects: false })
            expect(result?.steps[0]).toMatchObject({ outcome: 'failed', error: { code: 'ORIGIN_DENIED', mayHaveSideEffects: false } })
            expect(result?.steps[0].receipt).toBeUndefined()
            const stored = h.store.getTask(h.taskId)!
            expect(stored).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent', uncertainActions: [] })
            expect(stored.actions[h.actionId].state).toBe('failed')
        })
    })

    it('a driver without the declared gate, cancelled before its input: the action, task and batch all stay unknown', async () => {
        const h = await harness(false)
        const entered = browser.hold(lastReadBeforeInput)
        const batch = h.submit(h.click())
        await entered
        const cancelled = await h.cancel()
        expect(cancelled.task).toMatchObject({ pauseReason: 'cancelled-with-unknown-effect', uncertainActions: [h.actionId] })
        await releaseHeld()
        const result = (await batch).result
        expect(result).toMatchObject({ mayHaveSideEffects: true })
        expect(result?.steps.find((s) => s.actionId === h.actionId)).toMatchObject({ outcome: 'uncertain' })
        const stored = h.store.getTask(h.taskId)!
        expect(stored.actions[h.actionId].state).toBe('uncertain')
        expect(stored).toMatchObject({ status: 'paused', pauseReason: 'cancelled-with-unknown-effect', uncertainActions: [h.actionId] })
    })
})
