import { describe, expect, it, vi } from 'vitest'
import {
    countInTurnSessions,
    DEFAULT_RESTART_DRAIN_GRACE_SECONDS,
    resolveRestartDrainGraceSeconds,
    RestartDrainController,
    type RestartDrainActivity,
    type RestartDrainDeps,
} from './restartDrain'

function harness(initial: Partial<RestartDrainActivity> = {}) {
    let now = 1_000_000
    let activity: RestartDrainActivity = { inTurnCount: 0, automationCount: 0, busyTerminalCount: 0, openTerminalCount: 0, ...initial }
    let admissionClosed = false
    let ids = 0
    const deps = {
        now: () => now,
        activity: () => activity,
        closeAdmission: vi.fn(() => { admissionClosed = true }),
        reopenAdmission: vi.fn(() => { admissionClosed = false }),
        onReady: vi.fn(),
        onSelfComplete: vi.fn(),
        onCancelled: vi.fn(),
        onChange: vi.fn(),
        env: {},
        createOperationId: () => `op-${++ids}`,
    } satisfies RestartDrainDeps
    const controller = new RestartDrainController(deps)
    return {
        controller,
        deps,
        advance: (ms: number) => { now += ms },
        setActivity: (next: Partial<RestartDrainActivity>) => { activity = { ...activity, ...next } },
        get now() { return now },
        get admissionClosed() { return admissionClosed },
    }
}

describe('resolveRestartDrainGraceSeconds (Q2)', () => {
    it('uses the per-reason defaults, with account-switch fixed at 15 s', () => {
        expect(DEFAULT_RESTART_DRAIN_GRACE_SECONDS).toMatchObject({
            'bundle-replaced': 120, 'version-mismatch': 120, 'desktop-version-match': 120,
            'app-update': 60, 'env-reapply': 15, 'user-restart': 15, 'account-switch': 15,
        })
        expect(resolveRestartDrainGraceSeconds('account-switch', undefined, {})).toBe(15)
    })

    it('lets the request override and clamps into 0~300', () => {
        expect(resolveRestartDrainGraceSeconds('env-reapply', 42, {})).toBe(42)
        expect(resolveRestartDrainGraceSeconds('env-reapply', 9_999, {})).toBe(300)
        expect(resolveRestartDrainGraceSeconds('env-reapply', -5, {})).toBe(0)
    })

    it('honours the env override when the request has none', () => {
        expect(resolveRestartDrainGraceSeconds('bundle-replaced', undefined, { HAPPY_DAEMON_RESTART_DRAIN_GRACE_SECONDS: '7' })).toBe(7)
    })
})

