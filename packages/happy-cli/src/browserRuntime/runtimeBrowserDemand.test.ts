import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserRuntime } from './runtime'
import { TaskStore } from './taskStore'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { FakeClock } from './clock'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import type { AgentGrant, ProfileId, RequestId } from './contracts'
import { createPersonalBrowserAdmission } from './runtimeProcess'
import type { CdpDriver } from './drivers/cdpDriver'
import type { NativeBrowserSession } from './nativeBrowserSession'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('starts the personal browser only after task scope validation; metadata and a duplicate request do not start it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'browser-demand-')); roots.push(dir)
    const profileId = 'profile' as ProfileId
    const ensureBrowser = vi.fn(async () => {})
    const options = { store: await TaskStore.open(dir), drivers: new Map([[profileId, new FakeBrowserDriver()]]),
        clock: new FakeClock(100), sites: fixtureSitePolicies(['https://fixture.test']), ensureBrowser }
    const runtime = new BrowserRuntime(options)
    const credential: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never,
        workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: 'a' as never, profileId,
        allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'listSpaces', 'createTask'],
        taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
    const auth = { credential, verifiedAtMs: 100 }
    const space = await runtime.createSpace(auth, { profileId, requestId: 'space' as RequestId })
    await runtime.listSpaces(auth, { profileId })
    expect(ensureBrowser).not.toHaveBeenCalled()
    await expect(runtime.createTask({ ...auth, credential: { ...credential, profileId: 'foreign' as ProfileId } },
        { taskSpaceId: space.taskSpaceId, requestId: 'forbidden' as RequestId })).rejects.toThrow()
    expect(ensureBrowser).not.toHaveBeenCalled()
    const request = { taskSpaceId: space.taskSpaceId, requestId: 'task' as RequestId }
    const task = await runtime.createTask(auth, request)
    expect(ensureBrowser).toHaveBeenCalledExactlyOnceWith(profileId)
    expect((await runtime.createTask(auth, request)).taskId).toEqual(task.taskId)
    expect(ensureBrowser).toHaveBeenCalledOnce()
    // A long OS launch must not allow an expired grant to create a task.
    ensureBrowser.mockImplementationOnce(async () => { options.clock.set(credential.expiresAtMs + 1) })
    await expect(runtime.createTask(auth, { ...request, requestId: 'expired' as RequestId })).rejects.toThrow()
    expect(options.store.listTasks()).toHaveLength(1)
    await options.store.close()
})

it('admits inputs on a new browser lifetime while fencing old tasks and tabs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'browser-restart-')); roots.push(dir)
    const store = await TaskStore.open(dir), profileId = 'profile' as ProfileId
    const first = new FakeBrowserDriver(), second = new FakeBrowserDriver()
    const session = (driver: FakeBrowserDriver): NativeBrowserSession => ({
        driver: driver as unknown as CdpDriver, stopped: new Promise(() => {}),
        check: async () => {}, close: async () => ({ terminated: true }),
    })
    const drivers = new Map([[profileId, first as unknown as CdpDriver]])
    let active = session(first)
    const start = vi.fn(async () => active)
    const reconnected = vi.fn(() => runtime.onDriverReconnected(profileId))
    const ensureBrowser = createPersonalBrowserAdmission(profileId, drivers, start, reconnected)
    const runtime: BrowserRuntime = new BrowserRuntime({ store, drivers, clock: new FakeClock(100),
        sites: fixtureSitePolicies(['https://fixture.test']), ensureBrowser })
    const credential: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never,
        workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: 'a' as never, profileId,
        allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'openPage', 'getTask', 'submitBatch'],
        taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
    const auth = { credential, verifiedAtMs: 100 }
    await Promise.all([ensureBrowser(profileId), ensureBrowser(profileId)])
    expect(start).toHaveBeenCalledOnce()
    expect(reconnected).toHaveBeenCalledOnce()
    await expect(ensureBrowser('foreign' as ProfileId)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    expect(start).toHaveBeenCalledOnce()
    const space = await runtime.createSpace(auth, { profileId, requestId: 'space' as RequestId })
    const old = await runtime.createTask(auth, { ...space, requestId: 'old' as RequestId })
    await runtime.openPage(auth, { taskId: old.taskId, url: 'https://fixture.test/old', requestId: 'old-tab' as RequestId })
    await runtime.onDriverDisconnected(profileId)
    active = session(second)
    const fresh = await runtime.createTask(auth, { ...space, requestId: 'fresh' as RequestId })
    expect(await runtime.getTask(auth, { taskId: old.taskId })).toMatchObject({ status: 'paused', pauseReason: 'browser-replaced', tabs: [] })
    expect(second.adoptedTabs).toEqual([])
    const opened = await runtime.openPage(auth, { taskId: fresh.taskId, url: 'https://fixture.test/new', requestId: 'new-tab' as RequestId })
    const current = await runtime.getTask(auth, { taskId: fresh.taskId })
    const batch = await runtime.submitBatch(auth, { taskId: fresh.taskId, expectedVersion: current.stateVersion,
        requestId: 'navigate' as RequestId, steps: [{ stepId: 's' as never, actionId: 'a' as never, tabId: opened.tabId,
            kind: 'navigate', url: 'https://fixture.test/after', timeoutMs: 1000 }] }, { waitMs: 1000 })
    expect(batch.result?.outcome).toBe('succeeded')
    await store.close()
})
