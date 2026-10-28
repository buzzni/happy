/**
 * Tabs kept for the user: once a task hands a tab to the user (a hand-off, a login or
 * captcha wait) or a user takes control of it, no automatic cleanup closes it — not when
 * the task ends, the user gives control back, the session ends, the space idles, the task
 * expires, a local client is revoked or the Runtime restarts. The tab keeps its task, space,
 * target and lease records and counts against the quotas; cleanup reports it as retained.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from './clock'
import { POC_LIMITS, type AgentGrant, type InteractiveCapability, type ProfileId, type RequestId, type SnapshotId, type TabId, type TaskId, type TaskSpaceId } from './contracts'
import { BrowserRuntime } from './runtime'
import type { SitePolicy } from './policy'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { TaskStore, type FaultInjector } from './taskStore'

const MINUTE = 60_000
const ORIGIN = 'https://fixture.test'
const SITES: SitePolicy[] = [{ origin: ORIGIN, actions: [{ match: {}, risk: 'auto' }], loginCompleteWhen: { urlPrefix: `${ORIGIN}/home` } }]
const profileId = 'profile-1' as ProfileId
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

let requests = 0
const rid = (label: string) => `${label}-${++requests}` as RequestId

async function harness(options: { dir?: string; driver?: FakeBrowserDriver; clock?: FakeClock; spaceIdleReclaimMs?: number; faults?: FaultInjector } = {}) {
    const dir = options.dir ?? await mkdtemp(join(tmpdir(), 'abp-retention-'))
    if (!options.dir) dirs.push(dir)
    const store = await TaskStore.open(dir, options.faults)
    const clock = options.clock ?? new FakeClock(1_000)
    const driver = options.driver ?? new FakeBrowserDriver()
    const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock, sites: SITES, maxSpacesPerProfile: 4,
        ...(options.spaceIdleReclaimMs ? { spaceIdleReclaimMs: options.spaceIdleReclaimMs } : {}) })
    const agent = (agentSessionId = 'session-a') => ({ verifiedAtMs: clock.now(), credential: {
        kind: 'agent-grant', grantId: `grant-${agentSessionId}`, principalId: 'p', workspaceId: 'w', machineId: 'm', agentSessionId, profileId,
        allowedOrigins: [ORIGIN], operations: ['createSpace', 'createTask', 'joinSpace', 'openPage', 'closePage', 'closeSpace', 'submitBatch', 'getTask', 'observe', 'finishTask', 'cancel', 'resume'],
        taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 10 * 24 * 60 * MINUTE } as unknown as AgentGrant })
    const capability: InteractiveCapability = { kind: 'interactive', capabilityId: 'ui' as never, principalId: 'p' as never, workspaceId: 'w' as never,
        machineId: 'm' as never, viewerSessionId: 'viewer', profileId, operations: ['takeOver', 'releaseControl', 'resume', 'getTask'],
        issuedAtMs: 0, expiresAtMs: 10 * 24 * 60 * MINUTE }
    const ui = { credential: capability, verifiedAtMs: clock.now() }
    /** A space with one task and one open tab of `agentSessionId` (a fresh space unless given). */
    const open = async (agentSessionId = 'session-a', path = '/start', taskSpaceId?: TaskSpaceId) => {
        const auth = agent(agentSessionId)
        const spaceId = taskSpaceId ?? (await runtime.createSpace(auth, { profileId, requestId: rid('space') })).taskSpaceId
        const task = await runtime.createTask(auth, { taskSpaceId: spaceId, requestId: rid('task') })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: `${ORIGIN}${path}`, requestId: rid('open') })
        return { auth, taskSpaceId: spaceId, taskId: task.taskId, tabId: opened.tabId }
    }
    /** The agent's click on an opaque submission: the Runtime hands the tab to the user (awaiting-user / handoff). */
    const handOff = async (page: { auth: ReturnType<typeof agent>; taskId: TaskId; tabId: TabId }) => {
        driver.seedTab(page.tabId, { url: `${ORIGIN}/start`, form: { action: `${ORIGIN}/session`, method: 'post', enctype: 'application/x-www-form-urlencoded',
            target: '', fields: [['user', 'synthetic']], submitter: null, opaque: true },
            elements: [{ ref: '@go' as never, role: 'button', name: 'Opaque submission', visible: true, frameOrigin: ORIGIN }] })
        const observed = await runtime.observe(page.auth, { taskId: page.taskId, tabId: page.tabId })
        const current = await runtime.getTask(page.auth, { taskId: page.taskId })
        const batch = await runtime.submitBatch(page.auth, { taskId: page.taskId, expectedVersion: current.stateVersion, requestId: rid('batch'), steps: [
            { stepId: 'go' as never, actionId: `go-${rid('a')}` as never, kind: 'click', tabId: page.tabId, ref: '@go' as never, snapshotId: observed.snapshotId as SnapshotId, timeoutMs: 1000 },
            { stepId: 'wait' as never, actionId: `wait-${rid('a')}` as never, kind: 'waitFor', tabId: page.tabId, until: { kind: 'text', text: 'Complete' }, timeoutMs: 1000 },
        ] }, { waitMs: 2000 })
        expect(batch.task.status).toBe('awaiting-user')
        expect(batch.result?.waitReason).toBe('handoff')
    }
    const takeOver = (page: { taskId: TaskId; tabId: TabId }) => runtime.takeOver(ui, { taskId: page.taskId, tabId: page.tabId,
        expectedEpoch: runtime.leases.owner(page.tabId, profileId).leaseEpoch, requestId: rid('take') })
    const release = (page: { taskId: TaskId; tabId: TabId }, leaseEpoch: number) => runtime.releaseControl(ui, { taskId: page.taskId, tabId: page.tabId,
        expectedEpoch: leaseEpoch, requestId: rid('release') })
    const retained = (taskSpaceId: TaskSpaceId) => Object.entries(store.getSpace(taskSpaceId)?.tabDispositions ?? {})
        .filter(([, disposition]) => disposition.retained).map(([tabId]) => tabId)
    return { dir, store, clock, driver, runtime, agent, ui, open, handOff, takeOver, release, retained }
}

