/**
 * Proof that a stopped session's processes are actually gone.
 *
 * `stopSession` sends one SIGTERM and drops the session from tracking, so its
 * `stopped: true` means "a signal was sent", not "the process exited" — a
 * caller that deletes the project right after can race a child still writing
 * to the workspace. This supplies the missing evidence, and nothing else:
 *
 * - The snapshot is taken **before** the stop, while the tracked root is still
 *   listed, and only those processes are observed afterwards. Nothing here
 *   sends a signal, scans cwds, matches command lines, or guesses a tree from
 *   a pid alone.
 * - Identity is pid **plus** `/proc/<pid>/stat` start time. A bare pid proves
 *   nothing after an exit: the kernel hands it out again.
 * - "I could not look" is always `unavailable`; no tracking is `not-tracked`.
 *   Neither is ever `exited` — the caller deletes data on `exited`, so an
 *   unproven exit must degrade to a warning. That is why every read
 *   distinguishes *absent* (the pid is gone) from *unreadable* (EACCES, EIO,
 *   a timeout, malformed content): conflating them would turn a permission
 *   error into a proof of exit.
 * - Every read is bounded and the whole walk is budgeted, so a wedged `/proc`
 *   stalls the answer rather than the stop RPC.
 *
 * **Scope, stated on the wire.** `session-process-tree-snapshot` is exactly
 * what is verified: the root and the descendants that existed at capture time.
 * A descendant spawned after the snapshot, or already reparented away from the
 * root, is outside it, so a consumer cannot read `exited` as "nothing of this
 * session is left on the machine".
 *
 * Linux only — the identity comes from `/proc`. Elsewhere the answer is
 * `unavailable`; the daemons this matters for run in Linux containers, and a
 * `ps`-based approximation would be a second untested path producing the same
 * confident-looking word.
 */

import { promises as fsp } from 'node:fs';

import type { StopSessionResult } from './sessionIdleReaper';

/** The only verification scope this module produces. */
export const SESSION_EXIT_VERIFICATION_SCOPE = 'session-process-tree-snapshot' as const;

export type SessionExitVerificationStatus = 'exited' | 'timeout' | 'unavailable' | 'not-tracked';

/**
 * Fixed vocabulary — these travel over the wire. Never a path, argv, env value
 * or raw error text.
 */
export type SessionExitVerificationDetail =
  | 'platform-unsupported'
  | 'process-table-unreadable'
  | 'root-process-absent'
  | 'root-identity-changed'
  | 'snapshot-too-large'
  | 'snapshot-budget-exceeded'
  | 'session-not-tracked'
  | 'stop-refused'
  | 'verification-unsupported';

export type SessionExitVerification = {
  status: SessionExitVerificationStatus;
  scope: typeof SESSION_EXIT_VERIFICATION_SCOPE;
  detail?: SessionExitVerificationDetail;
  /** Processes in the snapshot (root included). Present once one was taken. */
  observedProcessCount?: number;
  /** Snapshot processes still alive when the budget ran out. */
  remainingProcessCount?: number;
};

/** One process, as identified for this check. */
export type ProcessRow = {
  pid: number;
  ppid: number;
  /** `/proc/<pid>/stat` field 22. Separates a recycled pid from the original. */
  startToken: string;
  /** State `Z`: exited, not yet reaped. The process image is already gone. */
  zombie: boolean;
};

/** Absence and unreadability are different answers and never merged. */
export type ProcReadResult =
  | { status: 'ok'; content: string }
  | { status: 'absent' }
  | { status: 'unreadable' };

export type ProcListResult =
  | { status: 'ok'; entries: string[] }
  | { status: 'absent' }
  | { status: 'unreadable' };

export interface ProcFs {
  platform: string;
  listProc(timeoutMs: number): Promise<ProcListResult>;
  readProcStat(pid: number, timeoutMs: number): Promise<ProcReadResult>;
}

export type ProcessTableResult =
  | { status: 'ok'; rows: ProcessRow[] }
  /** No `/proc` here. A definite answer, not a failed read. */
  | { status: 'unsupported' }
  | { status: 'unreadable' }
  /** The deadline passed mid-walk; the remaining reads were not issued. */
  | { status: 'expired' };

export type ProcessProbeResult =
  | { status: 'alive'; row: ProcessRow }
  /** The pid is gone. */
  | { status: 'absent' }
  | { status: 'unsupported' }
  | { status: 'unreadable' }
  | { status: 'expired' };

