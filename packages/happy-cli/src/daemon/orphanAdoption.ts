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
import { hydrateTrackedSessionFromPersisted } from './persistedSessionHydration';
import type { TrackedSession } from './types';

/** Label used for sessions the daemon didn't spawn. Matches the string the
 *  external-session webhook path writes, so provenance reads the same either
 *  way — the idle guard's local-session protection keys off it. */
export const EXTERNAL_SESSION_STARTED_BY = 'happy directly - likely by user from terminal';

export type OrphanAdoptionResult =
  | { adopted: true; session: TrackedSession; startedAt: number }
  | { adopted: false; reason: 'no-pid' | 'pid-dead' | 'pid-conflict' };

/** trackedPidOwner sentinel for a pid the daemon just spawned but whose
 *  session-started webhook hasn't arrived yet (happySessionId still unset).
 *  Never equals a real Happy session id, so resolveOrphanAdoption always
 *  treats it as a conflict. */
export const PENDING_SPAWN_OWNER = '<pending-daemon-spawn>';

/**
 * trackedPidOwner for resolveOrphanAdoption: identifies whether a pid is
 * already claimed by this daemon, even before its happySessionId is known.
 *
 * spawnTrackedHappyProcess registers the pid synchronously at spawn time
 * (startedBy: 'daemon'), but happySessionId is only filled in once the
 * session-started webhook arrives. A runtime report that reaches the daemon
 * in that window carries a *different* identity (the real session id) than
 * the pending entry's undefined happySessionId, so a naive `tracked
 * ?.happySessionId` lookup reports the pid as unclaimed. resolveOrphanAdoption
 * then "adopts" the pending pid as an external session and overwrites its
 * startedBy — the webhook's `existingSession.startedBy === 'daemon'` check
 * then fails to match, its awaiter never resolves, and the RPC caller sees a
 * 60s timeout even though the session spawned and is running fine (2026-08-15
 * incident: session recovery routinely timed out this way).
 */
export function resolveTrackedPidOwner(tracked: { happySessionId?: string } | undefined): string | undefined {
  if (!tracked) return undefined;
  return tracked.happySessionId ?? PENDING_SPAWN_OWNER;
}

/**
 * Decide whether a runtime report from an untracked session should be adopted.
 */
export function resolveOrphanAdoption(input: {
  sessionId: string;
  /** PID the reporting process announced about itself. Absent on older CLIs. */
  hostPid?: number;
  persistedSessions: Record<string, PersistedSession>;
  isPidAlive: (pid: number) => boolean;
  /** Session currently tracked under a PID, if any. The daemon's tracked map is
   *  keyed by PID, so adopting over a claimed one would evict its owner. */
  trackedPidOwner?: (pid: number) => string | undefined;
  now: number;
}): OrphanAdoptionResult {
  const { sessionId, hostPid, persistedSessions, isPidAlive, trackedPidOwner, now } = input;
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
  // Adopting over another session's PID would silently drop that session from
  // tracking — the exact leak this module exists to close. A stale persisted
  // hostPid is the likely way to get here, so refuse rather than guess.
  const owner = trackedPidOwner?.(pid);
  if (owner !== undefined && owner !== sessionId) {
    return { adopted: false, reason: 'pid-conflict' };
  }

  const session: TrackedSession = {
    // Encryption and the resume cursor come with it: an adopted session that
    // lacks them can never be preserved for resume, so the reaper would kill it
    // before its cursor reached disk (2026-08-15 incident).
    ...hydrateTrackedSessionFromPersisted(persisted),
    // Restore the original provenance. Anything else here (e.g. an 'adopted'
    // label) would make evaluateIdleStopGuard treat a daemon-spawned session as
    // a user's terminal and protect it forever.
    startedBy: persisted?.metadata?.startedBy === 'daemon' ? 'daemon' : EXTERNAL_SESSION_STARTED_BY,
    happySessionId: sessionId,
    pid,
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
  const claimedPids = new Set(trackedPids);

  for (const [sessionId, persisted] of Object.entries(persistedSessions)) {
    const pid = persisted.metadata?.hostPid;
    // claimedPids grows as we adopt: two records can name the same PID (a
    // session re-registered under a new id in one process), and the tracked map
    // is PID-keyed, so the second would evict the first.
    if (pid === undefined || claimedPids.has(pid)) continue;
    // Cheap liveness first: the store keeps records for 14 days, so most PIDs
    // here are long dead and getProcessStartedAt blocks on a `ps` subprocess.
    if (!isPidAlive(pid)) continue;

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

    claimedPids.add(pid);
    orphans.push({ sessionId, session: adoption.session, startedAt: adoption.startedAt });
  }

  return orphans;
}
