/**
 * Stopping or replacing the running daemon from the CLI (aplus
 * specs/codexcli-daemon-restart-drain R5·R19·R22·R24, plan §2.2).
 *
 * | daemon                         | what happens                                                        |
 * |--------------------------------|---------------------------------------------------------------------|
 * | new (advertises the drain)     | begin → poll status (renews the lease) → `/stop` once ready → wait   |
 * |                                | cleanup 10 s → identity-checked kill of the daemon process only     |
 * | old (capabilities 404/refused) | `/stop` → wait 15 s (was 2 s) → identity-checked kill               |
 * | none (connection refused)      | identity check, then mark the state file stale                      |
 *
 * Session processes are never signalled here.
 */
import type { DaemonLocallyPersistedState } from '@/persistence'
import type { DaemonIdentity, DaemonIdentityVerdict } from './daemonIdentity'
import type { RestartDrainIntent, RestartDrainReason, RestartDrainView } from './restartDrain'

/** Cleanup a new daemon gets after its drain is ready and `/stop` was accepted. */
export const DRAINED_DAEMON_EXIT_WAIT_MS = 10_000
/** An old daemon (no drain) gets this long to finish its own cleanup (was 2 s). */
export const LEGACY_DAEMON_EXIT_WAIT_MS = 15_000
const STATUS_POLL_MS = 1_000
/** Beyond the drain's own deadline + lease, stop waiting on a daemon that stopped answering. */
const POLL_SLACK_MS = 30_000

export type DaemonPostResult =
    | { ok: true; body: any }
    | { ok: false; status?: number; code?: string; error: string }

/** Same value as `restartDrainRoutes.RESTART_DRAIN_HANDING_OFF` (kept free of the server module). */
const HANDING_OFF_CODE = 'RESTART_DRAIN_HANDING_OFF'
/** A daemon already replacing itself is given this long to exit. */
const HANDING_OFF_EXIT_WAIT_MS = 30_000

export interface RestartDrainClientDeps {
    readState: () => Promise<DaemonLocallyPersistedState | null>
    post: (path: string, body: unknown) => Promise<DaemonPostResult>
    isPidAlive: (pid: number) => boolean
    verifyIdentity: (identity: DaemonIdentity) => Promise<DaemonIdentityVerdict>
    kill: (pid: number) => void
    markStale: (state: DaemonLocallyPersistedState, reason: string) => void | Promise<void>
    sleep: (ms: number) => Promise<void>
    now: () => number
    randomId: () => string
    log: (message: string) => void
}

export interface StopDaemonOptions {
    /** `restart` when the caller starts a daemon right after; `stop` otherwise (default). */
    intent?: RestartDrainIntent
    /** Picks the default grace and is recorded (R26). Default `user-restart`. */
    reason?: RestartDrainReason
    graceSeconds?: number
    force?: boolean
    /** Don't wait: the daemon finishes on its own (lease 0). */
    noWait?: boolean
    onProgress?: (progress: StopDaemonProgress) => void
}

export type StopDaemonProgress =
    | { kind: 'draining'; inTurnCount: number; openTerminalCount: number; busyTerminalCount: number; secondsLeft: number }
    | { kind: 'legacy-stop' }
    | { kind: 'stopping' }

export type StopDaemonOutcome = 'not-running' | 'stopped' | 'left-running' | 'handed-to-daemon'

export class DaemonStopRefusedError extends Error {}

/** Signal only a process proven to be (or not provably not) the recorded daemon. */
async function killIfStillOurs(state: DaemonLocallyPersistedState, deps: RestartDrainClientDeps): Promise<boolean> {
    if (!deps.isPidAlive(state.pid)) return true
    if (state.identity) {
        const verdict = await deps.verifyIdentity(state.identity)
        if (verdict === 'dead') return true
        if (verdict === 'mismatch') {
            // R19: the pid now belongs to someone else — never signal it.
            deps.log(`[DAEMON STOP] pid ${state.pid} no longer belongs to the daemon (identity mismatch); not signalling it`)
            await deps.markStale(state, 'Daemon PID reused by another process')
            return true
        }
    }
    try {
        deps.kill(state.pid)
        deps.log(`[DAEMON STOP] Force killed daemon ${state.pid}`)
    } catch {
        deps.log('[DAEMON STOP] Daemon already gone')
    }
    return true
}

