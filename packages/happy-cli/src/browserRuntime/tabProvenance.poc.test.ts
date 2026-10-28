/**
 * Tab provenance across task ends, against a real Chrome: the Runtime's input leases tell the
 * CdpDriver whose input a popup came from. Agent tabs and popups, a popup the user opened
 * during a hand-off, a tab the user opened, and another task's tab and popup are mixed; then
 * one task's session ends (reclamation) and the other task finishes and closes its page.
 * Only the agent's own tab and popups of the cleaned-up task close.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentGrant, BrowserInstanceId, InteractiveCapability, ProfileId, RequestId, TabId, TaskId } from './contracts'
import { FakeClock } from './clock'
import { CdpDriver } from './drivers/cdpDriver'
import { HarnessCdp, eventually, findChrome, launchChrome, startSite, type LaunchedChrome, type Site } from './drivers/pocTestKit'
import { BrowserRuntime, USER_INPUT_ACTIVATION_MS } from './runtime'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import { TaskStore } from './taskStore'

const chromePath = findChrome()
if (!chromePath) console.warn('[browser-poc] SKIP tab provenance suite: no Chrome binary (set CHROME_PATH)')

describe.skipIf(!chromePath)('tab provenance at task end (real Chrome)', () => {
    let chrome: LaunchedChrome
    let site: Site
    let harness: HarnessCdp
    let dir: string
    beforeAll(async () => {
        chrome = await launchChrome()
        site = await startSite('a.poc-one.test')
        harness = await HarnessCdp.connect(chrome.browserWsUrl)
        site.route('/plain', '<body>plain</body>')
        site.route('/prov', () => `<body><button id="one" onclick="window.open('${site.url('/plain')}')">Open one</button></body>`)
        dir = await mkdtemp(join(tmpdir(), 'abp-tab-provenance-poc-'))
    })
    afterAll(async () => {
        harness?.close()
        await chrome?.stop()
        await site?.close()
        if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('closes only the cleaned-up task\'s agent tab and popups, keeping hand-off popups, user tabs and other tasks\' pages', async () => {
        const profileId = 'profile-1' as ProfileId
        const clock = new FakeClock(1_000)
        const store = await TaskStore.open(dir)
        const driver = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => `bi-${randomUUID()}` as BrowserInstanceId, maxAgentWindows: 8 })
        await driver.connect()
        const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock, sites: fixtureSitePolicies([site.origin]) })
        try {
            const agent = (agentSessionId: string) => ({ verifiedAtMs: clock.now(), credential: {
                kind: 'agent-grant', grantId: `grant-${agentSessionId}`, principalId: 'p', workspaceId: 'w', machineId: 'm', agentSessionId, profileId,
                allowedOrigins: [site.origin], operations: ['createSpace', 'createTask', 'openPage', 'closePage', 'submitBatch', 'getTask', 'observe', 'finishTask', 'resume'],
                taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 } as unknown as AgentGrant })
            const capability: InteractiveCapability = { kind: 'interactive', capabilityId: 'ui' as never, principalId: 'p' as never,
                workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer', profileId,
                operations: ['takeOver', 'releaseControl', 'resume', 'getTask'], issuedAtMs: 0, expiresAtMs: 3_600_000 }
            const ui = { credential: capability, verifiedAtMs: clock.now() }
            const start = async (session: string) => {
                const auth = agent(session)
                const { taskSpaceId } = await runtime.createSpace(auth, { profileId, requestId: `space-${session}` as RequestId })
                const task = await runtime.createTask(auth, { taskSpaceId, requestId: `task-${session}` as RequestId })
                const page = await runtime.openPage(auth, { taskId: task.taskId, url: site.url('/prov'), requestId: `open-${session}` as RequestId })
                return { auth, taskSpaceId, taskId: task.taskId, tabId: page.tabId }
            }
            const agentClick = async (who: { auth: ReturnType<typeof agent>; taskId: TaskId; tabId: TabId }, label: string) => {
                const observed = await runtime.observe(who.auth, { taskId: who.taskId, tabId: who.tabId })
                const ref = observed.elements.find((element) => element.name === 'Open one')!.ref
                const task = await runtime.getTask(who.auth, { taskId: who.taskId })
                const batch = await runtime.submitBatch(who.auth, { taskId: who.taskId, expectedVersion: task.stateVersion, requestId: `batch-${label}` as RequestId,
                    steps: [{ stepId: `s-${label}` as never, actionId: `click-${label}` as never, tabId: who.tabId, kind: 'click', ref, snapshotId: observed.snapshotId, timeoutMs: 10_000 }] }, { waitMs: 15_000 })
                expect(batch.result?.outcome).toBe('succeeded')
            }
            const targetOf = (tabId: TabId) => store.listSpaces().find((space) => space.tabTargets?.[tabId])!.tabTargets![tabId]
            const popupsOf = (tabId: TabId) => driver.popupReports().filter((report) => report.openerTabId === tabId)
            const alive = async (targetId: string) => (await harness.targets()).some((target) => target.targetId === targetId)

            const a = await start('session-a')
            const b = await start('session-b')
            // Hand-off: the user takes the tab, opens a popup from it and a tab of their own, and gives it back.
            const taken = await runtime.takeOver(ui, { taskId: a.taskId, tabId: a.tabId, expectedEpoch: runtime.leases.owner(a.tabId, profileId).leaseEpoch, requestId: 'take' as RequestId })
            await harness.evaluate(targetOf(a.tabId), `document.getElementById('one').click()`, { userGesture: true })
            const [userPopup] = await eventually(() => popupsOf(a.tabId), (reports) => reports.length === 1)
            const userTab = await harness.openFrontTab(site.url('/plain'))
            const released = await runtime.releaseControl(ui, { taskId: a.taskId, tabId: a.tabId, expectedEpoch: taken.leaseEpoch, requestId: 'release' as RequestId })
            await runtime.resume(ui, { taskId: a.taskId, expectedVersion: released.task.stateVersion, requestId: 'resume' as RequestId })
            clock.advance(USER_INPUT_ACTIVATION_MS)

            // Both agents open a popup at the same time from their own tabs.
            await Promise.all([agentClick(a, 'a'), agentClick(b, 'b')])
            const agentPopupA = (await eventually(() => popupsOf(a.tabId), (reports) => reports.length === 2))[1]
            const [agentPopupB] = await eventually(() => popupsOf(b.tabId), (reports) => reports.length === 1)
            expect([userPopup, agentPopupA, agentPopupB].map((report) => report.openedBy)).toEqual(['user', 'agent', 'agent'])

            // Session A ends: its task is cancelled and its space reclaimed.
            await runtime.endSession('session-a')
            const reports = await runtime.reclaimSpaces()
            expect(reports).toEqual([expect.objectContaining({ taskSpaceId: a.taskSpaceId, closed: true, closedTabs: [a.tabId] })])
            expect(await alive(targetOf(b.tabId))).toBe(true)
            expect(await alive(agentPopupA.targetId)).toBe(false)
            expect(await alive(userPopup.targetId)).toBe(true)
            expect(popupsOf(a.tabId).find((report) => report.targetId === userPopup.targetId)).toMatchObject({ openedBy: 'user', closed: false, released: true })
            expect(await alive(userTab)).toBe(true)
            expect(await alive(agentPopupB.targetId)).toBe(true)

            // Task B finishes: finishing closes nothing; closing its page closes its own popup with it.
            const current = await runtime.getTask(b.auth, { taskId: b.taskId })
            await runtime.finishTask(b.auth, { taskId: b.taskId, expectedVersion: current.stateVersion, requestId: 'finish-b' as RequestId })
            expect(await alive(agentPopupB.targetId)).toBe(true)
            const tabB = targetOf(b.tabId)
            expect(await runtime.closePage(b.auth, { taskSpaceId: b.taskSpaceId, tabId: b.tabId, requestId: 'close-b' as RequestId })).toEqual({ closed: true })
            expect(await alive(tabB)).toBe(false)
            expect(await alive(agentPopupB.targetId)).toBe(false)
            expect(await alive(userPopup.targetId)).toBe(true)
            expect(await alive(userTab)).toBe(true)
        } finally {
            await driver.close()
            await store.close()
        }
    })
})
