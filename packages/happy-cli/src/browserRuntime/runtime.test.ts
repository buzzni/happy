import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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

async function readTree(root: string): Promise<string> {
    const entries = await readdir(root, { withFileTypes: true })
    const contents = await Promise.all(entries.map(async (entry) => {
        const path = join(root, entry.name)
        return entry.isDirectory() ? readTree(path) : readFile(path, 'utf8')
    }))
    return contents.join('\n')
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

    it('refuses to close a tab through a different task space even after its task finishes', async () => {
        const h = await createHarness('abp-runtime-cross-space-close-')
        const taskView = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        await h.runtime.finishTask(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: taskView.stateVersion,
            requestId: 'finish-before-cross-close' as RequestId,
        })
        const otherSpace = await h.runtime.createSpace(h.auth, {
            profileId: h.profileId,
            requestId: 'other-space' as RequestId,
        })

        await expect(h.runtime.closePage(h.auth, {
            taskSpaceId: otherSpace.taskSpaceId,
            tabId: h.opened.tabId,
            requestId: 'cross-space-close' as RequestId,
        })).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        expect(h.driver.hasTab(h.opened.tabId)).toBe(true)
        await h.store.close()
    })

    it('deduplicates concurrent closePage requests before the driver closes the tab', async () => {
        const h = await createHarness('abp-runtime-close-duplicate-')
        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        await h.runtime.finishTask(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: task.stateVersion,
            requestId: 'finish-before-close' as RequestId,
        })
        const before = h.driver.targetLedger.filter((entry) => entry.operation === 'closeTab').length
        h.driver.setDelay('closeTab', 25)
        const request = { taskSpaceId: h.space.taskSpaceId, tabId: h.opened.tabId, requestId: 'same-close' as RequestId }
        const [first, duplicate] = await Promise.all([
            h.runtime.closePage(h.auth, request),
            h.runtime.closePage(h.auth, request),
        ])

        expect(duplicate).toEqual(first)
        expect(h.driver.targetLedger.filter((entry) => entry.operation === 'closeTab').length - before).toBe(1)
        await h.store.close()
    })

    it('keeps login waits through takeover and resumes only after the URL leaves the login path', async () => {
        const h = await createHarness('abp-runtime-login-wait-')
        const loginPage = await h.runtime.openPage(h.auth, {
            taskId: h.task.taskId,
            url: 'https://fixture.test/login',
            requestId: 'open-login' as RequestId,
        })
        const awaiting = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(awaiting.status).toBe('awaiting-user')
        expect(awaiting.waitReason).toBe('login')
        expect(h.store.getTask(h.task.taskId)?.waitCompletion).toMatchObject({
            tabId: loginPage.tabId,
            notPathPrefix: '/login',
        })

        const uiCredential: InteractiveCapability = {
            kind: 'interactive', capabilityId: 'login-ui' as never, principalId: 'p' as never,
            workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'login-viewer',
            profileId: h.profileId, operations: ['takeOver', 'releaseControl'], issuedAtMs: 0, expiresAtMs: 3_600_000,
        }
        const uiAuth = { credential: uiCredential, verifiedAtMs: h.clock.now() }
        const leaseManager = (h.runtime as unknown as { leases: { owner(tabId: string, profileId: ProfileId): { leaseEpoch: number } } }).leases
        const firstTakeover = await h.runtime.takeOver(uiAuth, {
            taskId: h.task.taskId,
            tabId: loginPage.tabId,
            expectedEpoch: leaseManager.owner(loginPage.tabId, h.profileId).leaseEpoch,
            requestId: 'login-takeover' as RequestId,
        })
        await expect(h.runtime.resume(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: firstTakeover.task.stateVersion,
            requestId: 'resume-during-control' as RequestId,
        })).rejects.toMatchObject({ code: 'CONFLICT' })
        const released = await h.runtime.releaseControl(uiAuth, {
            taskId: h.task.taskId,
            tabId: loginPage.tabId,
            expectedEpoch: firstTakeover.leaseEpoch,
            requestId: 'login-release' as RequestId,
        })
        const stillWaiting = await h.runtime.resume(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: released.task.stateVersion,
            requestId: 'resume-still-login' as RequestId,
        })
        expect(stillWaiting.status).toBe('awaiting-user')
        expect(stillWaiting.waitReason).toBe('login')

        const secondTakeover = await h.runtime.takeOver(uiAuth, {
            taskId: h.task.taskId,
            tabId: loginPage.tabId,
            expectedEpoch: leaseManager.owner(loginPage.tabId, h.profileId).leaseEpoch,
            requestId: 'login-takeover-again' as RequestId,
        })
        h.driver.seedTab(loginPage.tabId, { url: 'https://fixture.test/account', text: 'Signed in', elements: [] })
        const secondRelease = await h.runtime.releaseControl(uiAuth, {
            taskId: h.task.taskId,
            tabId: loginPage.tabId,
            expectedEpoch: secondTakeover.leaseEpoch,
            requestId: 'login-release-again' as RequestId,
        })
        const resumed = await h.runtime.resume(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: secondRelease.task.stateVersion,
            requestId: 'resume-after-login' as RequestId,
        })
        expect(resumed.status).toBe('paused')
        expect(resumed.pauseReason).toBe('awaiting-agent')
        await h.store.close()
    })

    it('expires idle user login waits without resuming execution', async () => {
        const h = await createHarness('abp-runtime-login-expiry-')
        await h.runtime.openPage(h.auth, {
            taskId: h.task.taskId,
            url: 'https://fixture.test/login',
            requestId: 'open-expiring-login' as RequestId,
        })
        const dispatchCount = h.driver.dispatchCounts.size
        h.clock.set(600_101)
        await h.runtime.sweep(h.clock.now())

        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(task.status).toBe('paused')
        expect(task.pauseReason).toBe('user-wait-expired')
        expect(task.waitReason).toBe('login')
        expect(h.driver.dispatchCounts.size).toBe(dispatchCount)
        await h.store.close()
    })

    it('re-adopts owned targets and restores lease epochs after a Runtime-only restart', async () => {
        const h = await createHarness('abp-runtime-adopt-same-browser-')
        const targetId = h.driver.targetLedger.find((entry) => entry.tabId === h.opened.tabId
            && entry.operation === 'openTab')?.targetId
        const leaseManager = (h.runtime as unknown as { leases: { owner(tabId: string, profileId: ProfileId): { leaseEpoch: number } } }).leases
        const previousEpoch = leaseManager.owner(h.opened.tabId, h.profileId).leaseEpoch
        await h.store.close()

        const store = await TaskStore.open(h.dir)
        const runtime = new BrowserRuntime({ store, drivers: new Map([[h.profileId, h.driver]]), clock: h.clock })
        const task = await runtime.getTask(h.auth, { taskId: h.task.taskId })
        const restoredLeases = (runtime as unknown as { leases: { owner(tabId: string, profileId: ProfileId): { leaseEpoch: number } } }).leases

        expect(targetId).toBeTruthy()
        expect(h.driver.adoptedTabs).toContainEqual({ tabId: h.opened.tabId, targetId, adopted: true })
        expect(task.tabs).toContain(h.opened.tabId)
        expect((await runtime.observe(h.auth, { taskId: h.task.taskId, tabId: h.opened.tabId })).url)
            .toBe('https://fixture.test/start')
        expect(restoredLeases.owner(h.opened.tabId, h.profileId).leaseEpoch).toBe(previousEpoch + 1)
        expect((store.getSpace(h.space.taskSpaceId) as unknown as { tabTargets?: Record<string, string> })?.tabTargets?.[h.opened.tabId])
            .toBe(targetId)
        const uiCredential: InteractiveCapability = {
            kind: 'interactive', capabilityId: 'adopt-ui' as never, principalId: 'p' as never,
            workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'adopt-viewer',
            profileId: h.profileId, operations: ['takeOver'], issuedAtMs: 0, expiresAtMs: 3_600_000,
        }
        const takeover = await runtime.takeOver({ credential: uiCredential, verifiedAtMs: h.clock.now() }, {
            taskId: h.task.taskId,
            tabId: h.opened.tabId,
            expectedEpoch: restoredLeases.owner(h.opened.tabId, h.profileId).leaseEpoch,
            requestId: 'take-over-restored-lease' as RequestId,
        })
        expect(takeover.leaseEpoch).toBe(previousEpoch + 2)
        await store.close()

        const restartedStore = await TaskStore.open(h.dir)
        const restartedRuntime = new BrowserRuntime({ store: restartedStore, drivers: new Map([[h.profileId, h.driver]]), clock: h.clock })
        await restartedRuntime.getTask(h.auth, { taskId: h.task.taskId })
        const restartedLeases = (restartedRuntime as unknown as {
            leases: {
                owner(tabId: string, profileId: ProfileId): { owner: { kind: string }; leaseEpoch: number }
                isUserFenced(profileId: ProfileId): boolean
            }
        }).leases
        expect(restartedLeases.owner(h.opened.tabId, h.profileId)).toMatchObject({
            owner: { kind: 'user' },
            leaseEpoch: takeover.leaseEpoch + 1,
        })
        expect(restartedLeases.isUserFenced(h.profileId)).toBe(true)
        await restartedStore.close()
    })

    it('drops tabs and space references when Runtime restarts against a different browser instance', async () => {
        const h = await createHarness('abp-runtime-adopt-replaced-browser-')
        h.driver.swapInstance()
        await h.store.close()

        const store = await TaskStore.open(h.dir)
        const runtime = new BrowserRuntime({ store, drivers: new Map([[h.profileId, h.driver]]), clock: h.clock })
        const task = await runtime.getTask(h.auth, { taskId: h.task.taskId })

        expect(task.pauseReason).toBe('browser-replaced')
        expect(task.tabs).toEqual([])
        expect(store.getSpace(h.space.taskSpaceId)?.tabs).toEqual([])
        expect(store.getSpace(h.space.taskSpaceId)?.goneTabs).toContain(h.opened.tabId)
        expect(await runtime.closePage(h.auth, {
            taskSpaceId: h.space.taskSpaceId,
            tabId: h.opened.tabId,
            requestId: 'close-already-gone' as RequestId,
        })).toEqual({ closed: false })
        await store.close()
    })

    it('fences immediately on takeover and exposes settling until the driver call returns', async () => {
        const h = await createHarness('abp-runtime-takeover-settling-')
        const view = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        h.driver.setIgnoreWaitAbort(true)
        const running = h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: view.stateVersion,
            requestId: 'takeover-running' as RequestId,
            steps: [{ stepId: 'wait' as never, actionId: 'wait' as never, tabId: h.opened.tabId,
                kind: 'waitFor', until: { kind: 'text', text: 'release' }, timeoutMs: 120_000 }],
        }, { waitMs: 5000 })
        await h.driver.waitForEntered

        const uiCredential: InteractiveCapability = {
            kind: 'interactive', capabilityId: 'settle-ui' as never, principalId: 'p' as never,
            workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'settle-viewer',
            profileId: h.profileId, operations: ['takeOver', 'releaseControl'], issuedAtMs: 0, expiresAtMs: 3_600_000,
        }
        const uiAuth = { credential: uiCredential, verifiedAtMs: h.clock.now() }
        const leaseManager = (h.runtime as unknown as { leases: { owner(tabId: string, profileId: ProfileId): { owner: { kind: string }; leaseEpoch: number } } }).leases
        const takeover = await h.runtime.takeOver(uiAuth, {
            taskId: h.task.taskId,
            tabId: h.opened.tabId,
            expectedEpoch: leaseManager.owner(h.opened.tabId, h.profileId).leaseEpoch,
            requestId: 'takeover-active-call' as RequestId,
        })

        expect(takeover).toMatchObject({ settling: true, owner: { kind: 'none' } })
        expect(leaseManager.owner(h.opened.tabId, h.profileId).owner.kind).toBe('none')
        h.driver.releaseWait()
        await running
        expect(leaseManager.owner(h.opened.tabId, h.profileId).owner.kind).toBe('user')
        await h.store.close()
    })

    it('keeps synthetic canaries and password values out of journal files and batch results', async () => {
        const h = await createHarness('abp-runtime-redaction-')
        h.driver.seedTab(h.opened.tabId, {
            url: 'https://fixture.test/start',
            title: 'Fixture',
            text: 'ABP-CANARY-FRAME-x',
            frameOrigins: ['https://untrusted.test'],
            elements: [{ ref: '@password' as never, role: 'textbox', name: 'Password', value: 'synthetic-password',
                visible: true, frameOrigin: 'https://fixture.test' }],
        })
        const view = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const batch = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: view.stateVersion,
            requestId: 'redaction-observe' as RequestId,
            steps: [{ stepId: 'observe' as never, actionId: 'observe' as never, tabId: h.opened.tabId,
                kind: 'observe', timeoutMs: 1000 }],
        }, { waitMs: 1000 })

        expect(JSON.stringify(batch)).not.toContain('ABP-CANARY-FRAME-x')
        expect(JSON.stringify(batch)).not.toContain('synthetic-password')
        const contents = await readTree(h.dir)
        expect(contents).not.toContain('ABP-CANARY-FRAME-x')
        expect(contents).not.toContain('synthetic-password')
        await h.store.close()
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

    it('keeps cancel outcome unknown when input was sent before the worker confirmation commit', async () => {
        const h = await createHarness('abp-runtime-cancel-confirm-race-')
        h.driver.seedTab(h.opened.tabId, {
            url: 'https://fixture.test/start',
            elements: [{ ref: '@e1' as never, role: 'button', name: 'Continue', visible: true,
                frameOrigin: 'https://fixture.test' }],
        })
        const held = h.driver.holdAfterNextDispatch('click')
        const view = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const batch = h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: view.stateVersion,
            requestId: 'click-then-cancel' as RequestId,
            steps: [
                { stepId: 'click' as never, actionId: 'click-before-cancel' as never, tabId: h.opened.tabId,
                    kind: 'click', ref: '@e1' as never, timeoutMs: 1000 },
                { stepId: 'later' as never, actionId: 'must-not-dispatch' as never, tabId: h.opened.tabId,
                    kind: 'click', ref: '@e1' as never, timeoutMs: 1000 },
            ],
        }, { waitMs: 5000 })
        await held.entered
        const cancelled = await h.runtime.cancel(h.auth, {
            taskId: h.task.taskId,
            requestId: 'cancel-after-input' as RequestId,
        })
        expect(cancelled.task.status).toBe('paused')
        expect(cancelled.task.pauseReason).toBe('cancelled-with-unknown-effect')
        held.release()
        await batch

        const finalTask = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(finalTask.status).toBe('paused')
        expect(finalTask.pauseReason).toBe('cancelled-with-unknown-effect')
        expect(finalTask.uncertainActions).toContain('click-before-cancel')
        expect(h.driver.dispatchCounts.get('must-not-dispatch') ?? 0).toBe(0)
        await h.store.close()
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

    it('never dispatches an approved action after a concurrent cancel ACK across 50 races', async () => {
        for (let index = 0; index < 50; index++) {
            const h = await createHarness(`abp-runtime-approve-cancel-${index}-`)
            h.driver.seedTab(h.opened.tabId, {
                url: 'https://fixture.test/start',
                elements: [{ ref: '@pay' as never, role: 'button', name: 'Pay now', visible: true,
                    frameOrigin: 'https://fixture.test' }],
            })
            const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
            const submitted = await h.runtime.submitBatch(h.auth, {
                taskId: h.task.taskId,
                expectedVersion: current.stateVersion,
                requestId: `race-batch-${index}` as RequestId,
                steps: [{ stepId: 'pay-step' as never, actionId: 'pay-action' as never, tabId: h.opened.tabId,
                    kind: 'click', ref: '@pay' as never, timeoutMs: 1000 }],
            }, { waitMs: 1000 })
            const approval = submitted.result?.pendingApproval
            if (!approval) throw new Error('test requires an approval to race')
            const uiCredential: InteractiveCapability = {
                kind: 'interactive', capabilityId: `race-ui-${index}` as never, principalId: 'p' as never,
                workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: `viewer-${index}`,
                profileId: h.profileId, operations: ['approve'], issuedAtMs: 0, expiresAtMs: 3_600_000,
            }
            const uiAuth = { credential: uiCredential, verifiedAtMs: h.clock.now() }
            const requestId = `race-approve-${index}` as RequestId
            let cancelAcknowledged = false
            let dispatchedAfterCancelAck = false
            h.driver.observeDispatches((actionId) => {
                if (actionId === 'pay-action' && cancelAcknowledged)
                    dispatchedAfterCancelAck = true
            })
            const approvalRequest = h.runtime.approve(uiAuth, {
                taskId: h.task.taskId,
                approvalId: approval.approvalId,
                bindingHash: approval.bindingHash,
                requestId,
                decision: 'approve',
            })
            const cancelRequest = h.runtime.cancel(h.auth, {
                taskId: h.task.taskId,
                requestId: `race-cancel-${index}` as RequestId,
            }).then((result) => {
                cancelAcknowledged = true
                return result
            })
            const [approveResult, cancelResult] = await Promise.allSettled([approvalRequest, cancelRequest])

            expect(cancelResult.status).toBe('fulfilled')
            expect(dispatchedAfterCancelAck).toBe(false)
            expect(h.driver.dispatchCounts.get('pay-action') ?? 0).toBeLessThanOrEqual(1)
            expect(approveResult.status === 'fulfilled' && cancelResult.status === 'fulfilled'
                && approveResult.value.outcome === 'approved'
                && cancelResult.value.task.status === 'cancelled'
                && dispatchedAfterCancelAck).toBe(false)
            await h.store.close()
        }
    }, 30_000)

    it('approves only the submit click and binds approval to the filled form values', async () => {
        const h = await createHarness('abp-runtime-submit-approval-')
        h.driver.seedTab(h.opened.tabId, {
            url: 'https://fixture.test/risky-submit',
            elements: [
                { ref: '@amount' as never, role: 'textbox', name: 'Amount', value: '', visible: true, frameOrigin: 'https://fixture.test' },
                { ref: '@submit' as never, role: 'button', name: 'Confirm payment', visible: true, frameOrigin: 'https://fixture.test' },
            ],
        })
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const batch = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'submit-amount' as RequestId,
            steps: [
                { stepId: 'fill-amount' as never, actionId: 'fill-amount' as never, tabId: h.opened.tabId,
                    kind: 'fill', ref: '@amount' as never, value: '5', timeoutMs: 1000 },
                { stepId: 'submit-order' as never, actionId: 'submit-order' as never, tabId: h.opened.tabId,
                    kind: 'click', ref: '@submit' as never, timeoutMs: 1000 },
            ],
        }, { waitMs: 1000 })

        expect(batch.result?.outcome).toBe('awaiting-user')
        expect(batch.result?.completedSteps).toContain('fill-amount')
        expect(batch.result?.pendingApproval?.actionId).toBe('submit-order')
        expect(batch.result?.pendingApproval?.description).toContain('Confirm payment')
        expect(batch.result?.pendingApproval?.description).toContain('Amount=5')
        expect(h.driver.dispatchCounts.get('fill-amount')).toBe(1)
        expect(h.driver.dispatchCounts.get('submit-order') ?? 0).toBe(0)

        const approval = batch.result?.pendingApproval
        if (!approval) throw new Error('test requires a pending submit approval')
        const uiCredential: InteractiveCapability = {
            kind: 'interactive', capabilityId: 'submit-ui' as never, principalId: 'p' as never,
            workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer',
            profileId: h.profileId, operations: ['approve'], issuedAtMs: 0, expiresAtMs: 3_600_000,
        }
        const uiAuth = { credential: uiCredential, verifiedAtMs: h.clock.now() }
        h.driver.seedTab(h.opened.tabId, {
            url: 'https://fixture.test/risky-submit',
            elements: [
                { ref: '@amount' as never, role: 'textbox', name: 'Amount', value: '6', visible: true, frameOrigin: 'https://fixture.test' },
                { ref: '@submit' as never, role: 'button', name: 'Confirm payment', visible: true, frameOrigin: 'https://fixture.test' },
            ],
        })
        await expect(h.runtime.approve(uiAuth, {
            taskId: h.task.taskId, approvalId: approval.approvalId, bindingHash: approval.bindingHash,
            requestId: 'approve-changed-amount' as RequestId, decision: 'approve',
        })).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' })
        expect(h.driver.dispatchCounts.get('submit-order') ?? 0).toBe(0)
        await h.store.close()
    })
})
