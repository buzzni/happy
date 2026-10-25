/** User-facing approval boundary: Auto is human consent for one task, never an agent capability. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeError } from './contracts'
import type { AgentGrant, AuthContext, BatchStep, InteractiveCapability, ProfileId, RequestId } from './contracts'
import { FakeClock } from './clock'
import { BrowserRuntime } from './runtime'
import { TaskStore } from './taskStore'
import { FakeBrowserDriver } from './testing/fakeDriver'

const origin = 'https://fixture.test'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function harness() {
    const dir = await mkdtemp(join(tmpdir(), 'abp-auto-'))
    const store = await TaskStore.open(dir)
    cleanups.push(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
    const clock = new FakeClock(100)
    const profileId = 'profile' as ProfileId
    const driver = new FakeBrowserDriver()
    const sites = [{ origin, actions: [] }]
    const options = { store, clock, sites, drivers: new Map([[profileId, driver]]) }
    const runtime = new BrowserRuntime(options)
    const credential: AgentGrant = {
        kind: 'agent-grant', grantId: 'grant' as never, principalId: 'owner' as never,
        workspaceId: 'workspace' as never, machineId: 'machine' as never, agentSessionId: 'session' as never,
        profileId, allowedOrigins: [origin, 'https://other.test'], taskSpaceIds: [],
        operations: ['createSpace', 'createTask', 'openPage', 'observe', 'submitBatch', 'getTask', 'cancel', 'finishTask'],
        issuedAtMs: 0, expiresAtMs: 60_000,
    }
    const auth: AuthContext = { credential, verifiedAtMs: clock.now() }
    const human: AuthContext = { credential: {
        kind: 'interactive', capabilityId: 'capability', viewerSessionId: 'viewer', ...Object.fromEntries(
            ['principalId', 'workspaceId', 'machineId', 'profileId', 'issuedAtMs', 'expiresAtMs'].map(key => [key, credential[key as keyof AgentGrant]])),
        operations: ['approve', 'getTask'],
    } as InteractiveCapability, verifiedAtMs: clock.now() }
    const space = await runtime.createSpace(auth, { profileId, requestId: 'space' as RequestId })
    const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task' as RequestId })
    const opened = await runtime.openPage(auth, { taskId: task.taskId, url: origin + '/start', requestId: 'open' as RequestId })
    driver.seedTab(opened.tabId, { url: origin + '/start', elements: [
        { ref: '@menu' as never, role: 'button', name: 'Show filters', visible: true, frameOrigin: origin },
    ], uiActions: { '@menu': 'disclosure' } })
    const observation = await runtime.observe(auth, { taskId: task.taskId, tabId: opened.tabId })
    const mode = async (value: 'auto' | 'manual', requestId: string = value, origins = [origin], caller = human) => {
        const view = await runtime.getTask(auth, { taskId: task.taskId })
        return runtime.approve(caller, { taskId: task.taskId, requestId: requestId as RequestId, mode: value, origins, runtimeId: view.approvalMode!.runtimeId })
    }
    const click = async (id = 'click') => {
        const current = await runtime.getTask(auth, { taskId: task.taskId })
        const steps: BatchStep[] = [
            { kind: 'click', ref: '@menu', snapshotId: observation.snapshotId, tabId: opened.tabId,
                timeoutMs: 1000, stepId: id as never, actionId: id as never },
            { kind: 'waitFor', until: { kind: 'text', text: 'ready' }, tabId: opened.tabId,
                timeoutMs: 1000, stepId: (id + '-check') as never, actionId: (id + '-check') as never },
        ]
        return runtime.submitBatch(auth, { taskId: task.taskId, expectedVersion: current.stateVersion, requestId: id as RequestId, steps }, { waitMs: 3000 })
    }
    return { runtime, store, options, driver, clock, auth, human, task, opened, observation, mode, click }
}

describe('task-scoped browser Auto', () => {
    it('defaults to manual and does not approve a pending click when Auto is enabled', async () => {
        const h = await harness()
        expect((await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).approvalMode?.mode).toBe('manual')
        const waiting = await h.click()
        expect(waiting.result?.outcome).toBe('awaiting-user')
        const enabled = await h.mode('auto')
        expect(enabled.task.approvalMode?.mode).toBe('auto')
        expect(enabled.task.pendingApproval?.approvalId).toBe(waiting.task.pendingApproval?.approvalId)
        expect(h.driver.targetLedger.filter(x => x.operation === 'click')).toHaveLength(0)
    })

    it('automatically runs a proven UI disclosure in the consented task and site', async () => {
        const h = await harness()
        await h.mode('auto')
        const pending = h.click()
        await h.driver.waitForEntered
        await new Promise(setImmediate)
        h.driver.releaseWait()
        const result = await pending
        expect(result.result?.outcome).toBe('succeeded')
        expect(result.task.pendingApproval).toBeUndefined()
        expect(h.driver.targetLedger.filter(x => x.operation === 'click')).toHaveLength(1)
        expect(h.driver.clickExpectations[0]).toMatchObject({ uiAction: 'disclosure' })
    })

    it('keeps unknown and dangerous buttons under human approval', async () => {
        const h = await harness()
        await h.mode('auto')
        h.driver.seedTab(h.opened.tabId, { url: origin + '/start', elements: [
            { ref: '@menu' as never, role: 'button', name: 'Show filters', visible: true, frameOrigin: origin },
        ] })
        expect((await h.click()).result?.outcome).toBe('awaiting-user')
    })

    it('rejects agents, other principals, wildcard and unvisited scope', async () => {
        const h = await harness()
        await expect(h.mode('auto', 'agent', [origin], h.auth)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        const other = { ...h.human, credential: { ...h.human.credential, principalId: 'other' as never } }
        await expect(h.mode('auto', 'other', [origin], other)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        await expect(h.mode('auto', 'wildcard', ['*'])).rejects.toMatchObject({ code: 'ORIGIN_DENIED' })
        await expect(h.mode('auto', 'unvisited', ['https://other.test'])).rejects.toMatchObject({ code: 'ORIGIN_DENIED' })
    })

    it('revokes on disable and does not re-enable when an old enable request is retried', async () => {
        const h = await harness()
        await h.mode('auto', 'enable')
        await h.mode('manual', 'disable')
        expect((await h.mode('auto', 'enable')).task.approvalMode?.mode).toBe('manual')
        expect((await h.click()).result?.outcome).toBe('awaiting-user')
    })

    it('does not restore Auto after a runtime restart', async () => {
        const h = await harness()
        await h.mode('auto')
        const replacement = new BrowserRuntime(h.options)
        expect((await replacement.getTask(h.auth, { taskId: h.task.taskId })).approvalMode?.mode).toBe('manual')
    })

    it('expires with the human capability and is discarded by grant revocation', async () => {
        const h = await harness()
        const short = { ...h.human, credential: { ...h.human.credential, expiresAtMs: 200 } }
        await h.mode('auto', 'short', [origin], short)
        h.clock.set(201)
        expect((await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).approvalMode?.mode).toBe('manual')
        await h.mode('auto', 'again')
        await h.runtime.revokeGrant((h.auth.credential as AgentGrant).grantId)
        expect(h.store.getTask(h.task.taskId)?.status).toBe('paused')
        expect((await h.runtime.getTask(h.human, { taskId: h.task.taskId })).approvalMode?.mode).toBe('manual')
    })

    it('does not carry Auto to another task', async () => {
        const h = await harness()
        await h.mode('auto')
        const task = await h.runtime.createTask(h.auth, { taskSpaceId: h.task.taskSpaceId, requestId: 'other-task' as RequestId })
        expect(task.approvalMode?.mode).toBe('manual')
        expect((await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).approvalMode?.mode).toBe('auto')
    })
    it('rejects an old runtime nonce rather than replaying consent after restart', async () => {
        const h = await harness()
        const runtimeId = (await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).approvalMode!.runtimeId
        const replacement = new BrowserRuntime(h.options)
        await expect(replacement.approve(h.human, { taskId: h.task.taskId, requestId: 'old-runtime' as RequestId,
            mode: 'auto', origins: [origin], runtimeId })).rejects.toMatchObject({ code: 'CONFLICT' })
    })

    it('fences a description that finishes after the user disables Auto', async () => {
        const h = await harness()
        await h.mode('auto')
        const original = h.driver.describeRef.bind(h.driver)
        let release!: () => void, entered!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const ready = new Promise<void>(resolve => { entered = resolve })
        h.driver.describeRef = async (...args) => { const result = await original(...args); entered(); await gate; return result }
        const batch = h.click()
        await ready
        await h.mode('manual')
        release()
        await batch
        expect(h.driver.targetLedger.filter(x => x.operation === 'click')).toHaveLength(0)
    })

    it('fences consent revoked during driver input preparation', async () => {
        const h = await harness()
        await h.mode('auto')
        const original = h.driver.click.bind(h.driver)
        let release!: () => void, entered!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const ready = new Promise<void>(resolve => { entered = resolve })
        h.driver.click = async (...args) => { entered(); await gate; return original(...args) }
        const batch = h.click()
        await ready
        await h.mode('manual')
        release()
        await batch
        expect(h.driver.targetLedger.filter(x => x.operation === 'click')).toHaveLength(0)
    })

    it('drops task consent when the logical session ends', async () => {
        const h = await harness()
        await h.mode('auto')
        await h.runtime.endSession('session')
        expect((await h.runtime.getTask(h.human, { taskId: h.task.taskId })).approvalMode?.mode).toBe('manual')
    })

    it('drops Auto immediately when the consenting viewer capability is revoked', async () => {
        const h = await harness()
        await h.mode('auto')
        await h.store.revoke((h.human.credential as InteractiveCapability).capabilityId)
        expect((await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).approvalMode?.mode).toBe('manual')
        expect((await h.click()).result?.outcome).toBe('awaiting-user')
    })

    it('does not invalidate the agent task version when the user toggles a mode', async () => {
        const h = await harness()
        const before = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        await h.mode('auto')
        expect((await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).stateVersion).toBe(before.stateVersion)
        await h.mode('manual')
        const batch = await h.runtime.submitBatch(h.auth, { taskId: h.task.taskId, expectedVersion: before.stateVersion,
            requestId: 'unchanged-agent-plan' as RequestId, steps: [{ kind: 'observe', tabId: h.opened.tabId,
                stepId: 'read' as never, actionId: 'read' as never, timeoutMs: 1000 }] }, { waitMs: 2000 })
        expect(batch.result?.outcome).toBe('succeeded')
    })

    it('retries a failed journal write with the same request ID instead of returning false success', async () => {
        const h = await harness()
        const mutate = h.store.mutate.bind(h.store)
        let fail = true
        h.store.mutate = (id, callback) => mutate(id, current => {
            const mutation = callback(current)
            if (fail && mutation?.event.data.approvalModeChanged) {
                fail = false; throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'fixture journal failure')
            }
            return mutation
        })
        await expect(h.mode('auto', 'retry-once')).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' })
        expect((await h.mode('auto', 'retry-once')).task.approvalMode?.mode).toBe('auto')
    })

    it('bounds one task without blocking another task or preventing disable', async () => {
        const h = await harness()
        await h.mode('auto', 'initial')
        for (let i = 0; i < 65; i++) await h.mode('manual', 'manual-' + i)
        await expect(h.mode('auto', 'full')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
        expect((await h.mode('manual', 'still-disable')).task.approvalMode?.mode).toBe('manual')
        const task = await h.runtime.createTask(h.auth, { taskSpaceId: h.task.taskSpaceId, requestId: 'fresh-task' as RequestId })
        const page = await h.runtime.openPage(h.auth, { taskId: task.taskId, url: origin + '/start', requestId: 'fresh-page' as RequestId })
        await h.runtime.observe(h.auth, { taskId: task.taskId, tabId: page.tabId })
        const view = await h.runtime.getTask(h.auth, { taskId: task.taskId })
        const result = await h.runtime.approve(h.human, { taskId: task.taskId, requestId: 'fresh-mode' as RequestId,
            mode: 'auto', origins: [origin], runtimeId: view.approvalMode!.runtimeId })
        expect(result.task.approvalMode?.mode).toBe('auto')
    })

    it('does not replay a failed enable after a newer explicit disable', async () => {
        const h = await harness()
        const mutate = h.store.mutate.bind(h.store)
        let fail = true
        h.store.mutate = (id, callback) => mutate(id, current => {
            const mutation = callback(current)
            if (fail && mutation?.event.data.approvalModeChanged === 'auto') {
                fail = false; throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'fixture failure')
            }
            return mutation
        })
        await expect(h.mode('auto', 'older-failed')).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' })
        await h.mode('manual', 'newer-disable')
        await expect(h.mode('auto', 'older-failed')).rejects.toMatchObject({ code: 'CONFLICT' })
        expect((await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).approvalMode?.mode).toBe('manual')
    })

    it('preserves the failed request guard when a retry fails origin validation', async () => {
        const h = await harness()
        const mutate = h.store.mutate.bind(h.store)
        let fail = true
        h.store.mutate = (id, callback) => mutate(id, current => {
            const mutation = callback(current)
            if (fail && mutation?.event.data.approvalModeChanged === 'auto') {
                fail = false; throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'fixture failure')
            }
            return mutation
        })
        await expect(h.mode('auto', 'older-failed')).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' })
        h.options.sites.push({ origin: 'https://other.test', actions: [] })
        const observeAt = async (url: string) => {
            h.driver.seedTab(h.opened.tabId, { url, elements: [] })
            await h.runtime.observe(h.auth, { taskId: h.task.taskId, tabId: h.opened.tabId })
        }
        await observeAt('https://other.test/page')
        await expect(h.mode('auto', 'older-failed')).rejects.toMatchObject({ code: 'ORIGIN_DENIED' })
        await h.mode('manual', 'newer-disable')
        await observeAt(origin + '/start')
        await expect(h.mode('auto', 'older-failed')).rejects.toMatchObject({ code: 'CONFLICT' })
        expect((await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).approvalMode?.mode).toBe('manual')
    })

})
