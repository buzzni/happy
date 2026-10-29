/**
 * The input boundary of a write step (navigate/click/fill): a fence or failure before the
 * driver began the input is a recoverable failure, one after it an unknown outcome that is
 * never replayed. Receipts report what the driver saw, nothing more.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from './clock'
import { BrowserRuntimeError, type AgentGrant, type BatchStep, type InteractiveCapability, type ProfileId, type RequestId, type TabId } from './contracts'
import { BrowserRuntime } from './runtime'
import { TaskStore } from './taskStore'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'

const ORIGIN = 'https://fixture.test'
const SITES = fixtureSitePolicies([ORIGIN])
type Write = 'click' | 'fill' | 'navigate'
const WRITES: Write[] = ['click', 'fill', 'navigate']

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

async function harness(prefix: string, driver = new FakeBrowserDriver(), existingDir?: string, fault?: Parameters<typeof TaskStore.open>[1]) {
    const dir = existingDir ?? await mkdtemp(join(tmpdir(), prefix))
    if (!existingDir) dirs.push(dir)
    const store = await TaskStore.open(dir, fault)
    const clock = new FakeClock(100)
    const profileId = 'profile-1' as ProfileId
    const runtime = new BrowserRuntime({ sites: SITES, store, drivers: new Map([[profileId, driver]]), clock })
    const credential: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never,
        machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: [ORIGIN],
        operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'subscribe', 'cancel', 'observe', 'finishTask', 'resume', 'closePage', 'closeSpace'],
        taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
    const auth = { credential, verifiedAtMs: clock.now() }
    const ui: InteractiveCapability = { kind: 'interactive', capabilityId: 'ui' as never, principalId: 'p' as never, workspaceId: 'w' as never,
        machineId: 'm' as never, viewerSessionId: 'viewer', profileId, operations: ['takeOver', 'releaseControl'], issuedAtMs: 0, expiresAtMs: 3_600_000 }
    const uiAuth = { credential: ui, verifiedAtMs: clock.now() }
    return { dir, store, clock, profileId, driver, runtime, auth, uiAuth }
}
type Harness = Awaited<ReturnType<typeof harness>>

/** A task with one tab showing a button and a text field, observed by the agent. */
async function openTask(h: Harness, name = 'one') {
    const space = await h.runtime.createSpace(h.auth, { profileId: h.profileId, requestId: `space-${name}` as RequestId })
    const task = await h.runtime.createTask(h.auth, { taskSpaceId: space.taskSpaceId, requestId: `task-${name}` as RequestId })
    const opened = await h.runtime.openPage(h.auth, { taskId: task.taskId, url: `${ORIGIN}/start`, requestId: `open-${name}` as RequestId })
    h.driver.seedTab(opened.tabId, { url: `${ORIGIN}/start`, elements: [
        { ref: '@continue' as never, role: 'button', name: 'Continue', visible: true, frameOrigin: ORIGIN },
        { ref: '@name' as never, role: 'textbox', name: 'Name', value: '', visible: true, frameOrigin: ORIGIN },
    ] })
    const observed = await h.runtime.observe(h.auth, { taskId: task.taskId, tabId: opened.tabId })
    return { taskId: task.taskId, taskSpaceId: space.taskSpaceId, tabId: opened.tabId, snapshotId: observed.snapshotId }
}
type OpenTask = Awaited<ReturnType<typeof openTask>>

function writeStep(t: OpenTask, kind: Write, actionId: string): BatchStep {
    const base = { stepId: `${actionId}-step` as never, actionId: actionId as never, tabId: t.tabId, kind, timeoutMs: 1_000 }
    if (kind === 'navigate') return { ...base, url: `${ORIGIN}/next` }
    if (kind === 'fill') return { ...base, ref: '@name' as never, snapshotId: t.snapshotId, value: 'Neo' }
    return { ...base, ref: '@continue' as never, snapshotId: t.snapshotId }
}

async function submit(h: Harness, t: OpenTask, steps: BatchStep[], requestId: string) {
    const view = await h.runtime.getTask(h.auth, { taskId: t.taskId })
    return h.runtime.submitBatch(h.auth, { taskId: t.taskId, expectedVersion: view.stateVersion, requestId: requestId as RequestId, steps }, { waitMs: 5_000 })
}

