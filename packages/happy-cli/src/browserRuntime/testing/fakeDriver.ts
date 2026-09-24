import { randomUUID } from 'node:crypto'
import { BrowserRuntimeError, type BrowserDriver, type BrowserInstanceId, type DriverOptions, type DriverTabHandle, type ElementDescription, type ElementRef, type ObservedElement, type Observation, type ScreenshotResult, type SnapshotId, type TabId, type WaitPredicate } from '../contracts'

export interface FakePage { url: string; title?: string; text?: string; elements?: ObservedElement[]; documentGeneration?: number; frameOrigins?: string[]; formAction?: string; formValues?: Record<string, string> }
type Operation = 'openTab' | 'closeTab' | 'navigate' | 'observe' | 'describeRef' | 'screenshot' | 'click' | 'fill' | 'waitFor'
interface HeldDispatch {
    operation: Operation
    entered(): void
    release(): void
    gate: Promise<void>
}
export class FakeBrowserDriver implements BrowserDriver {
    private instance = `browser-${randomUUID()}` as BrowserInstanceId
    private serial = 0
    private readonly pages = new Map<TabId, FakePage>()
    private readonly targetIds = new Map<TabId, string>()
    private readonly snapshotGenerations = new Map<SnapshotId, number>()
    private readonly activeSnapshots = new Map<TabId, SnapshotId>()
    private readonly snapshotElements = new Map<SnapshotId, Map<ElementRef, ObservedElement>>()
    private currentActionId?: string
    readonly dispatchCounts = new Map<string, number>()
    readonly targetLedger: Array<{ targetId: string; tabId: TabId; operation: Operation; actionId?: string }> = []
    readonly adoptedTabs: Array<{ tabId: TabId; targetId: string; adopted: boolean }> = []
    readonly dispatchedSnapshots: Array<{ tabId: TabId; snapshotId: SnapshotId; operation: 'click' | 'fill' }> = []
    observeCount = 0
    delays = new Map<Operation, number>()
    private readonly failures = new Map<Operation, Error[]>()
    private waitRelease?: () => void
    private ignoreWaitAbort = false
    private heldDispatch?: HeldDispatch
    private dispatchObserver?: (actionId: string) => void
    private notifyWaitEntered!: () => void
    readonly waitForEntered = new Promise<void>((resolve) => { this.notifyWaitEntered = resolve })

    browserInstanceId(): BrowserInstanceId { return this.instance }
    swapInstance(): BrowserInstanceId { return this.instance = `browser-${randomUUID()}` as BrowserInstanceId }
    armAction(actionId: string): void { this.currentActionId = actionId }
    setDelay(operation: Operation, ms: number): void { this.delays.set(operation, ms) }
    setIgnoreWaitAbort(ignore: boolean): void { this.ignoreWaitAbort = ignore }
    holdAfterNextDispatch(operation: Operation): { entered: Promise<void>; release(): void } {
        let notifyEntered!: () => void
        let release!: () => void
        const entered = new Promise<void>((resolve) => { notifyEntered = resolve })
        const gate = new Promise<void>((resolve) => { release = resolve })
        this.heldDispatch = { operation, entered: notifyEntered, release, gate }
        return { entered, release }
    }
    observeDispatches(observer?: (actionId: string) => void): void { this.dispatchObserver = observer }
    failNext(operation: Operation, error: Error): void {
        this.failures.set(operation, [...(this.failures.get(operation) ?? []), error])
    }
    releaseWait(): void { this.waitRelease?.(); this.waitRelease = undefined }
    waitUntilReleased(): Promise<void> { return new Promise((resolve) => { this.waitRelease = resolve }) }

