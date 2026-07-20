/**
 * Daemon-owned filesystem runner for log retention. Work is scheduled after
 * startup, guarded by a cross-process lock, and all failures are reported as
 * counters instead of interrupting the daemon.
 */

import { open, opendir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  isHappyLogFileName,
  planLogPruning,
  readLogHousekeepingPolicy,
  type LogFileCandidate,
  type LogHousekeepingPolicy,
} from './logHousekeeping'

const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000
const HOUSEKEEPING_LOCK_STALE_MS = 60 * 60 * 1000

export interface LogHousekeepingResult {
  skipped: boolean
  prunedFiles: number
  prunedBytes: number
  errors: number
}

async function readLastRun(markerPath: string): Promise<number | null> {
  try {
    const value = Number((await readFile(markerPath, 'utf8')).trim())
    return Number.isFinite(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}

async function acquireHousekeepingLock(lockPath: string, now: number) {
  try {
    return await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    try {
      const lockStat = await stat(lockPath)
      if (now - lockStat.mtimeMs <= HOUSEKEEPING_LOCK_STALE_MS) return null
      await unlink(lockPath)
      return await open(lockPath, 'wx', 0o600)
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw retryError
    }
  }
}

export async function runLogHousekeepingOnce(input: {
  logsDir: string
  currentLogPath: string
  now?: number
  intervalMs?: number
  policy?: LogHousekeepingPolicy
}): Promise<LogHousekeepingResult> {
  const now = input.now ?? Date.now()
  const intervalMs = input.intervalMs ?? HOUSEKEEPING_INTERVAL_MS
  const markerPath = join(input.logsDir, '.housekeeping.timestamp')
  const lockPath = join(input.logsDir, '.housekeeping.lock')
  const lastRun = await readLastRun(markerPath)
  if (lastRun !== null && now - lastRun < intervalMs) {
    return { skipped: true, prunedFiles: 0, prunedBytes: 0, errors: 0 }
  }

  let lockHandle: Awaited<ReturnType<typeof open>> | null = null
  try {
    lockHandle = await acquireHousekeepingLock(lockPath, now)
    if (!lockHandle) return { skipped: true, prunedFiles: 0, prunedBytes: 0, errors: 0 }

    const candidates: LogFileCandidate[] = []
    const directory = await opendir(input.logsDir)
    for await (const entry of directory) {
      if (!entry.isFile() || !isHappyLogFileName(entry.name)) continue
      const path = join(input.logsDir, entry.name)
      const fileStat = await stat(path)
      candidates.push({
        path,
        modifiedAt: fileStat.mtimeMs,
        size: fileStat.size,
        current: path === input.currentLogPath,
      })
    }

    const byPath = new Map(candidates.map(candidate => [candidate.path, candidate]))
    const deletions = planLogPruning(
      candidates,
      now,
      input.policy ?? readLogHousekeepingPolicy(process.env),
    )
    let prunedFiles = 0
    let prunedBytes = 0
    let errors = 0
    for (const path of deletions) {
      try {
        await unlink(path)
        prunedFiles += 1
        prunedBytes += byPath.get(path)?.size ?? 0
      } catch {
        errors += 1
      }
    }
    await writeFile(markerPath, String(now), { mode: 0o600 })
    return { skipped: false, prunedFiles, prunedBytes, errors }
  } catch {
    return { skipped: false, prunedFiles: 0, prunedBytes: 0, errors: 1 }
  } finally {
    await lockHandle?.close().catch(() => undefined)
    if (lockHandle) await unlink(lockPath).catch(() => undefined)
  }
}

export function startLogHousekeeping(input: {
  logsDir: string
  currentLogPath: string
  intervalMs?: number
  debug: (message: string, details: Record<string, number>) => void
}): () => void {
  const intervalMs = input.intervalMs ?? HOUSEKEEPING_INTERVAL_MS
  const run = async () => {
    const result = await runLogHousekeepingOnce({
      logsDir: input.logsDir,
      currentLogPath: input.currentLogPath,
      intervalMs,
    })
    if (!result.skipped) {
      input.debug('[LOG HOUSEKEEPING] completed', {
        prunedFiles: result.prunedFiles,
        prunedBytes: result.prunedBytes,
        errors: result.errors,
      })
    }
  }
  const initialTimer = setTimeout(() => void run(), 0)
  const intervalTimer = setInterval(() => void run(), intervalMs)
  initialTimer.unref?.()
  intervalTimer.unref?.()
  return () => {
    clearTimeout(initialTimer)
    clearInterval(intervalTimer)
  }
}