async function waitForExit(pid: number, timeoutMs: number, deps: RestartDrainClientDeps): Promise<boolean> {
    const until = deps.now() + timeoutMs
    while (deps.now() < until) {
        if (!deps.isPidAlive(pid)) return true
        await deps.sleep(100)
    }
    return !deps.isPidAlive(pid)
}

async function stopViaHttp(deps: RestartDrainClientDeps): Promise<'accepted' | 'unreachable'> {
    const result = await deps.post('/stop', {})
    if (result.ok) return 'accepted'
    // A responding server that refused: never turn that into a force kill.
    if (result.status !== undefined && result.status >= 400) throw new DaemonStopRefusedError(result.error)
    return 'unreachable'
}

async function legacyStop(state: DaemonLocallyPersistedState, deps: RestartDrainClientDeps, options: StopDaemonOptions): Promise<StopDaemonOutcome> {
    options.onProgress?.({ kind: 'legacy-stop' })
    if (await stopViaHttp(deps) === 'accepted' && await waitForExit(state.pid, LEGACY_DAEMON_EXIT_WAIT_MS, deps)) return 'stopped'
    await killIfStillOurs(state, deps)
    return 'stopped'
}

export async function stopDaemonWithDrain(options: StopDaemonOptions, deps: RestartDrainClientDeps): Promise<StopDaemonOutcome> {
    const state = await deps.readState()
    if (!state || state.state === 'stopped' || state.state === 'crashed') return 'not-running'
    if (!deps.isPidAlive(state.pid)) {
        await deps.markStale(state, 'Daemon PID not running')
        return 'not-running'
    }

    const capabilities = await deps.post('/restart-drain/capabilities', {})
    if (!capabilities.ok && capabilities.status === undefined) {
        // Nothing answers the control port. Only a process proven to be the daemon is stopped.
        if (state.identity) {
            const verdict = await deps.verifyIdentity(state.identity)
            if (verdict === 'dead' || verdict === 'mismatch') {
                await deps.markStale(state, verdict === 'dead' ? 'Daemon PID not running' : 'Daemon PID reused by another process')
                return 'not-running'
            }
        }
        return legacyStop(state, deps, options)
    }
    if (!capabilities.ok || capabilities.body?.supported !== true || typeof capabilities.body?.instanceId !== 'string') {
        return legacyStop(state, deps, options)
    }

    const instanceId: string = capabilities.body.instanceId
    let view: RestartDrainView | null = null
    // A drain the daemon called off (our lease lapsed while this process was suspended, or a
    // restart's preflight failed) is begun once more; a second call-off leaves the daemon running.
    for (let attempt = 1; attempt <= 2; attempt++) {
        const begun = await deps.post('/restart-drain/begin', {
            requestId: deps.randomId(),
            expectedInstanceId: instanceId,
            reason: options.reason ?? 'user-restart',
            intent: options.intent ?? 'stop',
            ...(options.graceSeconds !== undefined ? { graceSeconds: options.graceSeconds } : {}),
            ...(options.force ? { force: true } : {}),
            leaseSeconds: options.noWait ? 0 : 30,
        })
        if (!begun.ok) {
            if (begun.code === HANDING_OFF_CODE) {
                deps.log('[DAEMON STOP] The daemon is already handing over to a new one; waiting for it to exit')
                await waitForExit(state.pid, HANDING_OFF_EXIT_WAIT_MS, deps)
                return 'stopped'
            }
            if (begun.status === 401) throw new DaemonStopRefusedError(begun.error)
            return legacyStop(state, deps, options)
        }
        if (options.noWait) return 'handed-to-daemon'

        view = begun.body as RestartDrainView
        while (view.state === 'draining') {
            options.onProgress?.({
                kind: 'draining',
                inTurnCount: view.inTurnCount,
                openTerminalCount: view.openTerminalCount,
                busyTerminalCount: view.busyTerminalCount,
                secondsLeft: Math.max(0, Math.ceil((view.deadlineAt - deps.now()) / 1000)),
            })
            await deps.sleep(STATUS_POLL_MS)
            const polled = await deps.post('/restart-drain/status', { expectedInstanceId: instanceId, operationId: view.operationId })
            if (polled.ok) {
                view = polled.body as RestartDrainView
                continue
            }
            if (!deps.isPidAlive(state.pid)) return 'stopped'
            if (deps.now() > view.deadlineAt + POLL_SLACK_MS) break
        }
        if (view.state !== 'cancelled') break
        deps.log(`[DAEMON STOP] The daemon called the drain off (attempt ${attempt})`)
    }
    if (view?.state === 'cancelled') {
        // Never cut a daemon whose drain was called off: it reopened admission and runs on.
        deps.log('[DAEMON STOP] Drain called off twice; leaving the daemon running')
        return 'left-running'
    }

    options.onProgress?.({ kind: 'stopping' })
    if (await stopViaHttp(deps) === 'accepted' && await waitForExit(state.pid, DRAINED_DAEMON_EXIT_WAIT_MS, deps)) return 'stopped'
    await killIfStillOurs(state, deps)
    return 'stopped'
}