    async openTab(url: string, _origins: string[], opts: DriverOptions): Promise<DriverTabHandle> {
        await this.delay('openTab', opts)
        this.throwNextFailure('openTab')
        const tabId = `tab-${++this.serial}` as TabId
        const targetId = `target-${this.serial}`
        this.pages.set(tabId, { url, title: 'Fixture', text: 'fixture ready', documentGeneration: 1, elements: [] })
        this.targetIds.set(tabId, targetId)
        this.record(tabId, targetId, 'openTab')
        return { tabId, targetId }
    }
    async closeTab(tabId: TabId, opts: DriverOptions): Promise<{ closed: boolean; beforeUnloadBlocked?: boolean }> {
        await this.delay('closeTab', opts); const page = this.pages.get(tabId); if (!page) return { closed: false }
        this.pages.delete(tabId); this.record(tabId, `target-${tabId}`, 'closeTab'); return { closed: true }
    }
    hasTab(tabId: TabId): boolean { return this.pages.has(tabId) }
    async adoptTab(tabId: TabId, targetId: string, _allowedOrigins: string[], _opts: DriverOptions): Promise<boolean> {
        const adopted = this.pages.has(tabId) && this.targetIds.get(tabId) === targetId
        this.adoptedTabs.push({ tabId, targetId, adopted })
        return adopted
    }
    async navigate(tabId: TabId, url: string, _origins: string[], opts: DriverOptions): Promise<{ url: string; documentGeneration: number }> {
        await this.delay('navigate', opts); this.throwNextFailure('navigate'); const page = this.requirePage(tabId); page.url = url; page.documentGeneration = (page.documentGeneration ?? 0) + 1; this.record(tabId, `target-${tabId}`, 'navigate'); await this.afterDispatch('navigate'); return { url, documentGeneration: page.documentGeneration }
    }
    async observe(tabId: TabId, allowedOrigins: string[], opts: DriverOptions & { maxElements?: number; maxTextChars?: number; scopeRef?: ElementRef }): Promise<Observation> {
        await this.delay('observe', opts); this.throwNextFailure('observe'); const page = this.requirePage(tabId); const origin = new URL(page.url).origin
        const frames = (page.frameOrigins ?? []).map((frameOrigin, index) => ({ frameKey: `frame-${index}`, origin: frameOrigin, allowed: allowedOrigins.includes(frameOrigin), outOfProcess: false }))
        const elements = (page.elements ?? []).filter((element) => allowedOrigins.includes(element.frameOrigin)).slice(0, opts.maxElements ?? 100)
        const snapshotId = `snapshot-${randomUUID()}` as SnapshotId
        this.observeCount++
        this.activeSnapshots.set(tabId, snapshotId)
        this.snapshotGenerations.set(snapshotId, page.documentGeneration ?? 1)
        this.snapshotElements.set(snapshotId, new Map(elements.map((element) => [element.ref, structuredClone(element)])))
        return { snapshotId, tabId, url: page.url, title: page.title ?? '', documentGeneration: page.documentGeneration ?? 1, elements, frames, truncated: false, text: allowedOrigins.includes(origin) ? (page.text ?? '').slice(0, opts.maxTextChars ?? 20_000) : '' }
    }
    async describeRef(tabId: TabId, ref: ElementRef, snapshotId: SnapshotId, opts: DriverOptions): Promise<ElementDescription> {
        await this.delay('describeRef', opts)
        this.throwNextFailure('describeRef')
        const page = this.requirePage(tabId)
        const described = this.snapshotElements.get(snapshotId)?.get(ref)
        this.assertSnapshot(tabId, snapshotId, page.documentGeneration ?? 1, described)
        const currentElement = page.elements?.find((element) => element.ref === ref)
        if (!described || !currentElement || !sameNode(described, currentElement))
            throw new BrowserRuntimeError('STALE_REF', 'Reference node was replaced', false, false)
        const values = page.formValues ?? Object.fromEntries((page.elements ?? []).flatMap((element) =>
            element.value !== undefined && !/password/i.test(element.name) ? [[element.name, element.value]] : []))
        const formValues = Object.fromEntries(Object.entries(values).filter(([name]) => !/password/i.test(name)))
        return { ref, role: described.role, name: described.name, frameOrigin: described.frameOrigin,
            pageUrl: page.url, formAction: page.formAction ?? described.formAction,
            formValues: structuredClone(formValues), documentGeneration: page.documentGeneration ?? 1 }
    }
    async screenshot(tabId: TabId, allowedOrigins: string[], opts: DriverOptions): Promise<ScreenshotResult> {
        await this.delay('screenshot', opts); this.throwNextFailure('screenshot'); const page = this.requirePage(tabId); if ((page.frameOrigins ?? []).some((origin) => !allowedOrigins.includes(origin))) throw new BrowserRuntimeError('ORIGIN_DENIED', 'A frame origin is not allowed')
        return { tabId, mimeType: 'image/png', data: Buffer.from('synthetic').toString('base64'), documentGeneration: page.documentGeneration ?? 1, targetId: `target-${tabId}`, capturedAtMs: Date.now() }
    }
    async click(tabId: TabId, ref: ElementRef, snapshotId: SnapshotId, opts: DriverOptions): Promise<void> { await this.delay('click', opts); this.throwNextFailure('click'); const page = this.requirePage(tabId); const element = this.snapshotElements.get(snapshotId)?.get(ref); this.assertSnapshot(tabId, snapshotId, page.documentGeneration ?? 1, element); const current = page.elements?.find((candidate) => candidate.ref === ref); if (!current || !sameNode(element!, current)) throw new BrowserRuntimeError('STALE_REF', 'Reference node was replaced', false, false); this.dispatchedSnapshots.push({ tabId, snapshotId, operation: 'click' }); this.record(tabId, `target-${tabId}`, 'click'); await this.afterDispatch('click') }
    async fill(tabId: TabId, ref: ElementRef, snapshotId: SnapshotId, value: string, opts: DriverOptions): Promise<void> {
        await this.delay('fill', opts)
        this.throwNextFailure('fill')
        const page = this.requirePage(tabId)
        const element = this.snapshotElements.get(snapshotId)?.get(ref)
        this.assertSnapshot(tabId, snapshotId, page.documentGeneration ?? 1, element)
        const current = page.elements?.find((candidate) => candidate.ref === ref)
        if (!current || !sameNode(element!, current))
            throw new BrowserRuntimeError('STALE_REF', 'Reference node was replaced', false, false)
        const field = page.elements?.find((element) => element.ref === ref)
        if (field)
            field.value = value
        this.dispatchedSnapshots.push({ tabId, snapshotId, operation: 'fill' })
        this.record(tabId, `target-${tabId}`, 'fill')
        await this.afterDispatch('fill')
    }
    async waitFor(tabId: TabId, _predicate: WaitPredicate, _origins: string[], opts: DriverOptions): Promise<void> {
        if (!this.pages.has(tabId)) throw new BrowserRuntimeError('TARGET_GONE', 'Tab does not exist')
        this.notifyWaitEntered()
        this.record(tabId, `target-${tabId}`, 'waitFor')
        await this.afterDispatch('waitFor')
        this.throwNextFailure('waitFor')
        await new Promise<void>((resolve, reject) => {
            const release = () => { opts.signal?.removeEventListener('abort', abort); resolve() }
            const abort = () => { opts.signal?.removeEventListener('abort', abort); reject(opts.signal?.reason ?? new Error('aborted')) }
            this.waitRelease = release
            if (!this.ignoreWaitAbort) {
                opts.signal?.addEventListener('abort', abort, { once: true })
                if (opts.signal?.aborted) abort()
            }
            const timeout = this.delays.get('waitFor')
            if (timeout !== undefined) setTimeout(release, timeout)
        })
    }
    async currentOrigin(tabId: TabId): Promise<string> { return new URL(this.requirePage(tabId).url).origin }
    async close(): Promise<void> { this.pages.clear() }
    seedTab(tabId: TabId, page: FakePage): void { this.pages.set(tabId, structuredClone(page)) }

