/**
 * Restart drain (aplus specs/codexcli-daemon-restart-drain R1~R3·R24).
 *
 * Before a daemon is replaced it closes admission — new session spawns and
 * resumes, automation ticks, server automation leases — and waits until no
 * turn is in flight, no automation runs and no daemon terminal is being typed
 * in, or until the grace runs out. Turns are never killed: session processes
 * are detached and outlive the daemon, so the wait only shrinks the window in
 * which a live turn loses daemon-routed features (bridge, port registry …).
 *
 * Input to open sessions (the next message, permission answers, aborts) is not
 * gated — it never goes through this daemon's admission.
 *
 * This module is the state machine only. The daemon wires admission, the
 * activity snapshot, terminal closing, the outcome ledger and the actual
 * stop/hand-off through `RestartDrainDeps`.
 */
import { randomUUID } from 'node:crypto'

export type RestartDrainIntent = 'restart' | 'stop'

export const RESTART_DRAIN_REASONS = [
    'bundle-replaced',
    'version-mismatch',
    'desktop-version-match',
    'app-update',
    'env-reapply',
    'user-restart',
    'account-switch',
    'signal',
] as const
export type RestartDrainReason = typeof RESTART_DRAIN_REASONS[number]

export type RestartDrainTrigger = 'request' | 'handoff-prewait' | 'handoff-cap' | 'handoff-terminal-cap' | 'signal'
export type RestartDrainOutcome = 'idle' | 'deadline' | 'force' | 'cancelled'

/**
 * Spec Q2: paths a person waits on are short, unattended ones are long.
 * `account-switch` is fixed at 15 s by this spec (not left to PR #2045).
 * `signal` (SIGHUP) is a self-completing restart nobody waits on.
 */
export const DEFAULT_RESTART_DRAIN_GRACE_SECONDS: Readonly<Record<RestartDrainReason, number>> = {
    'bundle-replaced': 120,
    'version-mismatch': 120,
    'desktop-version-match': 120,
    'app-update': 60,
    'env-reapply': 15,
    'user-restart': 15,
    'account-switch': 15,
    signal: 120,
}
export const MAX_RESTART_DRAIN_GRACE_SECONDS = 300
export const DEFAULT_RESTART_DRAIN_LEASE_SECONDS = 30
const MAX_RESTART_DRAIN_LEASE_SECONDS = 300
/** Replayed begin requests answered from memory, same bound as the standalone drain. */
const MAX_REMEMBERED_REQUEST_IDS = 128

export function isRestartDrainReason(value: unknown): value is RestartDrainReason {
    return typeof value === 'string' && (RESTART_DRAIN_REASONS as readonly string[]).includes(value)
}

function clampSeconds(value: number, max: number): number {
    return Math.min(max, Math.max(0, Math.floor(value)))
}

/**
 * Grace for a drain: explicit request → env override (`HAPPY_DAEMON_RESTART_DRAIN_GRACE_SECONDS`)
 * → the reason's default. Always within 0~300 s.
 */
export function resolveRestartDrainGraceSeconds(
    reason: RestartDrainReason,
    requested?: number,
    env: NodeJS.ProcessEnv = process.env,
): number {
    if (typeof requested === 'number' && Number.isFinite(requested)) {
        return clampSeconds(requested, MAX_RESTART_DRAIN_GRACE_SECONDS)
    }
    const override = Number(env.HAPPY_DAEMON_RESTART_DRAIN_GRACE_SECONDS)
    if (env.HAPPY_DAEMON_RESTART_DRAIN_GRACE_SECONDS !== undefined && Number.isFinite(override)) {
        return clampSeconds(override, MAX_RESTART_DRAIN_GRACE_SECONDS)
    }
    return DEFAULT_RESTART_DRAIN_GRACE_SECONDS[reason]
}

export interface RestartDrainActivity {
    /** Sessions whose turn is in flight (see `countInTurnSessions`). */
    inTurnCount: number
    /** Running automation ticks plus held server automation leases. */
    automationCount: number
    /** Daemon terminals with user input in the last 10 minutes. */
    busyTerminalCount: number
    openTerminalCount: number
}

export interface RestartDrainView {
    version: 1
    operationId: string
    state: 'draining' | 'ready' | 'cancelled'
    intent: RestartDrainIntent
    reason: RestartDrainReason
    trigger: RestartDrainTrigger
    inTurnCount: number
    openTerminalCount: number
    busyTerminalCount: number
    deadlineAt: number
    leaseExpiresAt?: number
}

