import { describe, expect, it } from 'vitest'
import { InputLeaseManager } from './inputLease'

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
})