/**
 * A shared deadline, checked before every read. Without it a walk of 4k
 * `/proc` entries at up to 250 ms each is a 17-minute stall inside a stop RPC;
 * the last read already in flight may still overshoot the deadline by one
 * read timeout, which is the only overshoot allowed here.
 */
export type Deadline = { expired(): boolean };

export function deadlineAfter(budgetMs: number, now: () => number = Date.now): Deadline {
  const end = now() + budgetMs;
  return { expired: () => now() >= end };
}

export interface ProcessProbe {
  /** Whole-table scan. Used once, for the capture. */
  scan(deadline: Deadline): Promise<ProcessTableResult>;
  /** One pid. Used for observation, so a stop never rescans all of `/proc`. */
  probe(pid: number, deadline: Deadline): Promise<ProcessProbeResult>;
}

/** A tree bigger than this is not walked; the answer becomes `unavailable`. */
const MAX_SNAPSHOT_PROCESSES = 512;
/** `/proc` entries read in one scan before giving up on a bounded answer. */
const MAX_SCANNED_ENTRIES = 4096;
/** Per-read bound. A wedged `/proc` read reports unreadable instead of hanging. */
export const PROC_READ_TIMEOUT_MS = 250;
/** Whole-capture bound, spent before the stop is even issued. */
export const DEFAULT_CAPTURE_BUDGET_MS = 1_500;
/** Observation bound after the stop. */
export const DEFAULT_EXIT_WAIT_BUDGET_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

/**
 * `/proc/<pid>/stat`: `pid (comm) state ppid ...`. The command name can contain
 * spaces and parens, so fields are split after the final `)`; from there field
 * 1 is state, 2 is ppid, 20 is the start time.
 */
export function parseProcStat(pid: number, stat: string): ProcessRow | null {
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const ppid = Number(fields[1]);
  const startToken = fields[19];
  if (!state || !startToken || !Number.isInteger(ppid)) return null;
  return { pid, ppid, startToken, zombie: state === 'Z' };
}

export function createProcProcessProbe(fs: ProcFs): ProcessProbe {
  const readRow = async (pid: number): Promise<ProcessProbeResult> => {
    const stat = await fs.readProcStat(pid, PROC_READ_TIMEOUT_MS);
    if (stat.status === 'absent') return { status: 'absent' };
    if (stat.status === 'unreadable') return { status: 'unreadable' };
    const row = parseProcStat(pid, stat.content);
    // Content we cannot parse is missing evidence, not an exit.
    return row ? { status: 'alive', row } : { status: 'unreadable' };
  };

  return {
    async scan(deadline: Deadline): Promise<ProcessTableResult> {
      if (fs.platform !== 'linux') return { status: 'unsupported' };
      if (deadline.expired()) return { status: 'expired' };
      const listing = await fs.listProc(PROC_READ_TIMEOUT_MS);
      if (listing.status !== 'ok') return { status: 'unreadable' };
      const pids = listing.entries.filter((entry) => /^\d+$/.test(entry));
      if (pids.length > MAX_SCANNED_ENTRIES) return { status: 'unreadable' };
      const rows: ProcessRow[] = [];
      for (const entry of pids) {
        if (deadline.expired()) return { status: 'expired' };
        const result = await readRow(Number(entry));
        // A pid that exits mid-scan is the outcome we are looking for, not a
        // failure; anything unreadable leaves the tree unknown.
        if (result.status === 'absent') continue;
        if (result.status !== 'alive') return { status: 'unreadable' };
        rows.push(result.row);
      }
      return { status: 'ok', rows };
    },
    async probe(pid: number, deadline: Deadline): Promise<ProcessProbeResult> {
      if (fs.platform !== 'linux') return { status: 'unsupported' };
      if (deadline.expired()) return { status: 'expired' };
      return readRow(pid);
    },
  };
}

/**
 * Real `/proc`, with each read bounded. A read that times out is `unreadable`
 * (the caller stops waiting; the underlying promise is left to settle), and
 * only ENOENT — the pid is gone — is `absent`.
 */
