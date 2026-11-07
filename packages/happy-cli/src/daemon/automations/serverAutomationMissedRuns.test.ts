import { describe, expect, it } from 'vitest'
import { MAX_COUNTED_MISSED_RUNS, planMissedRuns, type MissedRunPlanInput } from './serverAutomationMissedRuns'
import type { AutomationSchedule } from './automationDomain'

// aplus-dev-studio specs/scheduled-missed-run-policy R4·R6·R7 — the pure slot count behind one missed row.

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function plan(schedule: AutomationSchedule, nextRunAt: number, now: number, patch: Partial<MissedRunPlanInput> = {}) {
  return planMissedRuns({
    schedule, nextRunAt, now, enabledAt: 0, paused: false, runRequestedAt: null, githubTrigger: false, ...patch,
  })
}

describe('planMissedRuns', () => {
  const now = Date.UTC(2026, 10, 7, 9, 0)

  it('counts every interval slot of the gap from the first missed one', () => {
    const first = now - 8 * HOUR - 5 * MINUTE
    // 8h05m at 30 minutes: the first slot plus 16 more before now; the grid resumes 25 minutes from now.
    expect(plan({ kind: 'interval', minutes: 30 }, first, now)).toEqual({
      firstMissedAt: first, missedCount: 17, capped: false, resumeAt: now + 25 * MINUTE,
    })
  })

  it('leaves a slot still inside the 90 second claim window to the claim', () => {
    const schedule = { kind: 'interval' as const, minutes: 15 }
    expect(plan(schedule, now - 90_000, now)).toBeNull()
    expect(plan(schedule, now - 30_000, now)).toBeNull()
    expect(plan(schedule, now + MINUTE, now)).toBeNull()
    expect(plan(schedule, now - 90_001, now)).toEqual({
      firstMissedAt: now - 90_001, missedCount: 1, capped: false, resumeAt: now - 90_001 + 15 * MINUTE,
    })
  })

  it('stops counting at the cap and marks the count as a lower bound', () => {
    const first = now - 30 * 24 * HOUR
    // The latest slot is still found by arithmetic, not lost behind the cap.
    expect(plan({ kind: 'interval', minutes: 1 }, first, now)).toEqual({
      firstMissedAt: first, missedCount: MAX_COUNTED_MISSED_RUNS, capped: true, resumeAt: now - MINUTE,
    })
    // Calendar schedules walk slot by slot and stop at the same cap.
    const daily = plan({ kind: 'daily-zoned', hour: 9, minute: 0, timeZone: 'UTC' }, now - 1500 * 24 * HOUR, now)
    expect(daily).toEqual({
      firstMissedAt: now - 1500 * 24 * HOUR, missedCount: MAX_COUNTED_MISSED_RUNS, capped: true, resumeAt: now,
    })
  })

  it('walks daily and weekly calendars', () => {
    const daily = { kind: 'daily-zoned' as const, hour: 9, minute: 0, timeZone: 'Asia/Seoul' }
    const sevenDaysAgo = Date.UTC(2026, 9, 31, 0, 0) // 2026-10-31 09:00 KST
    const at = Date.UTC(2026, 10, 7, 0, 30) // 2026-11-07 09:30 KST
    expect(plan(daily, sevenDaysAgo, at)).toEqual({
      firstMissedAt: sevenDaysAgo, missedCount: 8, capped: false, resumeAt: Date.UTC(2026, 10, 8, 0, 0),
    })

    // Mondays and Wednesdays from Monday 2026-10-26 to Thursday 2026-11-05 → 26, 28, 2, 4.
    const weekly = { kind: 'weekly-zoned' as const, days: [1, 3], hour: 9, minute: 0, timeZone: 'UTC' }
    expect(plan(weekly, Date.UTC(2026, 9, 26, 9), Date.UTC(2026, 10, 5, 12))).toMatchObject({ missedCount: 4 })
  })

  it('counts each local day once across a daylight saving change', () => {
    // 02:30 does not exist in New York on 2026-03-08; that day's slot moves to 03:30 EDT.
    const schedule = { kind: 'daily-zoned' as const, hour: 2, minute: 30, timeZone: 'America/New_York' }
    const first = Date.UTC(2026, 2, 7, 7, 30) // 2026-03-07 02:30 EST
    expect(plan(schedule, first, Date.UTC(2026, 2, 9, 12))).toMatchObject({ firstMissedAt: first, missedCount: 3, capped: false })
    // And on the fall-back day the repeated 01:30 still runs once.
    const fallBack = { kind: 'daily-zoned' as const, hour: 1, minute: 30, timeZone: 'America/New_York' }
    expect(plan(fallBack, Date.UTC(2026, 9, 31, 5, 30), Date.UTC(2026, 10, 2, 12))).toMatchObject({ missedCount: 3 })
  })

  it('hands a slot still inside the claim window back to the claim instead of writing it off', () => {
    // Asleep overnight, awake 30 seconds after today's 09:00: yesterday is missed, today still runs.
    const daily = { kind: 'daily-zoned' as const, hour: 9, minute: 0, timeZone: 'UTC' }
    const awake = Date.UTC(2026, 10, 7, 9, 0, 30)
    expect(plan(daily, Date.UTC(2026, 10, 6, 9), awake)).toEqual({
      firstMissedAt: Date.UTC(2026, 10, 6, 9), missedCount: 1, capped: false, resumeAt: Date.UTC(2026, 10, 7, 9),
    })
  })

  it('treats a missed one-time schedule as a single slot', () => {
    const once = { kind: 'once-zoned' as const, date: '2026-11-06', hour: 9, minute: 0, timeZone: 'UTC' }
    expect(plan(once, Date.UTC(2026, 10, 6, 9), now)).toEqual({
      firstMissedAt: Date.UTC(2026, 10, 6, 9), missedCount: 1, capped: false, resumeAt: null,
    })
  })

  it('counts nothing for pause, run-now requests, GitHub triggers, slots before enabledAt or a spent schedule', () => {
    const schedule = { kind: 'interval' as const, minutes: 15 }
    const first = now - 3 * HOUR
    expect(plan(schedule, first, now, { paused: true })).toBeNull()
    expect(plan(schedule, first, now, { runRequestedAt: first })).toBeNull()
    expect(plan(schedule, first, now, { githubTrigger: true })).toBeNull()
    expect(plan({ kind: 'github', minutes: 15 }, first, now)).toBeNull()
    expect(plan(schedule, first, now, { enabledAt: first + 1 })).toBeNull()
    expect(plan(schedule, Number.MAX_SAFE_INTEGER, now)).toBeNull()
    // A run-now request postponed behind a still-running session keeps its identity while it waits.
    expect(plan(schedule, first, now, { runRequestedAt: first - 30 * MINUTE, deferredRunRequestAt: first - 30 * MINUTE })).toBeNull()
    // A run-now request for another instant does not hide the stale regular slot.
    expect(plan(schedule, first, now, { runRequestedAt: first - HOUR })).toMatchObject({ missedCount: 12 })
  })
})
