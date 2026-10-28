/**
 * Tab provenance across task ends, against a real Chrome. Agent tabs, a tab on a login wait
 * (handed to the user), a tab the user took over and gave back, popups (from an agent click, a
 * page timer, a user gesture), a tab the user opened and another session's tab and popup are
 * mixed; then one session ends (reclamation), the Runtime restarts on the same browser, and the
 * other task finishes and closes its page. Only plain agent tabs close: tabs kept for the user
 * survive with their records, and no popup or user page is closed by cleanup (their origin is unknown).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentGrant, BrowserInstanceId, InteractiveCapability, ProfileId, RequestId, TabId, TaskId, TaskSpaceId } from './contracts'
import { FakeClock } from './clock'
import { CdpDriver } from './drivers/cdpDriver'
import { HarnessCdp, eventually, findChrome, launchChrome, startSite, type LaunchedChrome, type Site } from './drivers/pocTestKit'
import { BrowserRuntime } from './runtime'
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
        site.route('/login', '<body><form><input name="user" aria-label="User"></form></body>')
        site.route('/prov', () => `<body><button id="one" onclick="window.open('${site.url('/plain?popup')}')">Open one</button></body>`)
        dir = await mkdtemp(join(tmpdir(), 'abp-tab-provenance-poc-'))
    })
    afterAll(async () => {
        harness?.close()
        await chrome?.stop()
        await site?.close()
        if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('closes only plain agent tabs of the cleaned-up task, keeping handed-off tabs, popups, user tabs and other tasks\' pages across a restart', async () => {
        const profileId = 'profile-1' as ProfileId
        const clock = new FakeClock(1_000)
        const instanceId = `bi-${randomUUID()}` as BrowserInstanceId
        const start = async () => {
            const store = await TaskStore.open(dir)
            const driver = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => instanceId, maxAgentWindows: 8 })
            await driver.connect()
            return { store, driver, runtime: new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock, sites: fixtureSitePolicies([site.origin]) }) }
        }
        let { store, driver, runtime } = await start()
        const alive = async (targetId: string) => (await harness.targets()).some((target) => target.targetId === targetId)
        try {
            const agent = (agentSessionId: string) => ({ verifiedAtMs: clock.now(), credential: {
                kind: 'agent-grant', grantId: `grant-${agentSessionId}`, principalId: 'p', workspaceId: 'w', machineId: 'm', agentSessionId, profileId,
                allowedOrigins: [site.origin], operations: ['createSpace', 'createTask', 'openPage', 'closePage', 'submitBatch', 'getTask', 'observe', 'finishTask', 'resume'],
                taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 } as unknown as AgentGrant })
            const capability: InteractiveCapability = { kind: 'interactive', capabilityId: 'ui' as never, principalId: 'p' as never,
                workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer', profileId,
                operations: ['takeOver', 'releaseControl', 'resume', 'getTask'], issuedAtMs: 0, expiresAtMs: 3_600_000 }
            const ui = { credential: capability, verifiedAtMs: clock.now() }
            const openTask = async (session: string, path: string, taskSpaceId?: TaskSpaceId) => {
                const auth = agent(session)
                const spaceId = taskSpaceId ?? (await runtime.createSpace(auth, { profileId, requestId: `space-${randomUUID()}` as RequestId })).taskSpaceId
                const task = await runtime.createTask(auth, { taskSpaceId: spaceId, requestId: `task-${randomUUID()}` as RequestId })
                const page = await runtime.openPage(auth, { taskId: task.taskId, url: site.url(path), requestId: `open-${randomUUID()}` as RequestId })
                return { auth, taskSpaceId: spaceId, taskId: task.taskId, tabId: page.tabId }
            }
            const agentClick = async (who: { auth: ReturnType<typeof agent>; taskId: TaskId; tabId: TabId }) => {
                const observed = await runtime.observe(who.auth, { taskId: who.taskId, tabId: who.tabId })
                const ref = observed.elements.find((element) => element.name === 'Open one')!.ref
                const task = await runtime.getTask(who.auth, { taskId: who.taskId })
                const batch = await runtime.submitBatch(who.auth, { taskId: who.taskId, expectedVersion: task.stateVersion, requestId: `batch-${randomUUID()}` as RequestId,
                    steps: [{ stepId: 's' as never, actionId: `click-${randomUUID()}` as never, tabId: who.tabId, kind: 'click', ref, snapshotId: observed.snapshotId, timeoutMs: 10_000 }] }, { waitMs: 15_000 })
                expect(batch.result?.outcome).toBe('succeeded')
            }
            const targetOf = (tabId: TabId) => store.listSpaces().find((space) => space.tabTargets?.[tabId])!.tabTargets![tabId]
            const popupsOf = (tabId: TabId) => driver.popupReports().filter((report) => report.openerTabId === tabId)

            const plain = await openTask('session-a', '/prov')
            const login = await openTask('session-a', '/login', plain.taskSpaceId)
            const held = await openTask('session-a', '/prov', plain.taskSpaceId)
            const other = await openTask('session-b', '/prov')
            expect((await runtime.getTask(login.auth, { taskId: login.taskId })).waitReason).toBe('login')
            // The agent's click and a page timer open popups of the plain tab; the other session's agent opens one too.
            await Promise.all([agentClick(plain), agentClick(other)])
            await harness.evaluate(targetOf(plain.tabId), `setTimeout(() => window.open('${site.url('/plain?timer')}'), 300)`, { userGesture: true })
            // The user takes the third tab, opens a popup from it and a tab of their own, and gives it back.
            const taken = await runtime.takeOver(ui, { taskId: held.taskId, tabId: held.tabId, expectedEpoch: runtime.leases.owner(held.tabId, profileId).leaseEpoch, requestId: 'take' as RequestId })
            await harness.evaluate(targetOf(held.tabId), `document.getElementById('one').click()`, { userGesture: true })
            const userTab = await harness.openFrontTab(site.url('/plain?user'))
            await runtime.releaseControl(ui, { taskId: held.taskId, tabId: held.tabId, expectedEpoch: taken.leaseEpoch, requestId: 'release' as RequestId })
            const popups = [...(await eventually(() => popupsOf(plain.tabId), (r) => r.length === 2)), ...(await eventually(() => popupsOf(held.tabId), (r) => r.length === 1))]
            const [otherPopup] = await eventually(() => popupsOf(other.tabId), (r) => r.length === 1)
            const targets = { plain: targetOf(plain.tabId), login: targetOf(login.tabId), held: targetOf(held.tabId), other: targetOf(other.tabId) }

            // Session A ends: its tasks are cancelled and its space reclaimed.
            await runtime.endSession('session-a')
            const [report] = await runtime.reclaimSpaces()
            expect(report).toMatchObject({ taskSpaceId: plain.taskSpaceId, closed: false, closedTabs: [plain.tabId] })
            expect(new Set(report.retainedTabs)).toEqual(new Set([login.tabId, held.tabId]))
            expect([await alive(targets.plain), await alive(targets.login), await alive(targets.held), await alive(targets.other)]).toEqual([false, true, true, true])
            for (const popup of [...popups, otherPopup]) expect(await alive(popup.targetId)).toBe(true)
            expect(await alive(userTab)).toBe(true)

            // The Runtime restarts on the same browser: the kept tabs are re-adopted and still kept.
            await driver.close()
            await store.close()
            ;({ store, driver, runtime } = await start())
            await runtime.getTask(other.auth, { taskId: other.taskId })
            const reclaimedAgain = await runtime.reclaimSpaces()
            expect(reclaimedAgain).toEqual([expect.objectContaining({ taskSpaceId: plain.taskSpaceId, closed: false })])
            expect(new Set(reclaimedAgain[0].retainedTabs)).toEqual(new Set([login.tabId, held.tabId]))
            expect(store.getSpace(plain.taskSpaceId)?.tabDispositions?.[login.tabId]).toMatchObject({ createdBy: 'agent', adoptedAtMs: expect.any(Number), retained: { reason: 'login' } })
            expect(store.getSpace(plain.taskSpaceId)?.tabDispositions?.[held.tabId]?.retained?.reason).toBe('user-control')
            expect([await alive(targets.login), await alive(targets.held)]).toEqual([true, true])

            // Task B finishes (closes nothing) and closes its own page; its popup stays (unknown origin).
            const current = await runtime.getTask(other.auth, { taskId: other.taskId })
            await runtime.finishTask(other.auth, { taskId: other.taskId, expectedVersion: current.stateVersion, requestId: 'finish-b' as RequestId })
            expect(await alive(targets.other)).toBe(true)
            expect(await runtime.closePage(other.auth, { taskSpaceId: other.taskSpaceId, tabId: other.tabId, requestId: 'close-b' as RequestId })).toEqual({ closed: true })
            expect(await alive(targets.other)).toBe(false)
            expect(await alive(otherPopup.targetId)).toBe(true)
            for (const popup of popups) expect(await alive(popup.targetId)).toBe(true)
            expect(await alive(userTab)).toBe(true)
        } finally {
            await driver.close()
            await store.close()
        }
    })
})