export function createProcFs(): ProcFs {
  const bounded = <T>(work: Promise<T>, timeoutMs: number, onTimeout: T): Promise<T> => new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout), timeoutMs);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(onTimeout); },
    );
  });

  return {
    platform: process.platform,
    listProc: (timeoutMs) => bounded<ProcListResult>(
      fsp.readdir('/proc')
        .then((entries) => ({ status: 'ok', entries }) as ProcListResult)
        .catch((error: NodeJS.ErrnoException) => (
          error.code === 'ENOENT' ? { status: 'absent' } : { status: 'unreadable' }
        )),
      timeoutMs,
      { status: 'unreadable' },
    ),
    readProcStat: (pid, timeoutMs) => bounded<ProcReadResult>(
      fsp.readFile(`/proc/${pid}/stat`, 'utf-8')
        .then((content) => ({ status: 'ok', content }) as ProcReadResult)
        .catch((error: NodeJS.ErrnoException) => (
          error.code === 'ENOENT' || error.code === 'ESRCH' ? { status: 'absent' } : { status: 'unreadable' }
        )),
      timeoutMs,
      { status: 'unreadable' },
    ),
  };
}

export type SessionProcessTreeSnapshot =
  | { kind: 'captured'; processes: ProcessRow[] }
  | { kind: 'unavailable'; detail: SessionExitVerificationDetail };

/**
 * The root and its descendants as they exist right now, with the root's
 * identity rechecked afterwards.
 *
 * Call this while the session is still tracked and running: after the stop the
 * root is gone and its children are reparented to init, which erases the edges
 * this walk follows. The recheck closes the window inside the scan itself — if
 * the root exited and its pid was recycled while we walked, the captured
 * children belong to a tree that no longer exists.
 */
export async function captureSessionProcessTree(input: {
  rootPid: number;
  probe: ProcessProbe;
  budgetMs?: number;
  now?: () => number;
}): Promise<SessionProcessTreeSnapshot> {
  const deadline = deadlineAfter(input.budgetMs ?? DEFAULT_CAPTURE_BUDGET_MS, input.now ?? Date.now);

  const table = await input.probe.scan(deadline);
  if (table.status === 'unsupported') return { kind: 'unavailable', detail: 'platform-unsupported' };
  if (table.status === 'unreadable') return { kind: 'unavailable', detail: 'process-table-unreadable' };
  if (table.status === 'expired') return { kind: 'unavailable', detail: 'snapshot-budget-exceeded' };

  const root = table.rows.find((row) => row.pid === input.rootPid);
  // The tracked pid is not there. The tracked process is certainly not running,
  // but if it died earlier its children were reparented and are no longer
  // reachable from it — missing evidence, not a proven exit.
  if (!root) return { kind: 'unavailable', detail: 'root-process-absent' };

  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const row of table.rows) {
    const siblings = childrenByParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenByParent.set(row.ppid, [row]);
  }

  const processes: ProcessRow[] = [root];
  const seen = new Set<number>([root.pid]);
  const queue: number[] = [root.pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of childrenByParent.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      processes.push(child);
      queue.push(child.pid);
      if (processes.length > MAX_SNAPSHOT_PROCESSES) {
        return { kind: 'unavailable', detail: 'snapshot-too-large' };
      }
    }
  }

  const recheck = await input.probe.probe(root.pid, deadline);
  if (recheck.status === 'unsupported') return { kind: 'unavailable', detail: 'platform-unsupported' };
  if (recheck.status === 'unreadable') return { kind: 'unavailable', detail: 'process-table-unreadable' };
  if (recheck.status === 'expired') return { kind: 'unavailable', detail: 'snapshot-budget-exceeded' };
  if (recheck.status === 'absent') return { kind: 'unavailable', detail: 'root-process-absent' };
  if (recheck.row.startToken !== root.startToken) {
    return { kind: 'unavailable', detail: 'root-identity-changed' };
  }

  return { kind: 'captured', processes };
}

/**
 * Watch the captured processes until every one is gone or the budget runs out.
 * Observation only — each pass reads just the captured pids, and no signal is
 * sent from here.
 */