describe('RestartDrainController', () => {
    it('closes admission and is ready at once when nothing is running', () => {
        const h = harness()
        const result = h.controller.begin({ reason: 'user-restart', intent: 'restart', trigger: 'request' })
        expect(result.ok && result.view.state).toBe('ready')
        expect(h.admissionClosed).toBe(true)
        expect(h.deps.onReady).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'idle', inTurnCountAtStart: 0 }))
        expect(h.deps.onSelfComplete).not.toHaveBeenCalled()
    })

    it('waits for in-flight turns and becomes ready when they end (R2)', () => {
        const h = harness({ inTurnCount: 2 })
        const begun = h.controller.begin({ reason: 'env-reapply', intent: 'stop', trigger: 'request' })
        expect(begun.ok && begun.view).toMatchObject({ state: 'draining', inTurnCount: 2, deadlineAt: h.now + 15_000 })
        h.advance(5_000)
        h.setActivity({ inTurnCount: 0 })
        h.controller.tick()
        expect(h.controller.current()?.state).toBe('ready')
        expect(h.deps.onReady).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'idle', waitedMs: 5_000, inTurnCountAtStart: 2 }))
    })

    it('does not wait for a session that is only waiting on the user', () => {
        expect(countInTurnSessions([
            { pid: 1, runtime: { thinking: false, hasOpenToolCall: false, pendingUserInput: true, updatedAt: 10 } },
            { pid: 2, runtime: { thinking: true, hasOpenToolCall: false, pendingUserInput: true, updatedAt: 10 } },
        ], { now: 20, knownSince: () => undefined })).toBe(0)
    })

    it('counts fresh thinking/open-tool runtimes and ignores stale ones', () => {
        expect(countInTurnSessions([
            { pid: 1, runtime: { thinking: true, hasOpenToolCall: false, updatedAt: 100_000 } },
            { pid: 2, runtime: { thinking: false, hasOpenToolCall: true, updatedAt: 100_000 } },
            { pid: 3, runtime: { thinking: true, hasOpenToolCall: false, updatedAt: 100_000 - 61_000 } },
            { pid: 4, runtime: { thinking: false, hasOpenToolCall: false, updatedAt: 100_000 } },
        ], { now: 100_000, knownSince: () => undefined })).toBe(2)
    })

    it('treats an adopted session as in a turn until its first report, for at most 60 s (R11)', () => {
        const sessions = [{ pid: 9 }]
        expect(countInTurnSessions(sessions, { now: 10_000, knownSince: () => 0 })).toBe(1)
        expect(countInTurnSessions(sessions, { now: 60_000, knownSince: () => 0 })).toBe(0)
    })

    it('reaches the deadline without killing anything and reports what was left (R3)', () => {
        const h = harness({ inTurnCount: 1, busyTerminalCount: 1, openTerminalCount: 2 })
        h.controller.begin({ reason: 'env-reapply', intent: 'stop', trigger: 'request' })
        h.advance(15_000)
        h.controller.tick()
        expect(h.deps.onReady).toHaveBeenCalledWith(expect.objectContaining({
            outcome: 'deadline', inTurnCountAtDeadline: 1, busyTerminalCountAtDeadline: 1,
        }))
    })

    it('waits on busy terminals for a requested restart (R23)', () => {
        const h = harness({ busyTerminalCount: 1 })
        h.controller.begin({ reason: 'user-restart', intent: 'restart', trigger: 'request' })
        expect(h.controller.current()?.state).toBe('draining')
        h.setActivity({ busyTerminalCount: 0 })
        h.controller.tick()
        expect(h.controller.current()?.state).toBe('ready')
    })

    it('joins a second request: earlier deadline wins, restart outranks stop (R3)', () => {
        const h = harness({ inTurnCount: 1 })
        const first = h.controller.begin({ reason: 'desktop-version-match', intent: 'stop', trigger: 'request' })
        const second = h.controller.begin({ reason: 'env-reapply', intent: 'restart', trigger: 'request' })
        expect(first.ok && second.ok && second.joined).toBe(true)
        expect(second.ok && second.view).toMatchObject({
            operationId: first.ok ? first.view.operationId : '', intent: 'restart', deadlineAt: h.now + 15_000,
        })
        // Opened once, then re-closed with the earlier deadline so refusals quote it (R6).
        expect(h.deps.closeAdmission.mock.calls).toEqual([[h.now + 120_000], [h.now + 15_000]])
    })

    it('a polling caller that joins a self-completing drain takes over the finish', () => {
        const h = harness({ inTurnCount: 1 })
        h.controller.begin({ reason: 'bundle-replaced', intent: 'restart', trigger: 'handoff-cap', leaseSeconds: 0 })
        h.controller.begin({ reason: 'user-restart', intent: 'stop', trigger: 'request', graceSeconds: 0 })
        expect(h.controller.current()?.state).toBe('ready')
        expect(h.deps.onSelfComplete).not.toHaveBeenCalled()
    })

    it('refuses to join a drain that is already handing itself over', () => {
        const h = harness()
        h.controller.begin({ reason: 'signal', intent: 'restart', trigger: 'signal', leaseSeconds: 0 })
        expect(h.controller.begin({ reason: 'user-restart', intent: 'stop', trigger: 'request' })).toEqual({ ok: false, code: 'handing-off' })
    })

    it('force pulls the deadline to now and is recorded as force', () => {
        const h = harness({ inTurnCount: 1 })
        h.controller.begin({ reason: 'app-update', intent: 'stop', trigger: 'request' })
        h.controller.begin({ reason: 'app-update', intent: 'stop', trigger: 'request', force: true })
        expect(h.deps.onReady).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'force', inTurnCountAtDeadline: 1 }))
    })

    it('answers a replayed begin with the same operation and does not re-apply it', () => {
        const h = harness({ inTurnCount: 1 })
        const first = h.controller.begin({ reason: 'env-reapply', intent: 'stop', trigger: 'request', requestId: 'r1' })
        h.advance(1_000)
        const replay = h.controller.begin({ reason: 'env-reapply', intent: 'restart', trigger: 'request', requestId: 'r1', force: true })
        expect(replay.ok && replay.view).toMatchObject({ operationId: first.ok ? first.view.operationId : '', intent: 'stop', state: 'draining' })
    })

    it('refuses an unknown reason or intent', () => {
        const h = harness()
        expect(h.controller.begin({ reason: 'whatever' as never, intent: 'stop', trigger: 'request' })).toEqual({ ok: false, code: 'invalid-request' })
        expect(h.controller.begin({ reason: 'env-reapply', intent: 'pause' as never, trigger: 'request' })).toEqual({ ok: false, code: 'invalid-request' })
        expect(h.admissionClosed).toBe(false)
    })

    describe('lease (R24)', () => {
        it('cancels an abandoned stop and reopens admission', () => {
            const h = harness({ inTurnCount: 1 })
            h.controller.begin({ reason: 'account-switch', intent: 'stop', trigger: 'request', leaseSeconds: 2 })
            h.advance(2_001)
            h.controller.tick()
            expect(h.controller.current()).toBeNull()
            expect(h.admissionClosed).toBe(false)
            expect(h.deps.onCancelled).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'cancelled' }), 'lease')
        })

        it('keeps a polled stop alive past the first lease window', () => {
            const h = harness({ inTurnCount: 1 })
            const begun = h.controller.begin({ reason: 'account-switch', intent: 'stop', trigger: 'request', leaseSeconds: 2 })
            const operationId = begun.ok ? begun.view.operationId : ''
            h.advance(1_500)
            expect(h.controller.status(operationId)?.state).toBe('draining')
            h.advance(1_500)
            h.controller.tick()
            expect(h.controller.current()?.state).toBe('draining')
        })

        it('finishes an abandoned restart by itself once ready', () => {
            const h = harness({ inTurnCount: 1 })
            h.controller.begin({ reason: 'user-restart', intent: 'restart', trigger: 'request', leaseSeconds: 2 })
            h.advance(2_001)
            h.controller.tick()
            expect(h.deps.onSelfComplete).not.toHaveBeenCalled()
            h.setActivity({ inTurnCount: 0 })
            h.controller.tick()
            expect(h.deps.onSelfComplete).toHaveBeenCalledTimes(1)
            expect(h.deps.onSelfComplete).toHaveBeenCalledWith(expect.objectContaining({ intent: 'restart', state: 'ready' }))
        })

        it('self-completes a restart that became ready while its caller was still there, once the lease lapses', () => {
            const h = harness()
            h.controller.begin({ reason: 'user-restart', intent: 'restart', trigger: 'request', leaseSeconds: 2 })
            expect(h.deps.onSelfComplete).not.toHaveBeenCalled()
            h.advance(2_001)
            h.controller.tick()
            h.controller.tick()
            expect(h.deps.onSelfComplete).toHaveBeenCalledTimes(1)
        })

        it('lease 0 starts in self-complete mode', () => {
            const h = harness()
            h.controller.begin({ reason: 'signal', intent: 'restart', trigger: 'signal', leaseSeconds: 0 })
            expect(h.deps.onSelfComplete).toHaveBeenCalledTimes(1)
        })

        it('never keeps admission closed past deadline + lease', () => {
            const h = harness({ inTurnCount: 1 })
            h.controller.begin({ reason: 'account-switch', intent: 'stop', trigger: 'request', leaseSeconds: 30 })
            h.advance(15_000 + 30_001)
            h.controller.tick()
            expect(h.admissionClosed).toBe(false)
        })
    })

    describe('handoff modes (R4)', () => {
        it('prewait: re-checks after closing admission and hands off when still idle', () => {
            const h = harness()
            const result = h.controller.begin({ reason: 'bundle-replaced', intent: 'restart', trigger: 'handoff-prewait', graceSeconds: 0, leaseSeconds: 0 })
            expect(result.ok && result.view.state).toBe('ready')
            expect(h.deps.onSelfComplete).toHaveBeenCalledTimes(1)
        })

        it('prewait: calls itself off when activity appeared, reopening admission', () => {
            const h = harness()
            let calls = 0
            h.deps.activity = vi.fn(() => ({ inTurnCount: calls++ === 0 ? 0 : 1, automationCount: 0, busyTerminalCount: 0, openTerminalCount: 0 }))
            const result = h.controller.begin({ reason: 'bundle-replaced', intent: 'restart', trigger: 'handoff-prewait', graceSeconds: 0, leaseSeconds: 0 })
            expect(result.ok && result.view.state).toBe('cancelled')
            expect(h.admissionClosed).toBe(false)
            expect(h.deps.onSelfComplete).not.toHaveBeenCalled()
            expect(h.deps.onCancelled).toHaveBeenCalledWith(expect.anything(), 'activity')
        })

        it('cap drain: ignores idle-but-open terminals for readiness', () => {
            const h = harness({ openTerminalCount: 1 })
            const result = h.controller.begin({ reason: 'bundle-replaced', intent: 'restart', trigger: 'handoff-cap', leaseSeconds: 0 })
            expect(result.ok && result.view.state).toBe('ready')
        })

        it('cap drain: a terminal becoming busy calls the drain off', () => {
            const h = harness({ inTurnCount: 1 })
            h.controller.begin({ reason: 'bundle-replaced', intent: 'restart', trigger: 'handoff-cap', leaseSeconds: 0 })
            h.setActivity({ busyTerminalCount: 1 })
            h.controller.tick()
            expect(h.controller.current()).toBeNull()
            expect(h.admissionClosed).toBe(false)
        })

        it('terminal-cap drain: waits terminals up to grace, then is ready', () => {
            const h = harness({ busyTerminalCount: 1 })
            h.controller.begin({ reason: 'bundle-replaced', intent: 'restart', trigger: 'handoff-terminal-cap', leaseSeconds: 0 })
            h.advance(119_000)
            h.controller.tick()
            expect(h.controller.current()?.state).toBe('draining')
            h.advance(1_000)
            h.controller.tick()
            expect(h.deps.onReady).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'deadline', busyTerminalCountAtDeadline: 1 }))
            expect(h.deps.onSelfComplete).toHaveBeenCalledTimes(1)
        })

        it('a requested restart joining a cap drain is no longer called off by a busy terminal', () => {
            const h = harness({ inTurnCount: 1 })
            h.controller.begin({ reason: 'bundle-replaced', intent: 'restart', trigger: 'handoff-cap', leaseSeconds: 0 })
            h.controller.begin({ reason: 'user-restart', intent: 'restart', trigger: 'request' })
            h.setActivity({ busyTerminalCount: 1 })
            h.controller.tick()
            expect(h.controller.current()?.state).toBe('draining')
        })
    })

    it('republishes only on visible changes', () => {
        const h = harness({ inTurnCount: 1 })
        h.controller.begin({ reason: 'env-reapply', intent: 'stop', trigger: 'request' })
        const published = h.deps.onChange.mock.calls.length
        h.controller.tick()
        h.controller.tick()
        expect(h.deps.onChange.mock.calls.length).toBe(published)
        h.setActivity({ inTurnCount: 2 })
        h.controller.tick()
        expect(h.deps.onChange.mock.calls.length).toBe(published + 1)
    })
})
