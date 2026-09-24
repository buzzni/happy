/**
 * A10 — component faults and durable recovery on the real stack.
 *
 * Fault points (3 iterations each, via poc.mjs fault):
 *  - kill-chrome: same container, new browserInstanceId → paused(browser-replaced),
 *    old tab/refs rejected, profile storage kept.
 *  - restart-browser-container: container identity changes too; same outcome.
 *  - kill-runtime + start-runtime with a write in flight: writer lock recovered,
 *    intent-committed write → uncertain, never retried.
 *  - restart-runtime (graceful) with a write in flight: same expectations.
 *  - Happy daemon restart: N/A — the Runtime has no daemon dependency here.
 *
 * After a Runtime container restart the published host ports may change; every
 * client after a fault is built from ports re-read with `docker port`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BatchStep, ProfileId, TabId, TaskId, TaskSpaceId } from '../contracts'
import {
    aid, cleanupTask, containerFingerprint, containerState, eventsUntil, evidence, expectCode, repeat, rid, runtimeLogTail, sid,
    startSuiteStack, waitForTask, type SuiteStack,
} from './a01a03a07a10Helpers'
import { PROFILE_A, PROFILE_B, SITE_A, type LedgerEntry } from './pocStack'

const SLOW_WRITE_MS = 12_000
const slowWrites = (entries: LedgerEntry[], key: string) => entries.filter((entry) => entry.kind === 'slow-write' && entry.key === key)
const clicks = (entries: LedgerEntry[]) => entries.filter((entry) => entry.kind === 'click' && entry.target === 'A-main').length

/** LS/IDB presence from /a10/storage-check (the shared /storage-check script does not parse), without echoing the stored values. */
function storageShape(text: string): { ls: boolean; idb: boolean; complete: boolean } {
    return { ls: /LS=present/.test(text), idb: /IDB=present/.test(text), complete: /IDB=/.test(text) }
}

async function readStorage(client: ReturnType<SuiteStack['client']>['client'], taskId: TaskId, tabId: TabId) {
    const deadline = Date.now() + 10_000
    for (;;) {
        const shape = storageShape((await client.observe({ taskId, tabId })).text)
        if (shape.complete || Date.now() > deadline) return shape
        await new Promise((resolve) => setTimeout(resolve, 200))
    }
}

