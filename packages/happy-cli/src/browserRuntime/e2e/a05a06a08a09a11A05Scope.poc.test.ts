/**
 * A05 — scope / Space / input owner (R5). Source: Saydo
 * specs/agent-browser-poc/acceptance.md A05. Each deterministic path runs
 * ABP_REPEAT (default 10) times; side effects are counted from the fixture
 * ledger, namespaced per tab and iteration.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProfileId, TaskId, TaskSpaceId } from '../contracts'
import {
    cleanupSpace, client, count, evidence, expectCode, latestEpoch, ledgerRun, mintAgent, mintInteractive, newTaskWithPage,
    observeUntil, pageUrl, range, rawOp, releaseBarrier, repeat, rid, settledLedger, step, waitForTask, waitLedger,
} from './a05a06a08a09a11Helpers'
import { PRINCIPAL_B, PROFILE_A, PROFILE_B, SITE_A, startPocStack, type PocStack } from './pocStack'

const N = repeat(10)

describe('A05 scope, Space and input owner', () => {
    let stack: PocStack
    beforeAll(async () => { stack = await startPocStack() }, 300_000)
    afterAll(() => stack?.down({ purge: true }))

    it.each(range(N))('cross-space, cross-principal, missing tabId, stale epoch and forged ids are rejected without side effects #%i', async (i) => {
        const setup = client(stack, mintAgent(stack).token)
        const S1 = (await setup.createSpace({ profileId: PROFILE_A, requestId: rid() })).taskSpaceId
        const S2 = (await setup.createSpace({ profileId: PROFILE_A, requestId: rid() })).taskSpaceId
        const g1 = mintAgent(stack, { taskSpaceIds: [S1] })
        const g2 = mintAgent(stack, { taskSpaceIds: [S2] })
        const c1 = client(stack, g1.token)
        const c2 = client(stack, g2.token)
        const L1 = ledgerRun(stack, `a05-s1-${i}`)
        const L2 = ledgerRun(stack, `a05-s2-${i}`)
        const t1 = await newTaskWithPage(c1, pageUrl(stack, SITE_A, '/x5/panel', { label: 'S1', color: 'ff0000' }, L1), { taskSpaceId: S1 })
        const t2 = await newTaskWithPage(c2, pageUrl(stack, SITE_A, '/x5/panel', { label: 'S2', color: '0000ff' }, L2), { taskSpaceId: S2 })
        const rejected: string[] = []
        const cAll = client(stack, mintAgent(stack).token)
        let t3: TaskId | undefined
        const deny = async (label: string, p: Promise<unknown>, code: Parameters<typeof expectCode>[1] = 'SCOPE_DENIED') => {
            const error = await expectCode(p, code, label)
            rejected.push(`${label}:${error.code}`)
        }
        try {
            const o1 = await c1.observe({ taskId: t1.taskId, tabId: t1.tabId })
            const o2 = await c2.observe({ taskId: t2.taskId, tabId: t2.tabId })
            expect(o1.text).toContain('S1')
            expect(o2.text).toContain('S2')
            const press2 = o2.elements.find((e) => e.name === 'Press S2')!.ref
            const t2Before = await c2.getTask({ taskId: t2.taskId })

            // S1 agent using S2's tab / task / space.
            await deny('s1-batch-with-s2-tab', c1.submitBatch({ taskId: t1.taskId, expectedVersion: t1.version, requestId: rid(), steps: [step(t2.tabId, 'click', { ref: press2 })] }))
            await deny('s1-observe-s2-tab', c1.observe({ taskId: t1.taskId, tabId: t2.tabId }))
            await deny('s1-screenshot-s2-tab', c1.screenshot({ taskId: t1.taskId, tabId: t2.tabId }))
            await deny('s1-observe-s2-task', c1.observe({ taskId: t2.taskId, tabId: t2.tabId }))
            await deny('s1-batch-s2-task', c1.submitBatch({ taskId: t2.taskId, expectedVersion: t2Before.stateVersion, requestId: rid(), steps: [step(t2.tabId, 'click', { ref: press2 })] }))
            await deny('s1-cancel-s2-task', c1.cancel({ taskId: t2.taskId, requestId: rid() }))
            await deny('s1-createTask-in-s2', c1.createTask({ taskSpaceId: S2, requestId: rid() }))
            await deny('s1-closePage-s2', c1.closePage({ taskSpaceId: S2, tabId: t2.tabId, requestId: rid() }))
            await deny('s1-closeSpace-s2', c1.closeSpace({ taskSpaceId: S2, requestId: rid() }))

            // Grant allowing both spaces (same principal) still cannot use another task's tab.
            const own3 = await cAll.createTask({ taskSpaceId: S2, requestId: rid() })
            t3 = own3.taskId
            await deny('both-spaces-grant-other-session-task', cAll.observe({ taskId: t2.taskId, tabId: t2.tabId }))
            await deny('both-spaces-grant-foreign-tab-in-own-task', cAll.observe({ taskId: own3.taskId, tabId: t2.tabId }))
            await deny('both-spaces-grant-batch-foreign-tab', cAll.submitBatch({ taskId: own3.taskId, expectedVersion: own3.stateVersion, requestId: rid(), steps: [step(t2.tabId, 'click', { ref: press2 })] }))

            // Principal B: own profile grant, mis-issued profile-A grant, and interactive capability.
            const bOwn = client(stack, mintAgent(stack, { principalId: PRINCIPAL_B, profileId: PROFILE_B }).token)
            await deny('principal-b-createSpace-profile-a', bOwn.createSpace({ profileId: PROFILE_A, requestId: rid() }))
            await deny('principal-b-getTask', bOwn.getTask({ taskId: t1.taskId }))
            const bOnA = client(stack, mintAgent(stack, { principalId: PRINCIPAL_B, profileId: PROFILE_A }).token)
            await deny('principal-b-on-a-getTask', bOnA.getTask({ taskId: t1.taskId }))
            await deny('principal-b-on-a-observe', bOnA.observe({ taskId: t1.taskId, tabId: t1.tabId }))
            await deny('principal-b-on-a-batch', bOnA.submitBatch({ taskId: t1.taskId, expectedVersion: t1.version, requestId: rid(), steps: [step(t1.tabId, 'click', { ref: o1.elements.find((e) => e.name === 'Press S1')!.ref })] }))
            await deny('principal-b-on-a-cancel', bOnA.cancel({ taskId: t1.taskId, requestId: rid() }))
            await deny('principal-b-on-a-createTask', bOnA.createTask({ taskSpaceId: S1, requestId: rid() }))
            const ui = client(stack, mintInteractive(stack).token)
            const bUi = client(stack, mintInteractive(stack, { principalId: PRINCIPAL_B }).token)
            await deny('principal-b-ui-getTask', bUi.getTask({ taskId: t1.taskId }))
            await deny('principal-b-ui-subscribe', bUi.subscribe({ taskId: t1.taskId, afterSeq: 0 }))
            await deny('principal-b-ui-takeOver', bUi.takeOver({ taskId: t1.taskId, tabId: t1.tabId, expectedEpoch: await latestEpoch(ui, t1.taskId), requestId: rid() }))

            // Missing tabId is a schema error.
            const missing = await rawOp(stack, 'observe', { taskId: t1.taskId }, { authorization: `Bearer ${g1.token}` })
            expect(missing.status).toBe(400)
            expect(missing.json.error?.code).toBe('INVALID_REQUEST')
            const { tabId: _omit, ...stepNoTab } = step(t1.tabId, 'click', { ref: '@e1' })
            const missingStep = await rawOp(stack, 'submitBatch', { taskId: t1.taskId, expectedVersion: t1.version, requestId: rid(), steps: [stepNoTab] }, { authorization: `Bearer ${g1.token}` })
            expect(missingStep.status).toBe(400)
            expect(missingStep.json.error?.code).toBe('INVALID_REQUEST')
            rejected.push('missing-tabId-observe:INVALID_REQUEST', 'missing-tabId-step:INVALID_REQUEST')

            // Stale epoch / stale version.
            const epoch = await latestEpoch(ui, t1.taskId)
            await deny('stale-epoch-takeOver', ui.takeOver({ taskId: t1.taskId, tabId: t1.tabId, expectedEpoch: epoch + 7, requestId: rid() }), 'STALE_LEASE')
            await deny('stale-epoch-release', ui.releaseControl({ taskId: t1.taskId, tabId: t1.tabId, expectedEpoch: Math.max(0, epoch - 1), requestId: rid() }), 'STALE_LEASE')
            await deny('stale-version-batch', c1.submitBatch({ taskId: t1.taskId, expectedVersion: t1.version - 1, requestId: rid(), steps: [step(t1.tabId, 'observe')] }), 'CONFLICT')

            // Forged ids.
            await deny('forged-taskId', c1.getTask({ taskId: `task-${randomUUID()}` as TaskId }))
            await deny('forged-taskId-batch', c1.submitBatch({ taskId: `task-${randomUUID()}` as TaskId, expectedVersion: 0, requestId: rid(), steps: [step(t1.tabId, 'observe')] }))
            await deny('forged-spaceId', c1.createTask({ taskSpaceId: `space-${randomUUID()}` as TaskSpaceId, requestId: rid() }))

            // Positive control: S1 agent presses its own tab exactly once.
            const own = await c1.submitBatch({ taskId: t1.taskId, expectedVersion: t1.version, requestId: rid(), steps: [step(t1.tabId, 'click', { ref: o1.elements.find((e) => e.name === 'Press S1')!.ref })] }, { waitMs: 30_000 })
            expect(own.result?.outcome).toBe('succeeded')
            const l1 = await waitLedger(stack, L1, (e) => count(e, 'click') >= 1, { settleMs: 1_000 })
            const l2 = await settledLedger(stack, L2, 0)
            const t2After = await c2.getTask({ taskId: t2.taskId })
            evidence('A05', { path: 'scope-rejections', i, rejected: rejected.length, codes: rejected, s1Presses: count(l1, 'click', { target: 'S1' }), s2Presses: count(l2, 'click'), t2VersionBefore: t2Before.stateVersion, t2VersionAfter: t2After.stateVersion })
            expect(count(l1, 'click')).toBe(1)
            expect(count(l1, 'click', { target: 'S1' })).toBe(1)
            expect(count(l2, 'click'), 'no rejected request may press the S2 tab').toBe(0)
            expect(t2After.stateVersion, 'rejected requests must not change the S2 task').toBe(t2Before.stateVersion)
            expect(t2After.status).toBe(t2Before.status)
        } finally {
            if (t3) await cAll.cancel({ taskId: t3, requestId: rid() })
            expect(await cleanupSpace(stack, c1, S1, [t1.taskId])).toBeUndefined()
            expect(await cleanupSpace(stack, c2, S2, [t2.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('two tasks of one agentSessionId racing for the same tab never interleave #%i', async (i) => {
        const g = mintAgent(stack)
        const c = client(stack, g.token)
        const L = ledgerRun(stack, `a05-race-${i}`)
        const ta = await newTaskWithPage(c, pageUrl(stack, SITE_A, '/x5/panel', { label: 'RACE', key: 'gate' }, L))
        const tb = await c.createTask({ taskSpaceId: ta.taskSpaceId, requestId: rid() })
        try {
            const o = await c.observe({ taskId: ta.taskId, tabId: ta.tabId })
            const press = o.elements.find((e) => e.name === 'Press RACE')!.ref
            // Task A: observe -> input -> (hold on the gate) -> input.
            const accepted = await c.submitBatch({ taskId: ta.taskId, expectedVersion: ta.version, requestId: rid(), steps: [
                step(ta.tabId, 'click', { ref: press }),
                step(ta.tabId, 'waitFor', { until: { kind: 'text', text: 'GATE OPEN' } }),
                step(ta.tabId, 'click', { ref: press }),
            ] })
            expect(accepted.accepted).toBe(true)
            await waitLedger(stack, L, (e) => count(e, 'click') >= 1, { settleMs: 0 })
            // Task B (same agent session) inside A's segment.
            const denied: string[] = []
            for (const [label, p] of [
                ['b-batch-on-a-tab', c.submitBatch({ taskId: tb.taskId, expectedVersion: tb.stateVersion, requestId: rid(), steps: [step(ta.tabId, 'click', { ref: press })] })],
                ['b-observe-a-tab', c.observe({ taskId: tb.taskId, tabId: ta.tabId })],
                ['b-screenshot-a-tab', c.screenshot({ taskId: tb.taskId, tabId: ta.tabId })],
            ] as const) denied.push(`${label}:${(await expectCode(p, ['SCOPE_DENIED', 'STALE_LEASE'], label)).code}`)
            await releaseBarrier(stack, L, 'gate', `n${i}`)
            const done = await waitForTask(c, ta.taskId, (t) => t.status !== 'running')
            const ledger = await settledLedger(stack, L, 1_000)
            const clicks = ledger.filter((e) => e.kind === 'click')
            evidence('A05', { path: 'same-session-race', i, denied, taskA: done.status, pause: done.pauseReason, clicks: clicks.map((e) => e.target) })
            expect(done.lastBatch?.outcome).toBe('succeeded')
            expect(clicks.map((e) => e.target)).toEqual(['RACE', 'RACE'])
        } finally {
            expect(await cleanupSpace(stack, c, ta.taskSpaceId, [ta.taskId, tb.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('same profile shares login across spaces; profile B stays logged out #%i', async (i) => {
        const cA = client(stack, mintAgent(stack).token)
        const cB = client(stack, mintAgent(stack, { profileId: PROFILE_B }).token)
        const user = `user${i}x${randomUUID().slice(0, 6)}`
        const login = await newTaskWithPage(cA, pageUrl(stack, SITE_A, '/login', { next: '/protected' }))
        const S2 = (await cA.createSpace({ profileId: PROFILE_A, requestId: rid() })).taskSpaceId
        const SB = (await cB.createSpace({ profileId: PROFILE_B as ProfileId, requestId: rid() })).taskSpaceId
        const tasks: Array<[typeof cA, TaskSpaceId, TaskId[]]> = [[cA, login.taskSpaceId, [login.taskId]], [cA, S2, []], [cB, SB, []]]
        try {
            const form = await cA.observe({ taskId: login.taskId, tabId: login.tabId })
            const userBox = form.elements.find((e) => e.name === 'User')!.ref
            const submit = form.elements.find((e) => e.name === 'Log in')!.ref
            const r = await cA.submitBatch({ taskId: login.taskId, expectedVersion: login.version, requestId: rid(), steps: [
                step(login.tabId, 'fill', { ref: userBox, value: user }),
                step(login.tabId, 'click', { ref: submit }),
                step(login.tabId, 'waitFor', { until: { kind: 'text', text: 'AUTHENTICATED' }, timeoutMs: 15_000 }),
            ] }, { waitMs: 30_000 })
            expect(r.result?.outcome).toBe('succeeded')
            const other = await newTaskWithPage(cA, pageUrl(stack, SITE_A, '/protected'), { taskSpaceId: S2 })
            tasks[1][2].push(other.taskId)
            const shared = await observeUntil(cA, other.taskId, other.tabId, (o) => o.text.includes('AUTHENTICATED') || o.url.includes('/login'))
            const b = await newTaskWithPage(cB, pageUrl(stack, SITE_A, '/protected'), { taskSpaceId: SB })
            tasks[2][2].push(b.taskId)
            const separate = await cB.observe({ taskId: b.taskId, tabId: b.tabId })
            evidence('A05', { path: 'login-sharing', i, sharedAuthenticated: shared.text.includes(`AUTHENTICATED as ${user}`), profileBPath: new URL(separate.url).pathname, profileBAuthenticated: separate.text.includes('AUTHENTICATED') })
            expect(shared.text).toContain(`AUTHENTICATED as ${user}`)
            expect(new URL(separate.url).pathname).toBe('/login')
            expect(separate.text).not.toContain('AUTHENTICATED')
        } finally {
            for (const [c, space, ids] of tasks) expect(await cleanupSpace(stack, c, space, ids)).toBeUndefined()
        }
    })
    // Kept last: a violation here leaves the task non-terminal and leaks its space quota.
    it.each(range(N))('openPage and submitBatch of the same task are serialised into one execution segment #%i', async (i) => {
        const c = client(stack, mintAgent(stack).token)
        const L = ledgerRun(stack, `a05-samerace-${i}`)
        const t = await newTaskWithPage(c, pageUrl(stack, SITE_A, '/x5/panel', { label: 'SAME' }, L))
        try {
            const o = await c.observe({ taskId: t.taskId, tabId: t.tabId })
            const press = o.elements.find((e) => e.name === 'Press SAME')!.ref
            const [batchResult, openResult] = await Promise.allSettled([
                c.submitBatch({ taskId: t.taskId, expectedVersion: t.version, requestId: rid(), steps: [step(t.tabId, 'click', { ref: press }), step(t.tabId, 'click', { ref: press })] }, { waitMs: 30_000 }),
                c.openPage({ taskId: t.taskId, url: pageUrl(stack, SITE_A, '/x5/panel', { label: 'OTHER' }, L), requestId: rid() }),
            ])
            const task = await waitForTask(c, t.taskId, (x) => x.status !== 'running')
            const ledger = await settledLedger(stack, L, 1_000)
            const winners = [batchResult, openResult].filter((r) => r.status === 'fulfilled').length
            const loserCode = [batchResult, openResult].map((r) => r.status === 'rejected' ? (r.reason as { code?: string }).code : undefined)
            evidence('A05', { path: 'same-task-openPage-vs-batch', i, batch: batchResult.status, openPage: openResult.status, loserCode, tabs: task.tabs.length, clicks: count(ledger, 'click') })
            expect(winners, 'CONTRACT: exactly one of openPage/submitBatch may start an execution segment; the other must be CONFLICT').toBe(1)
            expect(loserCode.filter(Boolean)).toEqual(['CONFLICT'])
        } finally {
            expect(await cleanupSpace(stack, c, t.taskSpaceId, [t.taskId])).toBeUndefined()
        }
    })
})