export interface RestartDrainSettlement {
    view: RestartDrainView
    outcome: RestartDrainOutcome
    graceSeconds: number
    startedAt: number
    waitedMs: number
    inTurnCountAtStart: number
    inTurnCountAtDeadline?: number
    busyTerminalCountAtDeadline?: number
}

export interface RestartDrainBeginRequest {
    reason: RestartDrainReason
    intent: RestartDrainIntent
    trigger: RestartDrainTrigger
    graceSeconds?: number
    force?: boolean
    /** 0 = self-complete: nobody polls, the daemon finishes the job itself. */
    leaseSeconds?: number
    requestId?: string
}

export interface RestartDrainDeps {
    now: () => number
    activity: () => RestartDrainActivity
    closeAdmission: (deadlineAt: number) => void
    reopenAdmission: () => void
    /** Ready reached (once per drain): close terminals, record the outcome. */
    onReady: (settlement: RestartDrainSettlement) => void
    /**
     * Nobody is left to finish: lease 0 or a lapsed `restart` lease. `restart`
     * hands off to a fresh daemon, `stop` shuts this one down.
     */
    onSelfComplete: (view: RestartDrainView) => void
    onCancelled: (settlement: RestartDrainSettlement, cause: 'lease' | 'activity' | 'requested') => void
    /** Any visible change — the daemon republishes `daemonState.lifecycle`. */
    onChange: () => void
    env?: NodeJS.ProcessEnv
    createOperationId?: () => string
}

interface Operation {
    operationId: string
    state: 'draining' | 'ready' | 'cancelled'
    intent: RestartDrainIntent
    reason: RestartDrainReason
    trigger: RestartDrainTrigger
    graceSeconds: number
    startedAt: number
    deadlineAt: number
    forced: boolean
    leaseExpiresAt: number | undefined
    /** True once nobody is going to call `/stop` for this drain. */
    selfComplete: boolean
    selfCompleted: boolean
    /** handoff-cap: entered only with idle terminals, cancelled if one becomes busy. */
    cancelOnBusyTerminal: boolean
    /** handoff-cap ignores terminals for readiness (it never waits on them). */
    waitsForTerminals: boolean
    inTurnCountAtStart: number
    lastActivity: RestartDrainActivity
}

export type RestartDrainBeginResult =
    | { ok: true; view: RestartDrainView; joined: boolean }
    | { ok: false; code: 'invalid-request' | 'not-ready' }

export class RestartDrainController {
    private operation: Operation | null = null
    private readonly requestIds = new Map<string, string>()
    private lastChangeKey = ''

    constructor(private readonly deps: RestartDrainDeps) {}

    /** True while new spawns, resumes and automation must be refused. */
    isAdmissionClosed(): boolean {
        return this.operation !== null && this.operation.state !== 'cancelled'
    }

    isDraining(): boolean {
        return this.operation?.state === 'draining'
    }

    isReady(): boolean {
        return this.operation?.state === 'ready'
    }

    current(): RestartDrainView | null {
        return this.operation && this.operation.state !== 'cancelled' ? this.view(this.operation) : null
    }

