import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { runLogHousekeepingOnce, startLogHousekeeping } from './logHousekeepingRunner'

const hour = 60 * 60 * 1000
const day = 24 * hour
const now = new Date('2026-07-20T00:00:00.000Z').getTime()

function writeAgedFile(path: string, ageMs: number, contents = 'log'): void {
  writeFileSync(path, contents)
  const modifiedAt = new Date(now - ageMs)
  utimesSync(path, modifiedAt, modifiedAt)
}

describe('log housekeeping runner', () => {
  it('prunes only planned files and skips a second run inside six hours', async () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'happy-log-housekeeping-'))
    const currentLogPath = join(logsDir, 'current-daemon.log')
    const expiredLogPath = join(logsDir, 'expired.log')
    const recentLogPath = join(logsDir, 'recent.log')
    writeAgedFile(currentLogPath, 30 * day)
    writeAgedFile(expiredLogPath, 15 * day, 'expired bytes')
    writeAgedFile(recentLogPath, 30 * 60 * 1000)

    const first = await runLogHousekeepingOnce({ logsDir, currentLogPath, now })
    const second = await runLogHousekeepingOnce({ logsDir, currentLogPath, now: now + hour })

    expect(first).toEqual({ skipped: false, prunedFiles: 1, prunedBytes: 13, errors: 0 })
    expect(existsSync(currentLogPath)).toBe(true)
    expect(existsSync(recentLogPath)).toBe(true)
    expect(existsSync(expiredLogPath)).toBe(false)
    expect(second).toEqual({ skipped: true, prunedFiles: 0, prunedBytes: 0, errors: 0 })
  })

  it('fails open when the log directory cannot be scanned', async () => {
    await expect(runLogHousekeepingOnce({
      logsDir: join(tmpdir(), 'happy-logs-do-not-exist'),
      currentLogPath: '/missing/current.log',
      now,
    })).resolves.toEqual({ skipped: false, prunedFiles: 0, prunedBytes: 0, errors: 1 })
  })

  it('starts asynchronously and exposes a stop function for daemon shutdown', () => {
    vi.useFakeTimers()
    const logsDir = mkdtempSync(join(tmpdir(), 'happy-log-housekeeping-start-'))
    const debug = vi.fn()

    const stop = startLogHousekeeping({
      logsDir,
      currentLogPath: join(logsDir, 'daemon.log'),
      intervalMs: 6 * hour,
      debug,
    })

    expect(debug).not.toHaveBeenCalled()
    expect(stop).toBeTypeOf('function')
    stop()
    vi.useRealTimers()
  })
})