/** One line of CLI progress for a drain in flight. */
export function formatStopDaemonProgress(progress: StopDaemonProgress): string {
    switch (progress.kind) {
        case 'draining':
            return `Waiting for the daemon to finish: ${progress.inTurnCount} running turn(s), ${progress.busyTerminalCount} terminal(s) in use · ${progress.secondsLeft}s left`
        case 'legacy-stop':
            return 'Stopping the daemon (this daemon cannot drain; waiting up to 15s)'
        case 'stopping':
            return 'Stopping the daemon'
    }
}

/** Reasons a CLI caller may name; `bundle-replaced` and `signal` belong to the daemon itself. */
const CLI_STOP_REASONS = ['env-reapply', 'account-switch', 'desktop-version-match', 'user-restart', 'app-update', 'version-mismatch'] as const

/**
 * `happy daemon stop [--for-restart [--reason r] [--grace N] [--no-wait]]` and
 * `happy daemon restart [--grace N] [--force]` (R5). Without `--for-restart`,
 * stop is a grace-0 drain; the other flags only make sense with it.
 */
export function parseDaemonStopArgs(subcommand: 'stop' | 'restart', argv: readonly string[]): { ok: true; options: StopDaemonOptions } | { ok: false; error: string } {
    let forRestart = subcommand === 'restart'
    let reason: RestartDrainReason | undefined
    let graceSeconds: number | undefined
    let noWait = false
    let force = false
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--for-restart' && subcommand === 'stop') forRestart = true
        else if (arg === '--no-wait' && subcommand === 'stop') noWait = true
        else if (arg === '--force' && subcommand === 'restart') force = true
        else if (arg === '--reason' && subcommand === 'stop') {
            const value = argv[++i]
            if (!(CLI_STOP_REASONS as readonly string[]).includes(value ?? '')) {
                return { ok: false, error: `--reason must be one of: ${CLI_STOP_REASONS.join(', ')}` }
            }
            reason = value as RestartDrainReason
        } else if (arg === '--grace') {
            const value = Number(argv[++i])
            if (!Number.isInteger(value) || value < 0 || value > 300) return { ok: false, error: '--grace must be a whole number of seconds between 0 and 300' }
            graceSeconds = value
        } else {
            return { ok: false, error: `Unknown option for daemon ${subcommand}: ${arg}` }
        }
    }
    if (!forRestart && (reason || graceSeconds !== undefined || noWait)) {
        return { ok: false, error: '--reason, --grace and --no-wait need --for-restart' }
    }
    if (subcommand === 'restart') {
        return { ok: true, options: { intent: 'restart', reason: 'user-restart', ...(graceSeconds !== undefined ? { graceSeconds } : {}), ...(force ? { force } : {}) } }
    }
    if (!forRestart) return { ok: true, options: { intent: 'stop', reason: 'user-restart', graceSeconds: 0 } }
    return {
        ok: true,
        options: {
            intent: 'stop',
            reason: reason ?? 'user-restart',
            ...(graceSeconds !== undefined ? { graceSeconds } : {}),
            ...(noWait ? { noWait } : {}),
        },
    }
}