    begin(request: RestartDrainBeginRequest): RestartDrainBeginResult {
        if (!isRestartDrainReason(request.reason) || (request.intent !== 'restart' && request.intent !== 'stop')) {
            return { ok: false, code: 'invalid-request' }
        }
        const now = this.deps.now()
        const leaseSeconds = request.leaseSeconds === undefined
            ? DEFAULT_RESTART_DRAIN_LEASE_SECONDS
            : clampSeconds(request.leaseSeconds, MAX_RESTART_DRAIN_LEASE_SECONDS)
        const replayed = request.requestId ? this.requestIds.get(request.requestId) : undefined
        if (replayed && this.operation?.operationId === replayed && this.operation.state !== 'cancelled') {
            this.renewLease(this.operation, leaseSeconds, now)
            return { ok: true, view: this.view(this.operation), joined: true }
        }

        const graceSeconds = resolveRestartDrainGraceSeconds(request.reason, request.graceSeconds, this.deps.env)
        const requestedDeadline = request.force ? now : now + graceSeconds * 1000
        const active = this.operation && this.operation.state !== 'cancelled' ? this.operation : null

        if (active) {
            // One drain per daemon: a later request joins it (R3).
            if (requestedDeadline < active.deadlineAt) active.deadlineAt = requestedDeadline
            if (request.force) active.forced = true
            if (request.intent === 'restart') active.intent = 'restart'
            if (request.trigger === 'request' || request.trigger === 'signal') {
                // A requested restart waits on busy terminals up to its grace and is
                // never called off because one is typed in.
                active.cancelOnBusyTerminal = false
                active.waitsForTerminals = true
            }
            if (leaseSeconds === 0) active.selfComplete = true
            else this.renewLease(active, leaseSeconds, now)
            this.remember(request.requestId, active.operationId)
            this.evaluate()
            return { ok: true, view: this.view(active), joined: true }
        }

        const activity = this.deps.activity()
        const operation: Operation = {
            operationId: this.deps.createOperationId?.() ?? randomUUID(),
            state: 'draining',
            intent: request.intent,
            reason: request.reason,
            trigger: request.trigger,
            graceSeconds,
            startedAt: now,
            deadlineAt: requestedDeadline,
            forced: request.force === true,
            leaseExpiresAt: leaseSeconds > 0 ? now + leaseSeconds * 1000 : undefined,
            selfComplete: leaseSeconds === 0,
            selfCompleted: false,
            cancelOnBusyTerminal: request.trigger === 'handoff-cap',
            waitsForTerminals: request.trigger !== 'handoff-cap',
            inTurnCountAtStart: activity.inTurnCount,
            lastActivity: activity,
        }
        this.operation = operation
        this.remember(request.requestId, operation.operationId)
        this.deps.closeAdmission(operation.deadlineAt)

        if (request.trigger === 'handoff-prewait') {
            // R4(b): admission is now closed; re-check the same idle condition.
            // Still idle → hand off now. Anything started meanwhile → call it off.
            const after = this.deps.activity()
            operation.lastActivity = after
            if (isIdle(after, true)) this.markReady(operation, 'idle')
            else this.settleCancelled(operation, 'activity')
        } else {
            this.evaluate()
        }
        this.notifyChange()
        return { ok: true, view: this.view(operation), joined: false }
    }

    /** Status poll: renews the caller's lease and answers the current view. */
    status(operationId: string): RestartDrainView | null {
        const operation = this.operation
        if (!operation || operation.operationId !== operationId) return null
        if (operation.state !== 'cancelled' && operation.leaseExpiresAt !== undefined) {
            this.renewLease(operation, DEFAULT_RESTART_DRAIN_LEASE_SECONDS, this.deps.now())
        }
        if (operation.state === 'draining') this.evaluate()
        return this.view(operation)
    }

    /** Pull the active drain's deadline to now (`force`). */
    force(): RestartDrainView | null {
        const operation = this.operation
        if (!operation || operation.state !== 'draining') return null
        operation.deadlineAt = this.deps.now()
        operation.forced = true
        this.evaluate()
        this.notifyChange()
        return this.view(operation)
    }

    /** Called off by the daemon itself (e.g. handoff saw new activity). */
    cancel(): void {
        const operation = this.operation
        if (!operation || operation.state === 'cancelled') return
        this.settleCancelled(operation, 'requested')
        this.notifyChange()
    }

    /** Periodic re-evaluation while a drain is open (in-memory only, no I/O). */
    tick(): void {
        const operation = this.operation
        if (!operation || operation.state === 'cancelled') return
        const now = this.deps.now()
        if (operation.leaseExpiresAt !== undefined && now > operation.leaseExpiresAt) {
            operation.leaseExpiresAt = undefined
            if (operation.intent === 'stop') {
                // R24: a stop nobody is waiting for any more is abandoned.
                this.settleCancelled(operation, 'lease')
                this.notifyChange()
                return
            }
            operation.selfComplete = true
        }
        if (operation.state === 'draining') this.evaluate()
        else this.maybeSelfComplete(operation)
        this.notifyChange()
    }

    private evaluate(): void {
        const operation = this.operation
        if (!operation || operation.state !== 'draining') return
        const activity = this.deps.activity()
        operation.lastActivity = activity
        if (operation.cancelOnBusyTerminal && activity.busyTerminalCount > 0) {
            this.settleCancelled(operation, 'activity')
            return
        }
        const now = this.deps.now()
        if (isIdle(activity, operation.waitsForTerminals)) {
            this.markReady(operation, 'idle')
        } else if (now >= operation.deadlineAt) {
            this.markReady(operation, operation.forced ? 'force' : 'deadline')
        }
    }

    private markReady(operation: Operation, outcome: Exclude<RestartDrainOutcome, 'cancelled'>): void {
        operation.state = 'ready'
        const now = this.deps.now()
        const atDeadline = outcome !== 'idle'
        this.deps.onReady({
            view: this.view(operation),
            outcome,
            graceSeconds: operation.graceSeconds,
            startedAt: operation.startedAt,
            waitedMs: Math.max(0, now - operation.startedAt),
            inTurnCountAtStart: operation.inTurnCountAtStart,
            ...(atDeadline ? {
                inTurnCountAtDeadline: operation.lastActivity.inTurnCount,
                busyTerminalCountAtDeadline: operation.lastActivity.busyTerminalCount,
            } : {}),
        })
        this.maybeSelfComplete(operation)
    }

