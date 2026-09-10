/**
 * Ownership check for daemon.state.json.
 *
 * A running daemon rewrites the state file on every heartbeat. Before doing so it
 * asks whether some *other* daemon has taken ownership of the file, in which case
 * it must shut down instead of fighting over the file.
 *
 * "Another pid is recorded" is not enough on its own: several code paths write a
 * previous daemon's pid back into the file after that daemon has already exited
 * (`checkIfDaemonRunningAndCleanupStaleState` marks it `crashed`). Treating a dead
 * pid as a live owner shuts down the only healthy daemon and leaves the machine
 * offline until someone restarts it by hand.
 *
 * "Another *live* pid is recorded" is not enough either: any process that calls
 * `writeDaemonState()` against this home can put its own pid there (2026-09-10: a
 * vitest worker did, against the developer's real HAPPY_HOME). What makes a
 * process *the daemon* is holding `daemon.state.json.lock`. While we still hold
 * that lock, no other daemon can have started, so the writer is not one — we keep
 * running and the next heartbeat writes our own state back.
 */
export type DaemonStateOwnershipReason =
  | 'own'
  | 'unrecorded'
  | 'foreign-dead'
  | 'foreign-without-lock'
  | 'foreign-daemon'

export function resolveDaemonStateOwnership(params: {
  recordedPid: number | null | undefined
  ownPid: number
  /** Pid written into daemon.state.json.lock, or null when unreadable/missing. */
  lockHolderPid: number | null
  isProcessAlive: (pid: number) => boolean
}): { yield: boolean; reason: DaemonStateOwnershipReason } {
  const { recordedPid, ownPid, lockHolderPid, isProcessAlive } = params

  if (recordedPid === null || recordedPid === undefined) {
    return { yield: false, reason: 'unrecorded' }
  }
  if (recordedPid === ownPid) {
    return { yield: false, reason: 'own' }
  }
  if (!isProcessAlive(recordedPid)) {
    return { yield: false, reason: 'foreign-dead' }
  }
  if (lockHolderPid === ownPid) {
    return { yield: false, reason: 'foreign-without-lock' }
  }
  // Lock is the recorded pid's, or we no longer hold it (handoff released it, or
  // it was removed). Without the lock as evidence a live foreign pid keeps its
  // historical meaning: another daemon owns the file.
  return { yield: true, reason: 'foreign-daemon' }
}