/** Starts a one-step write batch and waits until the fake is held at `point` (the input not sent). */
async function heldAt(h: Harness, t: OpenTask, kind: Write, actionId: string, point: Parameters<FakeBrowserDriver['holdBefore']>[0] = `input:${kind}`, skip = 0) {
    const hold = h.driver.holdBefore(point, skip)
    const batch = submit(h, t, [writeStep(t, kind, actionId)], `batch-${actionId}`)
    await hold.entered
    return { hold, batch }
}

function stored(h: Harness, t: OpenTask) {
    return h.store.getTask(t.taskId)!
}

function epochOf(h: Harness, tabId: TabId): number {
    return h.runtime.leases.owner(tabId, h.profileId).leaseEpoch
}

describe('a fence before the input: the write never left, so the task is not left with an unknown outcome', () => {
    it.each(WRITES)('cancel right before the %s input', async (kind) => {
        const h = await harness(`abp-boundary-cancel-${kind}-`)
        const t = await openTask(h)
        const { hold, batch } = await heldAt(h, t, kind, `${kind}-1`)
        const cancelled = await h.runtime.cancel(h.auth, { taskId: t.taskId, requestId: 'cancel' as RequestId })
        expect(cancelled.task.status).toBe('cancelled')
        expect(cancelled.task.uncertainActions).toEqual([])
        hold.release()
        await batch
        expect(h.driver.dispatchCounts.get(`${kind}-1`) ?? 0).toBe(0)
        expect(stored(h, t)).toMatchObject({ status: 'cancelled', uncertainActions: [] })
        expect(stored(h, t).actions[`${kind}-1`].state).toBe('skipped')
        await h.store.close()
    })

    it.each([['describeRef', 0], ['currentOrigin', 1]] as const)('cancel while the Runtime awaits %s after the intent', async (point, skip) => {
        const h = await harness(`abp-boundary-cancel-${point}-`)
        const t = await openTask(h)
        const { hold, batch } = await heldAt(h, t, 'click', 'click-pre', point, skip)
        expect(stored(h, t).actions['click-pre'].state).toBe('intent-committed')
        const cancelled = await h.runtime.cancel(h.auth, { taskId: t.taskId, requestId: 'cancel' as RequestId })
        expect(cancelled.task).toMatchObject({ status: 'cancelled', uncertainActions: [] })
        hold.release()
        await batch
        expect(h.driver.dispatchCounts.get('click-pre') ?? 0).toBe(0)
        expect(stored(h, t)).toMatchObject({ status: 'cancelled', uncertainActions: [] })
        await h.store.close()
    })

    it('a user takeover right before the input leaves no unknown outcome, and the click never happens', async () => {
        const h = await harness('abp-boundary-takeover-')
        const t = await openTask(h)
        const { hold, batch } = await heldAt(h, t, 'click', 'click-takeover')
        const control = await h.runtime.takeOver(h.uiAuth, { taskId: t.taskId, tabId: t.tabId, expectedEpoch: epochOf(h, t.tabId), requestId: 'take' as RequestId })
        expect(control.task).toMatchObject({ status: 'paused', pauseReason: 'user-control', uncertainActions: [] })
        hold.release()
        await batch
        expect(h.driver.dispatchCounts.get('click-takeover') ?? 0).toBe(0)
        expect(stored(h, t)).toMatchObject({ status: 'paused', pauseReason: 'user-control', uncertainActions: [] })
        await h.store.close()
    })

    it('a user taking over another task\'s tab of the profile fences this task\'s input too', async () => {
        const h = await harness('abp-boundary-profile-fence-')
        const t = await openTask(h, 'one')
        const other = await openTask(h, 'two')
        const { hold, batch } = await heldAt(h, t, 'click', 'click-fenced')
        await h.runtime.takeOver(h.uiAuth, { taskId: other.taskId, tabId: other.tabId, expectedEpoch: epochOf(h, other.tabId), requestId: 'take-other' as RequestId })
        hold.release()
        const result = (await batch).result
        expect(h.driver.dispatchCounts.get('click-fenced') ?? 0).toBe(0)
        expect(result).toMatchObject({ outcome: 'failed', mayHaveSideEffects: false })
        expect(result?.steps[0].error?.code).toBe('STALE_LEASE')
        expect(stored(h, t)).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent', uncertainActions: [] })
        await h.store.close()
    })

    it('a grant revoked right before the input pauses for a grant, not for an unknown outcome', async () => {
        const h = await harness('abp-boundary-revoke-')
        const t = await openTask(h)
        const { hold, batch } = await heldAt(h, t, 'fill', 'fill-revoked')
        await h.runtime.revokeGrant('g' as never)
        hold.release()
        // submitBatch's final read uses the revoked grant; the batch itself has ended.
        await batch.catch(() => undefined)
        expect(h.driver.dispatchCounts.get('fill-revoked') ?? 0).toBe(0)
        expect(stored(h, t)).toMatchObject({ status: 'paused', pauseReason: 'grant-expired', uncertainActions: [] })
        await h.store.close()
    })

    it('a browser connection lost right before the input: after reconnect the agent can go on, with a new action', async () => {
        const h = await harness('abp-boundary-disconnect-')
        const t = await openTask(h)
        const { hold, batch } = await heldAt(h, t, 'click', 'click-lost')
        await h.runtime.onDriverDisconnected(h.profileId)
        // The worker's late result arrives only after reconnect handling.
        await h.runtime.onDriverReconnected(h.profileId)
        hold.release()
        await batch
        expect(h.driver.dispatchCounts.get('click-lost') ?? 0).toBe(0)
        expect(stored(h, t)).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent', uncertainActions: [] })
        const again = await h.runtime.observe(h.auth, { taskId: t.taskId, tabId: t.tabId })
        const retried = await submit(h, { ...t, snapshotId: again.snapshotId }, [writeStep({ ...t, snapshotId: again.snapshotId }, 'click', 'click-again')], 'batch-again')
        expect(retried.result?.outcome).toBe('succeeded')
        expect(h.driver.dispatchCounts.get('click-again')).toBe(1)
        await h.store.close()
    })

    it('a driver that does not declare the input gate keeps the conservative unknown outcome', async () => {
        const driver = new FakeBrowserDriver()
        driver.gatesInputOnValidateDispatch = false
        const h = await harness('abp-boundary-ungated-', driver)
        const t = await openTask(h)
        const { hold, batch } = await heldAt(h, t, 'click', 'click-ungated')
        const cancelled = await h.runtime.cancel(h.auth, { taskId: t.taskId, requestId: 'cancel' as RequestId })
        expect(cancelled.task).toMatchObject({ status: 'paused', pauseReason: 'cancelled-with-unknown-effect', uncertainActions: ['click-ungated'] })
        hold.release()
        // No receipt either: without the gate the Runtime cannot tell whether the input left.
        expect((await batch).result?.steps.every((step) => step.receipt === undefined)).toBe(true)
        expect(stored(h, t)).toMatchObject({ status: 'paused', pauseReason: 'cancelled-with-unknown-effect', uncertainActions: ['click-ungated'] })
        await h.store.close()
    })

    it.each(['absent', 'false'] as const)('a driver whose gate capability is %s: the late result keeps the action and the batch unknown', async (form) => {
        const driver = new FakeBrowserDriver()
        if (form === 'absent') delete (driver as { gatesInputOnValidateDispatch?: boolean }).gatesInputOnValidateDispatch
        else driver.gatesInputOnValidateDispatch = false
        const h = await harness(`abp-boundary-legacy-${form}-`, driver)
        const t = await openTask(h)
        const { hold, batch } = await heldAt(h, t, 'fill', 'fill-legacy')
        await h.runtime.cancel(h.auth, { taskId: t.taskId, requestId: 'cancel' as RequestId })
        hold.release()
        const result = (await batch).result
        expect(result).toMatchObject({ mayHaveSideEffects: true })
        expect(result?.steps.find((step) => step.actionId === 'fill-legacy')).toMatchObject({ outcome: 'uncertain' })
        expect(stored(h, t).actions['fill-legacy'].state).toBe('uncertain')
        expect(stored(h, t)).toMatchObject({ status: 'paused', pauseReason: 'cancelled-with-unknown-effect', uncertainActions: ['fill-legacy'] })
        await h.store.close()
    })

    it.each([['without', false], ['with', true]] as const)('a driver %s the gate capability, its late result racing a cancel still persisting the revoked lease', async (_label, gated) => {
        let armed = false
        let entered!: () => void
        let release!: () => void
        const appendHeld = new Promise<void>((resolve) => { entered = resolve })
        const appendGate = new Promise<void>((resolve) => { release = resolve })
        const driver = new FakeBrowserDriver()
        if (!gated) delete (driver as { gatesInputOnValidateDispatch?: boolean }).gatesInputOnValidateDispatch
        const h = await harness('abp-boundary-cancel-race-', driver, undefined, async (operation) => {
            if (armed && operation === 'event-append') {
                armed = false
                entered()
                await appendGate
            }
        })
        const t = await openTask(h)
        const { hold, batch } = await heldAt(h, t, 'fill', 'fill-race')
        armed = true
        // Cancel revokes the lease, then waits on persisting it (held here) before it records the cancel.
        const cancel = h.runtime.cancel(h.auth, { taskId: t.taskId, requestId: 'cancel' as RequestId })
        await appendHeld
        hold.release()
        await new Promise((resolve) => setTimeout(resolve, 50))
        release()
        await cancel
        const result = (await batch).result
        expect(h.driver.dispatchCounts.get('fill-race') ?? 0).toBe(0)
        if (gated) {
            // Refused at the gate: nothing was sent, and the record is the cancel's, not a failure the agent must handle.
            expect(stored(h, t)).toMatchObject({ status: 'cancelled', pauseReason: undefined, uncertainActions: [] })
            expect(stored(h, t).actions['fill-race'].state).toBe('skipped')
            expect(result).toMatchObject({ outcome: 'cancelled', mayHaveSideEffects: false })
            return void await h.store.close()
        }
        expect(result).toMatchObject({ outcome: 'uncertain', mayHaveSideEffects: true })
        expect(stored(h, t).actions['fill-race'].state).toBe('uncertain')
        expect(stored(h, t)).toMatchObject({ status: 'paused', pauseReason: 'cancelled-with-unknown-effect', uncertainActions: ['fill-race'] })
        await h.store.close()
    })
})

