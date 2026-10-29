/**
 * Hand-off reasons and the return contract: why a page is with the user, from what the Runtime decided or the
 * browser reported, and that only the user's explicit return (or a live grant on a wait the user already finished)
 * gives the task back — never a vanished prompt, a reconnect or a new grant on its own.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeError, POC_LIMITS, type AgentGrant, type BatchStep, type InteractiveCapability, type ProfileId, type RequestId, type TabId } from './contracts'
import { FakeClock } from './clock'
import type { SitePolicy } from './policy'
import { BrowserRuntime } from './runtime'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import { TaskStore, type FaultInjector } from './taskStore'

const origin = 'https://fixture.test'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

async function createHarness(options: { sites?: SitePolicy[]; url?: string; faults?: FaultInjector } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'abp-handoff-')); dirs.push(dir)
    const store = await TaskStore.open(dir, options.faults); const clock = new FakeClock(100)
    const profileId = 'profile-1' as ProfileId; const driver = new FakeBrowserDriver()
    const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock, sites: options.sites ?? fixtureSitePolicies([origin]) })
    const grant = (grantId: string, expiresAtMs: number, agentSessionId = 'a'): AgentGrant => ({ kind: 'agent-grant', grantId: grantId as never,
        principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: agentSessionId as never, profileId,
        allowedOrigins: [origin], operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'cancel', 'observe', 'finishTask', 'resume'],
        taskSpaceIds: [], issuedAtMs: 0, expiresAtMs })
    const auth = { credential: grant('g', 3_600_000), verifiedAtMs: clock.now() }
    const capability: InteractiveCapability = { kind: 'interactive', capabilityId: 'ui' as never, principalId: 'p' as never,
        workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer', profileId,
        operations: ['approve', 'takeOver', 'releaseControl', 'resume', 'getTask'], issuedAtMs: 0, expiresAtMs: 3_600_000 }
    const ui = { credential: capability, verifiedAtMs: clock.now() }
    const space = await runtime.createSpace(auth, { profileId, requestId: 'space' as RequestId })
    const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task' as RequestId })
    const opened = await runtime.openPage(auth, { taskId: task.taskId, url: options.url ?? `${origin}/start`, requestId: 'open' as RequestId })
    // Read as the user: it stays valid when a test revokes the agent's grant.
    const view = () => runtime.getTask(ui, { taskId: task.taskId })
    const epoch = (tabId: TabId = opened.tabId) => runtime.leases.owner(tabId, profileId).leaseEpoch
    const batch = async (id: string, steps: Array<Partial<BatchStep>>, as = auth) => (await runtime.submitBatch(as, { taskId: task.taskId,
        expectedVersion: (await view()).stateVersion, requestId: `${id}-batch` as RequestId,
        steps: steps.map((step, index) => ({ stepId: `${id}-${index}` as never, actionId: `${id}-${index}` as never, tabId: opened.tabId, timeoutMs: 1000, ...step }) as BatchStep) },
    { waitMs: 1000 })).result!
    const takeOver = async (id: string) => runtime.takeOver(ui, { taskId: task.taskId, tabId: opened.tabId, expectedEpoch: epoch(), requestId: `${id}-take` as RequestId })
    const release = async (id: string, expectedEpoch = epoch()) => (await runtime.releaseControl(ui, { taskId: task.taskId, tabId: opened.tabId, expectedEpoch,
        requestId: `${id}-release` as RequestId })).task
    const userResume = (id: string, expectedVersion: number) => runtime.resume(ui, { taskId: task.taskId, expectedVersion, requestId: `${id}-resume` as RequestId })
    const agentResume = (id: string, expectedVersion: number, as = auth) => runtime.resume(as, { taskId: task.taskId, expectedVersion, requestId: `${id}-agent-resume` as RequestId })
    return { dir, store, clock, profileId, driver, runtime, grant, auth, ui, space, task, opened, view, epoch, batch, takeOver, release, userResume, agentResume }
}
type Harness = Awaited<ReturnType<typeof createHarness>>

/** A site whose policy holds one navigation: the agent's navigate there is handed to the user (a hand-off older Runtimes make too). */
const HELD: SitePolicy[] = [{ origin, actions: [{ match: { kinds: ['navigate'], targetPaths: ['/api/delete*'] }, risk: 'requires-approval' }, { match: {}, risk: 'auto' }] }]
/** The trusted result check a held action needs after it on the same tab (else the plan is refused before anything). */
const RESULT_CHECK: Partial<BatchStep> = { kind: 'waitFor', until: { kind: 'text', text: 'Complete' } }

