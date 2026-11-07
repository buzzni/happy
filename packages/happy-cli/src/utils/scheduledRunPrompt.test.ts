import { describe, expect, it } from 'vitest'
import { buildScheduledRunPrompt } from './scheduledRunPrompt'

// Saycode specs/scheduled-missed-run-policy R1: the run-time line sits right before `Original task:`.
function runTimeLine(prompt: string): string {
    const lines = prompt.split('\n')
    const index = lines.indexOf('Original task:')
    expect(index).toBeGreaterThan(0)
    return lines[index - 1]!
}

describe('buildScheduledRunPrompt', () => {
    it('puts the actual run time of the occurrence right before the original task', () => {
        const prompt = buildScheduledRunPrompt('Report', { at: Date.UTC(2026, 10, 7, 0, 20, 59), timeZone: 'Asia/Seoul' })
        expect(runTimeLine(prompt)).toBe('[CURRENT RUN TIME: Saturday, 2026-11-07 09:20 (Asia/Seoul, UTC+09:00)]')
        expect(prompt.endsWith('Original task:\n\nReport')).toBe(true)
        expect(prompt.match(/\[CURRENT RUN TIME:/g)).toHaveLength(1)
    })

    it.each([
        // America/New_York switches to daylight time at 2026-03-08 02:00 local (07:00 UTC).
        [Date.UTC(2026, 2, 8, 6, 30), 'America/New_York', 'Sunday, 2026-03-08 01:30 (America/New_York, UTC-05:00)'],
        [Date.UTC(2026, 2, 8, 7, 30), 'America/New_York', 'Sunday, 2026-03-08 03:30 (America/New_York, UTC-04:00)'],
        [Date.UTC(2026, 10, 6, 18, 45), 'Asia/Kathmandu', 'Saturday, 2026-11-07 00:30 (Asia/Kathmandu, UTC+05:45)'],
        [Date.UTC(2026, 0, 1, 0, 5), 'UTC', 'Thursday, 2026-01-01 00:05 (UTC, UTC+00:00)'],
    ])('formats %s in %s with its UTC offset and a 24-hour clock', (at, timeZone, expected) => {
        expect(runTimeLine(buildScheduledRunPrompt('task', { at, timeZone }))).toBe(`[CURRENT RUN TIME: ${expected}]`)
    })

    it.each([undefined, 'Not/AZone'])('falls back to the machine time zone when the schedule has none (%s)', (timeZone) => {
        const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone
        const at = Date.UTC(2026, 10, 7, 0, 20)
        expect(runTimeLine(buildScheduledRunPrompt('task', { at, timeZone })))
            .toBe(runTimeLine(buildScheduledRunPrompt('task', { at, timeZone: machineZone })))
        expect(runTimeLine(buildScheduledRunPrompt('task', { at, timeZone }))).toContain(`(${machineZone}, UTC`)
    })
})
