/**
 * Pure retention planning for the Happy log directory. Filesystem scanning and
 * deletion are kept outside this module so age/size/count ordering is fully
 * deterministic and independently testable.
 */

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export interface LogHousekeepingPolicy {
  maxAgeMs: number
  maxTotalBytes: number
  maxFiles: number
  protectRecentMs: number
}

export interface LogFileCandidate {
  path: string
  modifiedAt: number
  size: number
  current: boolean
}

export const DEFAULT_LOG_HOUSEKEEPING_POLICY: LogHousekeepingPolicy = {
  maxAgeMs: 14 * DAY_MS,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxFiles: 2_000,
  protectRecentMs: HOUR_MS,
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function readLogHousekeepingPolicy(env: NodeJS.ProcessEnv): LogHousekeepingPolicy {
  return {
    maxAgeMs: readPositiveInteger(
      env.HAPPY_LOG_MAX_AGE_DAYS,
      DEFAULT_LOG_HOUSEKEEPING_POLICY.maxAgeMs / DAY_MS,
    ) * DAY_MS,
    maxTotalBytes: readPositiveInteger(
      env.HAPPY_LOG_MAX_TOTAL_BYTES,
      DEFAULT_LOG_HOUSEKEEPING_POLICY.maxTotalBytes,
    ),
    maxFiles: readPositiveInteger(
      env.HAPPY_LOG_MAX_FILES,
      DEFAULT_LOG_HOUSEKEEPING_POLICY.maxFiles,
    ),
    protectRecentMs: DEFAULT_LOG_HOUSEKEEPING_POLICY.protectRecentMs,
  }
}

export function isHappyLogFileName(fileName: string): boolean {
  return /\.log(?:\.\d+)?$/.test(fileName)
}

export function planLogPruning(
  candidates: readonly LogFileCandidate[],
  now: number,
  policy: LogHousekeepingPolicy,
): string[] {
  const inactive = candidates
    .filter(candidate => !candidate.current && now - candidate.modifiedAt >= policy.protectRecentMs)
    .sort((left, right) => left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path))
  const expired = inactive.filter(candidate => now - candidate.modifiedAt > policy.maxAgeMs)
  const retained = inactive.filter(candidate => now - candidate.modifiedAt <= policy.maxAgeMs)
  const deletions = expired.map(candidate => candidate.path)
  let retainedBytes = retained.reduce((total, candidate) => total + candidate.size, 0)

  while (retainedBytes > policy.maxTotalBytes || retained.length > policy.maxFiles) {
    const oldest = retained.shift()
    if (!oldest) break
    retainedBytes -= oldest.size
    deletions.push(oldest.path)
  }

  return deletions
}
