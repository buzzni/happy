/**
 * Ownership check for daemon.state.json.
 *
 * A running daemon rewrites the state file on every heartbeat. Before doing so it
 * asks whether some *other* daemon has taken ownership of the file, in which case
 * it must shut down instead of fighting over the file.
 */
export function shouldYieldDaemonStateOwnership(params: {
  recordedPid: number | null | undefined
  ownPid: number
}): boolean {
  const { recordedPid, ownPid } = params

  if (recordedPid === null || recordedPid === undefined) {
    return false
  }
  return recordedPid !== ownPid
}