/** A page with a file input and a next button; observed by the agent so its refs are live. */
async function uploadPage(h: Harness) {
    h.driver.seedTab(h.opened.tabId, { url: `${origin}/upload`, elements: [
        { ref: '@file' as never, role: 'button', name: 'Attachment', visible: true, frameOrigin: origin },
        { ref: '@next' as never, role: 'button', name: 'Next', visible: true, frameOrigin: origin }] })
    return h.runtime.observe(h.auth, { taskId: h.task.taskId, tabId: h.opened.tabId })
}
/** The agent clicks the file input (the browser reports a chooser during that click) and then Next. */
async function chooserHandoff(h: Harness, id = 'chooser') {
    const snapshot = await uploadPage(h)
    h.driver.observeDuringNext('click', { fileChoosers: [{ mode: 'selectSingle' }] })
    return h.batch(id, [{ kind: 'click', ref: '@file', snapshotId: snapshot.snapshotId }, { kind: 'click', ref: '@next', snapshotId: snapshot.snapshotId }])
}

describe('hand-off reasons', () => {
    it('hands the page to the user when the browser reported a file chooser during an agent write, before any further step', async () => {
        const h = await createHarness()
        const result = await chooserHandoff(h)
        expect(result).toMatchObject({ outcome: 'awaiting-user', waitReason: 'handoff', mayHaveSideEffects: false,
            handoff: { reason: 'file-chooser', tabId: h.opened.tabId, actionId: 'chooser-0' } })
        // The click itself happened and is not an unknown outcome; the next step was never sent.
        expect(result.steps).toMatchObject([{ actionId: 'chooser-0', outcome: 'succeeded', receipt: { input: 'sent', fileChoosers: [{ mode: 'selectSingle' }] } }])
        expect(h.driver.dispatchCounts.get('chooser-0')).toBe(1)
        expect(h.driver.dispatchCounts.get('chooser-1') ?? 0).toBe(0)
        const task = await h.view()
        expect(task).toMatchObject({ status: 'awaiting-user', waitReason: 'handoff', uncertainActions: [],
            handoff: { reason: 'file-chooser', tabId: h.opened.tabId, actionId: 'chooser-0' } })
        await h.store.close()
    })

    it('does not hand off a write whose call reported no chooser', async () => {
        const h = await createHarness()
        const snapshot = await uploadPage(h)
        h.driver.observeDuringNext('click', { dialogs: [{ type: 'alert' }] })
        const result = await h.batch('plain', [{ kind: 'click', ref: '@next', snapshotId: snapshot.snapshotId }])
        expect(result.outcome).toBe('succeeded')
        expect((await h.view()).handoff).toBeUndefined()
        await h.store.close()
    })

    const permissive: SitePolicy[] = [{ origin, actions: [{ match: {}, risk: 'auto' }] }]
    it.each([
        ['a navigation the site policy holds', 'permission', { sites: HELD }],
        ['a form the Runtime cannot bind', 'manual-control', { sites: permissive, opaque: true }],
        ['a driver that cannot verify the target', 'manual-control', { sites: permissive,
            failure: new BrowserRuntimeError('APPROVAL_REQUIRED', 'transformed frame', false, false, undefined, 'manual-control') }],
        ['a driver hand-off that states no cause', 'unknown', { sites: permissive, failure: new BrowserRuntimeError('APPROVAL_REQUIRED', 'cannot tell', false, false) }],
    ] as const)('names %s as %s, from the decision that made it', async (_name, reason, setup) => {
        const h = await createHarness({ sites: setup.sites })
        h.driver.seedTab(h.opened.tabId, { url: `${origin}/cart`, elements: [{ ref: '@go' as never, role: 'button', name: 'Continue', visible: true, frameOrigin: origin }],
            ...('opaque' in setup ? { form: { action: `${origin}/session`, method: 'post', enctype: 'application/x-www-form-urlencoded', target: '',
                fields: [['user', 'a'], ['pw', { password: 8 }]], submitter: null, opaque: true } } : {}) })
        const snapshot = await h.runtime.observe(h.auth, { taskId: h.task.taskId, tabId: h.opened.tabId })
        if ('failure' in setup) h.driver.failNext('click', setup.failure)
        const step: Partial<BatchStep> = reason === 'permission' ? { kind: 'navigate', url: `${origin}/api/delete?id=1` } : { kind: 'click', ref: '@go', snapshotId: snapshot.snapshotId }
        const result = await h.batch('held', [step, RESULT_CHECK])
        expect(result).toMatchObject({ outcome: 'awaiting-user', waitReason: 'handoff', handoff: { reason, tabId: h.opened.tabId, actionId: 'held-0' } })
        expect(h.driver.dispatchCounts.get('held-0') ?? 0).toBe(0)
        expect((await h.view()).handoff).toMatchObject({ reason })
        await h.store.close()
    })

    it('keeps a login wait without a hand-off detail (it has its own wait reason)', async () => {
        const h = await createHarness({ url: `${origin}/login` })
        const task = await h.view()
        expect(task).toMatchObject({ status: 'awaiting-user', waitReason: 'login' })
        expect(task.handoff).toBeUndefined()
        await h.store.close()
    })
})

