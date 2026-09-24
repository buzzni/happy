import { randomUUID } from 'node:crypto'
import { BrowserRuntimeError, POC_LIMITS, SCHEMA_VERSION, type ActionId, type AgentGrant, type AuthContext, type BatchResult, type BatchStep, type BrowserDriver, type BrowserRuntimeApi, type BrowserRuntimeError as RuntimeError, type InputOwner, type Operation, type ProfileId, type TaskEvent, type TaskId, type TaskSpaceId, type TaskView, type TabId, type ApprovalId } from './contracts'
import { assertOperation } from './auth'
import { systemClock, type RuntimeClock } from './clock'
import { InputLeaseManager } from './inputLease'
import { approvalBinding, assertAllowedOrigin, classifyAction, payloadHash, redact } from './policy'
import { TaskStore, type StoredTask, type StoreEventInput } from './taskStore'
import { transitionTask } from './stateMachine'

export interface BrowserRuntimeOptions { store: TaskStore; drivers: Map<ProfileId, BrowserDriver> | Record<string, BrowserDriver>; clock?: RuntimeClock }
type DriverWithAction = BrowserDriver & { armAction?: (actionId: string) => void }

/** Durable, scoped task runtime. Driver awaits never hold the task commit queue. */
export class BrowserRuntime implements BrowserRuntimeApi {
    readonly leases = new InputLeaseManager()
    private readonly drivers: Map<ProfileId, BrowserDriver>
    private readonly clock: RuntimeClock
    private readonly controllers = new Map<TaskId, AbortController>()
    private readonly workers = new Map<TaskId, Promise<BatchResult>>()
    private readonly commitTails = new Map<TaskId, Promise<unknown>>()
    private readonly recovery: Promise<void>

    constructor(private readonly options: BrowserRuntimeOptions) {
        this.drivers = options.drivers instanceof Map ? options.drivers : new Map(Object.entries(options.drivers) as [ProfileId, BrowserDriver][])
        this.clock = options.clock ?? systemClock
        this.recovery = this.recoverExistingTasks()
    }

    async createSpace(auth: AuthContext, req: { profileId: ProfileId; requestId: import('./contracts').RequestId }): Promise<{ taskSpaceId: TaskSpaceId }> {
        await this.recovery
        this.checkCredential(auth, 'createSpace', req.profileId)
        const requestKeyValue = requestKey(auth, req.requestId)
        const existing = this.options.store.listSpaces().find((space) => space.requestKey === requestKeyValue)
        if (existing) {
            if (existing.requestHash !== payloadHash({ operation: 'createSpace', ...req })) throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input')
            return { taskSpaceId: existing.taskSpaceId }
        }
        const taskSpaceId = `space-${randomUUID()}` as TaskSpaceId
        await this.options.store.createSpace({ taskSpaceId, profileId: req.profileId, createdAtMs: this.clock.now(), tabs: [], owner: identity(auth), requestKey: requestKeyValue, requestHash: payloadHash({ operation: 'createSpace', ...req }), dedupe: {} } as never)
        return { taskSpaceId }
    }

    async createTask(auth: AuthContext, req: { taskSpaceId: TaskSpaceId; requestId: import('./contracts').RequestId }): Promise<TaskView> {
        await this.recovery
        const space = this.requireSpace(req.taskSpaceId)
        this.checkCredential(auth, 'createTask', space.profileId, req.taskSpaceId)
        this.authorizeSpace(auth, space)
        const duplicate = this.findRequest(req.requestId, auth)
        if (duplicate) { if (duplicate.hash !== payloadHash({ operation: 'createTask', ...req })) throw new BrowserRuntimeError('CONFLICT', 'requestId payload differs'); return this.view(duplicate.result as StoredTask) }
        const now = this.clock.now(); const taskId = `task-${randomUUID()}` as TaskId
        const credential = auth.credential as AgentGrant
        const task: StoredTask = { schemaVersion: SCHEMA_VERSION, taskId, taskSpaceId: req.taskSpaceId, profileId: space.profileId, agentSessionId: credential.agentSessionId, status: 'queued', cancelRequested: false, stateVersion: 0, highWatermarkSeq: 0, tabs: [], uncertainActions: [], createdAtMs: now, updatedAtMs: now, owner: identity(auth), agentGrant: credential, actions: {}, approvals: {}, batches: {}, dedupe: {}, browserInstanceId: this.driver(space.profileId).browserInstanceId() }
        const saved = await this.options.store.createTask(task, this.event('task-created', { taskSpaceId: req.taskSpaceId }, 0))
        const stored = await this.saveRequest(saved, auth, req.requestId, { operation: 'createTask', ...req }, this.view(saved))
        return this.view(stored)
    }