    private maybeSelfComplete(operation: Operation): void {
        if (operation.state !== 'ready' || !operation.selfComplete || operation.selfCompleted) return
        operation.selfCompleted = true
        this.deps.onSelfComplete(this.view(operation))
    }

    private settleCancelled(operation: Operation, cause: 'lease' | 'activity' | 'requested'): void {
        operation.state = 'cancelled'
        const now = this.deps.now()
        this.deps.reopenAdmission()
        this.deps.onCancelled({
            view: this.view(operation),
            outcome: 'cancelled',
            graceSeconds: operation.graceSeconds,
            startedAt: operation.startedAt,
            waitedMs: Math.max(0, now - operation.startedAt),
            inTurnCountAtStart: operation.inTurnCountAtStart,
        }, cause)
    }

    /** Republish only on a visible change, not on every tick. */
    private notifyChange(): void {
        const operation = this.operation
        const key = operation
            ? [operation.operationId, operation.state, operation.intent, operation.deadlineAt,
                operation.lastActivity.inTurnCount, operation.lastActivity.openTerminalCount,
                operation.lastActivity.busyTerminalCount].join('|')
            : ''
        if (key === this.lastChangeKey) return
        this.lastChangeKey = key
        this.deps.onChange()
    }

    private renewLease(operation: Operation, leaseSeconds: number, now: number): void {
        if (leaseSeconds <= 0) return
        operation.leaseExpiresAt = Math.max(operation.leaseExpiresAt ?? 0, now + leaseSeconds * 1000)
    }

    private remember(requestId: string | undefined, operationId: string): void {
        if (!requestId) return
        this.requestIds.delete(requestId)
        this.requestIds.set(requestId, operationId)
        while (this.requestIds.size > MAX_REMEMBERED_REQUEST_IDS) {
            const oldest = this.requestIds.keys().next().value
            if (oldest === undefined) break
            this.requestIds.delete(oldest)
        }
    }

    private view(operation: Operation): RestartDrainView {
        return {
            version: 1,
            operationId: operation.operationId,
            state: operation.state,
            intent: operation.intent,
            reason: operation.reason,
            trigger: operation.trigger,
            inTurnCount: operation.lastActivity.inTurnCount,
            openTerminalCount: operation.lastActivity.openTerminalCount,
            busyTerminalCount: operation.lastActivity.busyTerminalCount,
            deadlineAt: operation.deadlineAt,
            ...(operation.leaseExpiresAt !== undefined ? { leaseExpiresAt: operation.leaseExpiresAt } : {}),
        }
    }
}

function isIdle(activity: RestartDrainActivity, includeTerminals: boolean): boolean {
    return activity.inTurnCount === 0
        && activity.automationCount === 0
        && (!includeTerminals || activity.busyTerminalCount === 0)
}

/** A runtime older than this is not trusted to say a turn is still running. */
export const IN_TURN_RUNTIME_STALE_MS = 60_000
/** R11: a session known for less than this that has not reported yet counts as in a turn. */
export const IN_TURN_FIRST_REPORT_WAIT_MS = 60_000

export interface InTurnCandidate {
    pid: number
    runtime?: { thinking: boolean; hasOpenToolCall: boolean; pendingUserInput?: boolean; updatedAt: number }
}

/**
 * Turns in flight: `thinking || hasOpenToolCall` from a fresh runtime report.
 * A session waiting on the user (`pendingUserInput`) is not waited for. A
 * session the daemon has known for under a minute without any report — just
 * adopted after a restart, or just spawned — counts as in a turn, so two
 * back-to-back restarts cannot miss a turn the new daemon has not heard about
 * yet (R11). The runtime itself is never fabricated.
 */
export function countInTurnSessions(
    sessions: Iterable<InTurnCandidate>,
    input: { now: number; knownSince: (pid: number) => number | undefined },
): number {
    let count = 0
    for (const session of sessions) {
        const runtime = session.runtime
        if (runtime) {
            if (runtime.pendingUserInput) continue
            if ((runtime.thinking || runtime.hasOpenToolCall) && input.now - runtime.updatedAt <= IN_TURN_RUNTIME_STALE_MS) count++
            continue
        }
        const since = input.knownSince(session.pid)
        if (since !== undefined && input.now - since < IN_TURN_FIRST_REPORT_WAIT_MS) count++
    }
    return count
}
