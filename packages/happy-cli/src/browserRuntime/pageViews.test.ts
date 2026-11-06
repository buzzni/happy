import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentGrant, InteractiveCapability, ProfileId, RequestId } from './contracts'
import type { PageImage, PageInputRequest } from './pageViewContracts'
import { FakeClock } from './clock'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import { TaskStore } from './taskStore'
import { BrowserRuntime } from './runtime'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'page-views-'))
    const store = await TaskStore.open(dir)
    cleanup.push(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
    const profileId = 'profile' as ProfileId
    const clock = new FakeClock(1000)
    const image: PageImage = { data: 'synthetic-jpeg', mimeType: 'image/jpeg', documentGeneration: 1,
        viewport: { width: 800, height: 600, offsetX: 0, offsetY: 0, scale: 1 }, pixelWidth: 800, pixelHeight: 600,
        capturedAtMs: clock.now(), captureDurationMs: 5 }
    const pageView = { capture: vi.fn(async () => ({ ...image, capturedAtMs: clock.now() })),
        input: vi.fn(async (_tab, _frame, _event, validate) => { validate() }), release: vi.fn(async () => {}) }
    const driver = Object.assign(new FakeBrowserDriver(), { pageView })
    const options = { pageViewEnabled: true, sites: fixtureSitePolicies(['https://fixture.test']), store, drivers: new Map([[profileId, driver]]), clock }
    const runtime = new BrowserRuntime(options)
    const credential: AgentGrant = { kind: 'agent-grant', grantId: 'grant' as never, principalId: 'p' as never, workspaceId: 'w' as never,
        machineId: 'm' as never, agentSessionId: 'session' as never, profileId, allowedOrigins: ['https://fixture.test'],
        operations: ['createSpace', 'createTask', 'openPage', 'getTask'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 100000 }
    const agent = { credential, verifiedAtMs: clock.now() }
    const space = await runtime.createSpace(agent, { profileId, requestId: 'space' as RequestId })
    const task = await runtime.createTask(agent, { taskSpaceId: space.taskSpaceId, requestId: 'task' as RequestId })
    const opened = await runtime.openPage(agent, { taskId: task.taskId, url: 'https://fixture.test', requestId: 'page' as RequestId })
    const c: InteractiveCapability = { kind: 'interactive', capabilityId: 'cap', principalId: credential.principalId, workspaceId: credential.workspaceId,
        machineId: credential.machineId, profileId, viewerSessionId: 'viewer', operations: ['pageViewInfo', 'openPageView', 'getPageFrame',
            'dispatchPageInput', 'closePageView', 'getTask', 'listTasks', 'takeOver', 'releaseControl', 'resume'], issuedAtMs: 0, expiresAtMs: 90000 }
    const info = await runtime.pageViewInfo({ credential: c, verifiedAtMs: clock.now() }, { schemaVersion: 1, profileId })
    const user = { credential: { ...c, pageViewScope: { schemaVersion: 1 as const, agentSessionId: 'session', runtimeBindingId: info.runtimeBindingId } }, verifiedAtMs: clock.now() }
    const view = await runtime.openPageView(user, { schemaVersion: 1, agentSessionId: 'session', taskId: task.taskId, tabId: opened.tabId, runtimeBindingId: info.runtimeBindingId })
    const req = { schemaVersion: 1 as const, viewId: view.viewId }
    const frame = (await runtime.getPageFrame(user, req)).frame!
    const takeover = async () => runtime.takeOver(user, { taskId: task.taskId, tabId: opened.tabId,
        expectedEpoch: (await runtime.getTask(user, { taskId: task.taskId })).tabLeases!.find(t => t.tabId === opened.tabId)!.leaseEpoch, requestId: 'take' as RequestId })
    const input = (epoch: number): PageInputRequest => ({ ...req, frameId: frame.frameId, leaseEpoch: epoch, sequence: 1, event: { kind: 'text', text: '안녕하세요' } })
    return { runtime, store, options, clock, driver, pageView, user, agent, task, opened, req, frame, takeover, input }
}
it('narrows existing listing and get/control to the signed session and live runtime binding', async () => {
    const h = await fixture()
    const other = { ...h.user, credential: { ...h.user.credential, pageViewScope: { ...h.user.credential.pageViewScope, agentSessionId: 'other' } } }
    expect((await h.runtime.listTasks(other, { profileId: h.user.credential.profileId })).tasks).toEqual([])
    await expect(h.runtime.getTask(other, { taskId: h.task.taskId })).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    const replaced = new BrowserRuntime(h.options)
    await expect(replaced.getTask(h.user, { taskId: h.task.taskId })).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
})
it('refuses observer/stale input, executes a sequence once and retains an ACK receipt after close', async () => {
    const h = await fixture()
    await expect(h.runtime.dispatchPageInput(h.user, h.input(0))).rejects.toMatchObject({ code: 'STALE_LEASE' })
    expect(h.pageView.input).not.toHaveBeenCalled()
    const control = await h.takeover()
    const request = h.input(control.leaseEpoch)
    expect(await h.runtime.dispatchPageInput(h.user, request)).toEqual({ sequence: 1, state: 'applied' })
    expect(await h.runtime.dispatchPageInput(h.user, request)).toEqual({ sequence: 1, state: 'applied' })
    expect(h.pageView.input).toHaveBeenCalledTimes(1)
    await expect(h.runtime.dispatchPageInput(h.user, { ...request, event: { kind: 'text', text: 'changed' } })).rejects.toMatchObject({ code: 'CONFLICT' })
    await h.runtime.closePageView(h.user, h.req)
    expect((await h.runtime.getPageFrame(h.user, { ...h.req, statusOnly: true })).status).toMatchObject({ closed: true, lastSettled: 1, unknown: false })
})
it('keeps release fenced while dispatched input drains and never resumes on release alone', async () => {
    const h = await fixture()
    const control = await h.takeover()
    let settle!: () => void
    let entered!: () => void
    const ready = new Promise<void>(r => { entered = r })
    h.pageView.input.mockImplementationOnce(async (_t, _f, _e, validate) => { validate(); entered(); await new Promise<void>(r => { settle = r }) })
    const input = h.runtime.dispatchPageInput(h.user, h.input(control.leaseEpoch))
    await ready
    let returned = false
    const release = h.runtime.releaseControl(h.user, { taskId: h.task.taskId, tabId: h.opened.tabId, expectedEpoch: control.leaseEpoch, requestId: 'release' as RequestId }).then(v => { returned = true; return v })
    await new Promise(r => setImmediate(r))
    expect(returned).toBe(false)
    expect(h.runtime.leases.userControl(h.user.credential.profileId).settling).toBe(true)
    settle()
    await input
    expect((await release).task).toMatchObject({ status: 'paused', pauseReason: 'user-input-complete' })
    expect(h.pageView.release).toHaveBeenCalledTimes(1)
})
it('keeps unknown input in the task journal across view replacement and runtime restart', async () => {
    const h = await fixture()
    const control = await h.takeover()
    h.pageView.input.mockImplementationOnce(async (_t, _f, _e, validate) => { validate(); throw new Error('lost CDP response') })
    expect(await h.runtime.dispatchPageInput(h.user, h.input(control.leaseEpoch))).toMatchObject({ state: 'unknown' })
    const task = h.store.getTask(h.task.taskId)!
    expect(task.uncertainActions).toHaveLength(1)
    expect(task.pageViewInputOpen).toBe(true)
    const restarted = new BrowserRuntime(h.options)
    // Use an unscoped legacy read only to inspect persisted safety; the old scoped capability is invalid after restart.
    const legacy = { ...h.user, credential: { ...h.user.credential, pageViewScope: undefined } }
    const recovered = await restarted.getTask(legacy, { taskId: h.task.taskId })
    expect(recovered.uncertainActions.length).toBeGreaterThan(0)
    expect(restarted.leases.userControl(h.user.credential.profileId).settling).toBe(true)
})
it('discards a capture that finishes after close, and fixes view expiry to the original capability', async () => {
    const h = await fixture()
    h.clock.advance(500)
    let finish!: () => void
    let entered!: () => void
    const ready = new Promise<void>(r => { entered = r })
    h.pageView.capture.mockImplementationOnce(async () => { entered(); await new Promise<void>(r => { finish = r }); return { ...h.frame, capturedAtMs: h.clock.now() } })
    const late = h.runtime.getPageFrame(h.user, h.req)
    const rejected = expect(late).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    await ready
    await h.runtime.closePageView(h.user, h.req)
    finish()
    await rejected
    const renewed = { ...h.user, credential: { ...h.user.credential, capabilityId: 'renewed', expiresAtMs: 180000 } }
    h.clock.advance(90000)
    await expect(h.runtime.getPageFrame(renewed, { ...h.req, statusOnly: true })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})
it('drains held input on capability revocation and does not revive a cancelled task during recovery', async () => {
    const h = await fixture()
    const control = await h.takeover()
    await h.runtime.dispatchPageInput(h.user, h.input(control.leaseEpoch))
    h.runtime.pageViews.revoke(h.user.credential.capabilityId)
    await vi.waitFor(() => expect(h.pageView.release).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(h.store.getTask(h.task.taskId)!.pageViewInputOpen).toBe(false))
    // A crash may leave an input marker on a task already ended by another control flow.
    await h.store.mutate(h.task.taskId, current => ({ patch: { status: 'cancelled', cancelRequested: true, pageViewInputOpen: true },
        event: { schemaVersion: 1, taskId: current.taskId, seq: 0, stateVersion: current.stateVersion + 1, type: 'state-changed', atMs: h.clock.now(), leaseEpoch: 0, data: {} } }))
    const restarted = new BrowserRuntime(h.options)
    const legacy = { ...h.user, credential: { ...h.user.credential, pageViewScope: undefined } }
    expect((await restarted.getTask(legacy, { taskId: h.task.taskId })).status).toBe('cancelled')
    expect(restarted.leases.userControl(h.user.credential.profileId).settling).toBe(true)
})
it('enforces the aggregate encoded response budget before delivering a large image', async () => {
    const h = await fixture()
    h.clock.advance(500)
    h.pageView.capture.mockResolvedValueOnce({ ...h.frame, capturedAtMs: h.clock.now(), data: 'x'.repeat(510 * 1024) })
    await expect(h.runtime.getPageFrame(h.user, h.req)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    h.clock.advance(500)
    const response = await h.runtime.getPageFrame(h.user, h.req)
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(500 * 1024)
})