describe('overlapping cancels of a gated write refused before its input', () => {
    /** A store whose next `metadata` write can be held and whose next `event-append` can be failed. */
    function faults() {
        const state = { holdMetadata: false, failHeldMetadata: false, failAppend: false, entered: () => {}, release: () => {} }
        const held = new Promise<void>((resolve) => { state.entered = resolve })
        const gate = new Promise<void>((resolve) => { state.release = resolve })
        const inject = async (operation: string) => {
            if (state.holdMetadata && operation === 'metadata') {
                state.holdMetadata = false
                state.entered()
                await gate
                if (state.failHeldMetadata) {
                    state.failHeldMetadata = false
                    throw new Error('disk full')
                }
            }
            if (state.failAppend && operation === 'event-append') {
                state.failAppend = false
                throw new Error('disk full')
            }
        }
        return { state, held, inject }
    }
    function interactiveCancel(h: Harness) {
        return { credential: { ...h.uiAuth.credential, capabilityId: 'ui-cancel', operations: ['cancel' as const] }, verifiedAtMs: h.clock.now() }
    }

    it.each(['fails', 'succeeds'] as const)('a second cancel that %s while the first still persists the revoked lease', async (second) => {
        const f = faults()
        const h = await harness(`abp-boundary-two-cancels-${second}-`, new FakeBrowserDriver(), undefined, f.inject)
        const t = await openTask(h)
        const { hold, batch } = await heldAt(h, t, 'fill', 'fill-two')
        f.state.holdMetadata = true
        const first = h.runtime.cancel(h.auth, { taskId: t.taskId, requestId: 'cancel-a' as RequestId })
        await f.held
        f.state.failAppend = second === 'fails'
        const other = h.runtime.cancel(interactiveCancel(h), { taskId: t.taskId, requestId: 'cancel-b' as RequestId })
        if (second === 'fails') await expect(other).rejects.toBeInstanceOf(BrowserRuntimeError)
        else await other
        hold.release()
        await new Promise((resolve) => setTimeout(resolve, 50))
        f.state.release()
        await first
        const result = (await batch).result
        expect(h.driver.dispatchCounts.get('fill-two') ?? 0).toBe(0)
        expect(stored(h, t)).toMatchObject({ status: 'cancelled', pauseReason: undefined, uncertainActions: [] })
        expect(stored(h, t).actions['fill-two'].state).toBe('skipped')
        expect(result).toMatchObject({ outcome: 'cancelled', mayHaveSideEffects: false })
        await h.store.close()
    })

    it('both cancels fail: the late result waits for them, pauses the task as if no cancel came, and the next batch runs', async () => {
        const f = faults()
        const h = await harness('abp-boundary-two-cancels-fail-', new FakeBrowserDriver(), undefined, f.inject)
        const t = await openTask(h)
        const { hold, batch } = await heldAt(h, t, 'fill', 'fill-both')
        f.state.holdMetadata = true
        f.state.failHeldMetadata = true
        const first = h.runtime.cancel(h.auth, { taskId: t.taskId, requestId: 'cancel-a' as RequestId })
        await f.held
        f.state.failAppend = true
        await expect(h.runtime.cancel(interactiveCancel(h), { taskId: t.taskId, requestId: 'cancel-b' as RequestId })).rejects.toBeInstanceOf(BrowserRuntimeError)
        hold.release()
        await new Promise((resolve) => setTimeout(resolve, 50))
        f.state.release()
        await expect(first).rejects.toBeInstanceOf(BrowserRuntimeError)
        const result = (await batch).result
        expect(h.driver.dispatchCounts.get('fill-both') ?? 0).toBe(0)
        expect(result).toMatchObject({ outcome: 'failed', mayHaveSideEffects: false })
        expect(stored(h, t)).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent', cancelRequested: false, uncertainActions: [] })
        const next = await submit(h, t, [writeStep(t, 'click', 'click-next')], 'batch-next')
        expect(next.result?.outcome).toBe('succeeded')
        expect(h.driver.dispatchCounts.get('click-next')).toBe(1)
        await h.store.close()
    })

    it('a sole cancel that fails leaves no cancel in progress: the late result pauses the task, and a later cancel still works', async () => {
        const f = faults()
        const h = await harness('abp-boundary-cancel-fails-', new FakeBrowserDriver(), undefined, f.inject)
        const t = await openTask(h)
        const { hold, batch } = await heldAt(h, t, 'fill', 'fill-alone')
        f.state.failAppend = true
        await expect(h.runtime.cancel(h.auth, { taskId: t.taskId, requestId: 'cancel-x' as RequestId })).rejects.toBeInstanceOf(BrowserRuntimeError)
        hold.release()
        const result = (await batch).result
        // The leases stayed revoked (the physical fence holds), so nothing was sent; no cancel was recorded.
        expect(h.driver.dispatchCounts.get('fill-alone') ?? 0).toBe(0)
        expect(result).toMatchObject({ outcome: 'failed', mayHaveSideEffects: false })
        expect(stored(h, t)).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent', cancelRequested: false, uncertainActions: [] })
        const retried = await h.runtime.cancel(h.auth, { taskId: t.taskId, requestId: 'cancel-y' as RequestId })
        expect(retried.task.status).toBe('cancelled')
        await h.store.close()
    })
})

