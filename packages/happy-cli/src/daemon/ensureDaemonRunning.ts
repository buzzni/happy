import { logger } from '@/ui/logger'
import { checkIfDaemonRunningAndCleanupStaleState, isDaemonRunningCurrentlyInstalledHappyVersion } from './controlClient'
import { captureSpawnOutputStdio, spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { resolveDaemonMcpConfigEnvironment } from './daemonMcpConfig'
import { configuration } from '@/configuration'
import { isPidAlive, readDaemonLockHolderPid, readDaemonState } from '@/persistence'

const DAEMON_READY_TIMEOUT_MS = 5000
const DAEMON_READY_POLL_INTERVAL_MS = 100

/** The online lock owner just spawned us; its authenticated session reports still apply. */
async function isCurrentDaemonParent(): Promise<boolean> {
  const state = await readDaemonState()
  if (!state || state.pid <= 0 || state.pid !== process.ppid
    || state.state !== 'running' || state.socketConnected !== true
    || state.startedWithCliVersion !== configuration.currentCliVersion
    || !state.httpPort || !state.controlSecret) return false

  // OS parentage, version and lock ownership must agree. An online flag or
  // --started-by argument alone cannot bypass normal daemon verification.
  return readDaemonLockHolderPid() === state.pid && isPidAlive(state.pid)
}

export async function ensureDaemonRunning(): Promise<void> {
  logger.debug('Ensuring Happy background service is running & matches our version...')

  if (await isCurrentDaemonParent()) {
    logger.debug('[DAEMON CONTROL] Reusing the online owning daemon parent without a redundant health probe')
    return
  }

  if (await isDaemonRunningCurrentlyInstalledHappyVersion()) {
    return
  }

  logger.debug('Starting Happy background service...')

  const daemonEnvironment = await resolveDaemonMcpConfigEnvironment(process.env)

  // stdio captured rather than ignored — see captureSpawnOutputStdio. A
  // start-sync that dies before its logger is up leaves no other trace, and
  // the readiness loop below can then only report a timeout without a cause.
  const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
    detached: true,
    stdio: captureSpawnOutputStdio('daemon-start-sync.log', `ensureDaemonRunning from pid ${process.pid}`),
    env: daemonEnvironment,
  })
  daemonProcess.unref()

  // Wait for the spawned daemon to be fully ready: it must write daemon.state.json,
  // bind its HTTP port, and respond to a health ping. Without this, early callers
  // (e.g. notifyDaemonSessionStarted) race the daemon startup and the webhook is
  // silently lost — which later breaks resume-happy-session.
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await checkIfDaemonRunningAndCleanupStaleState()) {
      logger.debug('Happy background service is ready')
      return
    }
    await new Promise(resolve => setTimeout(resolve, DAEMON_READY_POLL_INTERVAL_MS))
  }

  logger.debug(`Happy background service did not become ready within ${DAEMON_READY_TIMEOUT_MS}ms; continuing anyway`)
}