/** A write the agent tries next: its input must not leave unless the task is the agent's again. */
const nextWrite = (id: string): Array<Partial<BatchStep>> => [{ kind: 'navigate', url: `${origin}/start?${id}` }]
/** The agent tries its next write; returns the refusal, or undefined when the batch was accepted. */
async function tryNextWrite(h: Harness, id: string, as = h.auth) {
    return h.batch(id, nextWrite(id), as).then(() => undefined, (error: unknown) => error)
}
/** Positive control: after a valid return the agent's next write is accepted and sent exactly once. */
async function expectOneWrite(h: Harness, id: string, as = h.auth) {
    expect(await h.batch(id, nextWrite(id), as)).toMatchObject({ outcome: 'succeeded' })
    expect(h.driver.dispatchCounts.get(`${id}-0`)).toBe(1)
}
/** The user takes the page and gives it back (an explicit return); returns the released task. */
async function userTurn(h: Harness, id: string) {
    const taken = await h.takeOver(id)
    return h.release(id, taken.leaseEpoch)
}

async function heldHandoff(h: Harness) {
    expect(await h.batch('held', [{ kind: 'navigate', url: `${origin}/api/delete?id=1` }, RESULT_CHECK])).toMatchObject({ outcome: 'awaiting-user', waitReason: 'handoff' })
}

