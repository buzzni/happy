/**
 * Whether a restart keeps the worker terminals (specs/terminal-survive-runner-restart HR3), and
 * whether this daemon uses workers at all (HR11).
 */
import type { RestartDrainIntent, RestartDrainReason } from '../restartDrain'

/**
 * HR11: the release default. `false` for the first release — workers only with
 * `HAPPY_TERMINAL_WORKER=1`. Turning them on for everyone is this one line, in a later pin
 * (tasks F1).
 */
export const TERMINAL_WORKER_DEFAULT_ENABLED = false

export const TERMINAL_WORKER_FLAG_ENV = 'HAPPY_TERMINAL_WORKER'

export type TerminalWorkerFlag = 'on' | 'off-kill-switch' | 'off-default'

/** `1` opts in, `0` is the kill switch whatever the default, anything else is the default. */
export function readTerminalWorkerFlag(env: NodeJS.ProcessEnv = process.env): TerminalWorkerFlag {
    const value = env[TERMINAL_WORKER_FLAG_ENV]?.trim()
    if (value === '1') return 'on'
    if (value === '0') return 'off-kill-switch'
    return TERMINAL_WORKER_DEFAULT_ENABLED ? 'on' : 'off-default'
}

export function terminalWorkersEnabled(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
    return platform !== 'win32' && readTerminalWorkerFlag(env) === 'on'
}

export type TerminalsCloseReason =
    | 'stop'
    | 'account-switch'
    | 'windows'
    | 'incompatible'
    | 'record-unreadable'
    | 'disabled'
    | 'worker-unavailable'

export type TerminalSurvivalDecision =
    | { terminals: 'keep' }
    | { terminals: 'close'; reason: TerminalsCloseReason }

export interface TerminalSurvivalInput {
    platform: NodeJS.Platform
    workersEnabled: boolean
    intent: RestartDrainIntent
    reason: RestartDrainReason
    /** The installed bundle speaks this daemon's worker protocol; false when that could not be confirmed. */
    installedProtocolMatches: boolean
    /** Every worker record could be read at the last scan. */
    recordsReadable: boolean
}

export function decideTerminalSurvival(input: TerminalSurvivalInput): TerminalSurvivalDecision {
    if (input.platform === 'win32') return { terminals: 'close', reason: 'windows' }
    if (!input.workersEnabled) return { terminals: 'close', reason: 'disabled' }
    if (input.intent === 'stop') return { terminals: 'close', reason: 'stop' }
    // A switched account must not inherit the previous account's shells.
    if (input.reason === 'account-switch') return { terminals: 'close', reason: 'account-switch' }
    if (!input.recordsReadable) return { terminals: 'close', reason: 'record-unreadable' }
    if (!input.installedProtocolMatches) return { terminals: 'close', reason: 'incompatible' }
    return { terminals: 'keep' }
}