describe('a tab handed to the user', () => {
    it('stays open when its session ends while the hand-off waits for the user, and the space reports it retained', async () => {
        const h = await harness()
        const page = await h.open()
        await h.handOff(page)
        await h.runtime.endSession('session-a')
        const [report] = await h.runtime.reclaimSpaces()
        expect(report).toMatchObject({ taskSpaceId: page.taskSpaceId, closed: false, closedTabs: [], retainedTabs: [page.tabId] })
        expect(h.driver.hasTab(page.tabId)).toBe(true)
        // Its task, target and space records stay.
        const space = h.store.getSpace(page.taskSpaceId)!
        expect(space.tabs).toEqual([page.tabId])
        expect(space.tabTargets?.[page.tabId]).toBeTruthy()
        expect(space.tabDispositions?.[page.tabId]).toMatchObject({ createdBy: 'agent', retained: { reason: 'handoff', taskId: page.taskId } })
        expect(h.store.getTask(page.taskId)?.tabs).toEqual([page.tabId])
        // Later passes keep it as well.
        expect(await h.runtime.reclaimSpaces()).toEqual([expect.objectContaining({ closed: false, retainedTabs: [page.tabId] })])
        expect(h.driver.hasTab(page.tabId)).toBe(true)
        await h.store.close()
    })

    it('stays open after the user held control, the task was cancelled and the user gave control back', async () => {
        const h = await harness()
        const page = await h.open()
        await h.handOff(page)
        const taken = await h.takeOver(page)
        await h.runtime.endSession('session-a')
        expect(await h.runtime.reclaimSpaces()).toEqual([expect.objectContaining({ retainedTabs: [page.tabId] })])
        await h.release(page, taken.leaseEpoch)
        await h.runtime.reclaimSpaces()
        expect(h.driver.hasTab(page.tabId)).toBe(true)
        expect(h.retained(page.taskSpaceId)).toEqual([page.tabId])
        await h.store.close()
    })

    it('keeps a tab the user took over without any hand-off, after release and session end', async () => {
        const h = await harness()
        const page = await h.open()
        const taken = await h.takeOver(page)
        expect(h.store.getSpace(page.taskSpaceId)?.tabDispositions?.[page.tabId]?.retained).toMatchObject({ reason: 'user-control', taskId: page.taskId })
        await h.release(page, taken.leaseEpoch)
        await h.runtime.endSession('session-a')
        await h.runtime.reclaimSpaces()
        expect(h.driver.hasTab(page.tabId)).toBe(true)
        await h.store.close()
    })

    it('keeps a page that opened on a login wait', async () => {
        const h = await harness()
        const page = await h.open('session-a', '/login')
        expect((await h.runtime.getTask(page.auth, { taskId: page.taskId })).waitReason).toBe('login')
        expect(h.store.getSpace(page.taskSpaceId)?.tabDispositions?.[page.tabId]?.retained?.reason).toBe('login')
        await h.runtime.endSession('session-a')
        await h.runtime.reclaimSpaces()
        expect(h.driver.hasTab(page.tabId)).toBe(true)
        await h.store.close()
    })

    it('stays kept when the agent resumes and finishes the task, and through idle reclamation', async () => {
        const h = await harness({ spaceIdleReclaimMs: 15 * MINUTE })
        const page = await h.open()
        await h.handOff(page)
        const taken = await h.takeOver(page)
        const released = await h.release(page, taken.leaseEpoch)
        const resumed = await h.runtime.resume(h.ui, { taskId: page.taskId, expectedVersion: released.task.stateVersion, requestId: rid('resume') })
        await h.runtime.finishTask(page.auth, { taskId: page.taskId, expectedVersion: resumed.stateVersion, requestId: rid('finish') })
        h.clock.advance(16 * MINUTE)
        expect(await h.runtime.reclaimSpaces()).toEqual([expect.objectContaining({ reason: 'idle', closed: false, retainedTabs: [page.tabId] })])
        expect(h.driver.hasTab(page.tabId)).toBe(true)
        await h.store.close()
    })

    it('is not closed by the agent: closePage and closeSpace refuse, the page stays', async () => {
        const h = await harness()
        const page = await h.open()
        const taken = await h.takeOver(page)
        await h.release(page, taken.leaseEpoch)
        await h.runtime.cancel(page.auth, { taskId: page.taskId, requestId: rid('cancel') })
        await expect(h.runtime.closePage(page.auth, { taskSpaceId: page.taskSpaceId, tabId: page.tabId, requestId: rid('close') }))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(h.runtime.closeSpace(page.auth, { taskSpaceId: page.taskSpaceId, requestId: rid('close-space') }))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        expect(h.driver.hasTab(page.tabId)).toBe(true)
        expect(h.store.getSpace(page.taskSpaceId)?.closed).not.toBe(true)
        await h.store.close()
    })

    it('closes the other tabs of the space (other tasks, plain agent tabs) and keeps only the handed-off one', async () => {
        const h = await harness()
        const kept = await h.open()
        const plain = await h.open('session-a', '/other', kept.taskSpaceId)
        const otherSession = await h.open('session-b')
        await h.handOff(kept)
        await h.runtime.endSession('session-a')
        const reports = await h.runtime.reclaimSpaces()
        expect(reports).toEqual([expect.objectContaining({ taskSpaceId: kept.taskSpaceId, closed: false, closedTabs: [plain.tabId], retainedTabs: [kept.tabId] })])
        expect([h.driver.hasTab(kept.tabId), h.driver.hasTab(plain.tabId), h.driver.hasTab(otherSession.tabId)]).toEqual([true, false, true])
        expect(h.store.getSpace(kept.taskSpaceId)?.tabs).toEqual([kept.tabId])
        await h.store.close()
    })

    it('is closed by an operator who forces the space closed, and only then', async () => {
        const h = await harness()
        const page = await h.open()
        await h.handOff(page)
        expect(await h.runtime.closeSpaceAsOperator(page.taskSpaceId)).toMatchObject({ closed: false, retainedTabs: [page.tabId] })
        expect(h.driver.hasTab(page.tabId)).toBe(true)
        expect(await h.runtime.closeSpaceAsOperator(page.taskSpaceId, { force: true })).toMatchObject({ closed: true, closedTabs: [page.tabId] })
        expect(h.driver.hasTab(page.tabId)).toBe(false)
        expect(h.store.getSpace(page.taskSpaceId)?.tabDispositions ?? {}).toEqual({})
        await h.store.close()
    })

    it('leaves its space once the user has closed it in the browser, freeing the quotas', async () => {
        const h = await harness()
        const page = await h.open()
        await h.handOff(page)
        await h.runtime.endSession('session-a')
        await h.driver.closeTab(page.tabId, { timeoutMs: 1000 })
        expect(await h.runtime.reclaimSpaces()).toEqual([expect.objectContaining({ taskSpaceId: page.taskSpaceId, closed: true, closedTabs: [page.tabId] })])
        expect(h.store.getSpace(page.taskSpaceId)?.tabDispositions ?? {}).toEqual({})
        await h.store.close()
    })

    it('keeps its task record through retention: the expired task is not purged while the tab is kept', async () => {
        const h = await harness()
        const page = await h.open()
        await h.handOff(page)
        await h.runtime.cancel(page.auth, { taskId: page.taskId, requestId: rid('cancel') })
        h.clock.advance(400 * 24 * 60 * MINUTE)
        expect(await h.runtime.purgeExpiredTasks(24 * 60 * MINUTE)).toEqual([])
        expect(h.driver.hasTab(page.tabId)).toBe(true)
        expect(h.store.getTask(page.taskId)).toBeDefined()
        await h.store.close()
    })

    it('lets a local client end (no endless retry) while its handed-off tab stays', async () => {
        const h = await harness()
        const owner = h.agent('session-a')
        const { taskSpaceId } = await h.runtime.createSpace(owner, { profileId, requestId: rid('space') })
        const client = { ...h.agent('client-1').credential, taskSpaceIds: [taskSpaceId] } as AgentGrant
        await h.runtime.attachLocalClient(owner, client, h.clock.now() + 60 * MINUTE)
        const auth = { credential: client, verifiedAtMs: h.clock.now() }
        const task = await h.runtime.createTask(auth, { taskSpaceId, requestId: rid('task') })
        const opened = await h.runtime.openPage(auth, { taskId: task.taskId, url: `${ORIGIN}/start`, requestId: rid('open') })
        const page = { auth, taskSpaceId, taskId: task.taskId, tabId: opened.tabId }
        await h.handOff(page)
        await h.runtime.endLocalClient('client-1')
        expect(h.driver.hasTab(page.tabId)).toBe(true)
        expect(h.store.getTask(page.taskId)?.status).toBe('cancelled')
        await h.store.close()
    })

    it('stays kept across a Runtime restart that re-adopts the tab, and is told apart from how it was created', async () => {
        const driver = new FakeBrowserDriver()
        const first = await harness({ driver })
        const page = await first.open()
        await first.handOff(page)
        await first.store.close()
        const restarted = await harness({ dir: first.dir, driver, clock: first.clock })
        await restarted.runtime.getTask(page.auth, { taskId: page.taskId })
        expect(driver.adoptedTabs).toEqual([expect.objectContaining({ tabId: page.tabId, adopted: true })])
        expect(restarted.store.getSpace(page.taskSpaceId)?.tabDispositions?.[page.tabId]).toMatchObject({ createdBy: 'agent',
            adoptedAtMs: expect.any(Number), retained: { reason: 'handoff' } })
        await restarted.runtime.endSession('session-a')
        expect(await restarted.runtime.reclaimSpaces()).toEqual([expect.objectContaining({ retainedTabs: [page.tabId] })])
        expect(driver.hasTab(page.tabId)).toBe(true)
        await restarted.store.close()
    })

    it('is dropped, not resurrected, when the browser was replaced', async () => {
        const h = await harness()
        const page = await h.open()
        await h.handOff(page)
        await h.runtime.onDriverDisconnected(profileId)
        h.driver.swapInstance()
        await h.runtime.onDriverReconnected(profileId)
        expect(h.store.getSpace(page.taskSpaceId)?.tabs).toEqual([])
        expect(h.store.getSpace(page.taskSpaceId)?.tabDispositions ?? {}).toEqual({})
        await h.store.close()
    })

    it('still counts against the active tab quota', async () => {
        const h = await harness()
        const page = await h.open()
        await h.handOff(page)
        await h.runtime.endSession('session-a')
        await h.runtime.reclaimSpaces()
        const spaceB = (await h.runtime.createSpace(h.agent('session-b'), { profileId, requestId: rid('space') })).taskSpaceId
        for (let i = 1; i < POC_LIMITS.maxActiveTabs; i++) await h.open('session-b', `/p${i}`, spaceB)
        await expect(h.open('session-b', '/over', spaceB)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
        expect(h.driver.hasTab(page.tabId)).toBe(true)
        await h.store.close()
    })

    it('fails a takeover whose retention could not be recorded, instead of handing control over unrecorded', async () => {
        let failSpaces = false
        const h = await harness({ faults: (operation) => { if (failSpaces && operation === 'metadata') throw new Error('injected spaces.json failure') } })
        const page = await h.open()
        failSpaces = true
        await expect(h.takeOver(page)).rejects.toBeDefined()
        failSpaces = false
        expect(h.runtime.leases.owner(page.tabId, profileId).owner.kind).toBe('none')
        await h.store.close()
    })

    it('keeps a tab of a record from before dispositions whose task was handed to the user, released, resumed and finished (history unknown)', async () => {
        const driver = new FakeBrowserDriver()
        const first = await harness({ driver })
        const page = await first.open()
        const plain = await first.open('session-a', '/other', page.taskSpaceId)
        await first.handOff(page)
        const taken = await first.takeOver(page)
        const released = await first.release(page, taken.leaseEpoch)
        const resumed = await first.runtime.resume(first.ui, { taskId: page.taskId, expectedVersion: released.task.stateVersion, requestId: rid('resume') })
        await first.runtime.finishTask(page.auth, { taskId: page.taskId, expectedVersion: resumed.stateVersion, requestId: rid('finish') })
        // What an earlier Runtime leaves on disk: no dispositions at all, and nothing current says the tab was handed over.
        await first.store.updateSpace(page.taskSpaceId, { tabDispositions: undefined })
        expect(first.store.getTask(page.taskId)).toMatchObject({ status: 'succeeded', waitReason: undefined })
        await first.store.close()

        const restarted = await harness({ dir: first.dir, driver, clock: first.clock })
        await restarted.runtime.getTask(page.auth, { taskId: page.taskId })
        // Unknown is not a proven hand-off: kept, and labelled as unknown history.
        for (const tabId of [page.tabId, plain.tabId])
            expect(restarted.store.getSpace(page.taskSpaceId)?.tabDispositions?.[tabId]).toEqual({ createdBy: 'agent', adoptedAtMs: expect.any(Number), retentionUnknown: true })
        // A tab this Runtime opens itself has its history: it still closes as before.
        const fresh = await restarted.open('session-a', '/fresh', page.taskSpaceId)
        await restarted.runtime.endSession('session-a')
        const [report] = await restarted.runtime.reclaimSpaces()
        expect(report).toMatchObject({ closed: false, closedTabs: [fresh.tabId] })
        expect(new Set(report.retainedTabs)).toEqual(new Set([page.tabId, plain.tabId]))
        expect(await restarted.runtime.reclaimSpaces()).toEqual([expect.objectContaining({ closed: false, closedTabs: [] })])
        await expect(restarted.runtime.closePage(page.auth, { taskSpaceId: page.taskSpaceId, tabId: page.tabId, requestId: rid('close') }))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(restarted.runtime.closeSpace(page.auth, { taskSpaceId: page.taskSpaceId, requestId: rid('close-space') }))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        restarted.clock.advance(400 * 24 * 60 * MINUTE)
        // Only the task of the closed fresh tab expires; the kept tabs' tasks stay.
        expect(await restarted.runtime.purgeExpiredTasks(24 * 60 * MINUTE)).toEqual([fresh.taskId])
        expect(new Set(restarted.runtime.spaceReport()[0].retainedTabs)).toEqual(new Set([page.tabId, plain.tabId]))
        await restarted.store.close()

        // A second restart re-adopts them with the same unknown history.
        const again = await harness({ dir: first.dir, driver, clock: first.clock })
        await again.runtime.reclaimSpaces()
        expect(again.store.getSpace(page.taskSpaceId)?.tabDispositions?.[page.tabId]).toMatchObject({ retentionUnknown: true })
        expect(again.store.getSpace(page.taskSpaceId)?.tabDispositions?.[page.tabId]?.retained).toBeUndefined()
        expect([driver.hasTab(page.tabId), driver.hasTab(plain.tabId), driver.hasTab(fresh.tabId)]).toEqual([true, true, false])
        expect(again.store.getTask(page.taskId)).toBeDefined()
        await again.store.close()
    })

    it('records a hand-off still pending in a record from before dispositions as a proven hand-off', async () => {
        const driver = new FakeBrowserDriver()
        const first = await harness({ driver })
        const page = await first.open()
        await first.handOff(page)
        await first.store.updateSpace(page.taskSpaceId, { tabDispositions: undefined })
        await first.store.close()
        const restarted = await harness({ dir: first.dir, driver, clock: first.clock })
        await restarted.runtime.getTask(page.auth, { taskId: page.taskId })
        expect(restarted.store.getSpace(page.taskSpaceId)?.tabDispositions?.[page.tabId]).toEqual({ createdBy: 'agent', adoptedAtMs: expect.any(Number),
            retained: { reason: 'handoff', taskId: page.taskId, atMs: expect.any(Number) } })
        await restarted.store.close()
    })

    it('lets a local client end while a tab of unknown history stays', async () => {
        const driver = new FakeBrowserDriver()
        const first = await harness({ driver })
        const owner = first.agent('session-a')
        const { taskSpaceId } = await first.runtime.createSpace(owner, { profileId, requestId: rid('space') })
        const client = { ...first.agent('client-1').credential, taskSpaceIds: [taskSpaceId] } as AgentGrant
        await first.runtime.attachLocalClient(owner, client, first.clock.now() + 60 * MINUTE)
        const auth = { credential: client, verifiedAtMs: first.clock.now() }
        const task = await first.runtime.createTask(auth, { taskSpaceId, requestId: rid('task') })
        const opened = await first.runtime.openPage(auth, { taskId: task.taskId, url: `${ORIGIN}/start`, requestId: rid('open') })
        await first.store.updateSpace(taskSpaceId, { tabDispositions: undefined })
        await first.store.close()
        const restarted = await harness({ dir: first.dir, driver, clock: first.clock })
        await restarted.runtime.endLocalClient('client-1')
        expect(driver.hasTab(opened.tabId)).toBe(true)
        expect(restarted.store.getTask(task.taskId)?.status).toBe('cancelled')
        await restarted.store.close()
    })

    it('reports kept tabs to the operator', async () => {
        const h = await harness()
        const page = await h.open()
        await h.handOff(page)
        expect(h.runtime.spaceReport()).toEqual([expect.objectContaining({ taskSpaceId: page.taskSpaceId, retainedTabs: [page.tabId] })])
        await h.store.close()
    })
})

describe('a tab never handed to the user', () => {
    it('closes as before when its session ends', async () => {
        const h = await harness()
        const page = await h.open()
        await h.runtime.endSession('session-a')
        expect(await h.runtime.reclaimSpaces()).toEqual([expect.objectContaining({ closed: true, closedTabs: [page.tabId] })])
        expect(h.driver.hasTab(page.tabId)).toBe(false)
        expect(h.store.getSpace(page.taskSpaceId)?.tabDispositions ?? {}).toEqual({})
        await h.store.close()
    })
})

describe('taking over a tab while its retention is written', () => {
    it('lets exactly one of two takeovers with the same epoch succeed', async () => {
        const h = await harness()
        const page = await h.open()
        const expectedEpoch = h.runtime.leases.owner(page.tabId, profileId).leaseEpoch
        const results = await Promise.allSettled([1, 2].map(() => h.runtime.takeOver(h.ui, { taskId: page.taskId, tabId: page.tabId, expectedEpoch, requestId: rid('take') })))
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((result) => result.status === 'rejected').map((result) => (result as PromiseRejectedResult).reason.code)).toEqual(['STALE_LEASE'])
        expect(h.store.getSpace(page.taskSpaceId)?.tabDispositions?.[page.tabId]?.retained?.reason).toBe('user-control')
        await h.store.close()
    })

    /** Holds the next spaces.json write (the retention record) until released. */
    function barrier() {
        let armed = false
        let entered!: () => void
        let release!: () => void
        const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
        const gate = new Promise<void>((resolve) => { release = resolve })
        const faults: FaultInjector = async (operation) => { if (armed && operation === 'metadata') { armed = false; entered(); await gate } }
        return { faults, arm: () => { armed = true }, entered: enteredPromise, release }
    }

    it('refuses control of a task cancelled while the retention was written, and keeps the record', async () => {
        const hold = barrier()
        const h = await harness({ faults: hold.faults })
        const page = await h.open()
        hold.arm()
        const pending = h.takeOver(page)
        await hold.entered
        const ui = { ...h.ui, credential: { ...h.ui.credential, operations: [...h.ui.credential.operations, 'cancel' as const] } }
        expect((await h.runtime.cancel(ui, { taskId: page.taskId, requestId: rid('cancel') })).task.status).toBe('cancelled')
        hold.release()
        await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(h.runtime.leases.owner(page.tabId, profileId).owner.kind).toBe('none')
        expect(h.store.getSpace(page.taskSpaceId)?.tabDispositions?.[page.tabId]?.retained?.reason).toBe('user-control')
        await h.store.close()
    })

    it('refuses control when the capability expired while the retention was written', async () => {
        const hold = barrier()
        const h = await harness({ faults: hold.faults })
        const page = await h.open()
        hold.arm()
        const pending = h.takeOver(page)
        await hold.entered
        h.clock.set(h.ui.credential.expiresAtMs + 1)
        hold.release()
        await expect(pending).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
        expect(h.runtime.leases.owner(page.tabId, profileId).owner.kind).toBe('none')
        await h.store.close()
    })
})
