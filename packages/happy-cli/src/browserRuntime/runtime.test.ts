import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type AgentGrant, type InteractiveCapability, type ProfileId, type RequestId } from './contracts'
import { FakeClock } from './clock'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { TaskStore } from './taskStore'
import { BrowserRuntime } from './runtime'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('BrowserRuntime durable request contract', () => {
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
        await store.commit(task.taskId, { status: 'running', actions: { 'uncertain-action': { state: 'intent-committed', kind: 'click', payloadHash: 'synthetic', batchId: 'batch-x', leaseEpoch: 3, browserInstanceId: driver.browserInstanceId() } } }, { type: 'action-intent', atMs: 101, stateVersion: 10, leaseEpoch: 3, data: { actionId: 'uncertain-action' } })
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
