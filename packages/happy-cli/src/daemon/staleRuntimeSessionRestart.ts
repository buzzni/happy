/**
 * Retire session processes still running an older CLI after the daemon was updated
 * (aplus specs/stale-runtime-session-restart).
 *
 * Session processes are detached and outlive a daemon restart, so a fix shipped in a new
 * runtime never reached a conversation that stayed open across the update (2026-11-07: a .388
 * process kept refusing exhausted-account starts long after the daemon became .394).
 *
 * The daemon only stops such a process while it is idle; the client's next input resumes the
 * conversation through `resume-happy-session`, which carries the caller's MCP grant, project
 * environment and folder scope — a daemon-side respawn would have none of them. The stop is the
 * same resumable SIGTERM the idle reapers use.
 */
import { DEFAULT_IDLE_STOP_PRESENCE_STALE_MS, DEFAULT_SESSION_IDLE_REAPER_BATCH_MAX, type StopSessionContext, type StopSessionResult } from './sessionIdleReaper';
import type { TrackedSession } from './types';

/** Idle time after the last turn end / user input before a stale session is stopped. Covers a
 *  user typing the next prompt right after a reply, and the ≤2s lag of the busy report. */
export const DEFAULT_STALE_RUNTIME_RESTART_QUIET_MS = 60 * 1000;

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-aplus\.(\d+))?$/;

/** True only when both versions parse and `session` sorts strictly before `daemon` (semver: a
 *  prerelease sorts before its release). A newer child — spawned from a bundle replaced on disk
 *  under a daemon that has not restarted yet — is never treated as stale. */
export function isOlderRuntimeVersion(session: string | undefined, daemon: string): boolean {
  const a = session ? VERSION.exec(session) : null;
  const b = VERSION.exec(daemon);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]);
  }
  if (a[4] === undefined || b[4] === undefined) return a[4] !== undefined && b[4] === undefined;
  return Number(a[4]) < Number(b[4]);
}

export function readStaleRuntimeRestartConfig(env: NodeJS.ProcessEnv = process.env): { disabled: boolean; quietMs: number } {
  const quiet = Number(env.HAPPY_DAEMON_STALE_RUNTIME_RESTART_QUIET_MS);
  return {
    disabled: ['1', 'true', 'yes'].includes(String(env.HAPPY_DAEMON_STALE_RUNTIME_RESTART_DISABLED ?? '').toLowerCase()),
    quietMs: env.HAPPY_DAEMON_STALE_RUNTIME_RESTART_QUIET_MS !== undefined && Number.isFinite(quiet) && quiet > 0
      ? quiet : DEFAULT_STALE_RUNTIME_RESTART_QUIET_MS,
  };
}

export function sweepStaleRuntimeSessions(input: {
  trackedSessions: readonly TrackedSession[];
  sessionStartTimes: ReadonlyMap<number, number>;
  daemonVersion: string;
  stopSession: (sessionId: string, context?: StopSessionContext) => StopSessionResult;
  /** A retention policy (keep-alive / idle window) the user set for the process; unreadable = protected. */
  retentionProtects?: (session: TrackedSession) => boolean;
  now?: number;
  quietMs?: number;
  presenceStaleMs?: number;
  batchMax?: number;
  logDebug?: (message: string) => void;
}): number {
  const now = input.now ?? Date.now();
  const quietMs = input.quietMs ?? DEFAULT_STALE_RUNTIME_RESTART_QUIET_MS;
  const presenceStaleMs = input.presenceStaleMs ?? DEFAULT_IDLE_STOP_PRESENCE_STALE_MS;
  const batchMax = input.batchMax ?? DEFAULT_SESSION_IDLE_REAPER_BATCH_MAX;
  let stopped = 0;

  for (const session of input.trackedSessions) {
    if (stopped >= batchMax) break;
    const sessionId = session.happySessionId;
    const version = session.happySessionMetadataFromLocalWebhook?.version;
    if (!sessionId || !isOlderRuntimeVersion(version, input.daemonVersion)) continue;

    // Only a fresh, idle report proves nothing would be lost. Background jobs, an attached
    // terminal and a retention policy keep the process: they hold state a resume cannot restore.
    const runtime = session.runtime;
    if (!runtime || now - runtime.updatedAt > presenceStaleMs) continue;
    if (runtime.thinking || runtime.hasOpenToolCall || runtime.pendingUserInput) continue;
    if (runtime.mode === 'local' || runtime.launchedBackgroundJob) continue;
    const idleSince = runtime.lastTurnEndAt === undefined && runtime.lastUserInteractionAt === undefined
      ? input.sessionStartTimes.get(session.pid)
      : Math.max(runtime.lastTurnEndAt ?? 0, runtime.lastUserInteractionAt ?? 0);
    if (idleSince === undefined || now - idleSince < quietMs) continue;
    if (input.retentionProtects?.(session)) continue;

    const result = input.stopSession(sessionId, { source: 'stale-runtime-restart', reason: 'runtime-updated', mode: 'if-not-busy' });
    if (result.stopped) {
      stopped += 1;
      input.logDebug?.(`[stale-runtime-restart] stopped ${sessionId} (runtime ${version} < daemon ${input.daemonVersion}); the next input resumes it on the new runtime`);
    }
  }
  return stopped;
}