    private requirePage(tabId: TabId): FakePage { const page = this.pages.get(tabId); if (!page) throw new BrowserRuntimeError('TARGET_GONE', 'Tab does not exist'); return page }
    private throwNextFailure(operation: Operation): void {
        const failure = this.failures.get(operation)?.shift()
        if (failure)
            throw failure
    }
    private assertSnapshot(tabId: TabId, snapshotId: SnapshotId, currentGeneration: number, element?: ObservedElement): void {
        if (this.activeSnapshots.get(tabId) !== snapshotId || this.snapshotGenerations.get(snapshotId) !== currentGeneration || !element)
            throw new BrowserRuntimeError('STALE_REF', 'Reference snapshot is stale', false, false)
    }
    private async delay(operation: Operation, opts: DriverOptions): Promise<void> {
        const delay = this.delays.get(operation) ?? 0
        if (!delay) return
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, delay)
            opts.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(opts.signal?.reason ?? new Error('aborted')) }, { once: true })
        })
    }
    private record(tabId: TabId, targetId: string, operation: Operation): void {
        const actionId = this.currentActionId
        if (actionId && ['openTab', 'navigate', 'click', 'fill'].includes(operation)) {
            this.dispatchCounts.set(actionId, (this.dispatchCounts.get(actionId) ?? 0) + 1)
            this.dispatchObserver?.(actionId)
        }
        this.targetLedger.push({ targetId, tabId, operation, actionId })
        this.currentActionId = undefined
    }
    private async afterDispatch(operation: Operation): Promise<void> {
        const held = this.heldDispatch
        if (!held || held.operation !== operation)
            return
        this.heldDispatch = undefined
        held.entered()
        await held.gate
    }
}

function sameNode(left: ObservedElement, right: ObservedElement): boolean {
    return left.ref === right.ref && left.role === right.role && left.name === right.name
        && left.frameOrigin === right.frameOrigin
}
