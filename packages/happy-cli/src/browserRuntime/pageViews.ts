/** Ephemeral human view sessions, serialized input receipts and lease drain. Task durability stays in Runtime. */
import { createHash, randomUUID } from 'node:crypto'
import { BrowserRuntimeError, type AuthContext, type InteractiveCapability, type Operation, type ProfileId, type TabId, type TaskId } from './contracts'
import type { InputLeaseManager } from './inputLease'
import { pageInputSchema, type InputReceipt, type PageImage, type PageInputRequest, type PageViewOpen, type PageViewRequest, type PageViewDriver, type PageViewStatus, type PageViewApi } from './pageViewContracts'
import type { StoredTask } from './taskStore'

interface Host {
    now(): number
    binding(profileId: ProfileId): string
    authorize(auth: AuthContext, operation: Operation, taskId: TaskId): Promise<void>
    validate(auth: AuthContext, operation: Operation, taskId: TaskId): void
    task(taskId: TaskId): StoredTask
    driver(profileId: ProfileId): PageViewDriver | undefined
    leases: InputLeaseManager
    /** Persists only an opaque action identifier and safety state, never event contents. */
    journal(taskId: TaskId, actionId: string, state: 'intent' | 'applied' | 'rejected' | 'unknown' | 'drained'): Promise<void>
}
interface View {
    id: string; auth: AuthContext; identity: string; binding: string; profileId: ProfileId; taskId: TaskId; tabId: TabId
    expiresAtMs: number; closed: boolean; unknown: boolean; draining?: Promise<void>; pending?: Promise<InputReceipt>
    accepted: number; settled: number; receipts: Map<number, { hash: string; receipt: InputReceipt }>
    frame?: PageImage & { frameId: string }; lastRequest: number; lastSeen: number; activeInput: boolean
}
function fail(code: 'SCOPE_DENIED' | 'CONFLICT' | 'STALE_REF' | 'STALE_LEASE' | 'UNAUTHORIZED' | 'QUOTA_EXCEEDED', message: string): never { throw new BrowserRuntimeError(code, message) }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function identity(c: InteractiveCapability): string {
    return JSON.stringify([c.principalId, c.workspaceId, c.machineId, c.profileId, c.viewerSessionId, c.pageViewScope])
}

