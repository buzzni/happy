import { describe, expect, it } from 'vitest'
import { RESTART_DRAIN_REASONS } from '../restartDrain'
import { decideTerminalSurvival, readTerminalWorkerFlag, TERMINAL_WORKER_DEFAULT_ENABLED, terminalWorkersEnabled, type TerminalSurvivalInput } from './survivalDecision'

const base: TerminalSurvivalInput = {
    platform: 'darwin', workersEnabled: true, intent: 'restart', reason: 'bundle-replaced',
    installedProtocolMatches: true, recordsReadable: true,
}

describe('decideTerminalSurvival (spec HR3)', () => {
    it.each(RESTART_DRAIN_REASONS.filter((reason) => reason !== 'account-switch'))('keeps terminals on a %s restart', (reason) => {
        expect(decideTerminalSurvival({ ...base, reason })).toEqual({ terminals: 'keep' })
    })

    it.each([
        [{ reason: 'account-switch' as const }, 'account-switch'],
        [{ intent: 'stop' as const }, 'stop'],
        [{ platform: 'win32' as const }, 'windows'],
        [{ workersEnabled: false }, 'disabled'],
        [{ recordsReadable: false }, 'record-unreadable'],
        [{ installedProtocolMatches: false }, 'incompatible'],
    ])('closes them for %o with reason %s', (override, reason) => {
        expect(decideTerminalSurvival({ ...base, ...override })).toEqual({ terminals: 'close', reason })
    })

    it('a stop wins over every keep condition, Windows over all', () => {
        expect(decideTerminalSurvival({ ...base, intent: 'stop', reason: 'user-restart' })).toMatchObject({ reason: 'stop' })
        expect(decideTerminalSurvival({ ...base, platform: 'win32', intent: 'stop' })).toMatchObject({ reason: 'windows' })
    })
})

describe('readTerminalWorkerFlag (spec HR11)', () => {
    it('is opt-in in this release: 1 turns workers on, 0 is the kill switch, anything else is the default', () => {
        expect(TERMINAL_WORKER_DEFAULT_ENABLED).toBe(false)
        expect(readTerminalWorkerFlag({ HAPPY_TERMINAL_WORKER: '1' })).toBe('on')
        expect(readTerminalWorkerFlag({ HAPPY_TERMINAL_WORKER: '0' })).toBe('off-kill-switch')
        expect(readTerminalWorkerFlag({})).toBe('off-default')
        expect(readTerminalWorkerFlag({ HAPPY_TERMINAL_WORKER: 'true' })).toBe('off-default')
    })

    it('never uses workers on Windows', () => {
        expect(terminalWorkersEnabled('win32', { HAPPY_TERMINAL_WORKER: '1' })).toBe(false)
        expect(terminalWorkersEnabled('darwin', { HAPPY_TERMINAL_WORKER: '1' })).toBe(true)
        expect(terminalWorkersEnabled('linux', {})).toBe(false)
    })
})
