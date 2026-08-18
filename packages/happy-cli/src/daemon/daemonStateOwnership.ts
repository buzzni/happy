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
 */
export function shouldYieldDaemonStateOwnership(params: {
  recordedPid: number | null | undefined
  ownPid: number
  isProcessAlive: (pid: number) => boolean
}): boolean {
  const { recordedPid, ownPid, isProcessAlive } = params

  if (recordedPid === null || recordedPid === undefined) {
    return false
  }
  if (recordedPid === ownPid) {
    return false
  }
  return isProcessAlive(recordedPid)
}