describe('after the input may have left: an unknown outcome, never replayed', () => {
    it.each(['after the driver returned (a later origin read needs the user)', 'after the gate opened (a driver error mislabelled side-effect free)'] as const)(
        'APPROVAL_REQUIRED %s is not handed off as if nothing was sent', async (when) => {
            const readRefused = when.startsWith('after the driver returned')
            class Driver extends FakeBrowserDriver {
                reads = 0
                override async currentOrigin(tabId: TabId): Promise<string> {
                    // The runtime reads the origin before the intent, before the input and after it: refuse the third.
                    if (readRefused && ++this.reads === 3) throw new BrowserRuntimeError('APPROVAL_REQUIRED', 'origin read needs the user', false, false)
                    return super.currentOrigin(tabId)
                }
            }
            const driver = new Driver()
            if (readRefused) delete (driver as { gatesInputOnValidateDispatch?: boolean }).gatesInputOnValidateDispatch
            const h = await harness('abp-boundary-approval-after-input-', driver)
            const t = await openTask(h)
            driver.reads = 0
            if (!readRefused) driver.failAfterInput('fill', new BrowserRuntimeError('APPROVAL_REQUIRED', 'refused after typing', false, false))
            const result = (await submit(h, t, [writeStep(t, 'fill', 'fill-handed')], 'batch-handed')).result
            expect(h.driver.dispatchCounts.get('fill-handed')).toBe(1)
            expect(result).toMatchObject({ outcome: 'uncertain', mayHaveSideEffects: true })
            expect(stored(h, t)).toMatchObject({ status: 'paused', pauseReason: 'outcome-unknown', uncertainActions: ['fill-handed'] })
            expect(stored(h, t).actions['fill-handed'].state).toBe('uncertain')
            await h.store.close()
        })

    it.each(WRITES)('cancel right after the %s input keeps the outcome unknown', async (kind) => {
        const h = await harness(`abp-boundary-cancel-after-${kind}-`)
        const t = await openTask(h)
        const held = h.driver.holdAfterNextDispatch(kind)
        const batch = submit(h, t, [writeStep(t, kind, `${kind}-sent`)], `batch-${kind}-sent`)
        await held.entered
        const cancelled = await h.runtime.cancel(h.auth, { taskId: t.taskId, requestId: 'cancel' as RequestId })
        expect(cancelled.task).toMatchObject({ status: 'paused', pauseReason: 'cancelled-with-unknown-effect', uncertainActions: [`${kind}-sent`] })
        held.release()
        await batch
        expect(h.driver.dispatchCounts.get(`${kind}-sent`)).toBe(1)
        expect(stored(h, t).actions[`${kind}-sent`].state).toBe('uncertain')
        await h.store.close()
    })

    it('a lost response after the input (connection closed) pauses outcome-unknown, and neither resubmission nor resume replays it', async () => {
        const h = await harness('abp-boundary-lost-response-')
        const t = await openTask(h)
        h.driver.failAfterInput('fill', new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'browser connection closed', false, true))
        const first = await submit(h, t, [writeStep(t, 'fill', 'fill-lost')], 'batch-fill-lost')
        expect(first.result).toMatchObject({ outcome: 'uncertain', mayHaveSideEffects: true })
        expect(stored(h, t)).toMatchObject({ status: 'paused', pauseReason: 'outcome-unknown', uncertainActions: ['fill-lost'] })
        await expect(h.runtime.resume(h.auth, { taskId: t.taskId, expectedVersion: stored(h, t).stateVersion, requestId: 'resume' as RequestId }))
            .rejects.toBeInstanceOf(BrowserRuntimeError)
        await expect(submit(h, t, [writeStep(t, 'fill', 'fill-lost')], 'batch-fill-lost-again')).rejects.toBeInstanceOf(BrowserRuntimeError)
        expect(h.driver.dispatchCounts.get('fill-lost')).toBe(1)
        await h.store.close()
    })

    it('a failure the driver labels side-effect free after the input began is still an unknown outcome', async () => {
        const h = await harness('abp-boundary-mislabelled-')
        const t = await openTask(h)
        h.driver.failAfterInput('click', new BrowserRuntimeError('TARGET_GONE', 'Session with given id not found', false, false))
        const result = (await submit(h, t, [writeStep(t, 'click', 'click-gone')], 'batch-click-gone')).result
        expect(result).toMatchObject({ outcome: 'uncertain', mayHaveSideEffects: true })
        expect(stored(h, t)).toMatchObject({ status: 'paused', pauseReason: 'outcome-unknown', uncertainActions: ['click-gone'] })
        await h.store.close()
    })

    it('a browser connection lost after the input, reconnected before the worker\'s late result: outcome-unknown, sent once', async () => {
        const h = await harness('abp-boundary-disconnect-after-')
        const t = await openTask(h)
        const held = h.driver.holdAfterNextDispatch('click')
        h.driver.failAfterInput('click', new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'browser connection closed', true, true))
        const batch = submit(h, t, [writeStep(t, 'click', 'click-sent-lost')], 'batch-click-sent-lost')
        await held.entered
        await h.runtime.onDriverDisconnected(h.profileId)
        await h.runtime.onDriverReconnected(h.profileId)
        held.release()
        await batch
        expect(stored(h, t)).toMatchObject({ status: 'paused', pauseReason: 'outcome-unknown', uncertainActions: ['click-sent-lost'] })
        expect(h.driver.dispatchCounts.get('click-sent-lost')).toBe(1)
        await h.store.close()
    })

    it('a browser connection lost after the input, the driver call then succeeding late: outcome-unknown, not left running', async () => {
        const h = await harness('abp-boundary-disconnect-late-success-')
        const t = await openTask(h)
        const held = h.driver.holdAfterNextDispatch('fill')
        const batch = submit(h, t, [writeStep(t, 'fill', 'fill-late')], 'batch-fill-late')
        await held.entered
        await h.runtime.onDriverDisconnected(h.profileId)
        await h.runtime.onDriverReconnected(h.profileId)
        held.release()
        expect((await batch).result).toMatchObject({ outcome: 'uncertain', mayHaveSideEffects: true })
        expect(stored(h, t)).toMatchObject({ status: 'paused', pauseReason: 'outcome-unknown', uncertainActions: ['fill-late'] })
        expect(h.driver.dispatchCounts.get('fill-late')).toBe(1)
        await h.store.close()
    })

    it('a read that succeeds only after a reconnect does not leave the task running without a worker', async () => {
        const h = await harness('abp-boundary-late-read-')
        const t = await openTask(h)
        const held = h.driver.holdAfterNextDispatch('observe')
        const batch = submit(h, t, [{ stepId: 'look-step' as never, actionId: 'look' as never, tabId: t.tabId, kind: 'observe', timeoutMs: 1_000 }], 'batch-look')
        await held.entered
        await h.runtime.onDriverDisconnected(h.profileId)
        await h.runtime.onDriverReconnected(h.profileId)
        held.release()
        await batch
        expect(stored(h, t)).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent', uncertainActions: [] })
        await h.store.close()
    })

    it('an unknown outcome survives a Runtime restart and is still not replayed', async () => {
        const h = await harness('abp-boundary-restart-')
        const t = await openTask(h)
        h.driver.failAfterInput('navigate', new BrowserRuntimeError('OUTCOME_UNKNOWN', 'driver operation timed out', false, true))
        await submit(h, t, [writeStep(t, 'navigate', 'nav-unknown')], 'batch-nav-unknown')
        await h.store.close()
        const restarted = await harness('', h.driver, h.dir)
        await restarted.runtime.started()
        const task = restarted.store.getTask(t.taskId)!
        expect(task).toMatchObject({ status: 'paused', pauseReason: 'outcome-unknown', uncertainActions: ['nav-unknown'] })
        expect(task.actions['nav-unknown'].state).toBe('uncertain')
        expect(h.driver.dispatchCounts.get('nav-unknown')).toBe(1)
        await restarted.store.close()
    })
})