    async openPage(auth: AuthContext, req: { taskId: TaskId; url: string; requestId: import('./contracts').RequestId }): Promise<{ tabId: TabId; actionId: ActionId; url: string; task: TaskView }> {
        await this.recovery
        const task = this.requireTask(req.taskId); this.authorizeTask(auth, 'openPage', task)
        const duplicate = this.taskRequest(task, auth, req.requestId, { operation: 'openPage', ...req })
        if (duplicate) return duplicate as { tabId: TabId; actionId: ActionId; url: string; task: TaskView }
        this.assertCanStart(task)
        if (this.clock.now() - task.createdAtMs >= POC_LIMITS.taskTimeLimitMs) { await this.commit(task, { status: 'paused', pauseReason: 'task-time-limit' }, 'state-changed', { pauseReason: 'task-time-limit' }); throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'Task time limit reached') }
        const grant = this.agentGrant(auth); const origin = assertAllowedOrigin(req.url, grant); const driver = this.driver(task.profileId)
        const totalTabs = this.options.store.listSpaces(task.profileId).reduce((sum, item) => sum + item.tabs.length, 0)
        if (totalTabs >= POC_LIMITS.maxActiveTabs) throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'Profile has reached its active tab limit')
        const actionId = `action-${randomUUID()}` as ActionId; const reservation = this.allocateTabId(); const epoch = this.leases.acquire(reservation, task.profileId, { kind: 'agent', agentSessionId: task.agentSessionId, taskId: task.taskId, segmentId: actionId })
        const running = transitionTask({ status: task.status, pauseReason: task.pauseReason }, { type: 'start' })
        await this.commit(task, { ...running, currentBatchId: undefined, actions: { ...task.actions, [actionId]: { state: 'intent-committed', payloadHash: payloadHash({ url: req.url }), leaseEpoch: epoch, browserInstanceId: driver.browserInstanceId() } } }, 'action-intent', { actionId, kind: 'navigate', url: redact(req.url), phase: 'intent-committed' }, epoch)
        const controller = new AbortController(); this.controllers.set(task.taskId, controller)
        ;(driver as DriverWithAction).armAction?.(actionId)
        this.leases.assert(reservation, task.profileId, task.taskId, actionId, epoch)
        let handle: Awaited<ReturnType<BrowserDriver['openTab']>>
        try { handle = await driver.openTab(req.url, grant.allowedOrigins, { signal: controller.signal, timeoutMs: 30_000 }) }
        catch (error) {
            this.leases.release(reservation, task.profileId)
            const current = this.requireTask(task.taskId)
            if (!current.cancelRequested) await this.commit(current, { status: 'paused', pauseReason: 'outcome-unknown', actions: { ...current.actions, [actionId]: { ...current.actions[actionId], state: 'uncertain' } }, uncertainActions: [...current.uncertainActions, actionId] }, 'action-uncertain', { actionId, error: safeError(error) }, epoch)
            throw new BrowserRuntimeError('OUTCOME_UNKNOWN', 'Page open result is uncertain', false, true)
        }
        const afterOpenTask = this.requireTask(task.taskId)
        const leaseAfterOpen = this.leases.owner(reservation, task.profileId)
        const browserChanged = afterOpenTask.browserInstanceId !== driver.browserInstanceId()
        if (afterOpenTask.cancelRequested || !this.isCredentialLive(auth) || leaseAfterOpen.leaseEpoch !== epoch || afterOpenTask.status !== 'running' || browserChanged) {
            await driver.closeTab(handle.tabId, { timeoutMs: 5000 }).catch(() => undefined)
            if (leaseAfterOpen.owner.kind === 'agent' && leaseAfterOpen.owner.taskId === task.taskId) this.leases.release(reservation, task.profileId)
            const actions = { ...afterOpenTask.actions, [actionId]: { ...afterOpenTask.actions[actionId], state: 'uncertain' } }
            await this.commit(afterOpenTask, { actions, uncertainActions: [...new Set([...afterOpenTask.uncertainActions, actionId])], ...(!this.isCredentialLive(auth) && !afterOpenTask.cancelRequested ? { status: 'paused', pauseReason: 'grant-expired' } : browserChanged ? { status: 'paused', pauseReason: 'browser-replaced' } : {}) }, 'late-result', { actionId, lateOpen: true, browserChanged }, epoch)
            throw new BrowserRuntimeError('OUTCOME_UNKNOWN', 'Page open completed after its execution fence changed', false, true)
        }
        const finalOrigin = await driver.currentOrigin(handle.tabId)
        if (!grant.allowedOrigins.includes(finalOrigin)) {
            await driver.closeTab(handle.tabId, { timeoutMs: 5000 }); this.leases.release(reservation, task.profileId)
            const current = this.requireTask(task.taskId)
            await this.commit(current, { status: 'failed', actions: { ...current.actions, [actionId]: { ...current.actions[actionId], state: 'failed' } } }, 'action-failed', { actionId, code: 'ORIGIN_DENIED' }, epoch)
            throw new BrowserRuntimeError('ORIGIN_DENIED', 'Navigation ended at a disallowed origin')
        }
        this.leases.release(reservation, task.profileId)
        const dispatched = this.requireTask(task.taskId)
        await this.commit(dispatched, { actions: { ...dispatched.actions, [actionId]: { ...dispatched.actions[actionId], state: 'dispatched' } } }, 'action-dispatched', { actionId }, epoch)
        const tabEpoch = this.leases.acquire(handle.tabId, task.profileId, { kind: 'agent', agentSessionId: task.agentSessionId, taskId: task.taskId, segmentId: actionId })
        const next = this.requireTask(task.taskId)
        const after = await this.commit(next, { tabs: [...next.tabs, handle.tabId], status: 'paused', pauseReason: 'awaiting-agent', browserInstanceId: driver.browserInstanceId(), actions: { ...next.actions, [actionId]: { ...next.actions[actionId], state: 'confirmed' } } }, 'page-opened', { tabId: handle.tabId, actionId, origin: finalOrigin }, tabEpoch)
        if (this.controllers.get(task.taskId) === controller) this.controllers.delete(task.taskId)
        const space = this.requireSpace(task.taskSpaceId)
        await this.options.store.updateSpace(task.taskSpaceId, { tabs: [...space.tabs, handle.tabId] })
        const result = { tabId: handle.tabId, actionId, url: redact(req.url), task: this.view(after) }
        await this.saveTaskRequest(after, auth, req.requestId, { operation: 'openPage', ...req }, result)
        this.leases.release(handle.tabId, task.profileId)
        return result
    }

    async closePage(auth: AuthContext, req: { taskSpaceId: TaskSpaceId; tabId: TabId; requestId: import('./contracts').RequestId }): Promise<{ closed: boolean; handoff?: 'beforeunload' }> {
        await this.recovery
        const space = this.requireSpace(req.taskSpaceId); this.checkCredential(auth, 'closePage', space.profileId, req.taskSpaceId); this.authorizeSpace(auth, space)
        const duplicate = this.spaceRequest(space, auth, req.requestId, { operation: 'closePage', ...req })
        if (duplicate) return duplicate as { closed: boolean; handoff?: 'beforeunload' }
        const refs = this.options.store.listTasks().filter((task) => task.tabs.includes(req.tabId) && (!['succeeded', 'failed', 'cancelled'].includes(task.status) || this.workers.has(task.taskId)))
        if (refs.length) throw new BrowserRuntimeError('CONFLICT', 'Tab is referenced by a non-terminal task')
        const lease = this.leases.owner(req.tabId, space.profileId)
        if (lease.owner.kind !== 'none') throw new BrowserRuntimeError('STALE_LEASE', 'Tab has an input owner')
        const result = await this.driver(space.profileId).closeTab(req.tabId, { timeoutMs: 5000 })
        if (result.beforeUnloadBlocked) return { closed: false, handoff: 'beforeunload' }
        const response = { closed: result.closed }
        await this.options.store.updateSpace(req.taskSpaceId, { tabs: space.tabs.filter((tab) => tab !== req.tabId), dedupe: this.spaceDedupe(space, auth, req.requestId, { operation: 'closePage', ...req }, response) })
        return response
    }

    async observe(auth: AuthContext, req: { taskId: TaskId; tabId: TabId; maxElements?: number; scopeRef?: import('./contracts').ElementRef }): Promise<import('./contracts').Observation> {
        await this.recovery
        const task = this.requireTask(req.taskId); this.authorizeTask(auth, 'observe', task); this.assertTaskTab(task, req.tabId)
        const result = await this.driver(task.profileId).observe(req.tabId, this.agentGrant(auth).allowedOrigins, { timeoutMs: 30_000, maxElements: req.maxElements, scopeRef: req.scopeRef })
        if (!this.agentGrant(auth).allowedOrigins.includes(new URL(result.url).origin)) throw new BrowserRuntimeError('ORIGIN_DENIED', 'Observed page origin is not allowed')
        return sanitizeObservation(result, this.agentGrant(auth).allowedOrigins)
    }

    async screenshot(auth: AuthContext, req: { taskId: TaskId; tabId: TabId }): Promise<import('./contracts').ScreenshotResult> {
        await this.recovery
        const task = this.requireTask(req.taskId); this.authorizeTask(auth, 'screenshot', task); this.assertTaskTab(task, req.tabId)
        return this.driver(task.profileId).screenshot(req.tabId, this.agentGrant(auth).allowedOrigins, { timeoutMs: 30_000 })
    }

    async submitBatch(auth: AuthContext, req: { taskId: TaskId; expectedVersion: number; requestId: import('./contracts').RequestId; steps: BatchStep[] }, opts?: { waitMs?: number }): Promise<{ batchId: import('./contracts').BatchId; accepted: true; task: TaskView; result?: BatchResult }> {
        await this.recovery
        const task = this.requireTask(req.taskId); this.authorizeTask(auth, 'submitBatch', task)
        const duplicate = this.taskRequest(task, auth, req.requestId, { operation: 'submitBatch', ...req })
        if (duplicate) return duplicate as { batchId: import('./contracts').BatchId; accepted: true; task: TaskView; result?: BatchResult }
        if (task.stateVersion !== req.expectedVersion) throw new BrowserRuntimeError('CONFLICT', 'Task version changed')
        this.assertCanStart(task)
        if (this.clock.now() - task.createdAtMs >= POC_LIMITS.taskTimeLimitMs) { await this.commit(task, { status: 'paused', pauseReason: 'task-time-limit' }, 'state-changed', { pauseReason: 'task-time-limit' }); throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'Task time limit reached') }
        if (!req.steps.length || req.steps.length > POC_LIMITS.maxBatchSteps) throw new BrowserRuntimeError('INVALID_REQUEST', 'Batch size is invalid')
        const ids = new Set<string>(); for (const step of req.steps) { if (ids.has(step.actionId)) throw new BrowserRuntimeError('CONFLICT', 'actionId repeats in batch'); ids.add(step.actionId); const prior = task.actions[step.actionId]; if (prior && prior.payloadHash !== payloadHash(step)) throw new BrowserRuntimeError('CONFLICT', 'actionId was reused with different input'); if (!task.tabs.includes(step.tabId)) throw new BrowserRuntimeError('SCOPE_DENIED', 'Step tab does not belong to task'); if (step.timeoutMs <= 0 || step.timeoutMs > (step.kind === 'waitFor' ? POC_LIMITS.maxWaitForTimeoutMs : POC_LIMITS.maxStepTimeoutMs)) throw new BrowserRuntimeError('INVALID_REQUEST', 'Step timeout is outside the allowed range') }
        const batchId = `batch-${randomUUID()}` as import('./contracts').BatchId
        const next = transitionTask({ status: task.status, pauseReason: task.pauseReason }, { type: 'start' })
        const predictedTask = this.view({ ...task, ...next, currentBatchId: batchId, pauseReason: undefined, waitReason: undefined, stateVersion: task.stateVersion + 1, highWatermarkSeq: task.highWatermarkSeq + 1, updatedAtMs: this.clock.now() } as StoredTask)
        const dedupe = { ...task.dedupe, [requestKey(auth, req.requestId)]: { hash: payloadHash({ operation: 'submitBatch', ...req }), result: { batchId, accepted: true, task: predictedTask } } }
        let accepted: StoredTask
        try { accepted = await this.commit(task, { ...next, currentBatchId: batchId, pauseReason: undefined, waitReason: undefined, dedupe, batches: { ...task.batches, [batchId]: { steps: redact(req.steps), nextStep: 0, result: undefined } } }, 'batch-accepted', { batchId, stepCount: req.steps.length }, 0, true) }
        catch (error) {
            if (error instanceof BrowserRuntimeError && error.code === 'QUOTA_EXCEEDED') await this.commit(this.requireTask(task.taskId), { status: 'paused', pauseReason: 'quota' }, 'state-changed', { status: 'paused', pauseReason: 'quota' })
            throw error
        }
        let resultPromise: Promise<BatchResult>
        resultPromise = this.runBatch(accepted, batchId, req.steps, auth).catch(async (error) => {
            if (error instanceof BrowserRuntimeError && error.code === 'JOURNAL_UNAVAILABLE') throw error
            let current = this.requireTask(task.taskId)
            if (current.status === 'running') {
                const unresolved = Object.entries(current.actions).filter(([, action]) => action.batchId === batchId && ['navigate', 'click', 'fill'].includes(String(action.kind)) && ['intent-committed', 'dispatched'].includes(String(action.state)))
                const uncertainActions = unresolved.map(([id]) => id as ActionId)
                const actions = { ...current.actions }; for (const [id, action] of unresolved) actions[id] = { ...action, state: 'uncertain' }
                current = await this.commit(current, { status: 'paused', pauseReason: uncertainActions.length ? 'outcome-unknown' : 'awaiting-agent', actions, ...(uncertainActions.length ? { uncertainActions: [...new Set([...current.uncertainActions, ...uncertainActions])] } : {}) }, uncertainActions.length ? 'action-uncertain' : 'action-failed', { batchId, error: safeError(error) })
            }
            const uncertain = current.pauseReason === 'outcome-unknown'
            return this.saveBatchResult(current, batchId, { batchId, taskId: current.taskId, outcome: uncertain ? 'uncertain' : 'failed', completedSteps: [], mayHaveSideEffects: uncertain, lastCheckpointSeq: current.highWatermarkSeq + 1, steps: [{ stepId: req.steps[0].stepId, actionId: req.steps[0].actionId, outcome: uncertain ? 'uncertain' : 'failed', error: safeError(error) }] })
        }).finally(() => { if (this.workers.get(task.taskId) === resultPromise) this.workers.delete(task.taskId) })
        void resultPromise.catch(() => undefined)
        this.workers.set(task.taskId, resultPromise)
        const waitMs = Math.max(0, opts?.waitMs ?? 0)
        if (!waitMs) return { batchId, accepted: true, task: this.view(accepted) }
        const result = await Promise.race([resultPromise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), waitMs))])
        return { batchId, accepted: true, task: await this.getTask(auth, { taskId: task.taskId }), ...(result ? { result } : {}) }
    }

    async finishTask(auth: AuthContext, req: { taskId: TaskId; expectedVersion: number; requestId: import('./contracts').RequestId }): Promise<TaskView> {
        await this.recovery
        const task = this.requireTask(req.taskId); this.authorizeTask(auth, 'finishTask', task)
        if (task.stateVersion !== req.expectedVersion || task.status !== 'paused' || task.pauseReason !== 'awaiting-agent' || task.uncertainActions.length || Object.values(task.approvals).some((a) => a.state === 'pending')) throw new BrowserRuntimeError('CONFLICT', 'Task is not ready to finish')
        const next = transitionTask({ status: task.status, pauseReason: task.pauseReason }, { type: 'finish' })
        return this.view(await this.commit(task, { ...next }, 'state-changed', { status: 'succeeded' }))
    }

    async getTask(auth: AuthContext, req: { taskId: TaskId }): Promise<TaskView> { await this.recovery; const task = this.requireTask(req.taskId); this.authorizeTask(auth, 'getTask', task); return this.view(task) }
    async subscribe(auth: AuthContext, req: { taskId: TaskId; afterSeq: number }): Promise<import('./contracts').SubscribeResult> {
        await this.recovery
        const task = this.requireTask(req.taskId); this.authorizeTask(auth, 'subscribe', task)
        if (req.afterSeq < 0) throw new BrowserRuntimeError('INVALID_REQUEST', 'Invalid event cursor')
        const events = this.options.store.events(req.taskId, req.afterSeq, this.clock.now())
        if (!events.length && req.afterSeq < task.highWatermarkSeq && ['succeeded', 'failed', 'cancelled'].includes(task.status) && this.clock.now() - task.updatedAtMs > POC_LIMITS.eventRetentionMs) return { kind: 'snapshot-required', snapshot: this.view(task), highWatermarkSeq: task.highWatermarkSeq }
        if (events.length && req.afterSeq < events[0].seq - 1) return { kind: 'snapshot-required', snapshot: this.view(task), highWatermarkSeq: task.highWatermarkSeq }
        return { kind: 'events', events, highWatermarkSeq: task.highWatermarkSeq }
    }

    async approve(auth: AuthContext, req: { taskId: TaskId; approvalId: ApprovalId; bindingHash: string; requestId: import('./contracts').RequestId; decision: 'approve' | 'reject' }): Promise<import('./contracts').ApproveResult> {
        await this.recovery
        const task = this.requireTask(req.taskId); this.authorizeTask(auth, 'approve', task)
        const approval = task.approvals[req.approvalId]
        if (!approval || approval.bindingHash !== req.bindingHash) throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval is no longer pending')
        if (approval.state === 'consumed' && approval.result) return { outcome: 'approved', task: this.view(task), batch: approval.result as BatchResult }
        if (approval.state !== 'pending') throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval is no longer pending')
        if (Number(approval.expiresAtMs) <= this.clock.now()) { await this.commit(task, { status: 'paused', pauseReason: 'approval-expired' }, 'state-changed', { status: 'paused', pauseReason: 'approval-expired' }); throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval expired') }
        if (req.decision === 'reject') { const cancelled = await this.commit(task, { status: 'cancelled', approvals: { ...task.approvals, [req.approvalId]: { ...approval, state: 'rejected' } } }, 'approval-rejected', { approvalId: req.approvalId }); return { outcome: 'rejected', task: this.view(cancelled) } }
        const originalGrant = task.agentGrant as AgentGrant | undefined
        if (!originalGrant || originalGrant.expiresAtMs <= this.clock.now() || this.options.store.isRevoked(originalGrant.grantId)) throw new BrowserRuntimeError('UNAUTHORIZED', 'Agent execution grant is no longer valid')
        const originalAuth: AuthContext = { credential: originalGrant, verifiedAtMs: this.clock.now() }
        const batchRecord = task.batches[String(approval.batchId)] as { steps: BatchStep[]; nextStep: number }
        const approvedStep = batchRecord.steps[Number(approval.nextStep)]
        const driver = this.driver(task.profileId)
        const lease = this.leases.owner(approvedStep.tabId, task.profileId)
        if (lease.leaseEpoch !== Number(approval.leaseEpoch) || driver.browserInstanceId() !== approval.browserInstanceId || await driver.currentOrigin(approvedStep.tabId) !== approval.origin) throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval binding changed')
        const observation = await driver.observe(approvedStep.tabId, originalGrant.allowedOrigins, { timeoutMs: approvedStep.timeoutMs })
        if (this.clock.now() >= Number(approval.expiresAtMs) || originalGrant.expiresAtMs <= this.clock.now() || this.options.store.isRevoked(originalGrant.grantId)) throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval or execution grant expired before dispatch')
        if (observation.documentGeneration !== Number(approval.documentGeneration) || payloadHash(approvedStep) !== approval.payloadHash) throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval document or payload changed')
        const expectedBinding = approvalBinding({ principalId: originalGrant.principalId, workspaceId: originalGrant.workspaceId, taskId: task.taskId, actionId: approvedStep.actionId, origin: String(approval.origin), payloadHash: String(approval.payloadHash), leaseEpoch: Number(approval.leaseEpoch), browserInstanceId: String(approval.browserInstanceId), documentGeneration: Number(approval.documentGeneration), expiresAtMs: Number(approval.expiresAtMs) })
        if (expectedBinding !== req.bindingHash) throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval binding changed')
        const { [approvedStep.actionId]: _priorAction, ...remainingActions } = task.actions
        const consumed = await this.commit(task, { status: 'running', pauseReason: undefined, waitReason: undefined, actions: remainingActions, approvals: { ...task.approvals, [req.approvalId]: { ...approval, state: 'consumed' } } }, 'approval-consumed', { approvalId: req.approvalId })
        const result = await this.runBatch(consumed, approval.batchId as import('./contracts').BatchId, batchRecord.steps, originalAuth, Number(approval.nextStep), approvedStep.actionId)
        const finalTask = this.requireTask(req.taskId)
        await this.commit(finalTask, { approvals: { ...finalTask.approvals, [req.approvalId]: { ...finalTask.approvals[req.approvalId], result } } }, 'agent-attention-required', { approvalId: req.approvalId, outcome: result.outcome })
        return { outcome: 'approved', task: this.view(this.requireTask(req.taskId)), batch: result }
    }

    async takeOver(auth: AuthContext, req: { taskId: TaskId; tabId: TabId; expectedEpoch: number; requestId: import('./contracts').RequestId }): Promise<import('./contracts').ControlResult> {
        await this.recovery
        const task = this.requireTask(req.taskId); this.authorizeTask(auth, 'takeOver', task); this.assertTaskTab(task, req.tabId)
        if (task.waitReason === 'approval') throw new BrowserRuntimeError('CONFLICT', 'Approval waits cannot be replaced with user takeover')
        const lease = this.leases.owner(req.tabId, task.profileId); if (lease.leaseEpoch !== req.expectedEpoch) throw new BrowserRuntimeError('STALE_LEASE', 'Lease epoch changed')
        const interactive = auth.credential as Extract<AuthContext['credential'], { kind: 'interactive' }>
        const owner: InputOwner = { kind: 'user', principalId: interactive.principalId, viewerSessionId: interactive.viewerSessionId }
        const epoch = this.leases.takeOver(req.tabId, task.profileId, owner)
        const pending = Object.entries(task.actions).filter(([, action]) => ['click', 'fill', 'navigate'].includes(String(action.kind)) && ['intent-committed', 'dispatched'].includes(String(action.state)))
        const actions = { ...task.actions }; for (const [id, action] of pending) actions[id] = { ...action, state: 'uncertain' }
        const paused = await this.commit(task, { status: 'paused', pauseReason: 'user-control', actions, ...(pending.length ? { uncertainActions: [...new Set([...task.uncertainActions, ...pending.map(([id]) => id as ActionId)])] } : {}) }, 'input-owner-changed', { tabId: req.tabId, owner: 'user', unsettledActions: pending.map(([id]) => id) }, epoch)
        this.controllers.get(task.taskId)?.abort(new Error('user takeover'))
        return { leaseEpoch: epoch, owner, task: this.view(paused) }
    }
    async releaseControl(auth: AuthContext, req: { taskId: TaskId; tabId: TabId; expectedEpoch: number; requestId: import('./contracts').RequestId }): Promise<import('./contracts').ControlResult> {
        await this.recovery
        const task = this.requireTask(req.taskId); this.authorizeTask(auth, 'releaseControl', task); this.assertTaskTab(task, req.tabId)
        const current = this.leases.owner(req.tabId, task.profileId); const interactive = auth.credential as Extract<AuthContext['credential'], { kind: 'interactive' }>
        if (current.leaseEpoch !== req.expectedEpoch || current.owner.kind !== 'user' || current.owner.principalId !== interactive.principalId || current.owner.viewerSessionId !== interactive.viewerSessionId) throw new BrowserRuntimeError('STALE_LEASE', 'User lease changed')
        const epoch = this.leases.release(req.tabId, task.profileId)
        const next = await this.commit(task, { status: 'paused', pauseReason: 'user-input-complete' }, 'input-owner-changed', { tabId: req.tabId, owner: 'none' }, epoch)
        return { leaseEpoch: epoch, owner: { kind: 'none' }, task: this.view(next) }
    }
    async resume(auth: AuthContext, req: { taskId: TaskId; expectedVersion: number; requestId: import('./contracts').RequestId }): Promise<TaskView> {
        await this.recovery
        const task = this.requireTask(req.taskId); this.authorizeTask(auth, 'resume', task)
        if (task.cancelRequested || ['user-control', 'quota', 'task-time-limit', 'outcome-unknown', 'cancelled-with-unknown-effect'].includes(task.pauseReason ?? '') || task.uncertainActions.length) throw new BrowserRuntimeError('CONFLICT', 'Task pause cannot be resumed directly')
        if (task.stateVersion !== req.expectedVersion || task.status !== 'paused' || !['awaiting-agent', 'user-input-complete', 'approval-expired', 'grant-expired', 'browser-replaced'].includes(task.pauseReason ?? '')) throw new BrowserRuntimeError('CONFLICT', 'Task is not resumable')
        if (auth.credential.kind !== 'agent-grant') throw new BrowserRuntimeError('SCOPE_DENIED', 'Agent grant required to resume')
        if (task.pauseReason === 'grant-expired') task.agentGrant = auth.credential
        if (task.pauseReason === 'user-input-complete' && task.waitReason) {
            if (Number(task.waitExpiresAtMs ?? 0) > 0 && this.clock.now() > Number(task.waitExpiresAtMs)) return this.view(await this.commit(task, { status: 'paused', pauseReason: 'user-wait-expired' }, 'state-changed', { pauseReason: 'user-wait-expired', waitReason: task.waitReason }))
            const wait = task.waitCompletion as { batchId: string; nextStep: number; tabId: TabId; predicate: BatchStep['until'] } | undefined
            if (!wait?.predicate) throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Wait completion condition is missing')
            const observation = await this.driver(task.profileId).observe(wait.tabId, auth.credential.allowedOrigins, { timeoutMs: 10_000 })
            if (!matchesWait(wait.predicate, observation)) return this.view(await this.commit(task, { status: 'awaiting-user' }, 'state-changed', { status: 'awaiting-user', waitReason: task.waitReason }))
            const record = task.batches[wait.batchId] as { steps: BatchStep[] }
            const resumeAt = wait.nextStep + 1
            const running = await this.commit(task, { status: 'running', pauseReason: undefined, waitReason: undefined, waitCompletion: undefined, browserInstanceId: this.driver(task.profileId).browserInstanceId(), batches: { ...task.batches, [wait.batchId]: { ...record, nextStep: resumeAt } } }, 'state-changed', { status: 'running', resumedAfter: task.waitReason })
            await this.runBatch(running, wait.batchId as import('./contracts').BatchId, record.steps, auth, resumeAt)
            return this.view(this.requireTask(task.taskId))
        }
        if (task.pauseReason === 'approval-expired' || task.pauseReason === 'user-wait-expired') {
            const approvalEntry = Object.entries(task.approvals).find(([, approval]) => approval.state === 'pending')
            if (approvalEntry) {
                const [approvalId, approval] = approvalEntry
                const batch = task.batches[String(approval.batchId)] as { steps: BatchStep[]; nextStep: number }
                const { [String(approval.actionId)]: _oldAction, ...actions } = task.actions
                const approvals = { ...task.approvals, [approvalId]: { ...approval, state: 'expired' } }
                const running = await this.commit(task, { status: 'running', pauseReason: undefined, waitReason: undefined, pendingApproval: undefined, agentGrant: auth.credential, actions, approvals }, 'state-changed', { status: 'running', approvalExpired: approvalId })
                await this.runBatch(running, approval.batchId as import('./contracts').BatchId, batch.steps, auth, Number(approval.nextStep))
                return this.view(this.requireTask(task.taskId))
            }
        }
        if (task.pauseReason === 'browser-replaced') {
            const driver = this.driver(task.profileId)
            for (const tab of task.tabs) if (!driver.hasTab(tab)) throw new BrowserRuntimeError('TARGET_GONE', 'Task tabs were lost with the browser instance')
            return this.view(await this.commit(task, { status: 'paused', pauseReason: 'awaiting-agent', browserInstanceId: driver.browserInstanceId() }, 'recovered', { browserInstanceId: driver.browserInstanceId() }))
        }
        if (task.pauseReason === 'awaiting-agent') return this.view(task)
        return this.view(await this.commit(task, { status: 'paused', pauseReason: 'awaiting-agent', agentGrant: auth.credential }, 'state-changed', { status: 'paused', pauseReason: 'awaiting-agent' }))
    }
    async cancel(auth: AuthContext, req: { taskId: TaskId; requestId: import('./contracts').RequestId }): Promise<{ status: 'cancel-accepted'; task: TaskView; fenceAckMs: number }> {
        await this.recovery
        const started = this.clock.now(); const task = this.requireTask(req.taskId); this.authorizeTask(auth, 'cancel', task)
        if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return { status: 'cancel-accepted', task: this.view(task), fenceAckMs: Math.max(0, this.clock.now() - started) }
        this.leases.revokeTask(task.taskId); this.controllers.get(task.taskId)?.abort(new Error('cancelled'))
        const uncertain = [...new Set([...task.uncertainActions, ...Object.entries(task.actions).filter(([, action]) => ['navigate', 'click', 'fill'].includes(String(action.kind)) && (action.state === 'intent-committed' || action.state === 'dispatched')).map(([id]) => id as ActionId)])]
        const next = await this.commit(task, { cancelRequested: true, status: uncertain.length ? 'paused' : 'cancelled', ...(uncertain.length ? { pauseReason: 'cancelled-with-unknown-effect', uncertainActions: [...new Set([...task.uncertainActions, ...uncertain])] } : {}) }, 'cancel-accepted', { cancelRequested: true, uncertainActions: uncertain })
        return { status: 'cancel-accepted', task: this.view(next), fenceAckMs: Math.max(0, this.clock.now() - started) }
    }
    async closeSpace(auth: AuthContext, req: { taskSpaceId: TaskSpaceId; requestId: import('./contracts').RequestId }): Promise<{ closedTabs: TabId[] }> {
        await this.recovery
        const space = this.requireSpace(req.taskSpaceId); this.checkCredential(auth, 'closeSpace', space.profileId, req.taskSpaceId); this.authorizeSpace(auth, space)
        const duplicate = this.spaceRequest(space, auth, req.requestId, { operation: 'closeSpace', ...req })
        if (duplicate) return duplicate as { closedTabs: TabId[] }
        if (this.options.store.listTasks().some((task) => task.taskSpaceId === req.taskSpaceId && (!['succeeded', 'failed', 'cancelled'].includes(task.status) || this.workers.has(task.taskId)))) throw new BrowserRuntimeError('CONFLICT', 'Task space has non-terminal or in-flight tasks')
        const closedTabs: TabId[] = []
        for (const tab of space.tabs) { if (this.leases.owner(tab as TabId, space.profileId).owner.kind !== 'none') throw new BrowserRuntimeError('STALE_LEASE', 'Task space has an input owner'); await this.driver(space.profileId).closeTab(tab as TabId, { timeoutMs: 5000 }); closedTabs.push(tab as TabId) }
        const response = { closedTabs }
        await this.options.store.updateSpace(req.taskSpaceId, { tabs: [], closed: true, dedupe: this.spaceDedupe(space, auth, req.requestId, { operation: 'closeSpace', ...req }, response) }); return response
    }

    async reconcileAction(taskId: TaskId, actionId: ActionId, confirmed: boolean): Promise<TaskView> {
        await this.recovery
        const task = this.requireTask(taskId); const action = task.actions[actionId]
        if (!action || action.state !== 'uncertain') throw new BrowserRuntimeError('CONFLICT', 'Action is not uncertain')
        const actions = { ...task.actions, [actionId]: { ...action, state: confirmed ? 'confirmed' : 'uncertain' } }
        const uncertainActions = confirmed ? task.uncertainActions.filter((id) => id !== actionId) : task.uncertainActions
        const status = task.cancelRequested && confirmed && uncertainActions.length === 0 ? 'cancelled' : task.status
        const updated = await this.commit(task, { actions, uncertainActions, status, ...(status === 'cancelled' ? { pauseReason: undefined } : uncertainActions.length === 0 && !task.cancelRequested ? { pauseReason: 'awaiting-agent' } : {}) }, confirmed ? 'action-confirmed' : 'action-uncertain', { actionId, reconciled: confirmed })
        return this.view(updated)
    }

    private async recoverExistingTasks(): Promise<void> {
        for (const task of this.options.store.listTasks()) {
            if (['succeeded', 'failed', 'cancelled'].includes(task.status)) continue
            const driver = this.drivers.get(task.profileId)
            const pendingWrites = Object.entries(task.actions).filter(([, action]) => ['navigate', 'click', 'fill'].includes(String(action.kind)) && ['intent-committed', 'dispatched'].includes(String(action.state)))
            const actions = { ...task.actions }
            for (const [id, action] of pendingWrites) actions[id] = { ...action, state: 'uncertain' }
            let patch: Partial<StoredTask>
            if (task.cancelRequested) {
                const unresolved = [...new Set([...task.uncertainActions, ...pendingWrites.map(([id]) => id as ActionId)])]
                patch = unresolved.length ? { status: 'paused', pauseReason: 'cancelled-with-unknown-effect', uncertainActions: unresolved, actions } : { status: 'cancelled' }
            } else if (!driver || (task.browserInstanceId && driver.browserInstanceId() !== task.browserInstanceId)) {
                patch = { status: 'paused', pauseReason: 'browser-replaced', browserInstanceId: driver?.browserInstanceId(), actions, pendingApproval: undefined }
            } else if (pendingWrites.length) {
                patch = { status: 'paused', pauseReason: 'outcome-unknown', uncertainActions: [...new Set([...task.uncertainActions, ...pendingWrites.map(([id]) => id as ActionId)])], actions }
            } else if (task.status === 'running' || task.status === 'recovering') {
                patch = { status: 'paused', pauseReason: 'awaiting-agent', actions }
            } else continue
            await this.commit(task, patch, 'recovered', { previousStatus: task.status, pauseReason: patch.pauseReason, uncertainActions: patch.uncertainActions ?? [] })
        }
    }

    pinnedProfiles(nowMs = this.clock.now()): ProfileId[] {
        const profiles = new Set<ProfileId>()
        for (const task of this.options.store.listTasks()) {
            if (['succeeded', 'failed', 'cancelled'].includes(task.status)) continue
            if (task.status === 'running' || task.status === 'recovering' || nowMs - task.updatedAtMs <= POC_LIMITS.pausedBrowserRetentionMs) profiles.add(task.profileId)
        }
        return [...profiles]
    }

    private async runBatch(task0: StoredTask, batchId: import('./contracts').BatchId, steps: BatchStep[], auth: AuthContext, fromIndex = 0, approvedActionId?: ActionId): Promise<BatchResult> {
        const results: BatchResult['steps'] = []; const completedSteps: BatchResult['completedSteps'] = []; let failedStep: BatchResult['failedStep']; let outcome: BatchResult['outcome'] = 'succeeded'; let mayHaveSideEffects = false
        const driver = this.driver(task0.profileId); const grant = this.agentGrant(auth); const controller = this.controllers.get(task0.taskId) ?? new AbortController(); this.controllers.set(task0.taskId, controller)
        const batchLeases = new Map<TabId, number>()
        let preserveLeases = false
        try {
            for (let index = fromIndex; index < steps.length; index++) {
                const step = steps[index]; let task = this.requireTask(task0.taskId)
                if (task.cancelRequested) { outcome = 'cancelled'; break }
                if (!this.isCredentialLive(auth)) { this.leases.revokeTask(task.taskId); await this.commit(task, { status: 'paused', pauseReason: 'grant-expired' }, 'state-changed', { pauseReason: 'grant-expired' }); outcome = 'failed'; break }
                if (this.clock.now() - task.createdAtMs >= POC_LIMITS.taskTimeLimitMs) { this.leases.revokeTask(task.taskId); await this.commit(task, { status: 'paused', pauseReason: 'task-time-limit' }, 'state-changed', { pauseReason: 'task-time-limit' }); outcome = 'failed'; break }
                if (task.browserInstanceId !== driver.browserInstanceId()) { await this.commit(task, { status: 'paused', pauseReason: 'browser-replaced', browserInstanceId: driver.browserInstanceId() }, 'state-changed', { pauseReason: 'browser-replaced' }); outcome = 'failed'; break }
                const origin = await driver.currentOrigin(step.tabId)
                if (!grant.allowedOrigins.includes(origin)) throw new BrowserRuntimeError('ORIGIN_DENIED', 'Current page origin is not allowed')
                let leaseEpoch = batchLeases.get(step.tabId)
                if (leaseEpoch === undefined) { leaseEpoch = this.leases.acquire(step.tabId, task.profileId, { kind: 'agent', agentSessionId: task.agentSessionId, taskId: task.taskId, segmentId: batchId }); batchLeases.set(step.tabId, leaseEpoch) }
                const action = task.actions[step.actionId]
                if (action) {
                    if (action.payloadHash !== payloadHash(step)) throw new BrowserRuntimeError('CONFLICT', 'actionId has been used with different input')
                    if (action.state === 'confirmed') { completedSteps.push(step.stepId); results.push({ stepId: step.stepId, actionId: step.actionId, outcome: 'succeeded' }); continue }
                    throw new BrowserRuntimeError('OUTCOME_UNKNOWN', 'actionId has an unresolved prior result', false, true)
                }
                task = await this.commit(task, { actions: { ...task.actions, [step.actionId]: { state: 'intent-committed', kind: step.kind, batchId, payloadHash: payloadHash(step), leaseEpoch, browserInstanceId: driver.browserInstanceId() } }, batches: { ...task.batches, [batchId]: { steps, nextStep: index } } }, 'action-intent', { actionId: step.actionId, kind: step.kind, payloadHash: payloadHash(step) }, leaseEpoch)
                const observed = ['click', 'fill'].includes(step.kind) ? await driver.observe(step.tabId, grant.allowedOrigins, { timeoutMs: step.timeoutMs }) : undefined
                const element = observed?.elements.find((candidate) => candidate.ref === step.ref)
                if (classifyAction(step, element) === 'approval-required' && step.actionId !== approvedActionId) {
                    const approvalId = `approval-${randomUUID()}` as ApprovalId; const expiresAtMs = this.clock.now() + POC_LIMITS.userWaitMs
                    const bindingHash = approvalBinding({ principalId: grant.principalId, workspaceId: grant.workspaceId, taskId: task.taskId, actionId: step.actionId, origin, payloadHash: payloadHash(step), leaseEpoch, browserInstanceId: driver.browserInstanceId(), documentGeneration: observed?.documentGeneration ?? 0, expiresAtMs })
                    const pendingApproval = { approvalId, actionId: step.actionId, origin, description: `Confirm ${step.kind}`, bindingHash, expiresAtMs }
                    const approvals = { ...task.approvals, [approvalId]: { ...pendingApproval, state: 'pending', batchId, nextStep: index, payloadHash: payloadHash(step), documentGeneration: observed?.documentGeneration ?? 0, leaseEpoch, browserInstanceId: driver.browserInstanceId() } }
                    task = await this.commit(task, { status: 'awaiting-user', waitReason: 'approval', pendingApproval, actions: { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state: 'planned' } }, approvals }, 'approval-requested', { approvalId, actionId: step.actionId, origin, bindingHash }, leaseEpoch)
                    preserveLeases = true
                    return this.saveBatchResult(task, batchId, { batchId, taskId: task.taskId, outcome: 'awaiting-user', completedSteps, mayHaveSideEffects: false, lastCheckpointSeq: task.highWatermarkSeq + 1, steps: results, pendingApproval, waitReason: 'approval' })
                }
                if (step.kind === 'waitFor') {
                    const pageUrl = await driver.currentOrigin(step.tabId)
                    const observedPage = await driver.observe(step.tabId, grant.allowedOrigins, { timeoutMs: step.timeoutMs })
                    const path = new URL(observedPage.url).pathname
                    const expectedProtectedPage = step.until?.kind === 'url' && !/\/(login|challenge)(\/|$)/.test(step.until.urlPrefix)
                    const waitReason = expectedProtectedPage && path.startsWith('/login') ? 'login' : expectedProtectedPage && path.startsWith('/challenge') ? 'captcha' : undefined
                    if (waitReason) {
                        task = await this.commit(task, { status: 'awaiting-user', waitReason, waitExpiresAtMs: this.clock.now() + POC_LIMITS.userWaitMs, waitCompletion: { batchId, nextStep: index, tabId: step.tabId, predicate: step.until, protectedOrigin: pageUrl } }, 'state-changed', { status: 'awaiting-user', waitReason, actionId: step.actionId }, leaseEpoch)
                        preserveLeases = true
                        return this.saveBatchResult(task, batchId, { batchId, taskId: task.taskId, outcome: 'awaiting-user', completedSteps, mayHaveSideEffects: false, lastCheckpointSeq: task.highWatermarkSeq + 1, steps: results, waitReason })
                    }
                }
                task = this.requireTask(task.taskId)
                if (task.cancelRequested || task.status !== 'running' || !this.isCredentialLive(auth) || task.browserInstanceId !== driver.browserInstanceId()) throw new BrowserRuntimeError('STALE_LEASE', 'Task execution fence changed')
                if (this.leases.owner(step.tabId, task.profileId).leaseEpoch !== leaseEpoch || await driver.currentOrigin(step.tabId) !== origin) throw new BrowserRuntimeError('STALE_LEASE', 'Input lease or origin changed before dispatch')
                this.leases.assert(step.tabId, task.profileId, task.taskId, batchId, leaseEpoch)
                const armed = driver as DriverWithAction; armed.armAction?.(step.actionId)
                try {
                    await this.dispatch(driver, step, observed, grant, controller.signal)
                    const finalOrigin = await driver.currentOrigin(step.tabId)
                    if (!grant.allowedOrigins.includes(finalOrigin)) throw new BrowserRuntimeError('ORIGIN_DENIED', 'Action navigated to a disallowed origin', false, true)
                    task = this.requireTask(task.taskId)
                    if (task.cancelRequested || this.leases.owner(step.tabId, task.profileId).leaseEpoch !== leaseEpoch || task.status !== 'running') {
                        const uncertain = ['click', 'fill', 'navigate'].includes(step.kind)
                        const state = uncertain ? 'uncertain' : 'skipped'
                        await this.commit(task, { actions: { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state } }, ...(uncertain ? { uncertainActions: [...new Set([...task.uncertainActions, step.actionId])] } : {}) }, 'late-result', { actionId: step.actionId, ignored: true }, leaseEpoch)
                        outcome = uncertain ? 'uncertain' : 'cancelled'; mayHaveSideEffects = uncertain; break
                    }
                    task = await this.commit(task, { actions: { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state: 'dispatched' } } }, 'action-dispatched', { actionId: step.actionId }, leaseEpoch)
                    const actions = { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state: 'confirmed' } }
                    task = await this.commit(task, { actions, batches: { ...task.batches, [batchId]: { steps, nextStep: index + 1 } } }, 'action-confirmed', { actionId: step.actionId }, leaseEpoch)
                    results.push({ stepId: step.stepId, actionId: step.actionId, outcome: 'succeeded', ...(observed ? { observation: sanitizeObservation(observed, grant.allowedOrigins) } : {}) }); completedSteps.push(step.stepId)
                } catch (error) {
                    task = this.requireTask(task.taskId)
                    if (task.pauseReason === 'user-control' || this.leases.owner(step.tabId, task.profileId).leaseEpoch !== leaseEpoch) {
                        const uncertain = ['click', 'fill', 'navigate'].includes(step.kind)
                        await this.commit(task, { actions: { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state: uncertain ? 'uncertain' : 'skipped' } }, ...(uncertain ? { uncertainActions: [...new Set([...task.uncertainActions, step.actionId])] } : {}) }, 'late-result', { actionId: step.actionId, ignored: true }, leaseEpoch)
                        outcome = uncertain ? 'uncertain' : 'cancelled'; mayHaveSideEffects = uncertain; break
                    }
                    if (task.cancelRequested) {
                        const uncertain = ['click', 'fill', 'navigate'].includes(step.kind)
                        const actions = { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state: uncertain ? 'uncertain' : 'skipped' } }
                        await this.commit(task, { actions, ...(uncertain ? { status: 'paused', pauseReason: 'cancelled-with-unknown-effect', uncertainActions: [...new Set([...task.uncertainActions, step.actionId])] } : { status: 'cancelled' }) }, 'late-result', { actionId: step.actionId, cancelled: true }, leaseEpoch)
                        outcome = 'cancelled'; break
                    }
                    const uncertain = ['click', 'fill', 'navigate'].includes(step.kind)
                    const actionState = uncertain ? 'uncertain' : 'failed'; const actions = { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state: actionState } }
                    task = await this.commit(task, { actions, status: uncertain ? 'paused' : 'failed', ...(uncertain ? { pauseReason: 'outcome-unknown', uncertainActions: [...task.uncertainActions, step.actionId] } : {}) }, uncertain ? 'action-uncertain' : 'action-failed', { actionId: step.actionId, error: safeError(error) }, leaseEpoch)
                    results.push({ stepId: step.stepId, actionId: step.actionId, outcome: uncertain ? 'uncertain' : 'failed', error: safeError(error) }); failedStep = step.stepId; outcome = uncertain ? 'uncertain' : 'failed'; mayHaveSideEffects = uncertain; break
                }
            }
            let finalTask = this.requireTask(task0.taskId)
            if (outcome === 'succeeded' && finalTask.status === 'running') {
                const pauseReason = this.clock.now() - finalTask.createdAtMs >= POC_LIMITS.taskTimeLimitMs ? 'task-time-limit' : 'awaiting-agent'
                finalTask = await this.commit(finalTask, { status: 'paused', pauseReason, currentBatchId: undefined }, 'state-changed', { status: 'paused', pauseReason })
            }
            finalTask = this.requireTask(finalTask.taskId)
            return this.saveBatchResult(finalTask, batchId, { batchId, taskId: finalTask.taskId, outcome, completedSteps, ...(failedStep ? { failedStep } : {}), mayHaveSideEffects, lastCheckpointSeq: finalTask.highWatermarkSeq + 1, steps: results })
        } finally {
            if (!preserveLeases) for (const [tabId, epoch] of batchLeases) {
                const current = this.leases.owner(tabId, task0.profileId)
                if (current.owner.kind === 'agent' && current.owner.taskId === task0.taskId && current.owner.segmentId === batchId && current.leaseEpoch === epoch) this.leases.release(tabId, task0.profileId)
            }
            if (this.controllers.get(task0.taskId) === controller) this.controllers.delete(task0.taskId)
        }
    }

    private async dispatch(driver: BrowserDriver, step: BatchStep, observed: import('./contracts').Observation | undefined, grant: AgentGrant, signal: AbortSignal): Promise<void> {
        const opts = { signal, timeoutMs: step.timeoutMs }
        switch (step.kind) {
            case 'navigate': { if (!step.url) throw new BrowserRuntimeError('INVALID_REQUEST', 'navigate requires url'); assertAllowedOrigin(step.url, grant); const result = await driver.navigate(step.tabId, step.url, grant.allowedOrigins, opts); assertAllowedOrigin(result.url, grant); return }
            case 'click': if (!step.ref || typeof step.ref === 'string' && step.ref.startsWith('$')) throw new BrowserRuntimeError('INVALID_REQUEST', 'click needs a resolved ref'); return driver.click(step.tabId, step.ref as import('./contracts').ElementRef, observed?.snapshotId as import('./contracts').SnapshotId, opts)
            case 'fill': if (!step.ref || step.value === undefined) throw new BrowserRuntimeError('INVALID_REQUEST', 'fill needs ref and value'); return driver.fill(step.tabId, step.ref as import('./contracts').ElementRef, observed?.snapshotId as import('./contracts').SnapshotId, step.value, opts)
            case 'observe': await driver.observe(step.tabId, grant.allowedOrigins, opts); return
            case 'screenshot': await driver.screenshot(step.tabId, grant.allowedOrigins, opts); return
            case 'waitFor': if (!step.until) throw new BrowserRuntimeError('INVALID_REQUEST', 'waitFor needs a predicate'); return driver.waitFor(step.tabId, step.until, grant.allowedOrigins, opts)
        }
    }

    private async commit(task: StoredTask, patch: Partial<StoredTask>, type: TaskEvent['type'], data: Record<string, unknown>, leaseEpoch = 0, business = false): Promise<StoredTask> {
        const previous = this.commitTails.get(task.taskId) ?? Promise.resolve()
        let release!: () => void
        const current = new Promise<void>((resolve) => { release = resolve })
        const queued = previous.then(() => current)
        this.commitTails.set(task.taskId, queued)
        await previous
        try { return await this.options.store.commit(task.taskId, patch, this.event(type, redact(data), task.stateVersion + 1, leaseEpoch), business) }
        catch (error) { this.leases.revokeTask(task.taskId); this.controllers.get(task.taskId)?.abort(new Error('journal unavailable')); throw error }
        finally { release(); if (this.commitTails.get(task.taskId) === queued) this.commitTails.delete(task.taskId) }
    }
    private async saveBatchResult(task: StoredTask, batchId: import('./contracts').BatchId, result: BatchResult): Promise<BatchResult> {
        const batches = { ...task.batches, [batchId]: { ...task.batches[batchId], result } }
        const committed = await this.commit(task, { lastBatch: result, batches }, 'state-changed', { batchId, batchOutcome: result.outcome, resultStored: true })
        return { ...result, lastCheckpointSeq: committed.highWatermarkSeq }
    }
    private event(type: TaskEvent['type'], data: Record<string, unknown>, stateVersion: number, leaseEpoch = 0): StoreEventInput { return { type, atMs: this.clock.now(), stateVersion, leaseEpoch, data } }
    private authorizeTask(auth: AuthContext, operation: Operation, task: StoredTask): void {
        this.checkCredential(auth, operation, task.profileId, task.taskSpaceId)
        if (task.owner.principalId !== auth.credential.principalId || task.owner.workspaceId !== auth.credential.workspaceId || task.owner.machineId !== auth.credential.machineId) throw new BrowserRuntimeError('SCOPE_DENIED', 'Task owner does not match credential')
        if (auth.credential.kind === 'agent-grant' && auth.credential.agentSessionId !== task.agentSessionId) throw new BrowserRuntimeError('SCOPE_DENIED', 'Agent session does not own task')
    }
    private checkCredential(auth: AuthContext, op: Operation, profileId: ProfileId, taskSpaceId?: TaskSpaceId): void {
        const credential = auth.credential
        assertOperation(auth, op, { principalId: credential.principalId, workspaceId: credential.workspaceId, machineId: credential.machineId, profileId, ...(taskSpaceId ? { taskSpaceId } : {}) })
        if (!this.isCredentialLive(auth)) throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential has expired or been revoked')
    }
    private isCredentialLive(auth: AuthContext): boolean { const credential = auth.credential; return credential.expiresAtMs > this.clock.now() && !this.options.store.isRevoked(credential.kind === 'agent-grant' ? credential.grantId : credential.capabilityId) }
    private agentGrant(auth: AuthContext): AgentGrant { if (auth.credential.kind !== 'agent-grant') throw new BrowserRuntimeError('SCOPE_DENIED', 'Agent grant required'); return auth.credential }
    private driver(profileId: ProfileId): BrowserDriver { const driver = this.drivers.get(profileId); if (!driver) throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'No browser driver is configured for profile'); return driver }
    private requireTask(id: TaskId): StoredTask { const task = this.options.store.getTask(id); if (!task) throw new BrowserRuntimeError('SCOPE_DENIED', 'Task does not exist'); return task }
    private requireSpace(id: TaskSpaceId): NonNullable<ReturnType<TaskStore['getSpace']>> { const space = this.options.store.getSpace(id); if (!space) throw new BrowserRuntimeError('SCOPE_DENIED', 'Task space does not exist'); return space }
    private assertTaskTab(task: StoredTask, tab: TabId): void { if (!task.tabs.includes(tab)) throw new BrowserRuntimeError('SCOPE_DENIED', 'Tab is not owned by task') }
    private assertCanStart(task: StoredTask): void {
        if (task.cancelRequested || ['succeeded', 'failed', 'cancelled'].includes(task.status)) throw new BrowserRuntimeError('CONFLICT', 'Task cannot accept new work')
        if (task.status === 'paused' && task.pauseReason !== 'awaiting-agent' || task.status === 'awaiting-user' || task.uncertainActions.length) throw new BrowserRuntimeError('CONFLICT', 'Task is paused for a blocking reason')
    }
    private allocateTabId(): TabId { return `lease-reservation-${randomUUID()}` as TabId }
    private view(task: StoredTask): TaskView { const { owner: _owner, agentGrant: _grant, actions: _actions, approvals: _approvals, batches: _batches, dedupe: _dedupe, __events: _events, lastSeq: _lastSeq, ...view } = task; return structuredClone(view) }
    private taskRequest(task: StoredTask, auth: AuthContext, requestId: string, payload: unknown): unknown | undefined { const key = requestKey(auth, requestId); const old = task.dedupe[key]; if (!old) return; if (old.hash !== payloadHash(payload)) throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input'); return old.result }
    private spaceRequest(space: NonNullable<ReturnType<TaskStore['getSpace']>>, auth: AuthContext, requestId: string, payload: unknown): unknown | undefined { const old = space.dedupe?.[requestKey(auth, requestId)]; if (!old) return; if (old.hash !== payloadHash(payload)) throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input'); return old.result }
    private spaceDedupe(space: NonNullable<ReturnType<TaskStore['getSpace']>>, auth: AuthContext, requestId: string, payload: unknown, result: unknown): NonNullable<NonNullable<ReturnType<TaskStore['getSpace']>>['dedupe']> { return { ...space.dedupe, [requestKey(auth, requestId)]: { hash: payloadHash(payload), result: redact(result) } } }
    private async saveTaskRequest(task: StoredTask, auth: AuthContext, requestId: string, payload: unknown, result: unknown): Promise<StoredTask> { const dedupe = { ...task.dedupe, [requestKey(auth, requestId)]: { hash: payloadHash(payload), result: redact(result) } }; return this.commit(task, { dedupe }, 'state-changed', { requestStored: true }) }
    private async saveRequest(task: StoredTask, auth: AuthContext, requestId: string, payload: unknown, result: unknown): Promise<StoredTask> { return this.saveTaskRequest(task, auth, requestId, payload, result) }
    private findRequest(requestId: string, auth: AuthContext): { hash: string; result: unknown } | undefined { const key = requestKey(auth, requestId); return this.options.store.listTasks().map((task) => task.dedupe[key]).find(Boolean) }
    private authorizeSpace(auth: AuthContext, space: NonNullable<ReturnType<TaskStore['getSpace']>>): void { if (space.owner && (space.owner.principalId !== auth.credential.principalId || space.owner.workspaceId !== auth.credential.workspaceId || space.owner.machineId !== auth.credential.machineId)) throw new BrowserRuntimeError('SCOPE_DENIED', 'Task space owner does not match credential') }
}

function identity(auth: AuthContext): { principalId: string; workspaceId: string; machineId: string } { return { principalId: auth.credential.principalId, workspaceId: auth.credential.workspaceId, machineId: auth.credential.machineId } }
function requestKey(auth: AuthContext, requestId: string): string { return `${auth.credential.principalId}/${auth.credential.workspaceId}/${auth.credential.machineId}/${requestId}` }
function safeError(error: unknown): import('./contracts').RuntimeErrorBody { const body = error instanceof BrowserRuntimeError ? error.toBody() : { code: 'RUNTIME_UNAVAILABLE' as const, message: 'Browser operation failed', retryable: true, mayHaveSideEffects: false }; return redact(body) }
function matchesWait(predicate: NonNullable<BatchStep['until']>, observation: import('./contracts').Observation): boolean {
    if (predicate.kind === 'text') return observation.text.includes(predicate.text)
    if (predicate.kind === 'url') return observation.url.startsWith(predicate.urlPrefix)
    return observation.elements.some((element) => element.ref === predicate.ref)
}
function sanitizeObservation(observation: import('./contracts').Observation, allowedOrigins: string[]): import('./contracts').Observation {
    const hasDeniedFrame = observation.frames.some((frame) => !allowedOrigins.includes(frame.origin))
    return redact({ ...observation, elements: observation.elements.filter((element) => allowedOrigins.includes(element.frameOrigin)), frames: observation.frames.map((frame) => ({ ...frame, allowed: allowedOrigins.includes(frame.origin), ...(!allowedOrigins.includes(frame.origin) ? { text: undefined } : {}) })), ...(hasDeniedFrame ? { text: '' } : {}) })
}
