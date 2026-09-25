import { describe, expect, it } from 'vitest'
import { InputLeaseManager } from './inputLease'
import { FakeBrowserDriver } from './testing/fakeDriver'

describe('input lease fencing', () => {
    it('refuses a second task in the same agent session and invalidates the old epoch on takeover', () => {
        const leases = new InputLeaseManager(); const profile = 'p' as never; const tab = 't' as never
        const first = { kind: 'agent' as const, agentSessionId: 'same-agent' as never, taskId: 'task-1' as never, segmentId: 'batch-1' as never }
        const second = { ...first, taskId: 'task-2' as never, segmentId: 'batch-2' as never }
        const epoch = leases.acquire(tab, profile, first)
        expect(() => leases.acquire(tab, profile, second)).toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }))
        const takeoverEpoch = leases.takeOver(tab, profile, { kind: 'user', principalId: 'p' as never, viewerSessionId: 'viewer' })
        expect(takeoverEpoch).toBe(epoch + 1)
        expect(() => leases.assert(tab, profile, first.taskId, first.segmentId, epoch)).toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }))
        expect(leases.isUserFenced(profile)).toBe(true)
    })

    it('keeps the user pending owner fenced across the whole profile until driver settling completes', () => {
        const leases = new InputLeaseManager()
        const profile = 'p' as never
        const tab = 't' as never
        const otherTab = 'other' as never
        const owner = { kind: 'agent' as const, agentSessionId: 'a' as never, taskId: 'task-1' as never, segmentId: 'batch-1' as never }
        const epoch = leases.acquire(tab, profile, owner)
        const fencedEpoch = leases.fenceForTakeover(tab, profile, owner.taskId, {
            kind: 'user', principalId: 'p' as never, viewerSessionId: 'viewer',
        })

        expect(fencedEpoch).toBe(epoch + 1)
        expect(leases.owner(tab, profile).owner.kind).toBe('none')
        expect(leases.isUserFenced(profile)).toBe(true)
        expect(() => leases.acquire(otherTab, profile, { ...owner, taskId: 'task-2' as never }))
            .toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }))

        expect(leases.completePendingTakeovers(owner.taskId)).toHaveLength(1)
        expect(leases.owner(tab, profile).owner.kind).toBe('user')
        expect(leases.isUserFenced(profile)).toBe(true)
    })

    it('rejects an existing agent lease on another tab while profile input belongs to a user', () => {
        const leases = new InputLeaseManager()
        const profile = 'p' as never
        const userTab = 'user-tab' as never
        const agentTab = 'agent-tab' as never
        const owner = { kind: 'agent' as const, agentSessionId: 'a' as never, taskId: 'task-2' as never,
            segmentId: 'batch-2' as never }
        const epoch = leases.acquire(agentTab, profile, owner)
        leases.takeOver(userTab, profile, { kind: 'user', principalId: 'p' as never, viewerSessionId: 'viewer' })
        expect(() => leases.assert(agentTab, profile, owner.taskId, owner.segmentId, epoch))
            .toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }))
    })

    it('keeps a second same-agent task out of an observe-input-postcondition segment', async () => {
        const leases = new InputLeaseManager()
        const driver = new FakeBrowserDriver()
        const profile = 'p' as never
        const tab = 'shared-tab' as never
        const task1 = 'task-1' as never
        const task2 = 'task-2' as never
        const segment1 = 'batch-1' as never
        const owner1 = { kind: 'agent' as const, agentSessionId: 'same-agent' as never, taskId: task1, segmentId: segment1 }
        const epoch = leases.acquire(tab, profile, owner1)
        driver.seedTab(tab, { url: 'https://fixture.test/start', text: 'ready', elements: [
            { ref: '@continue' as never, role: 'button', name: 'Continue', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        driver.setDelay('waitFor', 1)

        const observed = await driver.observe(tab, ['https://fixture.test'], { timeoutMs: 1000 })
        expect(observed.url).toBe('https://fixture.test/start')
        expect(() => leases.acquire(tab, profile, {
            kind: 'agent', agentSessionId: 'same-agent' as never, taskId: task2, segmentId: 'batch-2' as never,
        })).toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }))

        driver.armAction('task1-input')
        await driver.click(tab, '@continue' as never, observed.snapshotId, { timeoutMs: 1000 })
        driver.armAction('task1-postcondition')
        await driver.waitFor(tab, { kind: 'text', text: 'done' }, ['https://fixture.test'], { timeoutMs: 1000 })
        leases.assert(tab, profile, task1, segment1, epoch)
        leases.release(tab, profile)

        leases.acquire(tab, profile, {
            kind: 'agent', agentSessionId: 'same-agent' as never, taskId: task2, segmentId: 'batch-2' as never,
        })
        const task2Observation = await driver.observe(tab, ['https://fixture.test'], { timeoutMs: 1000 })
        driver.armAction('task2-input')
        await driver.click(tab, '@continue' as never, task2Observation.snapshotId, { timeoutMs: 1000 })

        expect(driver.targetLedger.filter((entry) => entry.actionId).map((entry) => entry.actionId)).toEqual([
            'task1-input', 'task1-postcondition', 'task2-input',
        ])
    })
})
