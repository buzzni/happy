export async function prepareDaemonStartup({
  preflightCandidate,
  runningVersionMatches,
  stopRunningDaemon,
}: {
  preflightCandidate: () => Promise<void>
  runningVersionMatches: () => Promise<boolean>
  stopRunningDaemon: () => Promise<void>
}): Promise<'start' | 'already-running'> {
  await preflightCandidate()

  if (await runningVersionMatches()) {
    return 'already-running'
  }

  await stopRunningDaemon()
  return 'start'
}

export async function handoffToReplacedBundle({
  preflightReplacement,
  teardownCurrentDaemon,
  spawnReplacement,
}: {
  preflightReplacement: () => Promise<boolean>
  teardownCurrentDaemon: () => Promise<void>
  spawnReplacement: () => void
}): Promise<'kept-current' | 'handed-off'> {
  if (!await preflightReplacement()) {
    return 'kept-current'
  }

  await teardownCurrentDaemon()
  spawnReplacement()
  return 'handed-off'
}