export class PageViews {
    private readonly views = new Map<string, View>()
    private readonly captures = new Map<ProfileId, Promise<unknown>>()
    private readonly budgets = new Map<ProfileId, { at: number; bytes: number; quality: number; dimension: number }>()
    constructor(private readonly host: Host) {
        host.leases.subscribe(() => {
            for (const view of this.views.values()) {
                if (!view.activeInput || view.closed) continue
                const { owner } = host.leases.owner(view.tabId, view.profileId)
                const c = view.auth.credential as InteractiveCapability
                if (owner.kind !== 'user' || owner.viewerSessionId !== c.viewerSessionId || owner.principalId !== c.principalId)
                    void this.drain(view).catch(() => {}) // journal/fence retain failure; never enables input
            }
        })
    }
    async open(auth: AuthContext, req: PageViewOpen) {
        await this.host.authorize(auth, 'openPageView', req.taskId)
        const c = auth.credential as InteractiveCapability
        if (!c.pageViewScope || req.agentSessionId !== c.pageViewScope.agentSessionId || req.runtimeBindingId !== this.host.binding(c.profileId)
            || req.runtimeBindingId !== c.pageViewScope.runtimeBindingId) fail('SCOPE_DENIED', 'Page view binding changed')
        const task = this.host.task(req.taskId)
        if (!task.tabs.includes(req.tabId) || ['succeeded', 'failed', 'cancelled'].includes(task.status)) fail('SCOPE_DENIED', 'Task page is not open')
        if (!this.host.driver(c.profileId)) throw new BrowserRuntimeError('UNSUPPORTED_OPERATION', 'Page viewer is unavailable')
        for (const view of this.views.values()) {
            if (!view.closed && view.identity === identity(c)) await this.drain(view)
        }
        this.host.validate(auth, 'openPageView', req.taskId)
        this.prune()
        if ([...this.views.values()].filter(v => v.profileId === c.profileId && !v.closed).length >= 2
            || [...this.views.values()].filter(v => v.profileId === c.profileId).length >= 64) fail('QUOTA_EXCEEDED', 'Page view limit reached')
        const view: View = { id: randomUUID(), auth, identity: identity(c), binding: req.runtimeBindingId, profileId: c.profileId,
            taskId: req.taskId, tabId: req.tabId, expiresAtMs: c.expiresAtMs, closed: false, unknown: false, accepted: 0, settled: 0,
            receipts: new Map(), lastRequest: -Infinity, lastSeen: this.host.now(), activeInput: false }
        this.views.set(view.id, view)
        return { schemaVersion: 1 as const, viewId: view.id, expiresAtMs: view.expiresAtMs, input: true }
    }
    async frame(auth: AuthContext, req: PageViewRequest & { statusOnly?: boolean }): ReturnType<PageViewApi['getPageFrame']> {
        const view = await this.get(auth, 'getPageFrame', req.viewId)
        if (req.statusOnly || view.closed) return { schemaVersion: 1 as const, status: this.status(view) }
        if (this.captures.has(view.profileId)) fail('CONFLICT', 'A page capture is still running')
        const now = this.host.now()
        const control = this.host.leases.userControl(view.profileId)
        const interval = control.tabs.some(t => t.tabId === view.tabId) && !control.settling ? 200 : 500
        const budget = this.budgets.get(view.profileId) ?? { at: now, bytes: 0, quality: 55, dimension: 1280 }
        if (now - budget.at >= 1000) { budget.at = now; budget.bytes = 0 }
        if (now - view.lastRequest < interval || budget.bytes >= 500 * 1024) fail('QUOTA_EXCEEDED', 'Page capture rate limited')
        view.lastRequest = now
        this.budgets.set(view.profileId, budget)
        const capture = this.host.driver(view.profileId)!.capture(view.tabId,
            () => this.validate(view, auth, 'getPageFrame'), budget.quality, budget.dimension)
        this.captures.set(view.profileId, capture)
        let frame: PageImage
        try { frame = await capture } finally { if (this.captures.get(view.profileId) === capture) this.captures.delete(view.profileId) }
        this.validate(view, auth, 'getPageFrame')
        const next = { ...frame, frameId: randomUUID() }
        const result = { schemaVersion: 1 as const, status: this.status(view), frame: { ...next, ageMs: Math.max(0, this.host.now() - frame.capturedAtMs) } }
        const bytes = Buffer.byteLength(JSON.stringify({ ok: true, result }))
        if (bytes > 100 * 1024) { budget.quality = Math.max(30, budget.quality - 5); budget.dimension = Math.max(800, budget.dimension - 80) }
        if (bytes > 1024 * 1024 || budget.bytes + bytes > 500 * 1024) fail('QUOTA_EXCEEDED', 'Page image exceeds response budget')
        budget.bytes += bytes
        view.frame = next
        return result
    }
    async input(auth: AuthContext, req: PageInputRequest): Promise<InputReceipt> {
        const view = await this.get(auth, 'dispatchPageInput', req.viewId)
        const hash = digest(req)
        const old = view.receipts.get(req.sequence)
        if (old) {
            if (old.hash !== hash) fail('CONFLICT', 'Input sequence already used')
            return { ...old.receipt }
        }
        if (!pageInputSchema.safeParse(req.event).success || Buffer.byteLength(JSON.stringify(req)) > 8192) fail('CONFLICT', 'Invalid page input')
        if (view.pending || req.sequence !== view.accepted + 1) fail('CONFLICT', 'Input must be serialized')
        if (!view.frame || view.frame.frameId !== req.frameId || this.host.now() - view.frame.capturedAtMs > 3000) fail('STALE_REF', 'Page frame is stale')
        this.assertControl(view, auth, req.leaseEpoch)
        const frame = view.frame
        const receipt: InputReceipt = { sequence: req.sequence, state: 'pending' }
        view.accepted = req.sequence
        view.receipts.set(req.sequence, { hash, receipt })
        const actionId = `page-input-${view.id}-${req.sequence}`
        const operation = (async (): Promise<InputReceipt> => {
            let sent = false
            try {
                await this.host.journal(view.taskId, actionId, 'intent')
                view.activeInput = true
                await this.host.driver(view.profileId)!.input(view.tabId, frame, req.event, () => {
                    this.assertControl(view, auth, req.leaseEpoch)
                    sent = true
                })
                await this.host.journal(view.taskId, actionId, 'applied')
                receipt.state = 'applied'
            } catch (error) {
                const unknown = sent || error instanceof BrowserRuntimeError && error.mayHaveSideEffects
                receipt.state = unknown ? 'unknown' : 'rejected'
                if (unknown) view.unknown = true
                try { await this.host.journal(view.taskId, actionId, unknown ? 'unknown' : 'rejected') }
                catch { view.unknown = true; receipt.state = 'unknown' }
                if (view.unknown) void this.drain(view).catch(() => {})
            } finally {
                view.settled = req.sequence
                while (view.receipts.size > 64) view.receipts.delete(view.receipts.keys().next().value!)
            }
            return { ...receipt }
        })()
        view.pending = operation
        try { return await operation } finally { if (view.pending === operation) view.pending = undefined }
    }
    async close(auth: AuthContext, req: PageViewRequest) {
        const view = await this.get(auth, 'closePageView', req.viewId)
        await this.drain(view)
        return this.status(view)
    }
    async drainTask(taskId: TaskId): Promise<void> {
        await Promise.all([...this.views.values()].filter(v => v.taskId === taskId).map(v => this.drain(v)))
    }
    revoke(capabilityId: string): void {
        for (const view of this.views.values()) if ((view.auth.credential as InteractiveCapability).capabilityId === capabilityId)
            void this.drain(view).catch(() => {})
    }
    sweep(): void {
        for (const view of this.views.values()) {
            if (view.closed) continue
            let valid = true
            try { this.validate(view, view.auth, 'getPageFrame') } catch { valid = false }
            if (!valid || this.host.now() - view.lastSeen > 10_000) void this.drain(view).catch(() => {})
        }
        this.prune()
    }
    private prune(): void {
        for (const [id, view] of this.views) if (view.closed && !view.pending && !view.draining && !view.unknown && this.host.now() >= view.expiresAtMs + 60_000) this.views.delete(id)
    }
    private async get(auth: AuthContext, op: Operation, id: string): Promise<View> {
        const view = this.views.get(id)
        if (!view || auth.credential.kind !== 'interactive' || view.identity !== identity(auth.credential)) fail('SCOPE_DENIED', 'Page view scope does not match')
        await this.host.authorize(auth, op, view.taskId)
        if (view.binding !== this.host.binding(view.profileId) || this.host.now() >= view.expiresAtMs) {
            void this.drain(view).catch(() => {})
            fail('UNAUTHORIZED', 'Page view expired or replaced')
        }
        view.lastSeen = this.host.now()
        return view
    }
    private validate(view: View, auth: AuthContext, operation: Operation): void {
        this.host.validate(auth, operation, view.taskId)
        const task = this.host.task(view.taskId)
        if (view.closed || view.unknown || this.host.now() >= view.expiresAtMs || view.binding !== this.host.binding(view.profileId)
            || !task.tabs.includes(view.tabId) || ['succeeded', 'failed', 'cancelled'].includes(task.status)) fail('SCOPE_DENIED', 'Page view is no longer live')
    }
    private assertControl(view: View, auth: AuthContext, epoch: number): void {
        this.validate(view, auth, 'dispatchPageInput')
        const lease = this.host.leases.owner(view.tabId, view.profileId)
        const c = auth.credential as InteractiveCapability
        if (view.draining || this.host.task(view.taskId).uncertainActions.length || this.host.leases.userControl(view.profileId).settling
            || lease.leaseEpoch !== epoch || lease.owner.kind !== 'user' || lease.owner.principalId !== c.principalId || lease.owner.viewerSessionId !== c.viewerSessionId)
            fail('STALE_LEASE', 'Page input requires settled user control')
    }
    private status(view: View): PageViewStatus {
        return { closed: view.closed, draining: !!view.draining, unknown: view.unknown, lastAccepted: view.accepted,
            lastSettled: view.settled, receipts: [...view.receipts.values()].map(v => ({ ...v.receipt })) }
    }
    private drain(view: View): Promise<void> {
        if (view.draining) return view.draining
        if (view.closed && (!view.activeInput || view.unknown)) return Promise.resolve()
        view.closed = true // synchronous admission fence, before any await or lease notification
        view.frame = undefined
        const releaseFence = this.host.leases.fenceProfile(view.profileId)
        const drain = (async () => {
            try {
                await view.pending
                if (view.activeInput) {
                    if (view.binding !== this.host.binding(view.profileId)) throw new Error('Page binding changed before release')
                    await this.host.driver(view.profileId)!.release(view.tabId)
                    if (!view.unknown) await this.host.journal(view.taskId, `page-drain-${view.id}`, 'drained')
                }
                view.activeInput = false
                if (!view.unknown) releaseFence()
            } catch {
                view.unknown = true
                await this.host.journal(view.taskId, `page-drain-${view.id}`, 'unknown')
            }
        })()
        view.draining = drain
        return drain.finally(() => { if (view.draining === drain) view.draining = undefined })
    }
}
