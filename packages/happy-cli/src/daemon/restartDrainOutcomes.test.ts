import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RestartDrainSettlement } from './restartDrain'
import {
    appendRestartDrainOutcome,
    buildRestartDrainOutcomeRecord,
    MAX_RESTART_DRAIN_OUTCOME_LINES,
    RESTART_DRAIN_OUTCOMES_FILE,
    sessionsAfterForReason,
} from './restartDrainOutcomes'

function settlement(overrides: Partial<RestartDrainSettlement> = {}, view: Partial<RestartDrainSettlement['view']> = {}): RestartDrainSettlement {
    return {
        view: {
            version: 1, operationId: 'op-secret-should-not-leak', state: 'ready', intent: 'stop', reason: 'app-update',
            trigger: 'request', inTurnCount: 1, openTerminalCount: 0, busyTerminalCount: 0, deadlineAt: 2, ...view,
        },
        outcome: 'deadline', graceSeconds: 60, startedAt: 1, waitedMs: 60_012, inTurnCountAtStart: 2,
        inTurnCountAtDeadline: 1, busyTerminalCountAtDeadline: 0, ...overrides,
    }
}

describe('restart drain outcome ledger (R26)', () => {
    it('maps sessionsAfter by reason: only app-update stops sessions', () => {
        expect(sessionsAfterForReason('app-update')).toBe('stopped')
        for (const reason of ['bundle-replaced', 'version-mismatch', 'desktop-version-match', 'env-reapply', 'user-restart', 'account-switch', 'signal'] as const) {
            expect(sessionsAfterForReason(reason)).toBe('kept')
        }
    })

    it.each(['idle', 'deadline', 'force', 'cancelled'] as const)('records outcome %s with its trigger', (outcome) => {
        const record = buildRestartDrainOutcomeRecord({
            settlement: settlement({ outcome }, { trigger: 'handoff-cap', reason: 'bundle-replaced', intent: 'restart' }),
            closedTerminalCount: 1, at: 99, cliVersion: '1.1.10-aplus.360',
        })
        expect(record).toMatchObject({ version: 1, outcome, trigger: 'handoff-cap', reason: 'bundle-replaced', sessionsAfter: 'kept', closedTerminalCount: 1 })
    })

    it('writes one 0600 line per drain plus a [RESTART_DRAIN] log line, without identifying values', () => {
        const home = mkdtempSync(join(tmpdir(), 'drain-outcomes-'))
        const log = vi.fn()
        const record = buildRestartDrainOutcomeRecord({ settlement: settlement(), closedTerminalCount: 0, at: 5, cliVersion: '1.1.10' })
        expect(appendRestartDrainOutcome(home, record, log)).toBe(true)
        const path = join(home, RESTART_DRAIN_OUTCOMES_FILE)
        const text = readFileSync(path, 'utf8')
        expect(text.trim().split('\n')).toHaveLength(1)
        expect(JSON.parse(text)).toEqual(record)
        if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[RESTART_DRAIN\] outcome=deadline reason=app-update .*inTurnAtDeadline=1 .*sessionsAfter=stopped/))
        for (const forbidden of ['op-secret-should-not-leak', 'operationId', 'sessionId', 'directory', home]) {
            expect(text).not.toContain(forbidden)
        }
    })

    it('keeps only the newest 500 lines', () => {
        const home = mkdtempSync(join(tmpdir(), 'drain-outcomes-cap-'))
        const path = join(home, RESTART_DRAIN_OUTCOMES_FILE)
        writeFileSync(path, Array.from({ length: MAX_RESTART_DRAIN_OUTCOME_LINES }, (_, i) => JSON.stringify({ i })).join('\n') + '\n')
        appendRestartDrainOutcome(home, buildRestartDrainOutcomeRecord({ settlement: settlement(), closedTerminalCount: 0, at: 7, cliVersion: 'x' }), () => {})
        const lines = readFileSync(path, 'utf8').trim().split('\n')
        expect(lines).toHaveLength(MAX_RESTART_DRAIN_OUTCOME_LINES)
        expect(JSON.parse(lines[0])).toEqual({ i: 1 })
        expect(JSON.parse(lines.at(-1)!)).toMatchObject({ at: 7 })
    })

    it('reports a failed write without throwing', () => {
        const home = mkdtempSync(join(tmpdir(), 'drain-outcomes-fail-'))
        writeFileSync(join(home, 'blocker'), '')
        const log = vi.fn()
        const ok = appendRestartDrainOutcome(join(home, 'blocker', 'nested'), buildRestartDrainOutcomeRecord({ settlement: settlement(), closedTerminalCount: 0, at: 1, cliVersion: 'x' }), log)
        expect(ok).toBe(false)
        expect(log).toHaveBeenCalledWith(expect.stringContaining('outcome ledger write failed'))
    })
})
