import { randomUUID } from 'node:crypto'
import { BrowserRuntimeError, type BrowserDriver, type BrowserInstanceId, type DriverOptions, type DriverTabHandle, type ElementRef, type ObservedElement, type Observation, type ScreenshotResult, type SnapshotId, type TabId, type WaitPredicate } from '../contracts'

export interface FakePage { url: string; title?: string; text?: string; elements?: ObservedElement[]; documentGeneration?: number; frameOrigins?: string[] }
type Operation = 'openTab' | 'closeTab' | 'navigate' | 'observe' | 'screenshot' | 'click' | 'fill' | 'waitFor'
export class FakeBrowserDriver implements BrowserDriver {
    private instance = `browser-${randomUUID()}` as BrowserInstanceId
    private serial = 0
    private readonly pages = new Map<TabId, FakePage>()
    private currentActionId?: string
    readonly dispatchCounts = new Map<string, number>()
    readonly targetLedger: Array<{ targetId: string; tabId: TabId; operation: Operation; actionId?: string }> = []
    delays = new Map<Operation, number>()
    private readonly failures = new Map<Operation, Error[]>()
    private waitRelease?: () => void
    private notifyWaitEntered!: () => void
    readonly waitForEntered = new Promise<void>((resolve) => { this.notifyWaitEntered = resolve })

    browserInstanceId(): BrowserInstanceId { return this.instance }
    swapInstance(): BrowserInstanceId { return this.instance = `browser-${randomUUID()}` as BrowserInstanceId }
    armAction(actionId: string): void { this.currentActionId = actionId }
    setDelay(operation: Operation, ms: number): void { this.delays.set(operation, ms) }
    failNext(operation: Operation, error: Error): void {
        this.failures.set(operation, [...(this.failures.get(operation) ?? []), error])
    }
    releaseWait(): void { this.waitRelease?.(); this.waitRelease = undefined }
    waitUntilReleased(): Promise<void> { return new Promise((resolve) => { this.waitRelease = resolve }) }

    async openTab(url: string, _origins: string[], opts: DriverOptions): Promise<DriverTabHandle> {
        await this.delay('openTab', opts)
        const tabId = `tab-${++this.serial}` as TabId
        const targetId = `target-${this.serial}`
        this.pages.set(tabId, { url, title: 'Fixture', text: 'fixture ready', documentGeneration: 1, elements: [] })
        this.record(tabId, targetId, 'openTab')
        return { tabId, targetId }
    }
    async closeTab(tabId: TabId, opts: DriverOptions): Promise<{ closed: boolean; beforeUnloadBlocked?: boolean }> {
        await this.delay('closeTab', opts); const page = this.pages.get(tabId); if (!page) return { closed: false }
        this.pages.delete(tabId); this.record(tabId, `target-${tabId}`, 'closeTab'); return { closed: true }
    }
    hasTab(tabId: TabId): boolean { return this.pages.has(tabId) }
    async navigate(tabId: TabId, url: string, _origins: string[], opts: DriverOptions): Promise<{ url: string; documentGeneration: number }> {
        await this.delay('navigate', opts); const page = this.requirePage(tabId); page.url = url; page.documentGeneration = (page.documentGeneration ?? 0) + 1; this.record(tabId, `target-${tabId}`, 'navigate'); return { url, documentGeneration: page.documentGeneration }
    }
    async observe(tabId: TabId, allowedOrigins: string[], opts: DriverOptions & { maxElements?: number; maxTextChars?: number; scopeRef?: ElementRef }): Promise<Observation> {
        await this.delay('observe', opts); const page = this.requirePage(tabId); const origin = new URL(page.url).origin
        const frames = (page.frameOrigins ?? []).map((frameOrigin, index) => ({ frameKey: `frame-${index}`, origin: frameOrigin, allowed: allowedOrigins.includes(frameOrigin), outOfProcess: false }))
        const elements = (page.elements ?? []).filter((element) => allowedOrigins.includes(element.frameOrigin)).slice(0, opts.maxElements ?? 100)
        return { snapshotId: `snapshot-${randomUUID()}` as SnapshotId, tabId, url: page.url, title: page.title ?? '', documentGeneration: page.documentGeneration ?? 1, elements, frames, truncated: false, text: allowedOrigins.includes(origin) ? (page.text ?? '').slice(0, opts.maxTextChars ?? 20_000) : '' }
    }
    async screenshot(tabId: TabId, allowedOrigins: string[], opts: DriverOptions): Promise<ScreenshotResult> {
        await this.delay('screenshot', opts); const page = this.requirePage(tabId); if ((page.frameOrigins ?? []).some((origin) => !allowedOrigins.includes(origin))) throw new BrowserRuntimeError('ORIGIN_DENIED', 'A frame origin is not allowed')
        return { tabId, mimeType: 'image/png', data: Buffer.from('synthetic').toString('base64'), documentGeneration: page.documentGeneration ?? 1, targetId: `target-${tabId}`, capturedAtMs: Date.now() }
    }
    async click(tabId: TabId, _ref: ElementRef, _snapshotId: SnapshotId, opts: DriverOptions): Promise<void> { await this.delay('click', opts); this.requirePage(tabId); this.record(tabId, `target-${tabId}`, 'click') }
    async fill(tabId: TabId, _ref: ElementRef, _snapshotId: SnapshotId, _value: string, opts: DriverOptions): Promise<void> { await this.delay('fill', opts); this.requirePage(tabId); this.record(tabId, `target-${tabId}`, 'fill') }
    async waitFor(tabId: TabId, _predicate: WaitPredicate, _origins: string[], opts: DriverOptions): Promise<void> {
        if (!this.pages.has(tabId)) throw new BrowserRuntimeError('TARGET_GONE', 'Tab does not exist')
        this.notifyWaitEntered()
        this.record(tabId, `target-${tabId}`, 'waitFor')
        const failure = this.failures.get('waitFor')?.shift()
        if (failure) throw failure
        await new Promise<void>((resolve, reject) => {
            const release = () => { opts.signal?.removeEventListener('abort', abort); resolve() }
            const abort = () => { opts.signal?.removeEventListener('abort', abort); reject(opts.signal?.reason ?? new Error('aborted')) }
            this.waitRelease = release
            opts.signal?.addEventListener('abort', abort, { once: true })
            if (opts.signal?.aborted) abort()
            const timeout = this.delays.get('waitFor')
            if (timeout !== undefined) setTimeout(release, timeout)
        })
    }
    async currentOrigin(tabId: TabId): Promise<string> { return new URL(this.requirePage(tabId).url).origin }
    async close(): Promise<void> { this.pages.clear() }
    seedTab(tabId: TabId, page: FakePage): void { this.pages.set(tabId, structuredClone(page)) }

    private requirePage(tabId: TabId): FakePage { const page = this.pages.get(tabId); if (!page) throw new BrowserRuntimeError('TARGET_GONE', 'Tab does not exist'); return page }
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
        if (actionId && ['openTab', 'navigate', 'click', 'fill'].includes(operation)) this.dispatchCounts.set(actionId, (this.dispatchCounts.get(actionId) ?? 0) + 1)
        this.targetLedger.push({ targetId, tabId, operation, actionId })
        this.currentActionId = undefined
    }
}
