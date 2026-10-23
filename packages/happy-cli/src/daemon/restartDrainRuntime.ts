/**
 * The daemon's restart drain, wired (aplus specs/codexcli-daemon-restart-drain
 * R1~R6·R20·R23~R26): the state machine plus admission, terminal closing, the
 * outcome ledger, the two-stage bundle handoff, SIGHUP and "지금 교대".
 *
 * `run.ts` supplies closures over its own state; everything decided here is
 * testable without a daemon.
 */
import type { DaemonRestartLifecycle } from '@/api/types'
import {
    decideHandoffStep,
    readHandoffCaps,
    type PendingHandoff,
} from './daemonHandoffAutomationGate'
import {
    RestartDrainController,
    type RestartDrainActivity,
    type RestartDrainBeginRequest,
    type RestartDrainSettlement,
    type RestartDrainView,
} from './restartDrain'
import { buildRestartLifecycle } from './restartDrainLifecycle'
import { appendRestartDrainOutcome, buildRestartDrainOutcomeRecord } from './restartDrainOutcomes'
import type { RestartDrainControlPort } from './restartDrainRoutes'

export type ForceHandoffResult =
    | { ok: true; deadlineAt: number }
    | { ok: false; code: 'no-pending-handoff' | 'replacement-unavailable' }

export interface DaemonRestartDrainRuntimeInput {
    instanceId: string
    now?: () => number
    activity: () => RestartDrainActivity
    /** Close/reopen spawn·resume admission and pause/resume the automation runners. */
    closeAdmission: (deadlineAt: number) => void
    reopenAdmission: () => void
    closeTerminalsForRestart: () => Promise<number>
    /** Can the installed bundle start a daemon? Run before a self-started handoff. */
    preflightReplacement: () => Promise<boolean>
    /** Tear this daemon down and start the installed bundle's daemon. */
    handOff: () => Promise<void>
    /** Shut this daemon down without a replacement (`stop` with nobody waiting). */
    shutdown: () => void
    publishLifecycle: () => void
    happyHomeDir: string
    cliVersion: string
    log: (message: string) => void
    env?: NodeJS.ProcessEnv
    tickIntervalMs?: number
}

