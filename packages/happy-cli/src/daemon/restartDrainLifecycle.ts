/**
 * What `daemonState.lifecycle` says about a restart drain (aplus
 * specs/codexcli-daemon-restart-drain R6·R22·R25), and the spawn/resume
 * refusal while admission is closed.
 */
import type { DaemonRestartLifecycle, DaemonState } from '@/api/types'
import type { PendingHandoff } from './daemonHandoffAutomationGate'
import type { RestartDrainView } from './restartDrain'

/** Refused before anything ran; retry once the daemon is back (R1·R6). */
export const DAEMON_RESTARTING_CODE = 'daemon-restarting'

export function buildRestartLifecycle(drain: RestartDrainView | null, pendingHandoff: PendingHandoff | null): DaemonRestartLifecycle {
    const pending = pendingHandoff ? { pendingHandoff: { ...pendingHandoff } } : {}
    if (!drain || drain.state === 'cancelled') return { state: 'running', ...pending }
    return {
        // `ready` still has admission closed — to a viewer it is the end of the same restart.
        state: 'draining',
        intent: drain.intent,
        reason: drain.reason,
        inTurnCount: drain.inTurnCount,
        openTerminalCount: drain.openTerminalCount,
        busyTerminalCount: drain.busyTerminalCount,
        deadlineAt: drain.deadlineAt,
        ...pending,
    }
}

export function withRestartLifecycle(state: DaemonState, lifecycle: DaemonRestartLifecycle | null): DaemonState {
    if (lifecycle) return { ...state, lifecycle }
    const { lifecycle: _dropped, ...rest } = state
    return rest
}

export function daemonRestartingRefusal(kind: 'launch' | 'resume', deadlineAt: number): {
    type: 'error'
    code: typeof DAEMON_RESTARTING_CODE
    errorMessage: string
    deadlineAt: number
} {
    return {
        type: 'error',
        code: DAEMON_RESTARTING_CODE,
        errorMessage: `Daemon is restarting; retry the ${kind} after it is back`,
        deadlineAt,
    }
}