describe('returning a hand-off', () => {
    it('is not resumed by the prompt going away or the browser reconnecting, only by the user giving it back', async () => {
        const h = await createHarness()
        await chooserHandoff(h)
        const refusedNow = async (id: string) => {
            expect(await tryNextWrite(h, id)).toMatchObject({ code: 'CONFLICT' })
            expect(h.driver.dispatchCounts.get(`${id}-0`) ?? 0).toBe(0)
        }
        const waiting = await h.view()
        // The chooser closing leaves no trace the Runtime acts on; nobody resumes before the user acted.
        await expect(h.agentResume('early', waiting.stateVersion)).rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(h.userResume('early', waiting.stateVersion)).rejects.toMatchObject({ code: 'CONFLICT' })
        await refusedNow('waiting')
        await h.runtime.onDriverDisconnected(h.profileId)
        await h.runtime.onDriverReconnected(h.profileId)
        expect(await h.view()).toMatchObject({ status: 'awaiting-user', waitReason: 'handoff', handoff: { reason: 'file-chooser' } })
        await refusedNow('reconnected')

        const taken = await h.takeOver('turn')
        expect(taken.task).toMatchObject({ status: 'paused', pauseReason: 'user-control', handoff: { reason: 'file-chooser' } })
        await h.runtime.onDriverDisconnected(h.profileId)
        await h.runtime.onDriverReconnected(h.profileId)
        expect(await h.view()).toMatchObject({ status: 'paused', pauseReason: 'user-control', handoff: { reason: 'file-chooser' } })
        await refusedNow('controlled')
        // The reconnect moved the lease epoch: a release naming an earlier one is refused.
        await expect(h.release('stale-epoch', taken.leaseEpoch - 1)).rejects.toMatchObject({ code: 'STALE_LEASE' })

        const released = await h.release('turn')
        expect(released).toMatchObject({ status: 'paused', pauseReason: 'user-input-complete', handoff: { reason: 'file-chooser' } })
        await h.runtime.onDriverDisconnected(h.profileId)
        await h.runtime.onDriverReconnected(h.profileId)
        const parked = await h.view()
        expect(parked).toMatchObject({ status: 'paused', pauseReason: 'user-input-complete', handoff: { reason: 'file-chooser' } })
        await refusedNow('released')

        // An explicit resume of the current state gives it back; one of an earlier state does not.
        await expect(h.userResume('stale', released.stateVersion - 1)).rejects.toMatchObject({ code: 'CONFLICT' })
        const resumed = await h.userResume('turn', parked.stateVersion)
        expect(resumed).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent' })
        expect(resumed.waitReason).toBeUndefined()
        expect(resumed.handoff).toBeUndefined()
        // The rest of the batch is the agent's to re-plan; nothing of it was sent.
        expect(h.driver.dispatchCounts.get('chooser-1') ?? 0).toBe(0)
        expect(resumed.lastBatch).toMatchObject({ outcome: 'failed', steps: [{ actionId: 'chooser-0', outcome: 'succeeded' }, { actionId: 'chooser-1', outcome: 'skipped' }] })
        await expectOneWrite(h, 'after-return')
        await h.store.close()
    })

    it.each([['hand-off', 'waiting'], ['hand-off', 'released'], ['login', 'waiting']] as const)('stays the user\'s when the Runtime restarts in the middle of a reconnect (%s, %s)', async (wait, stage) => {
        const h = await createHarness({ sites: HELD, ...(wait === 'login' ? { url: `${origin}/login` } : {}) })
        if (wait === 'hand-off') await heldHandoff(h)
        if (stage === 'released') await userTurn(h, 'turn')
        await h.runtime.onDriverDisconnected(h.profileId)
        await h.store.close()
        // The Runtime restarts on the same browser before the reconnect was handled.
        const store = await TaskStore.open(h.dir)
        const runtime = new BrowserRuntime({ store, drivers: new Map([[h.profileId, h.driver]]), clock: h.clock, sites: HELD })
        const view = () => runtime.getTask(h.ui, { taskId: h.task.taskId })
        const waitReason = wait === 'login' ? 'login' : 'handoff'
        const expected = stage === 'waiting' ? { status: 'awaiting-user', waitReason } : { status: 'paused', pauseReason: 'user-input-complete', waitReason }
        await runtime.sweep(h.clock.now())
        const current = await view()
        const attempt = await runtime.submitBatch(h.auth, { taskId: h.task.taskId, expectedVersion: current.stateVersion, requestId: 'restart-next' as RequestId,
            steps: [{ stepId: 's' as never, actionId: 'restart-next' as never, tabId: h.opened.tabId, kind: 'navigate', url: `${origin}/start?next`, timeoutMs: 1000 }] }, { waitMs: 1000 })
            .then(() => undefined, (error: unknown) => error)
        expect(h.driver.dispatchCounts.get('restart-next') ?? 0).toBe(0)
        expect(attempt).toMatchObject({ code: 'CONFLICT' })
        expect(current).toMatchObject(expected)
        if (wait === 'hand-off') expect(current.handoff).toMatchObject({ reason: 'permission' })
        await store.close()
    })

    it.each(['handoff', 'login'] as const)('is the agent\'s again when the user finished a %s wait, its grant ended, and the Runtime restarted', async (wait) => {
        const h = await createHarness({ sites: HELD, ...(wait === 'login' ? { url: `${origin}/login` } : {}) })
        if (wait === 'handoff') await heldHandoff(h)
        const taken = await h.takeOver('turn')
        if (wait === 'login') h.driver.seedTab(h.opened.tabId, { url: `${origin}/account`, text: 'Signed in', elements: [] })
        expect(await h.release('turn', taken.leaseEpoch)).toMatchObject({ status: 'paused', pauseReason: 'user-input-complete', waitReason: wait })
        // The run-once turn ends: its grant is revoked, and the finished wait is kept as it is.
        await h.runtime.revokeGrant(h.auth.credential.grantId)
        await h.runtime.sweep(h.clock.now())
        expect(await h.view()).toMatchObject({ status: 'paused', pauseReason: 'user-input-complete', waitReason: wait })
        await h.store.close()
        const store = await TaskStore.open(h.dir)
        const runtime = new BrowserRuntime({ store, drivers: new Map([[h.profileId, h.driver]]), clock: h.clock, sites: HELD })
        const recovered = await runtime.getTask(h.ui, { taskId: h.task.taskId })
        expect(recovered).toMatchObject({ status: 'paused', pauseReason: 'user-input-complete', waitReason: wait })
        // The user is not asked again; a fresh grant gives the task back as without the restart.
        const fresh = { credential: h.grant('g2', 3_600_000), verifiedAtMs: h.clock.now() }
        const resumed = await runtime.resume(fresh, { taskId: h.task.taskId, expectedVersion: recovered.stateVersion, requestId: 'restart-agent-resume' as RequestId })
        expect(resumed).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent' })
        expect(await runtime.sessionWaiting('a')).toBe(false)
        await store.close()
    })

    it('stays the user\'s when the reconnect could not be recorded and a later sweep finds the task still recovering', async () => {
        let failWrites = false
        const h = await createHarness({ faults: (operation) => { if (failWrites && operation === 'task-replace') throw new Error('injected write failure') } })
        await chooserHandoff(h)
        await h.runtime.onDriverDisconnected(h.profileId)
        failWrites = true
        await expect(h.runtime.onDriverReconnected(h.profileId)).rejects.toThrow()
        failWrites = false
        expect(await h.view()).toMatchObject({ status: 'recovering' })
        await h.runtime.sweep(h.clock.now())
        const attempt = await tryNextWrite(h, 'after-sweep')
        expect(h.driver.dispatchCounts.get('after-sweep-0') ?? 0).toBe(0)
        expect(attempt).toMatchObject({ code: 'CONFLICT' })
        expect(await h.view()).toMatchObject({ status: 'awaiting-user', waitReason: 'handoff', handoff: { reason: 'file-chooser' } })
        await h.store.close()
    })

    it('lets the agent resume a hand-off the user gave back, with its live grant, and only that task\'s owner', async () => {
        const h = await createHarness()
        await chooserHandoff(h)
        const released = await userTurn(h, 'turn')
        const stranger = { credential: h.grant('g-other', 3_600_000, 'other-session'), verifiedAtMs: h.clock.now() }
        await expect(h.agentResume('stranger', released.stateVersion, stranger)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        const resumed = await h.agentResume('owner', released.stateVersion)
        expect(resumed).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent' })
        expect(resumed.handoff).toBeUndefined()
        await expectOneWrite(h, 'after-return')
        await h.store.close()
    })

    it('is not returned by the user giving back another task\'s page', async () => {
        const h = await createHarness()
        await chooserHandoff(h)
        const other = await h.runtime.createTask(h.auth, { taskSpaceId: h.space.taskSpaceId, requestId: 'other-task' as RequestId })
        const otherPage = await h.runtime.openPage(h.auth, { taskId: other.taskId, url: `${origin}/start?other`, requestId: 'other-open' as RequestId })
        const taken = await h.runtime.takeOver(h.ui, { taskId: other.taskId, tabId: otherPage.tabId, expectedEpoch: h.epoch(otherPage.tabId), requestId: 'other-take' as RequestId })
        await h.runtime.releaseControl(h.ui, { taskId: other.taskId, tabId: otherPage.tabId, expectedEpoch: taken.leaseEpoch, requestId: 'other-release' as RequestId })
        // This task's page cannot be given back through the other task either.
        await expect(h.runtime.releaseControl(h.ui, { taskId: other.taskId, tabId: h.opened.tabId, expectedEpoch: h.epoch(), requestId: 'cross-release' as RequestId }))
            .rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        expect(await h.view()).toMatchObject({ status: 'awaiting-user', waitReason: 'handoff', handoff: { reason: 'file-chooser' } })
        expect(await tryNextWrite(h, 'not-returned')).toMatchObject({ code: 'CONFLICT' })
        expect(h.driver.dispatchCounts.get('not-returned-0') ?? 0).toBe(0)
        await h.store.close()
    })

    it('refuses the user\'s return while the task grant is revoked, and keeps the hand-off', async () => {
        const h = await createHarness()
        await chooserHandoff(h)
        const released = await userTurn(h, 'turn')
        await h.runtime.revokeGrant(h.auth.credential.grantId)
        await expect(h.userResume('revoked', released.stateVersion)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        expect(await h.view()).toMatchObject({ waitReason: 'handoff', handoff: { reason: 'file-chooser' } })
        expect(h.driver.dispatchCounts.get('chooser-1') ?? 0).toBe(0)
        await h.store.close()
    })

    it.each(['handoff', 'login'] as const)('does not let a fresh agent grant stand in for the user on a %s wait whose grant expired', async (wait) => {
        const h = await createHarness({ sites: HELD, ...(wait === 'login' ? { url: `${origin}/login` } : {}) })
        if (wait === 'handoff') await heldHandoff(h)
        expect(await h.view()).toMatchObject({ status: 'awaiting-user', waitReason: wait })
        // The grant ends while the user has not acted yet.
        await h.runtime.revokeGrant(h.auth.credential.grantId)
        await h.runtime.sweep(h.clock.now())
        const parked = await h.view()
        expect(parked).toMatchObject({ status: 'paused', pauseReason: 'grant-expired', waitReason: wait })
        const fresh = { credential: h.grant('g2', 3_600_000), verifiedAtMs: h.clock.now() }
        const rebound = await h.agentResume('rebind', parked.stateVersion, fresh)
        // The agent's next write right after the rebinding resume: refused, nothing sent.
        const attempt = await tryNextWrite(h, 'bypass', fresh)
        expect(h.driver.dispatchCounts.get('bypass-0') ?? 0).toBe(0)
        expect(attempt).toMatchObject({ code: 'CONFLICT' })
        // Back to waiting for the user, with the new grant kept for the user's later return.
        expect(rebound).toMatchObject({ status: 'awaiting-user', waitReason: wait })
        if (wait === 'handoff') {
            expect(rebound.handoff).toMatchObject({ reason: 'permission' })
            const released = await userTurn(h, 'turn')
            expect(await h.userResume('turn', released.stateVersion)).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent' })
            await expectOneWrite(h, 'after-return', fresh)
        }
        await h.store.close()
    })

    it('ends the hand-off detail when the wait expires, keeping the wait reason as before', async () => {
        const h = await createHarness()
        await chooserHandoff(h)
        h.clock.advance(POC_LIMITS.userWaitMs + 1)
        await h.runtime.sweep(h.clock.now())
        const expired = await h.view()
        expect(expired).toMatchObject({ status: 'paused', pauseReason: 'user-wait-expired', waitReason: 'handoff' })
        expect(expired.handoff).toBeUndefined()
        expect(await tryNextWrite(h, 'expired')).toMatchObject({ code: 'CONFLICT' })
        // The user may still take the page; that is not the expired hand-off coming back.
        const taken = await h.takeOver('late')
        expect(taken.task).toMatchObject({ status: 'paused', pauseReason: 'user-control', waitReason: 'handoff' })
        expect(taken.task.handoff).toBeUndefined()
        await h.store.close()
    })

    it('ends a hand-off lost with the browser, so a later grant expiry does not bring that wait back', async () => {
        const h = await createHarness()
        await chooserHandoff(h)
        h.driver.swapInstance()
        await h.runtime.onDriverDisconnected(h.profileId)
        await h.runtime.onDriverReconnected(h.profileId)
        const replaced = await h.view()
        expect(replaced).toMatchObject({ status: 'paused', pauseReason: 'browser-replaced', tabs: [] })
        expect(replaced.handoff).toBeUndefined()
        const resumed = await h.agentResume('replaced', replaced.stateVersion)
        expect(resumed).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent' })
        expect(resumed.waitReason).toBeUndefined()
        await h.runtime.revokeGrant(h.auth.credential.grantId)
        const parked = await h.view()
        expect(parked).toMatchObject({ status: 'paused', pauseReason: 'grant-expired' })
        const fresh = { credential: h.grant('g2', 3_600_000), verifiedAtMs: h.clock.now() }
        expect(await h.agentResume('fresh', parked.stateVersion, fresh)).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent' })
        await h.store.close()
    })

    // The detail only describes the hand-off: neither its absence (an older Runtime) nor a value this Runtime does not
    // know changes what may run. Both still need the user's return, and then the agent writes once.
    it.each([['recorded by an older Runtime (no detail)', undefined], ['with a reason this Runtime does not know', { reason: 'os-permission' }]] as const)(
        'treats a hand-off %s like any other hand-off', async (_name, detail) => {
            const h = await createHarness()
            await chooserHandoff(h)
            await h.store.mutate(h.task.taskId, (current) => ({ patch: { handoff: detail ? { ...current.handoff!, ...detail } as never : undefined,
                stateVersion: current.stateVersion }, event: { type: 'state-changed', atMs: h.clock.now(), leaseEpoch: 0, data: {} } }))
            const stored = await h.view()
            expect(stored).toMatchObject({ status: 'awaiting-user', waitReason: 'handoff' })
            expect(stored.handoff?.reason).toBe(detail?.reason)
            await expect(h.agentResume('early', stored.stateVersion)).rejects.toMatchObject({ code: 'CONFLICT' })
            expect(await tryNextWrite(h, 'early')).toMatchObject({ code: 'CONFLICT' })
            expect(h.driver.dispatchCounts.get('early-0') ?? 0).toBe(0)
            const released = await userTurn(h, 'turn')
            expect(await h.userResume('turn', released.stateVersion)).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent' })
            await expectOneWrite(h, 'after-return')
            await h.store.close()
        })
})
