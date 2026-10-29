/**
 * A file-chooser hand-off against a real Chrome: the agent clicks a file input and then a button in one batch. The
 * browser reports the chooser during the first click (observed only), so the Runtime hands the page to the user and
 * the button is never clicked until the user gave the page back and the agent asks again.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentGrant, BrowserInstanceId, InteractiveCapability, ProfileId, RequestId } from './contracts'
import { FakeClock } from './clock'
import { CdpDriver } from './drivers/cdpDriver'
import { HIT_SCRIPT, findChrome, launchChrome, startSite, type LaunchedChrome, type Site } from './drivers/pocTestKit'
import { BrowserRuntime } from './runtime'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import { TaskStore } from './taskStore'

const chromePath = findChrome()
if (!chromePath) console.warn('[browser-poc] SKIP hand-off suite: no Chrome binary (set CHROME_PATH)')

describe.skipIf(!chromePath)('file-chooser hand-off (real Chrome)', () => {
    let chrome: LaunchedChrome
    let site: Site
    let dir: string
    beforeAll(async () => {
        chrome = await launchChrome()
        site = await startSite('a.poc-one.test')
        site.route('/upload', `${HIT_SCRIPT}<body><input type="file" aria-label="Attachment" onchange="hit('change')">`
            + `<button onclick="hit('next')">Next</button></body>`)
        dir = await mkdtemp(join(tmpdir(), 'abp-handoff-poc-'))
    })
    afterAll(async () => {
        await chrome?.stop()
        await site?.close()
        if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('stops before the next step, sends nothing until the user gave the page back, then runs the agent\'s next click once', async () => {
        const profileId = 'profile-1' as ProfileId
        const clock = new FakeClock(1_000)
        const store = await TaskStore.open(dir)
        const driver = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => `bi-${randomUUID()}` as BrowserInstanceId, maxAgentWindows: 8 })
        await driver.connect()
        const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock, sites: fixtureSitePolicies([site.origin]) })
        try {
            const auth = { verifiedAtMs: clock.now(), credential: { kind: 'agent-grant', grantId: 'grant-a', principalId: 'p', workspaceId: 'w', machineId: 'm',
                agentSessionId: 'session-a', profileId, allowedOrigins: [site.origin],
                operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'observe', 'resume'],
                taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 } as unknown as AgentGrant }
            const capability: InteractiveCapability = { kind: 'interactive', capabilityId: 'ui' as never, principalId: 'p' as never,
                workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer', profileId,
                operations: ['takeOver', 'releaseControl', 'resume', 'getTask'], issuedAtMs: 0, expiresAtMs: 3_600_000 }
            const ui = { credential: capability, verifiedAtMs: clock.now() }
            const space = await runtime.createSpace(auth, { profileId, requestId: 'space' as RequestId })
            const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task' as RequestId })
            const { tabId } = await runtime.openPage(auth, { taskId: task.taskId, url: site.url('/upload'), requestId: 'open' as RequestId })
            const view = () => runtime.getTask(ui, { taskId: task.taskId })
            const clicks = async (id: string, names: string[]) => {
                const observed = await runtime.observe(auth, { taskId: task.taskId, tabId })
                const steps = names.map((name, index) => ({ stepId: `${id}-${index}` as never, actionId: `${id}-${index}` as never, tabId, kind: 'click' as const,
                    ref: observed.elements.find((element) => element.name === name)!.ref, snapshotId: observed.snapshotId, timeoutMs: 10_000 }))
                return runtime.submitBatch(auth, { taskId: task.taskId, expectedVersion: (await view()).stateVersion, requestId: `${id}-batch` as RequestId, steps },
                    { waitMs: 15_000 })
            }

            const first = (await clicks('upload', ['Attachment', 'Next'])).result!
            expect(first).toMatchObject({ outcome: 'awaiting-user', waitReason: 'handoff', mayHaveSideEffects: false,
                handoff: { reason: 'file-chooser', tabId, actionId: 'upload-0' } })
            expect(first.steps).toMatchObject([{ actionId: 'upload-0', outcome: 'succeeded', receipt: { input: 'sent', fileChoosers: [{ mode: 'selectSingle' }] } }])
            // Give a late page reaction time to show: still nothing chosen and the button never clicked.
            await new Promise((resolve) => setTimeout(resolve, 300))
            expect([site.hits('change'), site.hits('next')]).toEqual([0, 0])
            const waiting = await view()
            expect(waiting).toMatchObject({ status: 'awaiting-user', handoff: { reason: 'file-chooser' } })
            await expect(runtime.resume(auth, { taskId: task.taskId, expectedVersion: waiting.stateVersion, requestId: 'early' as RequestId }))
                .rejects.toMatchObject({ code: 'CONFLICT' })
            await expect(clicks('early', ['Next'])).rejects.toMatchObject({ code: 'CONFLICT' })
            expect(site.hits('next')).toBe(0)

            const taken = await runtime.takeOver(ui, { taskId: task.taskId, tabId, expectedEpoch: runtime.leases.owner(tabId, profileId).leaseEpoch, requestId: 'take' as RequestId })
            const released = await runtime.releaseControl(ui, { taskId: task.taskId, tabId, expectedEpoch: taken.leaseEpoch, requestId: 'release' as RequestId })
            const resumed = await runtime.resume(ui, { taskId: task.taskId, expectedVersion: released.task.stateVersion, requestId: 'resume' as RequestId })
            expect(resumed).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent' })
            expect(resumed.handoff).toBeUndefined()

            expect((await clicks('next', ['Next'])).result).toMatchObject({ outcome: 'succeeded' })
            await new Promise((resolve) => setTimeout(resolve, 300))
            expect(site.hits('next')).toBe(1)
        } finally {
            await driver.close()
            await store.close()
        }
    }, 60_000)
})
