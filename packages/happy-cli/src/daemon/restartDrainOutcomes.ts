/**
 * Restart drain outcome ledger (aplus specs/codexcli-daemon-restart-drain R26).
 *
 * One line per finished drain — the measurement that decides whether the held
 * Phase 3·4 (restart snapshot, interruption records) are ever needed: how
 * often a drain hit its grace with turns still in flight, split by whether the
 * sessions then survived (`kept`) or were stopped (`stopped`, only the
 * standalone app update).
 *
 * Deliberately carries nothing identifying: no session ids, folders, accounts,
 * prompts or secrets — only counts, durations, reason and version. A failed
 * write is logged and never blocks the restart.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
    RestartDrainIntent,
    RestartDrainOutcome,
    RestartDrainReason,
    RestartDrainSettlement,
    RestartDrainTrigger,
} from './restartDrain'

export const RESTART_DRAIN_OUTCOMES_FILE = 'restart-drain-outcomes.jsonl'
export const MAX_RESTART_DRAIN_OUTCOME_LINES = 500

export interface RestartDrainOutcomeRecord {
    version: 1
    at: number
    reason: RestartDrainReason
    intent: RestartDrainIntent
    trigger: RestartDrainTrigger
    outcome: RestartDrainOutcome
    graceSeconds: number
    waitedMs: number
    inTurnCountAtStart: number
    inTurnCountAtDeadline?: number
    busyTerminalCountAtDeadline?: number
    closedTerminalCount: number
    sessionsAfter: 'kept' | 'stopped'
    cliVersion: string
}

/** Only the standalone app update stops sessions after its drain; every other restart keeps them. */
export function sessionsAfterForReason(reason: RestartDrainReason): 'kept' | 'stopped' {
    return reason === 'app-update' ? 'stopped' : 'kept'
}

export function buildRestartDrainOutcomeRecord(input: {
    settlement: RestartDrainSettlement
    closedTerminalCount: number
    at: number
    cliVersion: string
}): RestartDrainOutcomeRecord {
    const { settlement } = input
    return {
        version: 1,
        at: input.at,
        reason: settlement.view.reason,
        intent: settlement.view.intent,
        trigger: settlement.view.trigger,
        outcome: settlement.outcome,
        graceSeconds: settlement.graceSeconds,
        waitedMs: settlement.waitedMs,
        inTurnCountAtStart: settlement.inTurnCountAtStart,
        ...(settlement.inTurnCountAtDeadline !== undefined ? { inTurnCountAtDeadline: settlement.inTurnCountAtDeadline } : {}),
        ...(settlement.busyTerminalCountAtDeadline !== undefined
            ? { busyTerminalCountAtDeadline: settlement.busyTerminalCountAtDeadline }
            : {}),
        closedTerminalCount: input.closedTerminalCount,
        sessionsAfter: sessionsAfterForReason(settlement.view.reason),
        cliVersion: input.cliVersion,
    }
}

/** The structured log line, greppable as `[RESTART_DRAIN]` even after log rotation dropped the rest. */
export function formatRestartDrainOutcomeLog(record: RestartDrainOutcomeRecord): string {
    const fields: string[] = [
        `outcome=${record.outcome}`,
        `reason=${record.reason}`,
        `intent=${record.intent}`,
        `trigger=${record.trigger}`,
        `graceSeconds=${record.graceSeconds}`,
        `waitedMs=${record.waitedMs}`,
        `inTurnAtStart=${record.inTurnCountAtStart}`,
    ]
    if (record.inTurnCountAtDeadline !== undefined) fields.push(`inTurnAtDeadline=${record.inTurnCountAtDeadline}`)
    if (record.busyTerminalCountAtDeadline !== undefined) fields.push(`busyTerminalsAtDeadline=${record.busyTerminalCountAtDeadline}`)
    fields.push(`closedTerminals=${record.closedTerminalCount}`, `sessionsAfter=${record.sessionsAfter}`, `cliVersion=${record.cliVersion}`)
    return `[RESTART_DRAIN] ${fields.join(' ')}`
}

/**
 * Synchronous on purpose: the record is written right before teardown or exit.
 * Keeps the newest {@link MAX_RESTART_DRAIN_OUTCOME_LINES} lines, rewriting
 * the file atomically once it grows past that.
 */
export function appendRestartDrainOutcome(
    happyHomeDir: string,
    record: RestartDrainOutcomeRecord,
    log: (message: string) => void,
): boolean {
    log(formatRestartDrainOutcomeLog(record))
    const path = join(happyHomeDir, RESTART_DRAIN_OUTCOMES_FILE)
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
        chmodSync(path, 0o600)
        const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
        if (lines.length > MAX_RESTART_DRAIN_OUTCOME_LINES) {
            const tmp = `${path}.${process.pid}.tmp`
            try {
                writeFileSync(tmp, `${lines.slice(-MAX_RESTART_DRAIN_OUTCOME_LINES).join('\n')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'w' })
                renameSync(tmp, path)
            } catch (error) {
                rmSync(tmp, { force: true })
                throw error
            }
        }
        return true
    } catch (error) {
        log(`[RESTART_DRAIN] outcome ledger write failed: ${(error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? 'unknown'}`)
        return false
    }
}
