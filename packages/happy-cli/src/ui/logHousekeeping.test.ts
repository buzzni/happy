import { describe, expect, it } from 'vitest'

import {
  isHappyLogFileName,
  planLogPruning,
  readLogHousekeepingPolicy,
  type LogFileCandidate,
} from './logHousekeeping'

const hour = 60 * 60 * 1000
const day = 24 * hour
const now = new Date('2026-07-20T00:00:00.000Z').getTime()

function candidate(
  path: string,
  ageMs: number,
  size: number,
  current = false,
): LogFileCandidate {
  return { path, modifiedAt: now - ageMs, size, current }
}

describe('log housekeeping policy', () => {
  it('removes expired inactive logs while protecting current and recent files', () => {
    const deletions = planLogPruning([
      candidate('/logs/current.log', 30 * day, 100, true),
      candidate('/logs/recent.log', 30 * 60 * 1000, 100),
      candidate('/logs/expired.log', 15 * day, 100),
      candidate('/logs/kept.log', 10 * day, 100),
    ], now, {
      maxAgeMs: 14 * day,
      maxTotalBytes: 1_000,
      maxFiles: 10,
      protectRecentMs: hour,
    })

    expect(deletions).toEqual(['/logs/expired.log'])
  })

  it('deletes oldest inactive logs until byte and file budgets both fit', () => {
    const deletions = planLogPruning([
      candidate('/logs/oldest.log', 10 * day, 10),
      candidate('/logs/older.log', 9 * day, 10),
      candidate('/logs/newer.log', 8 * day, 10),
      candidate('/logs/newest.log', 7 * day, 10),
    ], now, {
      maxAgeMs: 30 * day,
      maxTotalBytes: 25,
      maxFiles: 2,
      protectRecentMs: hour,
    })

    expect(deletions).toEqual(['/logs/oldest.log', '/logs/older.log'])
  })

  it('recognizes current and rotated logs without touching unrelated files', () => {
    expect(isHappyLogFileName('2026-07-20-pid-1-daemon.log')).toBe(true)
    expect(isHappyLogFileName('2026-07-20-pid-1-daemon.log.3')).toBe(true)
    expect(isHappyLogFileName('.housekeeping.timestamp')).toBe(false)
    expect(isHappyLogFileName('notes.txt')).toBe(false)
  })

  it('uses the approved retention defaults for invalid overrides', () => {
    expect(readLogHousekeepingPolicy({
      HAPPY_LOG_MAX_AGE_DAYS: 'zero',
      HAPPY_LOG_MAX_TOTAL_BYTES: '-1',
      HAPPY_LOG_MAX_FILES: '0',
    })).toEqual({
      maxAgeMs: 14 * day,
      maxTotalBytes: 1024 * 1024 * 1024,
      maxFiles: 2_000,
      protectRecentMs: hour,
    })
  })
})
