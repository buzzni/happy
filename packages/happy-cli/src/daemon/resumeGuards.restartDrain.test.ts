import { describe, expect, it } from 'vitest'
import { createLaunchReadinessGate } from './resumeGuards'
import { daemonRestartingRefusal, DAEMON_RESTARTING_CODE } from './restartDrainLifecycle'

describe('launch readiness gate during a restart drain (T8)', () => {
    it('closes for a restart without un-marking initialization, and reopens', () => {
        const gate = createLaunchReadinessGate()
        gate.markReady()
        gate.closeForRestart(5_000)
        expect(gate.isReady()).toBe(true)
        expect(gate.restartDeadline()).toBe(5_000)
        gate.reopenAfterRestartDrain()
        expect(gate.restartDeadline()).toBeNull()
    })

    it('refuses with a machine-readable, retryable code and the drain deadline', () => {
        expect(daemonRestartingRefusal('launch', 9_000)).toEqual({
            type: 'error', code: DAEMON_RESTARTING_CODE, deadlineAt: 9_000,
            errorMessage: 'Daemon is restarting; retry the launch after it is back',
        })
        expect(DAEMON_RESTARTING_CODE).toBe('daemon-restarting')
    })
})