export function createDaemonRestartDrainRuntime(input: DaemonRestartDrainRuntimeInput) {
    const now = input.now ?? Date.now
    const caps = readHandoffCaps(input.env)
    let pendingHandoff: PendingHandoff | null = null
    // A ready drain is only final once the daemon actually stops or hands off: a lapsed
    // lease or a failed preflight can still call it off, and then nothing may have closed
    // terminals or written a `ready` outcome line.
    let readySettlement: RestartDrainSettlement | null = null
    let finalizing: Promise<void> | null = null
    let tickTimer: ReturnType<typeof setInterval> | null = null
    let handingOff = false

    const record = (settlement: RestartDrainSettlement, closedTerminalCount: number) => {
        appendRestartDrainOutcome(
            input.happyHomeDir,
            buildRestartDrainOutcomeRecord({ settlement, closedTerminalCount, at: now(), cliVersion: input.cliVersion }),
            input.log,
        )
    }

    const stopTicking = () => {
        if (tickTimer) clearInterval(tickTimer)
        tickTimer = null
    }

    const controller: RestartDrainController = new RestartDrainController({
        now,
        activity: input.activity,
        env: input.env,
        closeAdmission: (deadlineAt) => {
            input.closeAdmission(deadlineAt)
            if (!tickTimer) {
                tickTimer = setInterval(() => controller.tick(), input.tickIntervalMs ?? 1_000)
                tickTimer.unref?.()
            }
        },
        reopenAdmission: () => {
            stopTicking()
            input.reopenAdmission()
        },
        onReady: (settlement) => {
            input.log(`[RESTART_DRAIN] ready (${settlement.outcome}) reason=${settlement.view.reason} trigger=${settlement.view.trigger}`)
            readySettlement = settlement
            finalizing = null
        },
        onSelfComplete: (view) => {
            // Never inside the call that reached ready (it may be answering an HTTP request).
            setTimeout(() => { void selfComplete(view) }, 0)
        },
        onCancelled: (settlement, cause) => {
            // Called off after ready: that ready was never final — one line, `cancelled`.
            readySettlement = null
            finalizing = null
            if (cause === 'lease') input.log(`[RESTART_DRAIN] drain-abandoned: nobody renewed the lease; admission reopened (reason=${settlement.view.reason})`)
            else input.log(`[RESTART_DRAIN] cancelled (${cause}); admission reopened`)
            record(settlement, 0)
        },
        onChange: () => input.publishLifecycle(),
    })

    /**
     * The point of no return for a ready drain: close the daemon terminals while the socket is
     * still up, so each close says why (R23), and write the outcome line (R26). Idempotent.
     */
    function finalizeReady(): Promise<void> {
        const settlement = readySettlement
        if (!settlement) return Promise.resolve()
        finalizing ??= (async () => {
            let closed = 0
            try {
                closed = await input.closeTerminalsForRestart()
            } catch (error) {
                input.log(`[RESTART_DRAIN] closing terminals failed: ${(error as Error)?.message ?? 'unknown'}`)
            }
            record(settlement, closed)
            readySettlement = null
        })()
        return finalizing
    }

    async function selfComplete(view: RestartDrainView): Promise<void> {
        if (view.intent === 'stop') {
            input.log('[RESTART_DRAIN] stop drain finished with nobody waiting; shutting down')
            await finalizeReady()
            input.shutdown()
            return
        }
        // Handoff and SIGHUP preflight before opening the drain; a requested restart whose
        // caller vanished has not been preflighted yet.
        if (view.trigger === 'request' && !(await input.preflightReplacement())) {
            input.log('[RESTART_DRAIN] replacement preflight failed; keeping this daemon')
            controller.cancel()
            return
        }
        if (handingOff) return
        handingOff = true
        stopTicking()
        await finalizeReady()
        await input.handOff()
    }

    async function beginPreflighted(request: RestartDrainBeginRequest): Promise<RestartDrainView | null> {
        if (!(await input.preflightReplacement())) {
            input.log('[DAEMON RUN] New daemon bundle preflight failed; keeping current daemon running')
            return null
        }
        // A handoff decided before the await must not join a drain that opened meanwhile: joining would make a
        // requested stop (e.g. account-switch) restart this daemon instead. The next heartbeat decides again.
        if (request.trigger !== 'signal' && controller.isAdmissionClosed()) {
            input.log('[DAEMON RUN] Another restart drain opened during the handoff preflight; leaving it to that drain')
            return controller.current()
        }
        const result = controller.begin(request)
        return result.ok ? result.view : null
    }

    const controlPort: RestartDrainControlPort = {
        instanceId: input.instanceId,
        begin: (request) => controller.begin(request),
        status: (operationId) => controller.status(operationId),
        stopBlocked: () => controller.isDraining(),
        handingOff: () => handingOff || controller.isSelfCompleting(),
    }

    return {
        controller,
        controlPort,
        /** Awaited by shutdown: a ready drain closes its terminals and writes its outcome line first. */
        finalizeReady,
        isAdmissionClosed: () => controller.isAdmissionClosed(),
        pendingHandoff: () => pendingHandoff,
        lifecycle: (): DaemonRestartLifecycle => buildRestartLifecycle(controller.current(), pendingHandoff),

        /**
         * One heartbeat of the bundle handoff (R4·R25), before this beat's automation
         * ticks. Answers whether the ticks may run.
         */
        async heartbeat(bundleReplaced: boolean): Promise<'run-automations' | 'hold-automations'> {
            const at = now()
            const activity = input.activity()
            if (!bundleReplaced) {
                if (pendingHandoff) {
                    pendingHandoff = null
                    input.publishLifecycle()
                }
            } else if (!pendingHandoff) {
                pendingHandoff = { detectedAt: at, busyTerminalCount: activity.busyTerminalCount, forceAvailable: false }
                input.log('[DAEMON RUN] Daemon bundle replaced on disk; waiting for a quiet moment to hand off')
                input.publishLifecycle()
            } else if (pendingHandoff.busyTerminalCount !== activity.busyTerminalCount) {
                pendingHandoff = { ...pendingHandoff, busyTerminalCount: activity.busyTerminalCount }
                input.publishLifecycle()
            }

            const step = decideHandoffStep({
                bundleReplaced,
                pending: pendingHandoff,
                now: at,
                inTurnCount: activity.inTurnCount,
                automationCount: activity.automationCount,
                busyTerminalCount: activity.busyTerminalCount,
                drainOpen: controller.isAdmissionClosed(),
                ...caps,
            })
            const base = { reason: 'bundle-replaced' as const, intent: 'restart' as const, leaseSeconds: 0 }
            switch (step) {
                case 'try-now':
                    await beginPreflighted({ ...base, trigger: 'handoff-prewait', graceSeconds: 0 })
                    break
                case 'begin-cap-drain':
                    input.log('[DAEMON RUN] Handoff pre-wait cap reached; draining before the handoff')
                    await beginPreflighted({ ...base, trigger: 'handoff-cap' })
                    break
                case 'publish-force-available':
                    if (pendingHandoff) pendingHandoff = { ...pendingHandoff, forceAvailable: true }
                    input.log('[DAEMON RUN] Handoff terminal cap reached; the next heartbeat drains (terminals wait up to grace)')
                    input.publishLifecycle()
                    break
                case 'begin-terminal-cap-drain':
                    await beginPreflighted({ ...base, trigger: 'handoff-terminal-cap' })
                    break
                case 'prewait':
                case 'none':
                    break
            }
            return controller.isAdmissionClosed() ? 'hold-automations' : 'run-automations'
        },

        /** R25 "지금 교대": only hastens a handoff that is already pending. */
        async forceHandoff(): Promise<ForceHandoffResult> {
            if (!pendingHandoff) return { ok: false, code: 'no-pending-handoff' }
            const current = controller.current()
            // Only the handoff's own drain is hastened; a requested drain (account-switch …) keeps its grace.
            if (current?.state === 'draining' && current.trigger.startsWith('handoff')) {
                const forced = controller.force()
                return { ok: true, deadlineAt: forced?.deadlineAt ?? now() }
            }
            if (current) return { ok: true, deadlineAt: current.deadlineAt }
            const begun = await beginPreflighted({
                reason: 'bundle-replaced', intent: 'restart', trigger: 'handoff-terminal-cap', force: true, leaseSeconds: 0,
            })
            return begun ? { ok: true, deadlineAt: begun.deadlineAt } : { ok: false, code: 'replacement-unavailable' }
        },

        /** R20: SIGHUP is a self-completing restart; it never forces. */
        async sighup(): Promise<void> {
            const request = { reason: 'signal' as const, intent: 'restart' as const, trigger: 'signal' as const, leaseSeconds: 0 }
            if (controller.isAdmissionClosed()) {
                controller.begin(request)
                return
            }
            await beginPreflighted(request)
        },

        dispose: stopTicking,
    }
}

export type DaemonRestartDrainRuntime = ReturnType<typeof createDaemonRestartDrainRuntime>