describe('action receipts', () => {
    it('reports the input and what the driver saw on the step result, durably and in the driver-call event', async () => {
        const h = await harness('abp-boundary-receipt-')
        const t = await openTask(h)
        h.driver.observeDuringNext('click', { dialogs: [{ type: 'alert' }], popups: [{ origin: 'https://fixture.test', closed: false }] })
        // A reported file chooser hands the page to the user after its step, so it is the last step's here.
        h.driver.observeDuringNext('fill', { fileChoosers: [{ mode: 'selectSingle' }] })
        const submitted = await submit(h, t, [writeStep(t, 'click', 'click-receipt'), writeStep(t, 'fill', 'fill-receipt')], 'batch-receipt')
        expect(submitted.result?.steps.map((step) => step.receipt)).toEqual([
            { input: 'sent', dialogs: [{ type: 'alert' }], popups: [{ origin: 'https://fixture.test', closed: false }] },
            { input: 'sent', fileChoosers: [{ mode: 'selectSingle' }] },
        ])
        const events = await h.runtime.subscribe(h.auth, { taskId: t.taskId, afterSeq: 0 })
        expect(events.kind).toBe('events')
        if (events.kind === 'events')
            expect(events.events.find((event) => event.type === 'action-dispatched' && event.data.actionId === 'click-receipt')?.data.receipt)
                .toMatchObject({ input: 'sent', dialogs: [{ type: 'alert' }] })
        await h.store.close()
        const restarted = await harness('', h.driver, h.dir)
        await restarted.runtime.started()
        expect(restarted.store.getTask(t.taskId)?.lastBatch?.steps[1].receipt).toMatchObject({ input: 'sent', fileChoosers: [{ mode: 'selectSingle' }] })
        await restarted.store.close()
    })

    it('a write refused right before its input reports input not-sent', async () => {
        const h = await harness('abp-boundary-receipt-unsent-')
        const t = await openTask(h, 'one')
        const other = await openTask(h, 'two')
        const { hold, batch } = await heldAt(h, t, 'navigate', 'nav-unsent')
        await h.runtime.takeOver(h.uiAuth, { taskId: other.taskId, tabId: other.tabId, expectedEpoch: epochOf(h, other.tabId), requestId: 'take-other' as RequestId })
        hold.release()
        expect((await batch).result?.steps[0]).toMatchObject({ outcome: 'failed', receipt: { input: 'not-sent' } })
        await h.store.close()
    })
})
