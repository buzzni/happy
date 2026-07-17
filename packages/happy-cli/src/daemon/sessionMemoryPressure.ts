import { execFile } from 'node:child_process';
import os from 'node:os';

/**
 * Memory-pressure measurement for tracked session processes.
 *
 * Each tracked session is a happy-cli wrapper process whose children (the
 * Claude/Codex agent runtime) hold most of the memory, so RSS is summed over
 * each session's full process subtree from a single `ps` snapshot.
 *
 * Eviction policy knobs live here too: sessions are only evicted for memory
 * reasons when their combined RSS exceeds `budgetBytes` (high-water mark), and
 * eviction stops once the estimate drops below `lowWaterBytes` (hysteresis so
 * the daemon doesn't flap around the threshold). `maxEvictionsPerTick` bounds
 * the blast radius of a single tick in case a measurement is ever wrong.
 */

export const DEFAULT_SESSION_MEMORY_BUDGET_RATIO = 0.5;
export const DEFAULT_LOW_WATER_RATIO = 0.8;
export const DEFAULT_MAX_EVICTIONS_PER_TICK = 5;
/** Fallback RSS estimate for a session whose subtree could not be measured —
 *  deliberately generous so eviction stops sooner rather than later. */
export const DEFAULT_SESSION_RSS_FALLBACK_BYTES = 512 * 1024 * 1024;

export type SessionMemoryPressureConfig = {
  disabled: boolean;
  /** High-water mark for combined tracked-session RSS. */
  budgetBytes: number;
  /** Eviction stops once the estimated total drops below this. */
  lowWaterBytes: number;
  maxEvictionsPerTick: number;
};

export function readSessionMemoryPressureConfig(
  env: NodeJS.ProcessEnv = process.env,
  totalMemoryBytes: number = os.totalmem(),
): SessionMemoryPressureConfig {
  const budgetMb = parsePositiveNumber(env.HAPPY_DAEMON_SESSION_MEMORY_BUDGET_MB);
  const budgetBytes = budgetMb !== undefined
    ? budgetMb * 1024 * 1024
    : Math.floor(totalMemoryBytes * DEFAULT_SESSION_MEMORY_BUDGET_RATIO);
  const lowWaterMb = parsePositiveNumber(env.HAPPY_DAEMON_SESSION_MEMORY_LOW_WATER_MB);
  const lowWaterBytes = lowWaterMb !== undefined
    ? Math.min(lowWaterMb * 1024 * 1024, budgetBytes)
    : Math.floor(budgetBytes * DEFAULT_LOW_WATER_RATIO);
  const maxEvictionsPerTick = parsePositiveNumber(env.HAPPY_DAEMON_SESSION_EVICT_MAX_PER_TICK)
    ?? DEFAULT_MAX_EVICTIONS_PER_TICK;
  return {
    disabled: ['1', 'true', 'yes'].includes(env.HAPPY_DAEMON_SESSION_PRESSURE_EVICTION_DISABLED?.toLowerCase() ?? ''),
    budgetBytes,
    lowWaterBytes,
    maxEvictionsPerTick,
  };
}

export type SessionRssMeasurement = {
  totalBytes: number;
  bytesByRootPid: Map<number, number>;
};

/**
 * Sum subtree RSS per root pid from `ps -axo pid=,ppid=,rss=` output (rss is
 * reported in KiB on both darwin and linux). A pid that appears under two
 * roots (impossible in a real process tree) is counted once, toward the first
 * root that reaches it.
 */
export function sumSubtreeRss(psOutput: string, rootPids: readonly number[]): SessionRssMeasurement {
  const childrenByPpid = new Map<number, number[]>();
  const rssByPid = new Map<number, number>();

  for (const line of psOutput.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rssKib = Number(parts[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rssKib)) continue;
    rssByPid.set(pid, rssKib * 1024);
    const siblings = childrenByPpid.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenByPpid.set(ppid, [pid]);
  }

  const claimed = new Set<number>();
  const bytesByRootPid = new Map<number, number>();
  let totalBytes = 0;

  for (const rootPid of rootPids) {
    if (!rssByPid.has(rootPid)) continue;
    let subtreeBytes = 0;
    const queue = [rootPid];
    while (queue.length > 0) {
      const pid = queue.pop()!;
      if (claimed.has(pid)) continue;
      claimed.add(pid);
      subtreeBytes += rssByPid.get(pid) ?? 0;
      for (const child of childrenByPpid.get(pid) ?? []) queue.push(child);
    }
    bytesByRootPid.set(rootPid, subtreeBytes);
    totalBytes += subtreeBytes;
  }

  return { totalBytes, bytesByRootPid };
}

/**
 * Measure combined subtree RSS for the given root pids. Returns null when the
 * snapshot cannot be taken — callers must treat that as "pressure unknown" and
 * skip eviction (fail closed: no measurement, no kills).
 */
export async function measureSessionRss(rootPids: readonly number[]): Promise<SessionRssMeasurement | null> {
  if (rootPids.length === 0) return { totalBytes: 0, bytesByRootPid: new Map() };
  try {
    const psOutput = await new Promise<string>((resolve, reject) => {
      execFile('ps', ['-axo', 'pid=,ppid=,rss='], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    return sumSubtreeRss(psOutput, rootPids);
  } catch {
    return null;
  }
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
