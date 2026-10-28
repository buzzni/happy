/**
 * The input evidence the Runtime gives its drivers for popup provenance: whose input a
 * tab's popup can have come from. Agent only while the agent's lease holds the tab and
 * no user can have given input on the profile within the user activation window.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentGrant, InteractiveCapability, ProfileId, RequestId, TabId } from './contracts'
import { FakeClock } from './clock'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import { TaskStore } from './taskStore'
import { BrowserRuntime, USER_INPUT_ACTIVATION_MS } from './runtime'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

async function createHarness() {
    const dir = await mkdtemp(join(tmpdir(), 'abp-tab-provenance-')); dirs.push(dir)
    const store = await TaskStore.open(dir); const clock = new FakeClock(100)
    const profileId = 'profile-1' as ProfileId; const driver = new FakeBrowserDriver()
    const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock, sites: fixtureSitePolicies(['https://fixture.test']) })
    const grant: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never,
        machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'],
        operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'observe', 'finishTask', 'resume'],
        taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
    const auth = { credential: grant, verifiedAtMs: clock.now() }
    const capability: InteractiveCapability = { kind: 'interactive', capabilityId: 'ui' as never, principalId: 'p' as never,
        workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer', profileId,
        operations: ['approve', 'takeOver', 'releaseControl', 'resume', 'getTask'], issuedAtMs: 0, expiresAtMs: 3_600_000 }
    const ui = { credential: capability, verifiedAtMs: clock.now() }
    const space = await runtime.createSpace(auth, { profileId, requestId: 'space' as RequestId })
    const openTask = async (label: string) => {
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: `task-${label}` as RequestId })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: `https://fixture.test/${label}`, requestId: `open-${label}` as RequestId })
        return { taskId: task.taskId, tabId: opened.tabId }
    }
    const evidence = (tabId: TabId) => driver.inputEvidence(tabId)
    return { store, clock, profileId, driver, runtime, auth, ui, openTask, evidence }
}

describe('input evidence for popup provenance', () => {
    it('reports the agent only while its batch holds the tab, and nothing about other tabs', async () => {
        const h = await createHarness()
        const one = await h.openTask('one')
        const two = await h.openTask('two')
        h.clock.advance(USER_INPUT_ACTIVATION_MS)
        h.driver.seedTab(one.tabId, { url: 'https://fixture.test/one', elements: [
            { ref: '@go' as never, role: 'button', name: 'Go', visible: true, frameOrigin: 'https://fixture.test' }] })
        const observed = await h.runtime.observe(h.auth, { taskId: one.taskId, tabId: one.tabId })
        expect(h.evidence(one.tabId)).toEqual({ owner: 'none', userInputRecent: false, userControlEpoch: 0 })
        const held = h.driver.holdAfterNextDispatch('click')
        const task = await h.runtime.getTask(h.auth, { taskId: one.taskId })
        const batch = h.runtime.submitBatch(h.auth, { taskId: one.taskId, expectedVersion: task.stateVersion, requestId: 'batch' as RequestId,
            steps: [{ stepId: 's' as never, actionId: 'click-go' as never, tabId: one.tabId, kind: 'click', ref: '@go' as never,
                snapshotId: observed.snapshotId, timeoutMs: 1000 }] }, { waitMs: 2000 })
        await held.entered
        expect(h.evidence(one.tabId)).toEqual({ owner: 'agent', userInputRecent: false, userControlEpoch: 0 })
        expect(h.evidence(two.tabId)).toEqual({ owner: 'none', userInputRecent: false, userControlEpoch: 0 })
        held.release()
        expect((await batch).result?.outcome).toBe('succeeded')
        expect(h.evidence(one.tabId)?.owner).toBe('none')
        await h.store.close()
    })

    it('reports user control on the held tab and recent user input on every tab until the activation window has passed', async () => {
        const h = await createHarness()
        const one = await h.openTask('one')
        const two = await h.openTask('two')
        h.clock.advance(USER_INPUT_ACTIVATION_MS)
        const taken = await h.runtime.takeOver(h.ui, { taskId: one.taskId, tabId: one.tabId,
            expectedEpoch: h.runtime.leases.owner(one.tabId, h.profileId).leaseEpoch, requestId: 'take' as RequestId })
        expect(h.evidence(one.tabId)).toEqual({ owner: 'user', userInputRecent: true, userControlEpoch: 1 })
        // The user's input is not confined to the tab they took: the whole profile follows them.
        expect(h.evidence(two.tabId)).toEqual({ owner: 'none', userInputRecent: true, userControlEpoch: 1 })
        await h.runtime.releaseControl(h.ui, { taskId: one.taskId, tabId: one.tabId, expectedEpoch: taken.leaseEpoch, requestId: 'release' as RequestId })
        h.clock.advance(USER_INPUT_ACTIVATION_MS - 1)
        expect(h.evidence(one.tabId)).toEqual({ owner: 'none', userInputRecent: true, userControlEpoch: 1 })
        h.clock.advance(1)
        expect(h.evidence(one.tabId)).toEqual({ owner: 'none', userInputRecent: false, userControlEpoch: 1 })
        await h.store.close()
    })

    it('treats the first activation window after the Runtime starts as possibly following user input', async () => {
        const h = await createHarness()
        const one = await h.openTask('one')
        expect(h.evidence(one.tabId)?.userInputRecent).toBe(true)
        h.clock.advance(USER_INPUT_ACTIVATION_MS)
        expect(h.evidence(one.tabId)?.userInputRecent).toBe(false)
        await h.store.close()
    })

    it('counts a viewer drain fence as user input', async () => {
        const h = await createHarness()
        const one = await h.openTask('one')
        h.clock.advance(USER_INPUT_ACTIVATION_MS)
        const lift = h.runtime.leases.fenceProfile(h.profileId)
        expect(h.evidence(one.tabId)).toEqual({ owner: 'none', userInputRecent: true, userControlEpoch: 1 })
        lift()
        h.clock.advance(USER_INPUT_ACTIVATION_MS)
        expect(h.evidence(one.tabId)).toEqual({ owner: 'none', userInputRecent: false, userControlEpoch: 1 })
        await h.store.close()
    })
})