describe('A10 component faults', () => {
    let suite: SuiteStack
    const spaces = new Map<ProfileId, TaskSpaceId>()

    beforeAll(async () => {
        suite = await startSuiteStack('a10')
        for (const profileId of [PROFILE_A, PROFILE_B]) {
            const { client, close } = suite.client(suite.mintAgent({ profileId }).token)
            spaces.set(profileId, (await client.createSpace({ profileId, requestId: rid() })).taskSpaceId)
            close()
        }
        // Profile A gets synthetic localStorage/IndexedDB state; "profile kept" is checked against it.
        const { client, close } = suite.client(suite.mintAgent().token)
        try {
            const task = await client.createTask({ taskSpaceId: spaces.get(PROFILE_A)!, requestId: rid() })
            const opened = await client.openPage({ taskId: task.taskId, url: `${SITE_A}/login?next=/storage-setup`, requestId: rid() })
            const form = await client.observe({ taskId: task.taskId, tabId: opened.tabId })
            const [user, password] = form.elements.filter((element) => element.visible && (element.role === 'textbox' || /password/i.test(element.name)))
            const login = form.elements.find((element) => element.role === 'button' && element.name === 'Log in')!
            const done = await client.submitBatch({
                taskId: task.taskId, expectedVersion: opened.task.stateVersion, requestId: rid(), steps: [
                    { stepId: sid('user'), actionId: aid('user'), tabId: opened.tabId, kind: 'fill', ref: user.ref, value: 'poc-user', timeoutMs: 10_000 },
                    { stepId: sid('pw'), actionId: aid('pw'), tabId: opened.tabId, kind: 'fill', ref: password.ref, value: 'synthetic-pw', timeoutMs: 10_000 },
                    { stepId: sid('login'), actionId: aid('login'), tabId: opened.tabId, kind: 'click', ref: login.ref, timeoutMs: 10_000 },
                    { stepId: sid('stored'), actionId: aid('stored'), tabId: opened.tabId, kind: 'waitFor', until: { kind: 'text', text: 'STORAGE SET' }, timeoutMs: 20_000 },
                ],
            }, { waitMs: 60_000 })
            expect(done.result?.outcome, `profile storage setup failed: ${JSON.stringify(done.result?.steps.map((step) => [step.stepId, step.outcome, step.error?.code, step.error?.message]))}`).toBe('succeeded')
            await client.finishTask({ taskId: task.taskId, expectedVersion: done.task.stateVersion, requestId: rid() })
            await client.closePage({ taskSpaceId: spaces.get(PROFILE_A)!, tabId: opened.tabId, requestId: rid() })
        } finally {
            close()
        }
    }, 300_000)

    afterAll(() => suite?.down())

    it('Happy daemon restart is N/A for this stack', () => {
        // runtimeMain has no daemon/relay connection: it serves grants minted by
        // the harness directly. There is nothing to restart; recorded as N/A.
        evidence('A10', { fault: 'daemon-restart', status: 'not-applicable', reason: 'Runtime process has no Happy daemon dependency in the PoC stack' })
    })

    for (const fault of ['kill-chrome', 'restart-browser-container'] as const) {
        it.each(repeat(3))(`${fault} iteration %i: new browserInstanceId → paused(browser-replaced), old refs rejected, profile kept`, async (iteration) => {
            const token = suite.mintAgent().token
            const agent = suite.client(token)
            const taskSpaceId = spaces.get(PROFILE_A)!
            let taskId: TaskId | undefined
            let oldTab: TabId | undefined
            const newTabs: TabId[] = []
            try {
                const task = await agent.client.createTask({ taskSpaceId, requestId: rid() })
                taskId = task.taskId
                const opened = await agent.client.openPage({ taskId, url: `${SITE_A}/oopif?run=${suite.run}`, requestId: rid() })
                oldTab = opened.tabId
                const obs = await agent.client.observe({ taskId, tabId: oldTab })
                const oldBuy = obs.elements.find((element) => element.name === 'Buy' && element.frameOrigin === SITE_A)!.ref
                const probeTask = await agent.client.createTask({ taskSpaceId, requestId: rid() })
                const probe = await agent.client.openPage({ taskId: probeTask.taskId, url: `${SITE_A}/a10/storage-check`, requestId: rid() })
                const storageBefore = await readStorage(agent.client, probeTask.taskId, probe.tabId)
                await agent.client.finishTask({ taskId: probeTask.taskId, expectedVersion: probe.task.stateVersion, requestId: rid() })
                await agent.client.closePage({ taskSpaceId, tabId: probe.tabId, requestId: rid() })
                expect(storageBefore.ls && storageBefore.idb, `profile storage missing before the fault: ${JSON.stringify(storageBefore)}`).toBe(true)
                const before = await agent.client.getTask({ taskId })
                const browserContainer = `abp-${suite.run}-browser-a`
                const fingerprintBefore = containerFingerprint(browserContainer)
                const clicksBefore = clicks(await suite.stack.ledger())
                agent.close()

                const faultAtMs = Date.now()
                suite.stack.fault(fault, 'a')
                await suite.waitForHealth(90_000)
                const fresh = suite.client(token)
                const replaced = await waitForTask(fresh.client, taskId, (view) => view.status === 'paused' && view.pauseReason === 'browser-replaced', 60_000)
                const detectedMs = Date.now() - faultAtMs
                const fingerprintAfter = containerFingerprint(browserContainer)
                expect(replaced.browserInstanceId, 'browserInstanceId must change').not.toBe(before.browserInstanceId)
                if (fault === 'kill-chrome') expect(fingerprintAfter, 'same container for kill-chrome').toBe(fingerprintBefore)
                else expect(fingerprintAfter, 'container restart must change the container fingerprint').not.toBe(fingerprintBefore)
                expect(replaced.tabs).not.toContain(oldTab)

                // Old tab/ref are dead: before and after resume.
                const observeOld = await expectCode(fresh.client.observe({ taskId, tabId: oldTab }), 'SCOPE_DENIED', 'observe old tab after browser replacement')
                const staleStep: BatchStep = { stepId: sid('old'), actionId: aid('old'), tabId: oldTab, kind: 'click', ref: oldBuy, timeoutMs: 5_000 }
                const oldBatch = await fresh.client.submitBatch({ taskId, expectedVersion: replaced.stateVersion, requestId: rid(), steps: [staleStep] }).then(() => 'accepted', (error) => error.code as string)
                expect(['CONFLICT', 'SCOPE_DENIED'], `stale-ref batch before resume: ${oldBatch}`).toContain(oldBatch)
                const resumed = await fresh.client.resume({ taskId, expectedVersion: replaced.stateVersion, requestId: rid() })
                expect(resumed.status).toBe('paused')
                expect(resumed.pauseReason).toBe('awaiting-agent')
                await expectCode(fresh.client.submitBatch({ taskId, expectedVersion: resumed.stateVersion, requestId: rid(), steps: [{ ...staleStep, actionId: aid('old2') }] }), 'SCOPE_DENIED', 'stale tab/ref after resume')

                // Same task continues on the new browser; profile storage survived.
                const check = await fresh.client.openPage({ taskId, url: `${SITE_A}/a10/storage-check`, requestId: rid() })
                newTabs.push(check.tabId)
                const storage = await readStorage(fresh.client, taskId, check.tabId)
                const storageKept = storage.ls && storage.idb
                const ledger = await suite.stack.waitForLedger(() => true, { settleMs: 500 })
                evidence('A10', {
                    fault, iteration, taskId, oldBrowserInstanceId: before.browserInstanceId, newBrowserInstanceId: replaced.browserInstanceId,
                    containerChanged: fingerprintAfter !== fingerprintBefore, detectedMs, observeOld: observeOld.code, oldBatch,
                    storageBefore, storageAfter: storage, staleClicksAtFixture: clicks(ledger) - clicksBefore,
                })
                expect(storageKept, 'profile localStorage/IndexedDB must survive the browser fault').toBe(true)
                expect(clicks(ledger) - clicksBefore, 'no input from a stale ref may reach the fixture').toBe(0)
                const current = await fresh.client.getTask({ taskId })
                const finished = await fresh.client.finishTask({ taskId, expectedVersion: current.stateVersion, requestId: rid() })
                expect(finished.status).toBe('succeeded')
                expect(finished.taskId).toBe(taskId)
            } finally {
                const cleanup = suite.client(token)
                if (taskId) await cleanupTask(suite, cleanup.client, taskId, taskSpaceId, [...(oldTab ? [oldTab] : []), ...newTabs])
                suite.closeAll()
            }
        }, 240_000)
    }

    const runtimeFaults = [
        // Graceful restart first: if SIGKILL recovery leaves the Runtime down, the
        // graceful path has still been measured.
        { name: 'restart-runtime', profileId: PROFILE_B, inject: () => suite.stack.fault('restart-runtime') },
        { name: 'kill-runtime+start-runtime', profileId: PROFILE_A, inject: () => { suite.stack.fault('kill-runtime'); suite.stack.fault('start-runtime') } },
    ]
    for (const { name, profileId, inject } of runtimeFaults) {
        it.each(repeat(3))(`${name} iteration %i: in-flight write → uncertain after recovery, never retried`, async (iteration) => {
            const token = suite.mintAgent({ profileId }).token
            const agent = suite.client(token)
            const taskSpaceId = spaces.get(profileId)!
            const key = `a10-${name}-${iteration}`
            let taskId: TaskId | undefined
            let tabId: TabId | undefined
            try {
                const task = await agent.client.createTask({ taskSpaceId, requestId: rid() })
                taskId = task.taskId
                const opened = await agent.client.openPage({ taskId, url: `${SITE_A}/marker?label=a10`, requestId: rid() })
                tabId = opened.tabId
                const writeAction = aid('slow-write')
                const step: BatchStep = { stepId: sid('write'), actionId: writeAction, tabId, kind: 'navigate', url: `${SITE_A}/a10/slow-write?run=${suite.run}&key=${encodeURIComponent(key)}&ms=${SLOW_WRITE_MS}`, timeoutMs: 30_000 }
                await agent.client.submitBatch({ taskId, expectedVersion: opened.task.stateVersion, requestId: rid(), steps: [step] })
                // In flight = intent durable and the fixture has received the request, response still held.
                const viewer = suite.client(suite.mintInteractive({ profileId }))
                await eventsUntil(viewer.client, taskId, 0, (events) => events.some((event) => event.type === 'action-intent' && event.data.actionId === writeAction))
                const received = await suite.stack.waitForLedger((entries) => slowWrites(entries, key).length >= 1, { timeoutMs: 15_000, settleMs: 0 })
                expect(slowWrites(received, key), 'write did not reach the fixture before the fault').toHaveLength(1)
                const inFlight = await agent.client.getTask({ taskId })
                expect(inFlight.status).toBe('running')
                const portsBefore = suite.runtimeUrl()
                suite.closeAll()

                const faultAtMs = Date.now()
                inject()
                let health: { pid: number; startedAtMs: number }
                try {
                    health = await suite.waitForHealth(60_000)
                } catch (error) {
                    evidence('A10', { fault: name, iteration, taskId, runtimeRecovered: false, container: containerState(suite.run), log: runtimeLogTail(suite.run, 8) })
                    throw new Error(`${name}: Runtime did not come back (writer lock / startup): ${(error as Error).message}`)
                }
                const recoveredMs = Date.now() - faultAtMs
                const fresh = suite.client(token)
                const recovered = await fresh.client.getTask({ taskId })
                // Hold past the fixture's response time: a retry would show up as a second receipt.
                const settle = await suite.stack.waitForLedger((entries) => slowWrites(entries, key).length > 1, { timeoutMs: SLOW_WRITE_MS + 3_000, settleMs: 0 })
                const receipts = slowWrites(settle, key).length
                const again = await fresh.client.getTask({ taskId })
                const newViewer = suite.client(suite.mintInteractive({ profileId }))
                const events = await eventsUntil(newViewer.client, taskId, 0, () => true)
                const resends = events.filter((event) => event.type === 'action-intent' && event.data.actionId === writeAction).length
                evidence('A10', {
                    fault: name, iteration, taskId, runtimeRecovered: true, recoveredMs, portsChanged: portsBefore !== suite.runtimeUrl(),
                    runtimePid: health.pid, runtimeStartedAtMs: health.startedAtMs, status: recovered.status, pauseReason: recovered.pauseReason,
                    uncertain: recovered.uncertainActions.includes(writeAction), fixtureReceipts: receipts, intentRecords: resends,
                    statusAfterSettle: `${again.status}/${again.pauseReason ?? '-'}`,
                })
                expect(recovered.status).toBe('paused')
                expect(recovered.pauseReason).toBe('outcome-unknown')
                expect(recovered.uncertainActions).toContain(writeAction)
                expect(receipts, 'uncertain write must not be retried').toBe(1)
                expect(resends, 'no second intent for the same action').toBe(1)
                expect(again.status).toBe('paused')
                expect(again.pauseReason).toBe('outcome-unknown')
                await expectCode(fresh.client.finishTask({ taskId, expectedVersion: again.stateVersion, requestId: rid() }), 'CONFLICT', 'finish while uncertain after recovery')
                await expectCode(fresh.client.submitBatch({ taskId, expectedVersion: again.stateVersion, requestId: rid(), steps: [step] }), 'CONFLICT', 'resend of the uncertain action')
            } finally {
                const cleanup = suite.client(token)
                if (taskId) await cleanupTask(suite, cleanup.client, taskId, taskSpaceId, tabId ? [tabId] : [])
                suite.closeAll()
            }
        }, 240_000)
    }
})