export async function waitForSnapshotExit(input: {
  processes: ProcessRow[];
  probe: ProcessProbe;
  budgetMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SessionExitVerification> {
  const budgetMs = input.budgetMs ?? DEFAULT_EXIT_WAIT_BUDGET_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = deadlineAfter(budgetMs, now);
  const observedProcessCount = input.processes.length;
  const timedOut = (remainingProcessCount: number): SessionExitVerification => ({
    status: 'timeout',
    scope: SESSION_EXIT_VERIFICATION_SCOPE,
    observedProcessCount,
    remainingProcessCount,
  });

  let pending = input.processes;
  for (;;) {
    const alive: ProcessRow[] = [];
    for (const [index, captured] of pending.entries()) {
      const result = await input.probe.probe(captured.pid, deadline);
      if (result.status === 'expired') {
        // Whatever was still alive, plus everything this pass never got to
        // look at: unproven either way, which is what timeout means.
        return timedOut(alive.length + (pending.length - index));
      }
      if (result.status === 'unsupported' || result.status === 'unreadable') {
        return {
          status: 'unavailable',
          scope: SESSION_EXIT_VERIFICATION_SCOPE,
          detail: result.status === 'unsupported' ? 'platform-unsupported' : 'process-table-unreadable',
          observedProcessCount,
        };
      }
      if (result.status === 'absent') continue;
      // Same pid, different start time: the captured process exited and the
      // kernel recycled its pid. A zombie has exited too.
      if (result.row.startToken !== captured.startToken || result.row.zombie) continue;
      alive.push(captured);
    }
    pending = alive;
    if (pending.length === 0) {
      return { status: 'exited', scope: SESSION_EXIT_VERIFICATION_SCOPE, observedProcessCount };
    }
    if (deadline.expired()) return timedOut(pending.length);
    await sleep(pollIntervalMs);
  }
}

export function unavailableVerification(detail: SessionExitVerificationDetail): SessionExitVerification {
  return { status: 'unavailable', scope: SESSION_EXIT_VERIFICATION_SCOPE, detail };
}

export function notTrackedVerification(): SessionExitVerification {
  return { status: 'not-tracked', scope: SESSION_EXIT_VERIFICATION_SCOPE, detail: 'session-not-tracked' };
}

/** What the daemon knows about the session it is about to stop. */
export type StopTarget = {
  pid: number;
  /** The tracking entry itself, compared by reference to detect replacement. */
  token: unknown;
};

/**
 * The verified stop: capture, stop, observe.
 *
 * The capture is the only `await` this adds ahead of the legacy synchronous
 * stop, and that gap is a hazard of its own — tracking can change under it, and
 * signalling the pid we started from would then hit whatever holds it now. So
 * the target is looked up again immediately before the stop, and the stop is
 * skipped entirely when the tracked entry moved, vanished, or when the capture
 * already proved the root pid absent or recycled. Missing evidence for reasons
 * that say nothing about the pid (no `/proc`, an unreadable read) leaves the
 * legacy stop exactly as it was, marked `unavailable`.
 */
export async function stopSessionWithVerifiedExit(input: {
  findTarget: () => StopTarget | undefined;
  stop: () => StopSessionResult;
  probe: ProcessProbe;
  captureBudgetMs?: number;
  waitBudgetMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ result: StopSessionResult; exitVerification: SessionExitVerification }> {
  const target = input.findTarget();
  if (!target) {
    // Nothing tracked: the legacy stop answers 'not-found' and there is no
    // process to have verified.
    return { result: input.stop(), exitVerification: notTrackedVerification() };
  }

  const snapshot = await captureSessionProcessTree({
    rootPid: target.pid,
    probe: input.probe,
    ...(input.captureBudgetMs !== undefined ? { budgetMs: input.captureBudgetMs } : {}),
    ...(input.now ? { now: input.now } : {}),
  });

  const current = input.findTarget();
  if (!current || current.pid !== target.pid || current.token !== target.token) {
    return {
      result: { stopped: false, reason: 'not-found' },
      exitVerification: notTrackedVerification(),
    };
  }

  if (snapshot.kind === 'unavailable'
    && (snapshot.detail === 'root-process-absent' || snapshot.detail === 'root-identity-changed')) {
    return {
      result: { stopped: false, reason: 'not-found' },
      exitVerification: unavailableVerification(snapshot.detail),
    };
  }

  const result = input.stop();
  if (!result.stopped) {
    return {
      result,
      exitVerification: result.reason === 'not-found'
        ? notTrackedVerification()
        : unavailableVerification('stop-refused'),
    };
  }
  if (snapshot.kind !== 'captured') {
    return { result, exitVerification: unavailableVerification(snapshot.detail) };
  }

  const exitVerification = await waitForSnapshotExit({
    processes: snapshot.processes,
    probe: input.probe,
    ...(input.waitBudgetMs !== undefined ? { budgetMs: input.waitBudgetMs } : {}),
    ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.sleep ? { sleep: input.sleep } : {}),
  });
  return { result, exitVerification };
}
