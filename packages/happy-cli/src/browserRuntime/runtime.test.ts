import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeError, type AgentGrant, type InteractiveCapability, type ProfileId, type RequestId } from './contracts'
import { FakeClock } from './clock'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { TaskStore } from './taskStore'
import { BrowserRuntime } from './runtime'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

async function createHarness(prefix: string, expiresAtMs = 3_600_000) {
    const dir = await mkdtemp(join(tmpdir(), prefix)); dirs.push(dir)
    const store = await TaskStore.open(dir); const clock = new FakeClock(100)
    const profileId = 'profile-1' as ProfileId; const driver = new FakeBrowserDriver()
    const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock })
    const credential: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'cancel', 'observe', 'screenshot', 'finishTask', 'resume', 'closePage', 'closeSpace'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs }
    const auth = { credential, verifiedAtMs: clock.now() }
    const space = await runtime.createSpace(auth, { profileId, requestId: 'space-req' as RequestId })
    const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task-req' as RequestId })
    const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open-req' as RequestId })
    return { dir, store, clock, profileId, driver, runtime, auth, space, task, opened }
}

describe('BrowserRuntime durable request contract', () => {
    it('returns a task version from openPage and submitBatch that the next call can use as expectedVersion', async () => {
        const h = await createHarness('abp-runtime-version-')
        expect(h.opened.task.stateVersion).toBe((await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).stateVersion)
        const submitted = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: h.opened.task.stateVersion,
            requestId: 'batch-version' as RequestId,
            steps: [{ stepId: 's1' as never, actionId: 'act-v1' as never, tabId: h.opened.tabId, kind: 'observe', timeoutMs: 1_000 }],
        }, { waitMs: 2_000 })
        expect(submitted.result?.outcome).toBe('succeeded')
        const finished = await h.runtime.finishTask(h.auth, { taskId: h.task.taskId, expectedVersion: submitted.task.stateVersion, requestId: 'finish-version' as RequestId })
        expect(finished.status).toBe('succeeded')
        await h.store.close()
    })

    it('notifies waitForEvents after a committed event', async () => {
        const h = await createHarness('abp-runtime-events-')
        const afterSeq = (await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).highWatermarkSeq
        const waiting = h.runtime.waitForEvents(h.task.taskId, afterSeq, 2_000)
        await h.runtime.cancel(h.auth, { taskId: h.task.taskId, requestId: 'wake-cancel' as RequestId })
        const result = await waiting
        expect(result.kind).toBe('events')
        if (result.kind === 'events') expect(result.events.some((event) => event.type === 'cancel-accepted')).toBe(true)
        await h.store.close()
    })

    it('pauses expired grants during an idle sweep', async () => {
        const h = await createHarness('abp-runtime-sweep-', 200)
        h.clock.set(201)
        await h.runtime.sweep(h.clock.now())
        const task = await h.runtime.getTask({ ...h.auth, credential: { ...h.auth.credential, expiresAtMs: 10_000 } }, { taskId: h.task.taskId })
        expect(task.status).toBe('paused')
        expect(task.pauseReason).toBe('grant-expired')
        await h.store.close()
    })

    it('fences a revoked grant without waiting for another client request', async () => {
        const h = await createHarness('abp-runtime-revoke-')
        await h.runtime.revokeGrant(h.auth.credential.grantId)
        const task = h.store.getTask(h.task.taskId)
        expect(task?.status).toBe('paused')
        expect(task?.pauseReason).toBe('grant-expired')
        expect(task?.cancelRequested).toBe(false)
        await h.store.close()
    })

    it('expires an approval in sweep and requires a fresh approval after resume', async () => {
        const h = await createHarness('abp-runtime-approval-expiry-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@e1' as never, role: 'button', name: 'Pay now', visible: true, frameOrigin: 'https://fixture.test' },
        ] })
        const initial = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const batch = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: initial.stateVersion,
            requestId: 'approval-expiry-batch' as RequestId,
            steps: [{ stepId: 'pay-step' as never, actionId: 'pay-action' as never, tabId: h.opened.tabId,
                kind: 'click', ref: '@e1' as never, timeoutMs: 1000 }],
        }, { waitMs: 1000 })
        const oldApprovalId = batch.result?.pendingApproval?.approvalId
        expect(oldApprovalId).toBeTruthy()
        h.clock.set(600_101)
        await h.runtime.sweep(h.clock.now())
        const expired = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(expired.pauseReason).toBe('approval-expired')
        await h.runtime.resume(h.auth, { taskId: h.task.taskId, expectedVersion: expired.stateVersion, requestId: 'approval-resume' as RequestId })
        const renewed = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(renewed.pendingApproval?.approvalId).not.toBe(oldApprovalId)
        expect(h.driver.dispatchCounts.get('pay-action') ?? 0).toBe(0)
        await h.store.close()
    })

    it('invalidates task tabs when a reconnected driver has a different browser instance', async () => {
        const h = await createHarness('abp-runtime-driver-restart-')
        await h.runtime.onDriverDisconnected(h.profileId)
        h.driver.swapInstance()
        await h.runtime.onDriverReconnected(h.profileId)
        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(task.status).toBe('paused')
        expect(task.pauseReason).toBe('browser-replaced')
        expect(task.tabs).toEqual([])
        expect(h.store.getSpace(h.space.taskSpaceId)?.tabs).toEqual([])
        await h.store.close()
    })

    it('restores a disconnected task when the browser instance is unchanged', async () => {
        const h = await createHarness('abp-runtime-driver-resume-')
        await h.runtime.onDriverDisconnected(h.profileId)
        await h.runtime.onDriverReconnected(h.profileId)
        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(task.status).toBe('paused')
        expect(task.pauseReason).toBe('awaiting-agent')
        expect(task.tabs).toContain(h.opened.tabId)
        await h.store.close()
    })

    it('accepts only one concurrent batch for an expected task version', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-runtime-version-')); dirs.push(dir)
        const store = await TaskStore.open(dir); const clock = new FakeClock(100)
        const profileId = 'profile-1' as ProfileId; const driver = new FakeBrowserDriver()
        const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock })
        const credential: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'cancel', 'observe', 'screenshot', 'finishTask', 'resume', 'closePage', 'closeSpace'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const auth = { credential, verifiedAtMs: clock.now() }
        const space = await runtime.createSpace(auth, { profileId, requestId: 'space-req' as RequestId })
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task-req' as RequestId })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open-req' as RequestId })
        const expectedVersion = (await runtime.getTask(auth, { taskId: task.taskId })).stateVersion
        const request = (requestId: string) => runtime.submitBatch(auth, { taskId: task.taskId, expectedVersion, requestId: requestId as RequestId, steps: [{ stepId: `step-${requestId}` as never, actionId: `action-${requestId}` as never, tabId: opened.tabId, kind: 'waitFor', until: { kind: 'text', text: 'ready' }, timeoutMs: 1000 }] })
        const results = await Promise.allSettled([request('batch-a'), request('batch-b')])
        expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1)
        await store.close()
    })

    it('deduplicates concurrent identical batch requests before dispatch', async () => {
        const h = await createHarness('abp-runtime-batch-duplicate-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@e1' as never, role: 'button', name: 'Continue', visible: true, frameOrigin: 'https://fixture.test' },
        ] })
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const request = {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'same-batch-request' as RequestId,
            steps: [{ stepId: 'same-step' as never, actionId: 'same-action' as never, tabId: h.opened.tabId,
                kind: 'click' as const, ref: '@e1' as never, timeoutMs: 1000 }],
        }
        const [first, duplicate] = await Promise.all([
            h.runtime.submitBatch(h.auth, request, { waitMs: 1000 }),
            h.runtime.submitBatch(h.auth, request),
        ])
        expect(duplicate.batchId).toBe(first.batchId)
        await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(h.driver.dispatchCounts.get('same-action')).toBe(1)
        await h.store.close()
    })

    it('deduplicates concurrent openPage calls with one external tab creation', async () => {
        const h = await createHarness('abp-runtime-open-duplicate-')
        const initialOpens = h.driver.targetLedger.filter((entry) => entry.operation === 'openTab').length
        h.driver.setDelay('openTab', 25)
        const request = { taskId: h.task.taskId, url: 'https://fixture.test/duplicate', requestId: 'open-same' as RequestId }
        const [first, second] = await Promise.all([
            h.runtime.openPage(h.auth, request),
            h.runtime.openPage(h.auth, request),
        ])
        expect(first.tabId).toBe(second.tabId)
        expect(h.driver.targetLedger.filter((entry) => entry.operation === 'openTab').length - initialOpens).toBe(1)
        await h.store.close()
    })

    it('replays a mutation request result from the journal after reopening the runtime', async () => {
        const h = await createHarness('abp-runtime-dedupe-restart-')
        const request = { taskId: h.task.taskId, requestId: 'cancel-durable' as RequestId }
        const first = await h.runtime.cancel(h.auth, request)
        await h.store.close()

        const store = await TaskStore.open(h.dir)
        const runtime = new BrowserRuntime({ store, drivers: new Map([[h.profileId, h.driver]]), clock: h.clock })
        const dispatchCount = h.driver.dispatchCounts.size
        const replay = await runtime.cancel(h.auth, request)

        expect(replay).toEqual(first)
        expect(h.driver.dispatchCounts.size).toBe(dispatchCount)
        await store.close()
    })

    it('keeps a legitimately in-flight 120 second waitFor live during stale-worker sweep', async () => {
        const h = await createHarness('abp-runtime-wait-heartbeat-')
        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const pending = h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: task.stateVersion,
            requestId: 'long-wait' as RequestId,
            steps: [{ stepId: 'wait-step' as never, actionId: 'wait-action' as never, tabId: h.opened.tabId,
                kind: 'waitFor', until: { kind: 'text', text: 'release me' }, timeoutMs: 120_000 }],
        }, { waitMs: 120_000 })
        await h.driver.waitForEntered
        h.clock.set(61_000)
        await h.runtime.sweep(h.clock.now())
        expect((await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).status).toBe('running')
        h.driver.releaseWait()
        const result = await pending
        expect(result.result?.outcome).toBe('succeeded')
        await h.store.close()
    })

    it('pauses after a timed-out read-only step so the same task can accept a follow-up batch', async () => {
        const h = await createHarness('abp-runtime-read-timeout-')
        h.driver.failNext('waitFor', new BrowserRuntimeError('OUTCOME_UNKNOWN', 'read-only wait timed out', true, false))
        const initial = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const failed = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: initial.stateVersion,
            requestId: 'read-timeout' as RequestId,
            steps: [{ stepId: 'timeout-step' as never, actionId: 'timeout-action' as never, tabId: h.opened.tabId,
                kind: 'waitFor', until: { kind: 'text', text: 'missing' }, timeoutMs: 1000 }],
        }, { waitMs: 1000 })
        expect(failed.result).toMatchObject({ outcome: 'failed', failedStep: 'timeout-step', mayHaveSideEffects: false })
        expect(failed.task.status).toBe('paused')
        expect(failed.task.pauseReason).toBe('awaiting-agent')
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const followup = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'read-timeout-followup' as RequestId,
            steps: [{ stepId: 'observe-step' as never, actionId: 'observe-action' as never, tabId: h.opened.tabId,
                kind: 'observe', timeoutMs: 1000 }],
        }, { waitMs: 1000 })
        expect(followup.result?.outcome).toBe('succeeded')
        await h.store.close()
    })

    it('replays an accepted batch for the same request and dispatches its action once', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-runtime-')); dirs.push(dir)
        const store = await TaskStore.open(dir); const clock = new FakeClock(100)
        const profileId = 'profile-1' as ProfileId
        const driver = new FakeBrowserDriver()
        const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock })
        const credential: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'cancel', 'observe', 'screenshot', 'finishTask', 'resume', 'closePage', 'closeSpace'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const auth = { credential, verifiedAtMs: clock.now() }
        const space = await runtime.createSpace(auth, { profileId, requestId: 'space-req' as RequestId })
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task-req' as RequestId })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open-req' as RequestId })
        const request = { taskId: task.taskId, expectedVersion: (await runtime.getTask(auth, { taskId: task.taskId })).stateVersion, requestId: 'batch-req' as RequestId, steps: [{ stepId: 'step-1' as never, actionId: 'action-1' as never, tabId: opened.tabId, kind: 'click' as const, ref: '@e1' as never, timeoutMs: 1000 }] }
        const first = await runtime.submitBatch(auth, request, { waitMs: 100 })
        const duplicate = await runtime.submitBatch(auth, request, { waitMs: 100 })
        expect(first.batchId).toBe(duplicate.batchId)
        expect(driver.dispatchCounts.get('action-1')).toBe(1)
        await expect(runtime.submitBatch(auth, { ...request, steps: [{ ...request.steps[0], ref: '@e2' as never }] }))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        await store.close()
    })

    it('fences a hanging waitFor without waiting for it and prevents later dispatch', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-runtime-cancel-')); dirs.push(dir)
        const store = await TaskStore.open(dir); const clock = new FakeClock(100)
        const profileId = 'profile-1' as ProfileId; const driver = new FakeBrowserDriver()
        const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock })
        const credential: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'cancel', 'observe', 'screenshot', 'finishTask', 'resume', 'closePage', 'closeSpace'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const auth = { credential, verifiedAtMs: clock.now() }
        const space = await runtime.createSpace(auth, { profileId, requestId: 'space-req' as RequestId })
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task-req' as RequestId })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open-req' as RequestId })
        const pendingBatch = runtime.submitBatch(auth, { taskId: task.taskId, expectedVersion: (await runtime.getTask(auth, { taskId: task.taskId })).stateVersion, requestId: 'hang-batch' as RequestId, steps: [
            { stepId: 'wait-step' as never, actionId: 'wait-action' as never, tabId: opened.tabId, kind: 'waitFor', until: { kind: 'text', text: 'never' }, timeoutMs: 120_000 },
            { stepId: 'click-step' as never, actionId: 'click-action' as never, tabId: opened.tabId, kind: 'click', ref: '@e1' as never, timeoutMs: 1000 },
        ] }, { waitMs: 60_000 })
        await driver.waitForEntered
        const before = Date.now()
        const cancelled = await runtime.cancel(auth, { taskId: task.taskId, requestId: 'cancel-req' as RequestId })
        expect(Date.now() - before).toBeLessThan(2000)
        expect(cancelled.task.status).toBe('cancelled')
        await pendingBatch
        await Promise.resolve()
        expect(driver.dispatchCounts.get('click-action') ?? 0).toBe(0)
        await store.close()
    })

    it('recovers a write intent as outcome-unknown without resending it', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-runtime-recovery-')); dirs.push(dir)
        let store = await TaskStore.open(dir); const clock = new FakeClock(100)
        const profileId = 'profile-1' as ProfileId; const driver = new FakeBrowserDriver()
        const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock })
        const credential: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'cancel', 'observe', 'screenshot', 'finishTask', 'resume', 'closePage', 'closeSpace'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const auth = { credential, verifiedAtMs: clock.now() }
        const space = await runtime.createSpace(auth, { profileId, requestId: 'space-req' as RequestId })
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task-req' as RequestId })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open-req' as RequestId })
        await store.commit(task.taskId, { status: 'running', actions: { 'uncertain-action': { state: 'intent-committed', kind: 'click', payloadHash: 'synthetic', batchId: 'batch-x' as never, leaseEpoch: 3, browserInstanceId: driver.browserInstanceId() } } }, { type: 'action-intent', atMs: 101, stateVersion: 10, leaseEpoch: 3, data: { actionId: 'uncertain-action' } })
        await store.close()
        store = await TaskStore.open(dir)
        const recovered = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock })
        const view = await recovered.getTask(auth, { taskId: task.taskId })
        expect(view.status).toBe('paused')
        expect(view.pauseReason).toBe('outcome-unknown')
        expect(view.uncertainActions).toContain('uncertain-action')
        expect(driver.dispatchCounts.get('uncertain-action') ?? 0).toBe(0)
        await store.close()
        void opened
    })

    it('blocks agent self-approval and consumes a bound interactive approval once', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-runtime-approval-')); dirs.push(dir)
        const store = await TaskStore.open(dir); const clock = new FakeClock(100)
        const profileId = 'profile-1' as ProfileId; const driver = new FakeBrowserDriver()
        const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock })
        const credential: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'cancel', 'observe', 'screenshot', 'finishTask', 'resume', 'closePage', 'closeSpace'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const auth = { credential, verifiedAtMs: clock.now() }
        const space = await runtime.createSpace(auth, { profileId, requestId: 'space-req' as RequestId })
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task-req' as RequestId })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open-req' as RequestId })
        driver.seedTab(opened.tabId, { url: 'https://fixture.test/start', elements: [{ ref: '@e1' as never, role: 'button', name: 'Pay now', visible: true, frameOrigin: 'https://fixture.test' }] })
        const batch = await runtime.submitBatch(auth, { taskId: task.taskId, expectedVersion: (await runtime.getTask(auth, { taskId: task.taskId })).stateVersion, requestId: 'approval-batch' as RequestId, steps: [{ stepId: 'pay' as never, actionId: 'pay-action' as never, tabId: opened.tabId, kind: 'click', ref: '@e1' as never, timeoutMs: 1000 }] }, { waitMs: 1000 })
        expect(batch.result?.outcome).toBe('awaiting-user')
        expect(driver.dispatchCounts.get('pay-action') ?? 0).toBe(0)
        const approval = batch.result?.pendingApproval
        if (!approval) throw new Error('test requires a pending approval')
        await expect(runtime.approve(auth, { taskId: task.taskId, approvalId: approval.approvalId, bindingHash: approval.bindingHash, requestId: 'self-approve' as RequestId, decision: 'approve', human: true } as never)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        const uiCredential: InteractiveCapability = { kind: 'interactive', capabilityId: 'ui-cap' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer', profileId, operations: ['approve'], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const uiAuth = { credential: uiCredential, verifiedAtMs: clock.now() }
        const request = { taskId: task.taskId, approvalId: approval.approvalId, bindingHash: approval.bindingHash, requestId: 'ui-approve' as RequestId, decision: 'approve' as const }
        const first = await runtime.approve(uiAuth, request)
        const duplicate = await runtime.approve(uiAuth, request)
        expect(first.outcome).toBe('approved')
        expect(duplicate.outcome).toBe('approved')
        expect(driver.dispatchCounts.get('pay-action')).toBe(1)
        expect((await runtime.getTask(auth, { taskId: task.taskId })).pauseReason).toBe('awaiting-agent')
        await store.close()
    })
})
