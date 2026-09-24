import { randomUUID } from 'node:crypto'
import { BrowserRuntimeError, POC_LIMITS, SCHEMA_VERSION, type ActionId, type AgentGrant, type AuthContext, type BatchId,
    type BatchResult, type BatchStep, type BrowserDriver, type BrowserInstanceId, type BrowserRuntimeApi, type GrantId,
        type ApproveResult, type ControlResult, type RuntimeErrorBody, type SnapshotId, type InputOwner, type Operation,
            type ProfileId, type RequestId, type TaskEvent, type TaskId, type TaskSpaceId, type TaskView, type TaskStatus,
                type TabId, type ApprovalId,
                type ElementRef, type Observation, type ScreenshotResult, type SubscribeResult } from './contracts'
import { assertOperation } from './auth'
import { createApproval } from './approvals'
import { dispatchStep } from './batchWorker'
import { systemClock, type RuntimeClock } from './clock'
import { InputLeaseManager } from './inputLease'
import { approvalBinding, assertAllowedOrigin, classifyAction, classifyUserWait, observedFormValues, payloadHash, redact } from './policy'
import { TaskStore, type SpaceRecord, type StoredTask, type StoreEventInput } from './taskStore'
import { browserInstanceMatches, inFlightWriteActions } from './recovery'
import { transitionTask } from './stateMachine'
export interface BrowserRuntimeOptions {
    store: TaskStore
    drivers: Map<ProfileId, BrowserDriver> | Record<string, BrowserDriver>
    clock?: RuntimeClock
}
type DriverWithAction = BrowserDriver & {
    armAction?: (actionId: string) => void
}
/** Durable, scoped task runtime. Driver awaits never hold the task commit queue. */
export class BrowserRuntime implements BrowserRuntimeApi {
    readonly leases = new InputLeaseManager()
    private readonly drivers: Map<ProfileId, BrowserDriver>
    private readonly clock: RuntimeClock
    private readonly controllers = new Map<TaskId, AbortController>()
    private readonly workers = new Map<TaskId, Promise<BatchResult>>()
    private readonly inFlightDriverCalls = new Set<TaskId>()
    private readonly commitTails = new Map<TaskId, Promise<unknown>>()
    private readonly eventWaiters = new Map<TaskId, Set<() => void>>()
    private readonly requestFlights = new Map<string, { hash: string; promise: Promise<unknown> }>()
    private readonly recovery: Promise<void>
    constructor(private readonly options: BrowserRuntimeOptions) {
        this.drivers = options.drivers instanceof Map ? options.drivers : new Map(Object.entries(options.drivers) as [
            ProfileId,
            BrowserDriver
        ][])
        this.clock = options.clock ?? systemClock
        this.recovery = this.recoverExistingTasks()
    }
    createSpace: BrowserRuntimeApi['createSpace'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'createSpace', ...req }, () => this.createSpaceImpl(auth, req))
    createTask: BrowserRuntimeApi['createTask'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'createTask', ...req }, () => this.createTaskImpl(auth, req))
    openPage: BrowserRuntimeApi['openPage'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'openPage', ...req }, () => this.openPageImpl(auth, req))
    closePage: BrowserRuntimeApi['closePage'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'closePage', ...req }, () => this.closePageImpl(auth, req))
    submitBatch: BrowserRuntimeApi['submitBatch'] = (auth, req, opts) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'submitBatch', ...req }, () => this.submitBatchImpl(auth, req, opts))
    finishTask: BrowserRuntimeApi['finishTask'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'finishTask', ...req }, () => this.finishTaskImpl(auth, req))
    approve: BrowserRuntimeApi['approve'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'approve', ...req }, () => this.approveImpl(auth, req))
    takeOver: BrowserRuntimeApi['takeOver'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'takeOver', ...req }, () => this.takeOverImpl(auth, req))
    releaseControl: BrowserRuntimeApi['releaseControl'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'releaseControl', ...req }, () => this.releaseControlImpl(auth, req))
    resume: BrowserRuntimeApi['resume'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'resume', ...req }, () => this.resumeImpl(auth, req))
    cancel: BrowserRuntimeApi['cancel'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'cancel', ...req }, () => this.cancelImpl(auth, req))
    closeSpace: BrowserRuntimeApi['closeSpace'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'closeSpace', ...req }, () => this.closeSpaceImpl(auth, req))

    private async createSpaceImpl(auth: AuthContext, req: {
        profileId: ProfileId
        requestId: RequestId
    }): Promise<{
        taskSpaceId: TaskSpaceId
    }> {
        await this.recovery
        this.checkCredential(auth, 'createSpace', req.profileId)
        const requestKeyValue = requestKey(auth, req.requestId)
        const existing = this.options.store.listSpaces().find((space) => space.requestKey === requestKeyValue)
        if (existing) {
            if (existing.requestHash !== payloadHash({ operation: 'createSpace', ...req }))
                throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input')
            return { taskSpaceId: existing.taskSpaceId }
        }
        const taskSpaceId = `space-${randomUUID()}` as TaskSpaceId
        await this.options.store.createSpace({ taskSpaceId, profileId: req.profileId, createdAtMs: this.clock.now(), tabs: [],
            tabTargets: {}, tabLeaseEpochs: {},
            owner: identity(auth), requestKey: requestKeyValue, requestHash: payloadHash({ operation: 'createSpace', ...req }),
                dedupe: {} })
        return { taskSpaceId }
    }
    private async createTaskImpl(auth: AuthContext, req: {
        taskSpaceId: TaskSpaceId
        requestId: RequestId
    }): Promise<TaskView> {
        await this.recovery
        const space = this.requireSpace(req.taskSpaceId)
        this.checkCredential(auth, 'createTask', space.profileId, req.taskSpaceId)
        this.authorizeSpace(auth, space)
        const duplicate = this.findRequest(req.requestId, auth)
        if (duplicate) {
            if (duplicate.hash !== payloadHash({ operation: 'createTask', ...req }))
                throw new BrowserRuntimeError('CONFLICT', 'requestId payload differs')
            return this.view(duplicate.result as StoredTask)
        }
        const now = this.clock.now()
        const taskId = `task-${randomUUID()}` as TaskId
        const credential = auth.credential as AgentGrant
        const task: StoredTask = { schemaVersion: SCHEMA_VERSION, taskId, taskSpaceId: req.taskSpaceId, profileId: space.profileId,
            agentSessionId: credential.agentSessionId, status: 'queued', cancelRequested: false, stateVersion: 0, highWatermarkSeq: 0,
                tabs: [], tabTargets: {}, tabLeaseEpochs: {}, uncertainActions: [], createdAtMs: now, updatedAtMs: now,
                    owner: identity(auth), agentGrant: credential,
                    actions: {}, approvals: {}, batches: {}, dedupe: {},
                    browserInstanceId: this.driver(space.profileId).browserInstanceId() }
        const saved = await this.options.store.createTask(task, this.event('task-created', { taskSpaceId: req.taskSpaceId }, 0))
        const stored = await this.saveRequest(saved, auth, req.requestId, { operation: 'createTask', ...req }, this.view(saved))
        return this.view(stored)
    }
    private async openPageImpl(auth: AuthContext, req: {
        taskId: TaskId
        url: string
        requestId: RequestId
    }): Promise<{
        tabId: TabId
        actionId: ActionId
        url: string
        task: TaskView
    }> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'openPage', task)
        const duplicate = this.taskRequest(task, auth, req.requestId, { operation: 'openPage', ...req })
        if (duplicate)
            return duplicate as {
                tabId: TabId
                actionId: ActionId
                url: string
                task: TaskView
            }
        this.assertCanStart(task)
        if (this.clock.now() - task.createdAtMs >= POC_LIMITS.taskTimeLimitMs) {
            await this.commit(task, { status: 'paused', pauseReason: 'task-time-limit' }, 'state-changed',
                { pauseReason: 'task-time-limit' })
            throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'Task time limit reached')
        }
        const grant = this.agentGrant(auth)
        const origin = assertAllowedOrigin(req.url, grant)
        const driver = this.driver(task.profileId)
        const totalTabs = this.options.store.listSpaces(task.profileId).reduce((sum, item) => sum + item.tabs.length, 0)
        if (totalTabs >= POC_LIMITS.maxActiveTabs)
            throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'Profile has reached its active tab limit')
        const actionId = `action-${randomUUID()}` as ActionId
        const reservation = this.allocateTabId()
        const epoch = this.leases.acquire(reservation, task.profileId, { kind: 'agent', agentSessionId: task.agentSessionId,
            taskId: task.taskId, segmentId: actionId })
        const running = transitionTask({ status: task.status, pauseReason: task.pauseReason }, { type: 'start' })
        await this.commit(task, { ...running, currentBatchId: undefined, actions: { ...task.actions,
            [actionId]: { state: 'intent-committed', payloadHash: payloadHash({ url: req.url }), leaseEpoch: epoch,
                browserInstanceId: driver.browserInstanceId() } } }, 'action-intent', { actionId, kind: 'navigate',
                    url: redact(req.url), phase: 'intent-committed' }, epoch)
        const controller = new AbortController()
        this.controllers.set(task.taskId, controller)
        ;(driver as DriverWithAction).armAction?.(actionId)
        this.leases.assert(reservation, task.profileId, task.taskId, actionId, epoch)
        let handle: Awaited<ReturnType<BrowserDriver['openTab']>>
        try {
            handle = await driver.openTab(req.url, grant.allowedOrigins, { signal: controller.signal, timeoutMs: 30000 })
        }
        catch (error) {
            this.leases.release(reservation, task.profileId)
            const current = this.requireTask(task.taskId)
            if (!current.cancelRequested)
                await this.commit(current, { status: 'paused', pauseReason: 'outcome-unknown', actions: { ...current.actions,
                    [actionId]: { ...current.actions[actionId], state: 'uncertain' } }, uncertainActions: [...current.uncertainActions,
                        actionId] }, 'action-uncertain', { actionId, error: safeError(error) }, epoch)
            throw new BrowserRuntimeError('OUTCOME_UNKNOWN', 'Page open result is uncertain', false, true)
        }
        const afterOpenTask = this.requireTask(task.taskId)
        const leaseAfterOpen = this.leases.owner(reservation, task.profileId)
        const browserChanged = afterOpenTask.browserInstanceId !== driver.browserInstanceId()
        if (afterOpenTask.cancelRequested || !this.isCredentialLive(auth) || leaseAfterOpen.leaseEpoch !== epoch
            || afterOpenTask.status !== 'running' || browserChanged) {
            await driver.closeTab(handle.tabId, { timeoutMs: 5000 }).catch(() => undefined)
            if (leaseAfterOpen.owner.kind === 'agent' && leaseAfterOpen.owner.taskId === task.taskId)
                this.leases.release(reservation, task.profileId)
            const actions = { ...afterOpenTask.actions, [actionId]: { ...afterOpenTask.actions[actionId], state: 'uncertain' as const } }
            await this.commit(afterOpenTask, { actions, uncertainActions: [...new Set([...afterOpenTask.uncertainActions, actionId])],
                ...(!this.isCredentialLive(auth) && !afterOpenTask.cancelRequested ? { status: 'paused',
                    pauseReason: 'grant-expired' } : browserChanged ? { status: 'paused', pauseReason: 'browser-replaced' } : {}) },
                        'late-result', { actionId, lateOpen: true, browserChanged }, epoch)
            throw new BrowserRuntimeError('OUTCOME_UNKNOWN', 'Page open completed after its execution fence changed', false, true)
        }
        const finalOrigin = await driver.currentOrigin(handle.tabId)
        if (!grant.allowedOrigins.includes(finalOrigin)) {
            await driver.closeTab(handle.tabId, { timeoutMs: 5000 })
            this.leases.release(reservation, task.profileId)
            const current = this.requireTask(task.taskId)
            await this.commit(current, { status: 'failed', actions: { ...current.actions, [actionId]: { ...current.actions[actionId],
                state: 'failed' } } }, 'action-failed', { actionId, code: 'ORIGIN_DENIED' }, epoch)
            throw new BrowserRuntimeError('ORIGIN_DENIED', 'Navigation ended at a disallowed origin')
        }
        const finalObservation = await driver.observe(handle.tabId, grant.allowedOrigins, { timeoutMs: 10000 })
        const waitReason = classifyUserWait(finalObservation.url)
        this.leases.release(reservation, task.profileId)
        const dispatched = this.requireTask(task.taskId)
        await this.commit(dispatched, { actions: { ...dispatched.actions, [actionId]: { ...dispatched.actions[actionId],
            state: 'dispatched' } } }, 'action-dispatched', { actionId }, epoch)
        const tabEpoch = this.leases.acquire(handle.tabId, task.profileId, { kind: 'agent', agentSessionId: task.agentSessionId,
            taskId: task.taskId, segmentId: actionId })
        const next = this.requireTask(task.taskId)
        const after = await this.commit(next, {
            tabs: [...next.tabs, handle.tabId],
            tabTargets: { ...next.tabTargets, [handle.tabId]: handle.targetId },
            tabLeaseEpochs: { ...next.tabLeaseEpochs, [handle.tabId]: tabEpoch },
            status: waitReason ? 'awaiting-user' : 'paused',
            pauseReason: waitReason ? undefined : 'awaiting-agent',
            ...(waitReason ? { waitReason, waitExpiresAtMs: this.clock.now() + POC_LIMITS.userWaitMs,
                waitCompletion: { tabId: handle.tabId, notPathPrefix: waitReason === 'login' ? '/login' : '/challenge' } } : {}),
            browserInstanceId: driver.browserInstanceId(), actions: { ...next.actions, [actionId]: { ...next.actions[actionId],
                state: 'confirmed' } } }, 'page-opened', { tabId: handle.tabId, actionId, origin: finalOrigin }, tabEpoch)
        if (this.controllers.get(task.taskId) === controller)
            this.controllers.delete(task.taskId)
        const space = this.requireSpace(task.taskSpaceId)
        await this.options.store.updateSpace(task.taskSpaceId, {
            tabs: [...space.tabs, handle.tabId],
            tabTargets: { ...space.tabTargets, [handle.tabId]: handle.targetId },
            tabLeaseEpochs: { ...space.tabLeaseEpochs, [handle.tabId]: tabEpoch },
        })
        const result = { tabId: handle.tabId, actionId, url: redact(req.url), task: this.view(after) }
        await this.saveTaskRequest(after, auth, req.requestId, { operation: 'openPage', ...req }, result)
        const releasedEpoch = this.leases.release(handle.tabId, task.profileId)
        await this.persistTabLease(task.taskId, task.taskSpaceId, handle.tabId, releasedEpoch)
        return result
    }
    private async closePageImpl(auth: AuthContext, req: {
        taskSpaceId: TaskSpaceId
        tabId: TabId
        requestId: RequestId
    }): Promise<{
        closed: boolean
        handoff?: 'beforeunload'
    }> {
        await this.recovery
        const space = this.requireSpace(req.taskSpaceId)
        this.checkCredential(auth, 'closePage', space.profileId, req.taskSpaceId)
        this.authorizeSpace(auth, space)
        const duplicate = this.spaceRequest(space, auth, req.requestId, { operation: 'closePage', ...req })
        if (duplicate)
            return duplicate as {
                closed: boolean
                handoff?: 'beforeunload'
            }
        if (!space.tabs.includes(req.tabId) && space.goneTabs?.includes(req.tabId)) {
            const response = { closed: false }
            await this.options.store.updateSpace(req.taskSpaceId, {
                dedupe: this.spaceDedupe(space, auth, req.requestId, { operation: 'closePage', ...req }, response),
            })
            return response
        }
        if (!space.tabs.includes(req.tabId))
            throw new BrowserRuntimeError('SCOPE_DENIED', 'Tab is not registered to this task space')
        const refs = this.options.store.listTasks().filter((task) => task.tabs.includes(req.tabId) && (!['succeeded', 'failed',
            'cancelled'].includes(task.status) || this.workers.has(task.taskId)))
        if (refs.length)
            throw new BrowserRuntimeError('CONFLICT', 'Tab is referenced by a non-terminal task')
        const lease = this.leases.owner(req.tabId, space.profileId)
        if (lease.owner.kind !== 'none')
            throw new BrowserRuntimeError('STALE_LEASE', 'Tab has an input owner')
        const result = await this.driver(space.profileId).closeTab(req.tabId, { timeoutMs: 5000 })
        if (result.beforeUnloadBlocked)
            return { closed: false, handoff: 'beforeunload' }
        const response = { closed: result.closed }
        const { [req.tabId]: _target, ...tabTargets } = space.tabTargets ?? {}
        const { [req.tabId]: _epoch, ...tabLeaseEpochs } = space.tabLeaseEpochs ?? {}
        await this.options.store.updateSpace(req.taskSpaceId, {
            tabs: space.tabs.filter((tab) => tab !== req.tabId),
            goneTabs: [...new Set([...(space.goneTabs ?? []), req.tabId])],
            tabTargets, tabLeaseEpochs,
            dedupe: this.spaceDedupe(space, auth, req.requestId, { operation: 'closePage', ...req }, response) })
        return response
    }
    async observe(auth: AuthContext, req: {
        taskId: TaskId
        tabId: TabId
        maxElements?: number
        scopeRef?: ElementRef
    }): Promise<Observation> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'observe', task)
        this.assertTaskTab(task, req.tabId)
        const result = await this.driver(task.profileId).observe(req.tabId, this.agentGrant(auth).allowedOrigins, { timeoutMs: 30000,
            maxElements: req.maxElements, scopeRef: req.scopeRef })
        if (!this.agentGrant(auth).allowedOrigins.includes(new URL(result.url).origin))
            throw new BrowserRuntimeError('ORIGIN_DENIED', 'Observed page origin is not allowed')
        return sanitizeObservation(result, this.agentGrant(auth).allowedOrigins)
    }
    async screenshot(auth: AuthContext, req: {
        taskId: TaskId
        tabId: TabId
    }): Promise<ScreenshotResult> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'screenshot', task)
        this.assertTaskTab(task, req.tabId)
        return this.driver(task.profileId).screenshot(req.tabId, this.agentGrant(auth).allowedOrigins, { timeoutMs: 30000 })
    }
    private async submitBatchImpl(auth: AuthContext, req: {
        taskId: TaskId
        expectedVersion: number
        requestId: RequestId
        steps: BatchStep[]
    }, opts?: {
        waitMs?: number
    }): Promise<{
        batchId: BatchId
        accepted: true
        task: TaskView
        result?: BatchResult
    }> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'submitBatch', task)
        const duplicate = this.taskRequest(task, auth, req.requestId, { operation: 'submitBatch', ...req })
        if (duplicate)
            return duplicate as {
                batchId: BatchId
                accepted: true
                task: TaskView
                result?: BatchResult
            }
        if (task.stateVersion !== req.expectedVersion)
            throw new BrowserRuntimeError('CONFLICT', 'Task version changed')
        this.assertCanStart(task)
        if (this.clock.now() - task.createdAtMs >= POC_LIMITS.taskTimeLimitMs) {
            await this.commit(task, { status: 'paused', pauseReason: 'task-time-limit' }, 'state-changed',
                { pauseReason: 'task-time-limit' })
            throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'Task time limit reached')
        }
        if (!req.steps.length || req.steps.length > POC_LIMITS.maxBatchSteps)
            throw new BrowserRuntimeError('INVALID_REQUEST', 'Batch size is invalid')
        const ids = new Set<string>()
        for (const step of req.steps) {
            if (ids.has(step.actionId))
                throw new BrowserRuntimeError('CONFLICT', 'actionId repeats in batch')
            ids.add(step.actionId)
            const prior = task.actions[step.actionId]
            if (prior && prior.payloadHash !== payloadHash(step))
                throw new BrowserRuntimeError('CONFLICT', 'actionId was reused with different input')
            if (!task.tabs.includes(step.tabId))
                throw new BrowserRuntimeError('SCOPE_DENIED', 'Step tab does not belong to task')
            if (step.timeoutMs <= 0 || step.timeoutMs > (step.kind === 'waitFor'
                ? POC_LIMITS.maxWaitForTimeoutMs : POC_LIMITS.maxStepTimeoutMs))
                throw new BrowserRuntimeError('INVALID_REQUEST', 'Step timeout is outside the allowed range')
        }
        const batchId = `batch-${randomUUID()}` as BatchId
        let accepted: StoredTask | null
        const hash = payloadHash({ operation: 'submitBatch', ...req })
        const key = requestKey(auth, req.requestId)
        try {
            accepted = await this.options.store.mutate(task.taskId, (current) => {
                const prior = current.dedupe[key]
                if (prior) {
                    if (prior.hash !== hash)
                        throw new BrowserRuntimeError('CONFLICT', 'requestId payload differs')
                    return null
                }
                if (current.stateVersion !== req.expectedVersion)
                    throw new BrowserRuntimeError('CONFLICT', 'Task version changed')
                this.assertCanStart(current)
                const next = transitionTask({ status: current.status, pauseReason: current.pauseReason }, { type: 'start' })
                const predictedTask = this.view({ ...current, ...next, currentBatchId: batchId, pauseReason: undefined,
                    waitReason: undefined, stateVersion: current.stateVersion + 1, highWatermarkSeq: current.highWatermarkSeq + 1,
                        updatedAtMs: this.clock.now() } as StoredTask)
                const dedupe = { ...current.dedupe, [key]: { hash, result: { batchId, accepted: true, task: predictedTask } } }
                return {
                    patch: { ...next, currentBatchId: batchId, pauseReason: undefined, waitReason: undefined, dedupe,
                        batches: { ...current.batches, [batchId]: { steps: redact(req.steps), nextStep: 0 } } },
                    event: this.event('batch-accepted', { batchId, stepCount: req.steps.length }, current.stateVersion + 1),
                    business: true,
                }
            })
            if (!accepted) {
                const current = this.requireTask(task.taskId)
                const duplicate = this.taskRequest(current, auth, req.requestId, { operation: 'submitBatch', ...req })
                if (duplicate)
                    return duplicate as {
                        batchId: BatchId
                        accepted: true
                        task: TaskView
                        result?: BatchResult
                    }
                throw new BrowserRuntimeError('CONFLICT', 'Task version changed')
            }
        }
        catch (error) {
            if (error instanceof BrowserRuntimeError && error.code === 'QUOTA_EXCEEDED')
                await this.commit(this.requireTask(task.taskId), { status: 'paused', pauseReason: 'quota' }, 'state-changed',
                    { status: 'paused', pauseReason: 'quota' })
            throw error
        }
        let resultPromise: Promise<BatchResult>
        resultPromise = this.runBatch(accepted, batchId, req.steps, auth).catch(async (error) => {
            if (error instanceof BrowserRuntimeError && error.code === 'JOURNAL_UNAVAILABLE')
                throw error
            let current = this.requireTask(task.taskId)
            if (current.status === 'running') {
                const unresolved = Object.entries(current.actions).filter(([, action]) => action.batchId === batchId && ['navigate',
                    'click', 'fill'].includes(String(action.kind)) && ['intent-committed', 'dispatched'].includes(String(action.state)))
                const uncertainActions = unresolved.map(([id]) => id as ActionId)
                const actions = { ...current.actions }
                for (const [id, action] of unresolved)
                    actions[id] = { ...action, state: 'uncertain' }
                current = await this.commit(current, {
                    status: 'paused',
                    pauseReason: uncertainActions.length ? 'outcome-unknown' : 'awaiting-agent',
                    actions,
                    ...(uncertainActions.length
                        ? { uncertainActions: [...new Set([...current.uncertainActions, ...uncertainActions])] }
                        : {}),
                }, uncertainActions.length ? 'action-uncertain' : 'action-failed', {
                    batchId,
                    error: safeError(error),
                })
            }
            const uncertain = current.pauseReason === 'outcome-unknown'
            return this.saveBatchResult(current, batchId, { batchId, taskId: current.taskId,
                outcome: uncertain ? 'uncertain' : 'failed', completedSteps: [], mayHaveSideEffects: uncertain,
                    lastCheckpointSeq: current.highWatermarkSeq + 1, steps: [{ stepId: req.steps[0].stepId,
                        actionId: req.steps[0].actionId, outcome: uncertain ? 'uncertain' : 'failed', error: safeError(error) }] })
        }).finally(() => { if (this.workers.get(task.taskId) === resultPromise)
            this.workers.delete(task.taskId); })
        void resultPromise.catch(() => undefined)
        this.workers.set(task.taskId, resultPromise)
        const waitMs = Math.max(0, opts?.waitMs ?? 0)
        if (!waitMs)
            return { batchId, accepted: true, task: this.view(accepted) }
        const result = await Promise.race([resultPromise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined),
            waitMs))])
        return { batchId, accepted: true, task: await this.getTask(auth, { taskId: task.taskId }), ...(result ? { result } : {}) }
    }
    private async finishTaskImpl(auth: AuthContext, req: {
        taskId: TaskId
        expectedVersion: number
        requestId: RequestId
    }): Promise<TaskView> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'finishTask', task)
        if (task.stateVersion !== req.expectedVersion || task.status !== 'paused' || task.pauseReason !== 'awaiting-agent'
            || task.uncertainActions.length || Object.values(task.approvals).some((a) => a.state === 'pending'))
            throw new BrowserRuntimeError('CONFLICT', 'Task is not ready to finish')
        const next = transitionTask({ status: task.status, pauseReason: task.pauseReason }, { type: 'finish' })
        return this.view(await this.commit(task, { ...next }, 'state-changed', { status: 'succeeded' }))
    }
    async getTask(auth: AuthContext, req: {
        taskId: TaskId
    }): Promise<TaskView> { await this.recovery; const task = this.requireTask(req.taskId); this.authorizeTask(auth, 'getTask',
        task); return this.view(task); }
    async subscribe(auth: AuthContext, req: {
        taskId: TaskId
        afterSeq: number
    }): Promise<SubscribeResult> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'subscribe', task)
        if (req.afterSeq < 0)
            throw new BrowserRuntimeError('INVALID_REQUEST', 'Invalid event cursor')
        const events = this.options.store.events(req.taskId, req.afterSeq, this.clock.now())
        if (!events.length && req.afterSeq < task.highWatermarkSeq && ['succeeded', 'failed',
            'cancelled'].includes(task.status) && this.clock.now() - task.updatedAtMs > POC_LIMITS.eventRetentionMs)
            return { kind: 'snapshot-required', snapshot: this.view(task), highWatermarkSeq: task.highWatermarkSeq }
        if (events.length && req.afterSeq < events[0].seq - 1)
            return { kind: 'snapshot-required', snapshot: this.view(task), highWatermarkSeq: task.highWatermarkSeq }
        return { kind: 'events', events, highWatermarkSeq: task.highWatermarkSeq }
    }
    async waitForEvents(taskId: TaskId, afterSeq: number, waitMs: number): Promise<SubscribeResult> {
        await this.recovery
        const read = () => {
            const task = this.requireTask(taskId)
            const events = this.options.store.events(taskId, afterSeq, this.clock.now())
            if (events.length && afterSeq < events[0].seq - 1)
                return { kind: 'snapshot-required' as const, snapshot: this.view(task), highWatermarkSeq: task.highWatermarkSeq }
            return { kind: 'events' as const, events, highWatermarkSeq: task.highWatermarkSeq }
        }
        const first = read()
        if (first.kind === 'snapshot-required' || first.events.length || waitMs <= 0)
            return first
        await new Promise<void>((resolve) => {
            const waiters = this.eventWaiters.get(taskId) ?? new Set<() => void>()
            const finish = () => { clearTimeout(timer); waiters.delete(finish); resolve(); }
            const timer = setTimeout(finish, waitMs)
            waiters.add(finish)
            this.eventWaiters.set(taskId, waiters)
        })
        return read()
    }
    async onDriverDisconnected(profileId: ProfileId): Promise<void> {
        await this.recovery
        for (const task of this.options.store.listTasks()) {
            if (task.profileId !== profileId || ['succeeded', 'failed', 'cancelled'].includes(task.status))
                continue
            if (task.status === 'recovering')
                continue
            const writeIds = inFlightWriteActions(task)
            const inflight = Object.entries(task.actions).filter(([, action]) => ['intent-committed', 'dispatched'].includes(action.state))
            const actions = { ...task.actions }
            for (const [id, action] of inflight) {
                if (['navigate', 'click', 'fill'].includes(String(action.kind)))
                    actions[id] = { ...action, state: 'uncertain' }
            }
            const writes = writeIds
            const pauseReason = writes.length ? 'outcome-unknown' : undefined
            await this.commit(task, { status: 'recovering', previousDriverStatus: task.status, ...(pauseReason ? { pauseReason,
                uncertainActions: [...new Set([...task.uncertainActions, ...writes])] } : {}), actions }, 'recovered',
                    { driver: 'disconnected', inFlightWrites: writes })
        }
    }
    async onDriverReconnected(profileId: ProfileId): Promise<void> {
        await this.recovery
        await this.restorePersistedTabs(profileId)
        const driver = this.drivers.get(profileId)
        let currentInstance: BrowserInstanceId | undefined
        try {
            currentInstance = driver?.browserInstanceId()
        }
        catch {
            currentInstance = undefined
        }
        for (const task of this.options.store.listTasks()) {
            if (task.profileId !== profileId || task.status !== 'recovering')
                continue
            const replaced = !browserInstanceMatches(task, currentInstance)
            if (replaced) {
                const approvals = Object.fromEntries(Object.entries(task.approvals).map(([id, approval]) => [id, { ...approval,
                    state: approval.state === 'pending' ? 'expired' : approval.state }]))
                const space = this.requireSpace(task.taskSpaceId)
                await this.options.store.updateSpace(task.taskSpaceId, { tabs: space.tabs.filter((tab) => !task.tabs.includes(tab)) })
                await this.commit(task, { status: 'paused', pauseReason: 'browser-replaced', tabs: [], pendingApproval: undefined,
                    approvals, browserInstanceId: currentInstance }, 'recovered', { driver: 'reconnected', browserReplaced: true })
                continue
            }
            const previousStatus = task.previousDriverStatus as TaskStatus | undefined
            const previous: TaskStatus = task.pauseReason === 'outcome-unknown' ? 'paused'
                : previousStatus ?? 'paused'
            const patch: Partial<StoredTask> = previous === 'paused'
                ? { status: previous, pauseReason: task.pauseReason ?? 'awaiting-agent' as const }
                : { status: previous, pauseReason: undefined }
            await this.commit(task, { ...patch, previousDriverStatus: undefined }, 'recovered', { driver: 'reconnected',
                browserReplaced: false })
        }
    }
    async revokeGrant(grantId: GrantId): Promise<void> {
        await this.options.store.revoke(grantId)
        await this.sweep(this.clock.now())
    }
    async sweep(nowMs: number): Promise<void> {
        await this.recovery
        for (const task of this.options.store.listTasks()) {
            if (['succeeded', 'failed', 'cancelled'].includes(task.status))
                continue
            if (task.cancelRequested)
                continue
            const grant = task.agentGrant as AgentGrant | undefined
            let reason: StoredTask['pauseReason'] | undefined
            if (!grant || grant.expiresAtMs <= nowMs || this.options.store.isRevoked(grant.grantId))
                reason = 'grant-expired'
            else if (Number(task.waitExpiresAtMs ?? 0) > 0 && Number(task.waitExpiresAtMs) <= nowMs)
                reason = task.waitReason === 'approval' ? 'approval-expired' : 'user-wait-expired'
            else if (nowMs - task.createdAtMs >= POC_LIMITS.taskTimeLimitMs)
                reason = 'task-time-limit'
            else if (task.status === 'running' && !this.inFlightDriverCalls.has(task.taskId)
                && nowMs - task.updatedAtMs >= POC_LIMITS.workerStaleMs)
                reason = undefined
            if (reason) {
                if (task.status === 'paused' && task.pauseReason === reason)
                    continue
                this.leases.revokeTask(task.taskId)
                this.controllers.get(task.taskId)?.abort(new Error(reason))
                await this.commit(task, { status: 'paused', pauseReason: reason,
                    ...(reason === 'approval-expired' ? { pendingApproval: undefined } : {}) }, 'state-changed', { pauseReason: reason })
            }
            else if (task.status === 'running' && !this.inFlightDriverCalls.has(task.taskId)
                && nowMs - task.updatedAtMs >= POC_LIMITS.workerStaleMs) {
                await this.commit(task, { status: 'recovering' }, 'recovered', { reason: 'worker-heartbeat-stale' })
            }
        }
    }
    private async approveImpl(auth: AuthContext, req: {
        taskId: TaskId
        approvalId: ApprovalId
        bindingHash: string
        requestId: RequestId
        decision: 'approve' | 'reject'
    }): Promise<ApproveResult> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'approve', task)
        const approval = task.approvals[req.approvalId]
        if (!approval || approval.bindingHash !== req.bindingHash)
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval is no longer pending')
        if (approval.state === 'consumed' && approval.result)
            return { outcome: 'approved', task: this.view(task), batch: approval.result as BatchResult }
        if (approval.state !== 'pending')
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval is no longer pending')
        if (Number(approval.expiresAtMs) <= this.clock.now()) {
            await this.commit(task, { status: 'paused', pauseReason: 'approval-expired' }, 'state-changed', { status: 'paused',
                pauseReason: 'approval-expired' })
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval expired')
        }
        if (req.decision === 'reject') {
            const cancelled = await this.commit(task, { status: 'cancelled', approvals: { ...task.approvals,
                [req.approvalId]: { ...approval, state: 'rejected' } } }, 'approval-rejected', { approvalId: req.approvalId })
            return { outcome: 'rejected', task: this.view(cancelled) }
        }
        const originalGrant = task.agentGrant as AgentGrant | undefined
        if (!originalGrant || originalGrant.expiresAtMs <= this.clock.now() || this.options.store.isRevoked(originalGrant.grantId))
            throw new BrowserRuntimeError('UNAUTHORIZED', 'Agent execution grant is no longer valid')
        const originalAuth: AuthContext = { credential: originalGrant, verifiedAtMs: this.clock.now() }
        const batchRecord = task.batches[String(approval.batchId)] as {
            steps: BatchStep[]
            nextStep: number
        }
        const approvedStep = batchRecord.steps[Number(approval.nextStep)]
        const driver = this.driver(task.profileId)
        const lease = this.leases.owner(approvedStep.tabId, task.profileId)
        if (lease.leaseEpoch !== Number(approval.leaseEpoch) || driver.browserInstanceId() !== approval.browserInstanceId
            || await driver.currentOrigin(approvedStep.tabId) !== approval.origin)
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval binding changed')
        const observation = await driver.observe(approvedStep.tabId, originalGrant.allowedOrigins, { timeoutMs: approvedStep.timeoutMs })
        if (this.clock.now() >= Number(approval.expiresAtMs) || originalGrant.expiresAtMs <= this.clock.now()
            || this.options.store.isRevoked(originalGrant.grantId))
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval or execution grant expired before dispatch')
        const currentApprovalPayloadHash = payloadHash({ step: approvedStep, formValues: observedFormValues(observation.elements) })
        if (observation.documentGeneration !== Number(approval.documentGeneration)
            || currentApprovalPayloadHash !== approval.payloadHash)
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval document or payload changed')
        const expectedBinding = approvalBinding({ principalId: originalGrant.principalId, workspaceId: originalGrant.workspaceId,
            taskId: task.taskId, actionId: approvedStep.actionId, origin: String(approval.origin),
                payloadHash: String(approval.payloadHash), leaseEpoch: Number(approval.leaseEpoch),
                    browserInstanceId: String(approval.browserInstanceId), documentGeneration: Number(approval.documentGeneration),
                        expiresAtMs: Number(approval.expiresAtMs) })
        if (expectedBinding !== req.bindingHash)
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval binding changed')
        const consumed = await this.options.store.mutate(task.taskId, (current) => {
            const latestApproval = current.approvals[req.approvalId]
            if (current.cancelRequested || current.status !== 'awaiting-user' || !latestApproval || latestApproval.state !== 'pending'
                || latestApproval.bindingHash !== req.bindingHash || Number(latestApproval.expiresAtMs) <= this.clock.now()) {
                throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval changed before consumption')
            }
            const { [approvedStep.actionId]: _priorAction, ...remainingActions } = current.actions
            return {
                patch: { status: 'running', pauseReason: undefined, waitReason: undefined, actions: remainingActions,
                    approvals: { ...current.approvals, [req.approvalId]: { ...latestApproval, state: 'consumed' } } },
                event: this.event('approval-consumed', { approvalId: req.approvalId }, current.stateVersion + 1),
            }
        })
        if (!consumed)
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval changed before consumption')
        const result = await this.runBatch(consumed, approval.batchId as BatchId, batchRecord.steps, originalAuth,
            Number(approval.nextStep), approvedStep.actionId)
        const finalTask = this.requireTask(req.taskId)
        await this.commit(finalTask, { approvals: { ...finalTask.approvals, [req.approvalId]: { ...finalTask.approvals[req.approvalId],
            result } } }, 'agent-attention-required', { approvalId: req.approvalId, outcome: result.outcome })
        return { outcome: 'approved', task: this.view(this.requireTask(req.taskId)), batch: result }
    }
    private async takeOverImpl(auth: AuthContext, req: {
        taskId: TaskId
        tabId: TabId
        expectedEpoch: number
        requestId: RequestId
    }): Promise<ControlResult> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'takeOver', task)
        this.assertTaskTab(task, req.tabId)
        if (task.waitReason === 'approval')
            throw new BrowserRuntimeError('CONFLICT', 'Approval waits cannot be replaced with user takeover')
        const lease = this.leases.owner(req.tabId, task.profileId)
        if (lease.leaseEpoch !== req.expectedEpoch)
            throw new BrowserRuntimeError('STALE_LEASE', 'Lease epoch changed')
        const interactive = auth.credential as Extract<AuthContext['credential'], {
            kind: 'interactive'
        }>
        const owner: InputOwner = { kind: 'user', principalId: interactive.principalId, viewerSessionId: interactive.viewerSessionId }
        const settling = this.inFlightDriverCalls.has(task.taskId)
        const epoch = this.leases.fenceForTakeover(req.tabId, task.profileId, task.taskId, owner)
        await this.persistTabLease(task.taskId, task.taskSpaceId, req.tabId, epoch, { tabId: req.tabId, owner })
        await this.persistProfileUserOwner(task.profileId, { tabId: req.tabId, owner })
        if (!settling)
            this.leases.completePendingTakeovers(task.taskId)
        const pending = Object.entries(task.actions).filter(([, action]) => ['click', 'fill',
            'navigate'].includes(String(action.kind)) && ['intent-committed', 'dispatched'].includes(String(action.state)))
        const actions = { ...task.actions }
        for (const [id, action] of pending)
            actions[id] = { ...action, state: 'uncertain' }
        const paused = await this.commit(task, { status: 'paused', pauseReason: 'user-control', actions,
            ...(pending.length ? { uncertainActions: [...new Set([...task.uncertainActions,
                ...pending.map(([id]) => id as ActionId)])] } : {}) }, 'input-owner-changed', { tabId: req.tabId, owner: 'user',
                    unsettledActions: pending.map(([id]) => id), settling }, epoch)
        this.controllers.get(task.taskId)?.abort(new Error('user takeover'))
        const currentOwner = this.leases.owner(req.tabId, task.profileId).owner
        return { leaseEpoch: epoch, owner: currentOwner, task: this.view(paused), settling }
    }
    private async releaseControlImpl(auth: AuthContext, req: {
        taskId: TaskId
        tabId: TabId
        expectedEpoch: number
        requestId: RequestId
    }): Promise<ControlResult> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'releaseControl', task)
        this.assertTaskTab(task, req.tabId)
        const current = this.leases.owner(req.tabId, task.profileId)
        const interactive = auth.credential as Extract<AuthContext['credential'], {
            kind: 'interactive'
        }>
        if (current.leaseEpoch !== req.expectedEpoch || current.owner.kind !== 'user'
            || current.owner.principalId !== interactive.principalId || current.owner.viewerSessionId !== interactive.viewerSessionId)
            throw new BrowserRuntimeError('STALE_LEASE', 'User lease changed')
        const epoch = this.leases.release(req.tabId, task.profileId)
        await this.persistTabLease(task.taskId, task.taskSpaceId, req.tabId, epoch, null)
        await this.persistProfileUserOwner(task.profileId, null)
        const next = await this.commit(task, { status: 'paused', pauseReason: 'user-input-complete' }, 'input-owner-changed',
            { tabId: req.tabId, owner: 'none' }, epoch)
        return { leaseEpoch: epoch, owner: { kind: 'none' }, task: this.view(next) }
    }
    private async resumeImpl(auth: AuthContext, req: {
        taskId: TaskId
        expectedVersion: number
        requestId: RequestId
    }): Promise<TaskView> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'resume', task)
        if (task.cancelRequested || ['user-control', 'quota', 'task-time-limit', 'outcome-unknown',
            'cancelled-with-unknown-effect'].includes(task.pauseReason ?? '') || task.uncertainActions.length)
            throw new BrowserRuntimeError('CONFLICT', 'Task pause cannot be resumed directly')
        if (task.stateVersion !== req.expectedVersion || task.status !== 'paused' || !['awaiting-agent', 'user-input-complete',
            'approval-expired', 'grant-expired', 'browser-replaced'].includes(task.pauseReason ?? ''))
            throw new BrowserRuntimeError('CONFLICT', 'Task is not resumable')
        if (auth.credential.kind !== 'agent-grant')
            throw new BrowserRuntimeError('SCOPE_DENIED', 'Agent grant required to resume')
        if (task.pauseReason === 'grant-expired')
            task.agentGrant = auth.credential
        if (task.pauseReason === 'user-input-complete' && task.waitReason) {
            if (Number(task.waitExpiresAtMs ?? 0) > 0 && this.clock.now() > Number(task.waitExpiresAtMs))
                return this.view(await this.commit(task, { status: 'paused', pauseReason: 'user-wait-expired' }, 'state-changed',
                    { pauseReason: 'user-wait-expired', waitReason: task.waitReason }))
            const wait = task.waitCompletion as {
                batchId?: string
                nextStep?: number
                tabId: TabId
                predicate: BatchStep['until']
                notPathPrefix?: string
            } | undefined
            if (!wait?.predicate && !wait?.notPathPrefix)
                throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Wait completion condition is missing')
            const observation = await this.driver(task.profileId).observe(wait.tabId, auth.credential.allowedOrigins, { timeoutMs: 10000 })
            const waitCompleted = wait.notPathPrefix
                ? !new URL(observation.url).pathname.startsWith(wait.notPathPrefix)
                : matchesWait(wait.predicate!, observation)
            if (!waitCompleted)
                return this.view(await this.commit(task, { status: 'awaiting-user' }, 'state-changed', { status: 'awaiting-user',
                    waitReason: task.waitReason }))
            if (!wait.batchId) {
                return this.view(await this.commit(task, {
                    status: 'paused',
                    pauseReason: 'awaiting-agent',
                    waitReason: undefined,
                    waitCompletion: undefined,
                    waitExpiresAtMs: undefined,
                    agentGrant: auth.credential,
                }, 'state-changed', { status: 'paused', pauseReason: 'awaiting-agent', waitCompleted: true }))
            }
            const record = task.batches[wait.batchId] as {
                steps: BatchStep[]
            }
            const resumeAt = Number(wait.nextStep ?? 0)
            const running = await this.commit(task, { status: 'running', pauseReason: undefined, waitReason: undefined,
                waitCompletion: undefined, browserInstanceId: this.driver(task.profileId).browserInstanceId(),
                    batches: { ...task.batches, [wait.batchId]: { ...record, nextStep: resumeAt } } }, 'state-changed',
                        { status: 'running', resumedAfter: task.waitReason })
            await this.runBatch(running, wait.batchId as BatchId, record.steps, auth, resumeAt)
            return this.view(this.requireTask(task.taskId))
        }
        if (task.pauseReason === 'approval-expired' || task.pauseReason === 'user-wait-expired') {
            const approvalEntry = Object.entries(task.approvals).find(([, approval]) => approval.state === 'pending')
            if (approvalEntry) {
                const [approvalId, approval] = approvalEntry
                const batch = task.batches[String(approval.batchId)] as {
                    steps: BatchStep[]
                    nextStep: number
                }
                const { [String(approval.actionId)]: _oldAction, ...actions } = task.actions
                const approvals = { ...task.approvals, [approvalId]: { ...approval, state: 'expired' as const } }
                const running = await this.commit(task, { status: 'running', pauseReason: undefined, waitReason: undefined,
                    pendingApproval: undefined, agentGrant: auth.credential, actions, approvals }, 'state-changed',
                        { status: 'running', approvalExpired: approvalId })
                await this.runBatch(running, approval.batchId as BatchId, batch.steps, auth, Number(approval.nextStep))
                return this.view(this.requireTask(task.taskId))
            }
        }
        if (task.pauseReason === 'browser-replaced') {
            const driver = this.driver(task.profileId)
            for (const tab of task.tabs)
                if (!driver.hasTab(tab))
                    throw new BrowserRuntimeError('TARGET_GONE', 'Task tabs were lost with the browser instance')
            return this.view(await this.commit(task, { status: 'paused', pauseReason: 'awaiting-agent',
                browserInstanceId: driver.browserInstanceId() }, 'recovered', { browserInstanceId: driver.browserInstanceId() }))
        }
        if (task.pauseReason === 'awaiting-agent')
            return this.view(task)
        return this.view(await this.commit(task, { status: 'paused', pauseReason: 'awaiting-agent', agentGrant: auth.credential },
            'state-changed', { status: 'paused', pauseReason: 'awaiting-agent' }))
    }
    private async cancelImpl(auth: AuthContext, req: {
        taskId: TaskId
        requestId: RequestId
    }): Promise<{
        status: 'cancel-accepted'
        task: TaskView
        fenceAckMs: number
    }> {
        await this.recovery
        const started = this.clock.now()
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'cancel', task)
        if (['succeeded', 'failed', 'cancelled'].includes(task.status))
            return { status: 'cancel-accepted', task: this.view(task), fenceAckMs: Math.max(0, this.clock.now() - started) }
        const revokedLeases = this.leases.revokeTask(task.taskId)
        for (const lease of revokedLeases)
            await this.persistTabLease(task.taskId, task.taskSpaceId, lease.tabId, lease.leaseEpoch)
        this.controllers.get(task.taskId)?.abort(new Error('cancelled'))
        const uncertain = [...new Set([...task.uncertainActions, ...Object.entries(task.actions).filter(([, action]) => ['navigate',
            'click', 'fill'].includes(String(action.kind)) && (action.state === 'intent-committed'
                || action.state === 'dispatched')).map(([id]) => id as ActionId)])]
        const next = await this.commit(task, { cancelRequested: true, status: uncertain.length ? 'paused' : 'cancelled',
            ...(uncertain.length ? { pauseReason: 'cancelled-with-unknown-effect',
                uncertainActions: [...new Set([...task.uncertainActions, ...uncertain])] } : {}) }, 'cancel-accepted',
                    { cancelRequested: true, uncertainActions: uncertain })
        return { status: 'cancel-accepted', task: this.view(next), fenceAckMs: Math.max(0, this.clock.now() - started) }
    }
    private async closeSpaceImpl(auth: AuthContext, req: {
        taskSpaceId: TaskSpaceId
        requestId: RequestId
    }): Promise<{
        closedTabs: TabId[]
    }> {
        await this.recovery
        const space = this.requireSpace(req.taskSpaceId)
        this.checkCredential(auth, 'closeSpace', space.profileId, req.taskSpaceId)
        this.authorizeSpace(auth, space)
        const duplicate = this.spaceRequest(space, auth, req.requestId, { operation: 'closeSpace', ...req })
        if (duplicate)
            return duplicate as {
                closedTabs: TabId[]
            }
        if (this.options.store.listTasks().some((task) => task.taskSpaceId === req.taskSpaceId && (!['succeeded', 'failed',
            'cancelled'].includes(task.status) || this.workers.has(task.taskId))))
            throw new BrowserRuntimeError('CONFLICT', 'Task space has non-terminal or in-flight tasks')
        const closedTabs: TabId[] = []
        for (const tab of space.tabs) {
            if (this.leases.owner(tab as TabId, space.profileId).owner.kind !== 'none')
                throw new BrowserRuntimeError('STALE_LEASE', 'Task space has an input owner')
            await this.driver(space.profileId).closeTab(tab as TabId, { timeoutMs: 5000 })
            closedTabs.push(tab as TabId)
        }
        const response = { closedTabs }
        await this.options.store.updateSpace(req.taskSpaceId, {
            tabs: [], tabTargets: {}, tabLeaseEpochs: {}, profileUserOwner: null, closed: true,
            dedupe: this.spaceDedupe(space, auth, req.requestId, { operation: 'closeSpace', ...req }, response),
        })
        return response
    }
    async reconcileAction(taskId: TaskId, actionId: ActionId, confirmed: boolean): Promise<TaskView> {
        await this.recovery
        const task = this.requireTask(taskId)
        const action = task.actions[actionId]
        if (!action || action.state !== 'uncertain')
            throw new BrowserRuntimeError('CONFLICT', 'Action is not uncertain')
        const state = confirmed ? 'confirmed' as const : 'uncertain' as const
        const actions = { ...task.actions, [actionId]: { ...action, state } }
        const uncertainActions = confirmed ? task.uncertainActions.filter((id) => id !== actionId) : task.uncertainActions
        const status = task.cancelRequested && confirmed && uncertainActions.length === 0 ? 'cancelled' : task.status
        const updated = await this.commit(task, { actions, uncertainActions, status,
            ...(status === 'cancelled' ? { pauseReason: undefined } : uncertainActions.length === 0
                && !task.cancelRequested ? { pauseReason: 'awaiting-agent' } : {}) },
                    confirmed ? 'action-confirmed' : 'action-uncertain', { actionId, reconciled: confirmed })
        return this.view(updated)
    }
    private async withRequestFlight<T>(
        auth: AuthContext,
        requestId: RequestId,
        payload: unknown,
        run: () => Promise<T>,
    ): Promise<T> {
        await this.recovery
        this.assertMutationScope(auth, payload)
        const key = requestKey(auth, requestId)
        const hash = payloadHash(payload)
        const stored = this.findDurableRequest(key)
        if (stored) {
            if (stored.hash !== hash)
                throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input')
            return structuredClone(stored.result) as T
        }
        const active = this.requestFlights.get(key)
        if (active) {
            if (active.hash !== hash)
                throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input')
            return structuredClone(await active.promise) as T
        }
        const promise = (async () => {
            const result = await run()
            await this.persistRequestResult(key, hash, payload, result)
            return result
        })()
        this.requestFlights.set(key, { hash, promise })
        try {
            return await promise
        } finally {
            if (this.requestFlights.get(key)?.promise === promise)
                this.requestFlights.delete(key)
        }
    }
    private assertMutationScope(auth: AuthContext, payload: unknown): void {
        if (!isRecord(payload) || typeof payload.operation !== 'string')
            throw new BrowserRuntimeError('INVALID_REQUEST', 'Mutation operation is missing')
        const operation = payload.operation as Operation
        if (typeof payload.taskId === 'string') {
            const task = this.requireTask(payload.taskId as TaskId)
            this.authorizeTask(auth, operation, task)
            return
        }
        if (typeof payload.taskSpaceId === 'string') {
            const space = this.requireSpace(payload.taskSpaceId as TaskSpaceId)
            this.checkCredential(auth, operation, space.profileId, space.taskSpaceId)
            this.authorizeSpace(auth, space)
            return
        }
        if (typeof payload.profileId === 'string') {
            this.checkCredential(auth, operation, payload.profileId as ProfileId)
            return
        }
        throw new BrowserRuntimeError('INVALID_REQUEST', 'Mutation resource is missing')
    }
    private findDurableRequest(key: string): { hash: string; result: unknown } | undefined {
        for (const task of this.options.store.listTasks()) {
            const value = task.dedupe[key]
            if (value) return value
        }
        for (const space of this.options.store.listSpaces()) {
            const value = space.dedupe?.[key]
            if (value) return value
            if (space.requestKey === key && space.requestHash)
                return { hash: space.requestHash, result: { taskSpaceId: space.taskSpaceId } }
        }
        return undefined
    }
    private async persistRequestResult(key: string, hash: string, payload: unknown, result: unknown): Promise<void> {
        if (this.findDurableRequest(key)) return
        const payloadRecord = isRecord(payload) ? payload : {}
        const resultRecord = isRecord(result) ? result : {}
        const nestedTask = isRecord(resultRecord.task) ? resultRecord.task : undefined
        const taskIdValue = payloadRecord.taskId ?? resultRecord.taskId ?? nestedTask?.taskId
        if (typeof taskIdValue === 'string') {
            const taskId = taskIdValue as TaskId
            await this.options.store.mutate(taskId, (current) => {
                const existing = current.dedupe[key]
                if (existing) {
                    if (existing.hash !== hash)
                        throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input')
                    return null
                }
                return {
                    patch: { dedupe: { ...current.dedupe, [key]: { hash, result: redact(result) } }, stateVersion: current.stateVersion },
                    event: this.event('state-changed', { requestStored: true }, current.stateVersion),
                }
            })
            return
        }
        const spaceIdValue = payloadRecord.taskSpaceId ?? resultRecord.taskSpaceId
        if (typeof spaceIdValue === 'string') {
            const spaceId = spaceIdValue as TaskSpaceId
            await this.options.store.mutateSpace(spaceId, (current) => {
                const existing = current.dedupe?.[key]
                if (existing) {
                    if (existing.hash !== hash)
                        throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input')
                    return null
                }
                return { dedupe: { ...current.dedupe, [key]: { hash, result: redact(result) } } }
            })
        }
    }
    private async persistTabLease(taskId: TaskId, taskSpaceId: TaskSpaceId, tabId: TabId, epoch: number,
        profileUserOwner?: SpaceRecord['profileUserOwner']): Promise<void> {
        await this.options.store.mutate(taskId, (current) => ({
            patch: {
                tabLeaseEpochs: { ...current.tabLeaseEpochs, [tabId]: epoch },
                stateVersion: current.stateVersion,
            },
            event: this.event('state-changed', { tabId, leaseEpochStored: true }, current.stateVersion),
        }))
        await this.options.store.mutateSpace(taskSpaceId, (current) => ({
            tabLeaseEpochs: { ...current.tabLeaseEpochs, [tabId]: epoch },
            ...(profileUserOwner === undefined ? {} : { profileUserOwner }),
        }))
    }
    private async persistProfileUserOwner(profileId: ProfileId,
        profileUserOwner: SpaceRecord['profileUserOwner']): Promise<void> {
        for (const space of this.options.store.listSpaces(profileId))
            await this.options.store.updateSpace(space.taskSpaceId, { profileUserOwner })
    }
    private async restorePersistedTabs(profileId?: ProfileId): Promise<void> {
        for (const space of this.options.store.listSpaces(profileId)) {
            const driver = this.drivers.get(space.profileId)
            if (!driver)
                continue
            let currentInstance: BrowserInstanceId | undefined
            try {
                currentInstance = driver.browserInstanceId()
            }
            catch {
                currentInstance = undefined
            }
            const profileOwner = this.options.store.listSpaces(space.profileId)
                .map((item) => item.profileUserOwner)
                .find((owner) => owner != null) ?? undefined
            for (const tabId of [...space.tabs]) {
                const references = this.options.store.listTasks().filter((task) => task.tabs.includes(tabId))
                const targetId = space.tabTargets?.[tabId]
                    ?? references.map((task) => task.tabTargets?.[tabId]).find((target): target is string => Boolean(target))
                const browserMatches = Boolean(currentInstance) && references.every((task) =>
                    !task.browserInstanceId || task.browserInstanceId === currentInstance)
                const allowedOrigins = references.flatMap((task) => (task.agentGrant as AgentGrant | undefined)?.allowedOrigins ?? [])
                let adopted = false
                if (browserMatches && targetId && driver.adoptTab) {
                    adopted = await driver.adoptTab(tabId, targetId, [...new Set(allowedOrigins)], { timeoutMs: 10000 })
                }
                else if (browserMatches) {
                    adopted = driver.hasTab(tabId)
                }
                if (!adopted) {
                    await this.dropOwnedTab(space, tabId, references)
                    continue
                }
                const previousEpoch = Math.max(space.tabLeaseEpochs?.[tabId] ?? 0,
                    ...references.map((task) => task.tabLeaseEpochs?.[tabId] ?? 0))
                const persistedOwner = profileOwner?.tabId === tabId ? profileOwner.owner : { kind: 'none' as const }
                const epoch = this.leases.restore(tabId, space.profileId, previousEpoch, persistedOwner)
                await this.options.store.mutateSpace(space.taskSpaceId, (current) => ({
                    tabLeaseEpochs: { ...current.tabLeaseEpochs, [tabId]: epoch },
                }))
                for (const task of references) {
                    await this.options.store.mutate(task.taskId, (current) => ({
                        patch: {
                            ...(targetId ? { tabTargets: { ...current.tabTargets, [tabId]: targetId } } : {}),
                            tabLeaseEpochs: { ...current.tabLeaseEpochs, [tabId]: epoch },
                            stateVersion: current.stateVersion,
                        },
                        event: this.event('state-changed', { tabId, leaseEpochRestored: true }, current.stateVersion),
                    }))
                }
            }
        }
    }
    private async dropOwnedTab(space: SpaceRecord, tabId: TabId, references: StoredTask[]): Promise<void> {
        await this.options.store.mutateSpace(space.taskSpaceId, (current) => {
            const { [tabId]: _target, ...tabTargets } = current.tabTargets ?? {}
            const { [tabId]: _epoch, ...tabLeaseEpochs } = current.tabLeaseEpochs ?? {}
            return {
                tabs: current.tabs.filter((tab) => tab !== tabId),
                goneTabs: [...new Set([...(current.goneTabs ?? []), tabId])],
                tabTargets,
                tabLeaseEpochs,
            }
        })
        for (const task of references) {
            await this.commit(task, {
                tabs: task.tabs.filter((tab) => tab !== tabId),
                tabTargets: Object.fromEntries(Object.entries(task.tabTargets ?? {}).filter(([tab]) => tab !== tabId)),
                tabLeaseEpochs: Object.fromEntries(Object.entries(task.tabLeaseEpochs ?? {}).filter(([tab]) => tab !== tabId)),
            }, 'page-closed', { tabId, reason: 'gone' })
        }
    }
    private async recoverExistingTasks(): Promise<void> {
        await this.restorePersistedTabs()
        for (const task of this.options.store.listTasks()) {
            if (['succeeded', 'failed', 'cancelled'].includes(task.status))
                continue
            const driver = this.drivers.get(task.profileId)
            const taskGrant = task.agentGrant as AgentGrant | undefined
            const pendingWriteIds = inFlightWriteActions(task)
            const pendingWrites = pendingWriteIds.map((id) => [id, task.actions[id]] as const)
            const actions = { ...task.actions }
            for (const [id, action] of pendingWrites)
                actions[id] = { ...action, state: 'uncertain' }
            let patch: Partial<StoredTask>
            if (task.cancelRequested) {
                const unresolved = [...new Set([...task.uncertainActions, ...pendingWrites.map(([id]) => id as ActionId)])]
                patch = unresolved.length ? { status: 'paused', pauseReason: 'cancelled-with-unknown-effect',
                    uncertainActions: unresolved, actions } : { status: 'cancelled' }
            }
            else if (!taskGrant || taskGrant.expiresAtMs <= this.clock.now()
                || this.options.store.isRevoked(taskGrant.grantId)) {
                patch = { status: 'paused', pauseReason: 'grant-expired', actions }
            }
            else if (!driver || !browserInstanceMatches(task, driver.browserInstanceId())) {
                patch = { status: 'paused', pauseReason: 'browser-replaced', browserInstanceId: driver?.browserInstanceId(), actions,
                    pendingApproval: undefined }
            }
            else if (pendingWrites.length) {
                patch = { status: 'paused', pauseReason: 'outcome-unknown', uncertainActions: [...new Set([...task.uncertainActions,
                    ...pendingWrites.map(([id]) => id as ActionId)])], actions }
            }
            else if (task.status === 'running' || task.status === 'recovering') {
                const batchId = task.currentBatchId
                const batch = batchId ? task.batches[batchId] : undefined
                const completedSteps = batch?.steps
                    .filter((step) => task.actions[step.actionId]?.state === 'confirmed')
                    .map((step) => step.stepId) ?? []
                const interrupted: BatchResult | undefined = batch && batchId ? {
                    batchId,
                    taskId: task.taskId,
                    outcome: 'failed',
                    completedSteps,
                    mayHaveSideEffects: false,
                    lastCheckpointSeq: task.highWatermarkSeq + 1,
                    steps: batch.steps
                        .filter((step) => completedSteps.includes(step.stepId))
                        .map((step) => ({ stepId: step.stepId, actionId: step.actionId, outcome: 'succeeded' })),
                } : undefined
                const interruptedBatch = batch && interrupted ? { ...batch, result: interrupted } : undefined
                patch = {
                    status: 'paused',
                    pauseReason: 'awaiting-agent',
                    actions,
                    currentBatchId: undefined,
                    ...(interrupted && batchId && interruptedBatch ? {
                        lastBatch: interrupted,
                        batches: { ...task.batches, [batchId]: interruptedBatch },
                    } : {}),
                }
            }
            else
                continue
            await this.commit(task, patch, 'recovered', { previousStatus: task.status, pauseReason: patch.pauseReason,
                uncertainActions: patch.uncertainActions ?? [] })
        }
    }
    pinnedProfiles(nowMs = this.clock.now()): ProfileId[] {
        const profiles = new Set<ProfileId>()
        for (const task of this.options.store.listTasks()) {
            const age = nowMs - task.updatedAtMs
            if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
                if (age <= POC_LIMITS.terminalBrowserIdleMs)
                    profiles.add(task.profileId)
                continue
            }
            if (task.status === 'running' || task.status === 'recovering'
                || task.status === 'awaiting-user'
                    && age <= POC_LIMITS.userWaitMs + POC_LIMITS.pausedBrowserRetentionMs
                || task.status !== 'awaiting-user' && age <= POC_LIMITS.pausedBrowserRetentionMs)
                profiles.add(task.profileId)
        }
        return [...profiles]
    }
    private async runBatch(task0: StoredTask, batchId: BatchId, steps: BatchStep[], auth: AuthContext, fromIndex = 0,
        approvedActionId?: ActionId): Promise<BatchResult> {
        const results: BatchResult['steps'] = []
        const completedSteps: BatchResult['completedSteps'] = []
        let failedStep: BatchResult['failedStep']
        let outcome: BatchResult['outcome'] = 'succeeded'
        let mayHaveSideEffects = false
        const driver = this.driver(task0.profileId)
        const grant = this.agentGrant(auth)
        const controller = this.controllers.get(task0.taskId) ?? new AbortController()
        this.controllers.set(task0.taskId, controller)
        const batchLeases = new Map<TabId, number>()
        let preserveLeases = false
        try {
            for (let index = fromIndex; index < steps.length; index++) {
                const step = steps[index]
                let task = this.requireTask(task0.taskId)
                if (task.cancelRequested) {
                    outcome = 'cancelled'
                    break
                }
                if (!this.isCredentialLive(auth)) {
                    this.leases.revokeTask(task.taskId)
                    await this.commit(task, { status: 'paused', pauseReason: 'grant-expired' }, 'state-changed',
                        { pauseReason: 'grant-expired' })
                    outcome = 'failed'
                    break
                }
                if (this.clock.now() - task.createdAtMs >= POC_LIMITS.taskTimeLimitMs) {
                    this.leases.revokeTask(task.taskId)
                    await this.commit(task, { status: 'paused', pauseReason: 'task-time-limit' }, 'state-changed',
                        { pauseReason: 'task-time-limit' })
                    outcome = 'failed'
                    break
                }
                if (task.browserInstanceId !== driver.browserInstanceId()) {
                    await this.commit(task, { status: 'paused', pauseReason: 'browser-replaced',
                        browserInstanceId: driver.browserInstanceId() }, 'state-changed', { pauseReason: 'browser-replaced' })
                    outcome = 'failed'
                    break
                }
                const origin = await driver.currentOrigin(step.tabId)
                if (!grant.allowedOrigins.includes(origin))
                    throw new BrowserRuntimeError('ORIGIN_DENIED', 'Current page origin is not allowed')
                let leaseEpoch = batchLeases.get(step.tabId)
                if (leaseEpoch === undefined) {
                    leaseEpoch = this.leases.acquire(step.tabId, task.profileId, { kind: 'agent', agentSessionId: task.agentSessionId,
                        taskId: task.taskId, segmentId: batchId })
                    batchLeases.set(step.tabId, leaseEpoch)
                    await this.persistTabLease(task.taskId, task.taskSpaceId, step.tabId, leaseEpoch)
                }
                const action = task.actions[step.actionId]
                if (action) {
                    if (action.payloadHash !== payloadHash(step))
                        throw new BrowserRuntimeError('CONFLICT', 'actionId has been used with different input')
                    if (action.state === 'confirmed') {
                        completedSteps.push(step.stepId)
                        results.push({ stepId: step.stepId, actionId: step.actionId, outcome: 'succeeded' })
                        continue
                    }
                    throw new BrowserRuntimeError('OUTCOME_UNKNOWN', 'actionId has an unresolved prior result', false, true)
                }
                task = await this.commit(task, { actions: { ...task.actions, [step.actionId]: { state: 'intent-committed',
                    kind: step.kind, batchId, payloadHash: payloadHash(step), leaseEpoch,
                        browserInstanceId: driver.browserInstanceId() } }, batches: { ...task.batches, [batchId]: { steps,
                            nextStep: index } } }, 'action-intent', { actionId: step.actionId, kind: step.kind,
                                payloadHash: payloadHash(step) }, leaseEpoch)
                const observed = ['click', 'fill'].includes(step.kind) ? await driver.observe(step.tabId, grant.allowedOrigins,
                    { timeoutMs: step.timeoutMs }) : undefined
                const element = observed?.elements.find((candidate) => candidate.ref === step.ref)
                if (classifyAction(step, element, undefined, observed?.url) === 'approval-required' && step.actionId !== approvedActionId) {
                    const expiresAtMs = this.clock.now() + POC_LIMITS.userWaitMs
                    const approval = createApproval({
                        grant,
                        taskId: task.taskId,
                        batchId,
                        step,
                        nextStep: index,
                        origin,
                        leaseEpoch,
                        browserInstanceId: driver.browserInstanceId(),
                        documentGeneration: observed?.documentGeneration ?? 0,
                        elementName: element?.name,
                        formValues: observedFormValues(observed?.elements ?? []),
                        expiresAtMs,
                    })
                    const approvalId = approval.summary.approvalId
                    const pendingApproval = approval.summary
                    const approvals = { ...task.approvals, [approvalId]: approval.record }
                    task = await this.commit(task, {
                        status: 'awaiting-user',
                        waitReason: 'approval',
                        waitExpiresAtMs: expiresAtMs,
                        pendingApproval,
                        actions: { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state: 'planned' } },
                            approvals }, 'approval-requested', {
                                approvalId,
                                actionId: step.actionId,
                                origin,
                                bindingHash: pendingApproval.bindingHash,
                            }, leaseEpoch)
                    preserveLeases = true
                    return this.saveBatchResult(task, batchId, { batchId, taskId: task.taskId, outcome: 'awaiting-user',
                        completedSteps, mayHaveSideEffects: false, lastCheckpointSeq: task.highWatermarkSeq + 1, steps: results,
                            pendingApproval, waitReason: 'approval' })
                }
                if (step.kind === 'waitFor') {
                    const pageUrl = await driver.currentOrigin(step.tabId)
                    const observedPage = await driver.observe(step.tabId, grant.allowedOrigins, { timeoutMs: step.timeoutMs })
                    const waitReason = classifyUserWait(observedPage.url)
                    if (waitReason) {
                        task = await this.commit(task, { status: 'awaiting-user', waitReason,
                            waitExpiresAtMs: this.clock.now() + POC_LIMITS.userWaitMs, waitCompletion: { batchId, nextStep: index,
                                tabId: step.tabId, notPathPrefix: waitReason === 'login' ? '/login' : '/challenge',
                                protectedOrigin: pageUrl } }, 'state-changed',
                                    { status: 'awaiting-user', waitReason, actionId: step.actionId }, leaseEpoch)
                        preserveLeases = true
                        return this.saveBatchResult(task, batchId, { batchId, taskId: task.taskId, outcome: 'awaiting-user',
                            completedSteps, mayHaveSideEffects: false, lastCheckpointSeq: task.highWatermarkSeq + 1, steps: results,
                                waitReason })
                    }
                }
                task = this.requireTask(task.taskId)
                if (task.cancelRequested || task.status !== 'running' || !this.isCredentialLive(auth)
                    || task.browserInstanceId !== driver.browserInstanceId())
                    throw new BrowserRuntimeError('STALE_LEASE', 'Task execution fence changed')
                if (this.leases.owner(step.tabId, task.profileId).leaseEpoch !== leaseEpoch
                    || await driver.currentOrigin(step.tabId) !== origin)
                    throw new BrowserRuntimeError('STALE_LEASE', 'Input lease or origin changed before dispatch')
                this.leases.assert(step.tabId, task.profileId, task.taskId, batchId, leaseEpoch)
                const armed = driver as DriverWithAction
                armed.armAction?.(step.actionId)
                this.inFlightDriverCalls.add(task.taskId)
                try {
                    await this.dispatch(driver, step, observed, grant, controller.signal)
                    const finalOrigin = await driver.currentOrigin(step.tabId)
                    if (!grant.allowedOrigins.includes(finalOrigin))
                        throw new BrowserRuntimeError('ORIGIN_DENIED', 'Action navigated to a disallowed origin', false, true)
                    const finalObservation = step.kind === 'navigate'
                        ? await driver.observe(step.tabId, grant.allowedOrigins, { timeoutMs: step.timeoutMs })
                        : undefined
                    const landedWaitReason = finalObservation ? classifyUserWait(finalObservation.url) : undefined
                    task = this.requireTask(task.taskId)
                    if (task.cancelRequested || this.leases.owner(step.tabId,
                        task.profileId).leaseEpoch !== leaseEpoch || task.status !== 'running') {
                        const uncertain = ['click', 'fill', 'navigate'].includes(step.kind)
                        const state = uncertain ? 'uncertain' as const : 'skipped' as const
                        await this.commit(task, { actions: { ...task.actions, [step.actionId]: { ...task.actions[step.actionId],
                            state } }, ...(uncertain ? { uncertainActions: [...new Set([...task.uncertainActions,
                                step.actionId])] } : {}) }, 'late-result', { actionId: step.actionId, ignored: true }, leaseEpoch)
                        outcome = uncertain ? 'uncertain' : 'cancelled'
                        mayHaveSideEffects = uncertain
                        break
                    }
                    task = await this.commit(task, { actions: { ...task.actions, [step.actionId]: { ...task.actions[step.actionId],
                        state: 'dispatched' } } }, 'action-dispatched', { actionId: step.actionId }, leaseEpoch)
                    const actions = { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state: 'confirmed' as const } }
                    task = await this.commit(task, { actions, batches: { ...task.batches, [batchId]: { steps,
                        nextStep: index + 1 } } }, 'action-confirmed', { actionId: step.actionId }, leaseEpoch)
                    results.push({ stepId: step.stepId, actionId: step.actionId, outcome: 'succeeded',
                        ...(observed ? { observation: sanitizeObservation(observed, grant.allowedOrigins) } : {}) })
                    completedSteps.push(step.stepId)
                    if (landedWaitReason) {
                        const notPathPrefix = landedWaitReason === 'login' ? '/login' : '/challenge'
                        task = await this.commit(task, {
                            status: 'awaiting-user',
                            waitReason: landedWaitReason,
                            waitExpiresAtMs: this.clock.now() + POC_LIMITS.userWaitMs,
                            waitCompletion: { batchId, nextStep: index + 1, tabId: step.tabId, notPathPrefix },
                        }, 'state-changed', {
                            status: 'awaiting-user',
                            waitReason: landedWaitReason,
                            tabId: step.tabId,
                        }, leaseEpoch)
                        preserveLeases = true
                        return this.saveBatchResult(task, batchId, {
                            batchId,
                            taskId: task.taskId,
                            outcome: 'awaiting-user',
                            completedSteps,
                            mayHaveSideEffects: false,
                            lastCheckpointSeq: task.highWatermarkSeq + 1,
                            steps: results,
                            waitReason: landedWaitReason,
                        })
                    }
                }
                catch (error) {
                    task = this.requireTask(task.taskId)
                    if (task.pauseReason === 'user-control' || this.leases.owner(step.tabId, task.profileId).leaseEpoch !== leaseEpoch) {
                        const uncertain = ['click', 'fill', 'navigate'].includes(step.kind)
                        const state = uncertain ? 'uncertain' as const : 'skipped' as const
                        await this.commit(task, { actions: { ...task.actions, [step.actionId]: { ...task.actions[step.actionId],
                            state } }, ...(uncertain ? { uncertainActions: [...new Set([...task.uncertainActions,
                                step.actionId])] } : {}) }, 'late-result', { actionId: step.actionId, ignored: true }, leaseEpoch)
                        outcome = uncertain ? 'uncertain' : 'cancelled'
                        mayHaveSideEffects = uncertain
                        break
                    }
                    if (task.cancelRequested) {
                        const uncertain = ['click', 'fill', 'navigate'].includes(step.kind)
                        const state = uncertain ? 'uncertain' as const : 'skipped' as const
                        const actions = { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state } }
                        await this.commit(task, { actions, ...(uncertain ? { status: 'paused',
                            pauseReason: 'cancelled-with-unknown-effect', uncertainActions: [...new Set([...task.uncertainActions,
                                step.actionId])] } : { status: 'cancelled' }) }, 'late-result', { actionId: step.actionId,
                                    cancelled: true }, leaseEpoch)
                        outcome = 'cancelled'
                        break
                    }
                    const write = ['click', 'fill', 'navigate'].includes(step.kind)
                    const runtimeError = error instanceof BrowserRuntimeError ? error : undefined
                    const deniedOrigin = runtimeError?.code === 'ORIGIN_DENIED'
                    const uncertain = write && runtimeError?.mayHaveSideEffects !== false && !deniedOrigin
                    const actionState = uncertain ? 'uncertain' as const : 'failed' as const
                    const actions = { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state: actionState } }
                    const safeFailure = !uncertain && !deniedOrigin
                    task = await this.commit(task, {
                        actions,
                        status: uncertain || safeFailure ? 'paused' : 'failed',
                        ...(uncertain
                            ? { pauseReason: 'outcome-unknown', uncertainActions: [...task.uncertainActions, step.actionId] }
                            : safeFailure ? { pauseReason: 'awaiting-agent' } : {}),
                        ...(safeFailure ? { currentBatchId: undefined } : {}),
                    }, uncertain ? 'action-uncertain' : 'action-failed', { actionId: step.actionId,
                                error: safeError(error) }, leaseEpoch)
                    results.push({ stepId: step.stepId, actionId: step.actionId, outcome: uncertain ? 'uncertain' : 'failed',
                        error: safeError(error) })
                    failedStep = step.stepId
                    outcome = uncertain ? 'uncertain' : 'failed'
                    mayHaveSideEffects = uncertain
                    break
                }
                finally {
                    this.inFlightDriverCalls.delete(task.taskId)
                    const completedTakeovers = this.leases.completePendingTakeovers(task.taskId)
                    if (completedTakeovers.length) {
                        const current = this.requireTask(task.taskId)
                        await this.commit(current, {}, 'input-owner-changed', {
                            owner: 'user',
                            settling: false,
                            tabs: completedTakeovers.map((takeover) => takeover.tabId),
                        }, completedTakeovers[0].leaseEpoch)
                    }
                }
            }
            let finalTask = this.requireTask(task0.taskId)
            if (outcome === 'succeeded' && finalTask.status === 'running') {
                const pauseReason = this.clock.now() - finalTask.createdAtMs >= POC_LIMITS.taskTimeLimitMs
                    ? 'task-time-limit' : 'awaiting-agent'
                finalTask = await this.commit(finalTask, { status: 'paused', pauseReason, currentBatchId: undefined }, 'state-changed',
                    { status: 'paused', pauseReason })
            }
            finalTask = this.requireTask(finalTask.taskId)
            return this.saveBatchResult(finalTask, batchId, { batchId, taskId: finalTask.taskId, outcome, completedSteps,
                ...(failedStep ? { failedStep } : {}), mayHaveSideEffects, lastCheckpointSeq: finalTask.highWatermarkSeq + 1,
                    steps: results })
        }
        finally {
            if (!preserveLeases)
                for (const [tabId, epoch] of batchLeases) {
                    const current = this.leases.owner(tabId, task0.profileId)
                    if (current.owner.kind === 'agent' && current.owner.taskId === task0.taskId && current.owner.segmentId === batchId
                        && current.leaseEpoch === epoch) {
                        const releasedEpoch = this.leases.release(tabId, task0.profileId)
                        await this.persistTabLease(task0.taskId, task0.taskSpaceId, tabId, releasedEpoch)
                    }
                }
            if (this.controllers.get(task0.taskId) === controller)
                this.controllers.delete(task0.taskId)
        }
    }
    private async dispatch(driver: BrowserDriver, step: BatchStep, observed: Observation | undefined,
        grant: AgentGrant, signal: AbortSignal): Promise<void> {
        return dispatchStep(driver, step, observed, grant, signal)
    }
    private async commit(task: StoredTask, patch: Partial<StoredTask>, type: TaskEvent['type'], data: Record<string, unknown>,
        leaseEpoch = 0, business = false): Promise<StoredTask> {
        const previous = this.commitTails.get(task.taskId) ?? Promise.resolve()
        let release!: () => void
        const current = new Promise<void>((resolve) => { release = resolve; })
        const queued = previous.then(() => current)
        this.commitTails.set(task.taskId, queued)
        await previous
        try {
            const committed = await this.options.store.mutate(task.taskId, (current) => {
                const rebased = rebaseTaskPatch(task, current, patch)
                if (current.cancelRequested && !task.cancelRequested && rebased.status !== 'cancelled') {
                    delete rebased.status
                    delete rebased.pauseReason
                }
                return {
                    patch: rebased,
                    event: this.event(type, redact(data), current.stateVersion + 1, leaseEpoch),
                    business,
                }
            })
            if (!committed)
                throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Task disappeared during commit')
            for (const wake of this.eventWaiters.get(task.taskId) ?? [])
                wake()
            return committed
        }
        catch (error) {
            this.leases.revokeTask(task.taskId)
            this.controllers.get(task.taskId)?.abort(new Error('journal unavailable'))
            throw error
        }
        finally {
            release()
            if (this.commitTails.get(task.taskId) === queued)
                this.commitTails.delete(task.taskId)
        }
    }
    private async saveBatchResult(task: StoredTask, batchId: BatchId, result: BatchResult): Promise<BatchResult> {
        const committed = await this.options.store.mutate(task.taskId, (current) => {
            const batch = current.batches[batchId]
            if (!batch)
                throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Batch record is missing')
            return {
                patch: {
                    lastBatch: result,
                    batches: { ...current.batches, [batchId]: { ...batch, result } },
                },
                event: this.event('state-changed', {
                    batchId,
                    batchOutcome: result.outcome,
                    resultStored: true,
                }, current.stateVersion),
            }
        })
        if (!committed)
            throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Batch result was not committed')
        return { ...result, lastCheckpointSeq: committed.highWatermarkSeq }
    }
    private event(type: TaskEvent['type'], data: Record<string, unknown>, stateVersion: number,
        leaseEpoch = 0): StoreEventInput { return { type, atMs: this.clock.now(), stateVersion, leaseEpoch, data }; }
    private authorizeTask(auth: AuthContext, operation: Operation, task: StoredTask): void {
        this.checkCredential(auth, operation, task.profileId, task.taskSpaceId)
        if (task.owner.principalId !== auth.credential.principalId || task.owner.workspaceId !== auth.credential.workspaceId
            || task.owner.machineId !== auth.credential.machineId)
            throw new BrowserRuntimeError('SCOPE_DENIED', 'Task owner does not match credential')
        if (auth.credential.kind === 'agent-grant' && auth.credential.agentSessionId !== task.agentSessionId)
            throw new BrowserRuntimeError('SCOPE_DENIED', 'Agent session does not own task')
    }
    private checkCredential(auth: AuthContext, op: Operation, profileId: ProfileId, taskSpaceId?: TaskSpaceId): void {
        const credential = auth.credential
        assertOperation(auth, op, { principalId: credential.principalId, workspaceId: credential.workspaceId,
            machineId: credential.machineId, profileId, ...(taskSpaceId ? { taskSpaceId } : {}) })
        if (!this.isCredentialLive(auth))
            throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential has expired or been revoked')
    }
    private isCredentialLive(auth: AuthContext): boolean {
        const credential = auth.credential
        return credential.expiresAtMs > this.clock.now()
            && !this.options.store.isRevoked(credential.kind === 'agent-grant' ? credential.grantId : credential.capabilityId)
    }
    private agentGrant(auth: AuthContext): AgentGrant { if (auth.credential.kind !== 'agent-grant')
        throw new BrowserRuntimeError('SCOPE_DENIED', 'Agent grant required'); return auth.credential; }
    private driver(profileId: ProfileId): BrowserDriver { const driver = this.drivers.get(profileId); if (!driver)
        throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'No browser driver is configured for profile'); return driver; }
    private requireTask(id: TaskId): StoredTask { const task = this.options.store.getTask(id); if (!task)
        throw new BrowserRuntimeError('SCOPE_DENIED', 'Task does not exist'); return task; }
    private requireSpace(id: TaskSpaceId): NonNullable<ReturnType<TaskStore['getSpace']>> {
        const space = this.options.store.getSpace(id)
        if (!space)
        throw new BrowserRuntimeError('SCOPE_DENIED', 'Task space does not exist'); return space; }
    private assertTaskTab(task: StoredTask, tab: TabId): void { if (!task.tabs.includes(tab))
        throw new BrowserRuntimeError('SCOPE_DENIED', 'Tab is not owned by task'); }
    private assertCanStart(task: StoredTask): void {
        if (task.cancelRequested || ['succeeded', 'failed', 'cancelled'].includes(task.status))
            throw new BrowserRuntimeError('CONFLICT', 'Task cannot accept new work')
        if (task.status === 'paused' && task.pauseReason !== 'awaiting-agent' || task.status === 'awaiting-user'
            || task.uncertainActions.length)
            throw new BrowserRuntimeError('CONFLICT', 'Task is paused for a blocking reason')
    }
    private allocateTabId(): TabId { return `lease-reservation-${randomUUID()}` as TabId; }
    private view(task: StoredTask): TaskView { const { owner: _owner, agentGrant: _grant, actions: _actions, approvals: _approvals,
        batches: _batches, dedupe: _dedupe, tabTargets: _tabTargets, tabLeaseEpochs: _tabLeaseEpochs,
        __events: _events, lastSeq: _lastSeq, ...view } = task; return structuredClone(view); }
    private taskRequest(task: StoredTask, auth: AuthContext, requestId: string,
        payload: unknown): unknown | undefined { const key = requestKey(auth, requestId); const old = task.dedupe[key]; if (!old)
        return; if (old.hash !== payloadHash(payload))
        throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input'); return old.result; }
    private spaceRequest(space: NonNullable<ReturnType<TaskStore['getSpace']>>, auth: AuthContext, requestId: string,
        payload: unknown): unknown | undefined { const old = space.dedupe?.[requestKey(auth, requestId)]; if (!old)
        return; if (old.hash !== payloadHash(payload))
        throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input'); return old.result; }
    private spaceDedupe(space: NonNullable<ReturnType<TaskStore['getSpace']>>, auth: AuthContext, requestId: string, payload: unknown,
        result: unknown): NonNullable<NonNullable<ReturnType<TaskStore['getSpace']>>['dedupe']> { return { ...space.dedupe,
            [requestKey(auth, requestId)]: { hash: payloadHash(payload), result: redact(result) } }; }
    private async saveTaskRequest(task: StoredTask, auth: AuthContext, requestId: string, payload: unknown,
        result: unknown): Promise<StoredTask> {
        const key = requestKey(auth, requestId)
        const hash = payloadHash(payload)
        const redactedResult = redact(result)
        const committed = await this.options.store.mutate(task.taskId, (current) => {
            const existing = current.dedupe[key]
            if (existing) {
                if (existing.hash !== hash)
                    throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input')
                return null
            }
            return {
                patch: {
                    dedupe: { ...current.dedupe, [key]: { hash, result: redactedResult } },
                    stateVersion: current.stateVersion,
                },
                event: this.event('state-changed', { requestStored: true }, current.stateVersion),
            }
        })
        return committed ?? this.requireTask(task.taskId)
    }
    private async saveRequest(task: StoredTask, auth: AuthContext, requestId: string, payload: unknown,
        result: unknown): Promise<StoredTask> { return this.saveTaskRequest(task, auth, requestId, payload, result); }
    private findRequest(requestId: string, auth: AuthContext): {
        hash: string
        result: unknown
    } | undefined {
        const key = requestKey(auth, requestId)
        return this.options.store.listTasks().map((task) => task.dedupe[key]).find(Boolean)
    }
    private authorizeSpace(auth: AuthContext, space: NonNullable<ReturnType<TaskStore['getSpace']>>): void { if (space.owner
        && (space.owner.principalId !== auth.credential.principalId || space.owner.workspaceId !== auth.credential.workspaceId
            || space.owner.machineId !== auth.credential.machineId))
        throw new BrowserRuntimeError('SCOPE_DENIED', 'Task space owner does not match credential'); }
}
function identity(auth: AuthContext): {
    principalId: string
    workspaceId: string
    machineId: string
} { return { principalId: auth.credential.principalId, workspaceId: auth.credential.workspaceId, machineId: auth.credential.machineId }; }
function rebaseTaskPatch(base: StoredTask, current: StoredTask, patch: Partial<StoredTask>): Partial<StoredTask> {
    const result = { ...patch }
    for (const field of ['actions', 'approvals', 'batches', 'dedupe'] as const) {
        const before = base[field] as Record<string, unknown>
        const proposed = patch[field] as Record<string, unknown> | undefined
        if (!proposed)
            continue
        const merged = { ...current[field] } as Record<string, unknown>
        const keys = new Set([...Object.keys(before), ...Object.keys(proposed)])
        for (const key of keys) {
            if (JSON.stringify(before[key]) === JSON.stringify(proposed[key]))
                continue
            if (!(key in proposed))
                delete merged[key]
            else
                merged[key] = proposed[key]
        }
        Object.assign(result, { [field]: merged })
    }
    return result
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function requestKey(auth: AuthContext, requestId: string): string {
    return `${auth.credential.principalId}/${auth.credential.workspaceId}/${auth.credential.machineId}/${requestId}`
}
function safeError(error: unknown): RuntimeErrorBody {
    const body = error instanceof BrowserRuntimeError ? error.toBody() : {
        code: 'RUNTIME_UNAVAILABLE' as const,
        message: 'Browser operation failed',
        retryable: true,
        mayHaveSideEffects: false,
    }
    return redact(body)
}
function matchesWait(predicate: NonNullable<BatchStep['until']>, observation: Observation): boolean {
    if (predicate.kind === 'text')
        return observation.text.includes(predicate.text)
    if (predicate.kind === 'url')
        return observation.url.startsWith(predicate.urlPrefix)
    return observation.elements.some((element) => element.ref === predicate.ref)
}
function sanitizeObservation(observation: Observation, allowedOrigins: string[]): Observation {
    const hasDeniedFrame = observation.frames.some((frame) => !allowedOrigins.includes(frame.origin))
    return redact({ ...observation, elements: observation.elements.filter((element) => allowedOrigins.includes(element.frameOrigin)),
        frames: observation.frames.map((frame) => ({ ...frame, allowed: allowedOrigins.includes(frame.origin),
            ...(!allowedOrigins.includes(frame.origin) ? { text: undefined } : {}) })), ...(hasDeniedFrame ? { text: '' } : {}) })
}
