/**
 * Adoption of sessions this daemon isn't tracking.
 *
 * A daemon replacement (version upgrade, crash, corrupted state file) can leave
 * live session processes behind with no daemon tracking them. Every reaper
 * iterates the tracked map only, so an untracked session is never evaluated at
 * all — not even by the absolute idle cut. It lives forever.
 *
 * Live sessions keep announcing themselves: `daemonPost` re-reads
 * daemon.state.json on every call, so their runtime reports reach whichever
 * daemon is current, roughly every 30s. This module turns such a report into a
 * TrackedSession. All I/O (PID liveness, clock) is injected so the decision is
 * a pure function.
 */

import type { PersistedSession } from '@/persistence';
import type { TrackedSession } from './types';

/** Label used for sessions the daemon didn't spawn. Matches the string the
 *  external-session webhook path writes, so provenance reads the same either
 *  way — the idle guard's local-session protection keys off it. */
export const EXTERNAL_SESSION_STARTED_BY = 'happy directly - likely by user from terminal';

export type OrphanAdoptionResult =
  | { adopted: true; session: TrackedSession; startedAt: number }
  | { adopted: false; reason: 'no-pid' | 'pid-dead' };

/**
 * Decide whether a runtime report from an untracked session should be adopted.
 */
export function resolveOrphanAdoption(input: {
  sessionId: string;
  /** PID the reporting process announced about itself. Absent on older CLIs. */
  hostPid?: number;
  persistedSessions: Record<string, PersistedSession>;
  isPidAlive: (pid: number) => boolean;
  now: number;
}): OrphanAdoptionResult {
  const { sessionId, hostPid, persistedSessions, isPidAlive, now } = input;
  const persisted = persistedSessions[sessionId];

  // Prefer the self-announced PID: a process reporting its own pid cannot be a
  // recycled one, while the persisted record can be up to 14 days old.
  const pid = hostPid ?? persisted?.metadata?.hostPid;
  if (pid === undefined) {
    return { adopted: false, reason: 'no-pid' };
  }
  if (!isPidAlive(pid)) {
    return { adopted: false, reason: 'pid-dead' };
  }

  const session: TrackedSession = {
    // Restore the original provenance. Anything else here (e.g. an 'adopted'
    // label) would make evaluateIdleStopGuard treat a daemon-spawned session as
    // a user's terminal and protect it forever.
    startedBy: persisted?.metadata?.startedBy === 'daemon' ? 'daemon' : EXTERNAL_SESSION_STARTED_BY,
    happySessionId: sessionId,
    pid,
    ...(persisted?.metadata ? { happySessionMetadataFromLocalWebhook: persisted.metadata } : {}),
    ...(persisted?.userHomeDir ? { userHomeDir: persisted.userHomeDir } : {}),
  };

  return {
    adopted: true,
    session,
    // Age drives every reaper policy, so keep the real one. With no persisted
    // record the age is unknown; `now` is the conservative choice (it grants
    // the session full min-session-age protection rather than removing it).
    startedAt: persisted?.savedAt ?? now,
  };
}

export type StartupOrphan = {
  sessionId: string;
  session: TrackedSession;
  startedAt: number;
};

/**
 * Find live sessions from the persisted store that this daemon isn't tracking.
 *
 * The report-driven path only sees sessions that still talk. A session whose
 * runtime is wedged is silent, so nothing would ever bring it into the tracked
 * map — and the zombie sweep, whose whole job is reclaiming exactly that, would
 * never get to look at it. This closes that gap at startup.
 *
 * Unlike a live report, a persisted record is not proof of identity: it can be
 * up to 14 days old and its PID may have been recycled. Adoption here is
 * therefore gated on the process having started no later than the record was
 * written, and a process whose start time can't be read is left alone.
 */
export function collectStartupOrphans(input: {
  persistedSessions: Record<string, PersistedSession>;
  /** PIDs already in the daemon's tracked map (spawned or recovered). */
  trackedPids: ReadonlySet<number>;
  isPidAlive: (pid: number) => boolean;
  /** Wall-clock start time of a process, or undefined if it can't be read. */
  getProcessStartedAt: (pid: number) => number | undefined;
  now: number;
}): StartupOrphan[] {
  const { persistedSessions, trackedPids, isPidAlive, getProcessStartedAt, now } = input;
  const orphans: StartupOrphan[] = [];

  for (const [sessionId, persisted] of Object.entries(persistedSessions)) {
    const pid = persisted.metadata?.hostPid;
    if (pid === undefined || trackedPids.has(pid)) continue;

    const startedAt = getProcessStartedAt(pid);
    // A process that started after the session record was written is a
    // different process wearing a recycled PID. Stopping it would kill a
    // bystander, so an unreadable start time is treated the same way: skip.
    if (startedAt === undefined || startedAt > persisted.savedAt) continue;

    const adoption = resolveOrphanAdoption({
      sessionId,
      hostPid: pid,
      persistedSessions,
      isPidAlive,
      now,
    });
    if (!adoption.adopted) continue;

    orphans.push({ sessionId, session: adoption.session, startedAt: adoption.startedAt });
  }

  return orphans;
}
