/**
 * aplus codexcli-daemon-restart-drain F2 (V1 2026-10-24) — the bundle handoff's replacement `daemon start`
 * polls the real state file while the old daemon is still alive: teardown has closed its control server and
 * marked the file stopped, and the old process exits only once the replacement confirms. Real persistence and
 * a real control server here (the unit setup isolates HAPPY_HOME_DIR), so the file the teardown writes is the
 * file the replacement reads.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { configuration } from '@/configuration'
import { clearDaemonState, readDaemonState, writeDaemonState, type DaemonLocallyPersistedState } from '@/persistence'
import { checkIfDaemonRunningAndCleanupStaleState } from './controlClient'
import { waitForDaemonStart } from './waitForDaemonStart'

const servers: Server[] = []

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

/** A control port that never confirms health — a closed port could be reused by another worker's server. */
async function closedPort(): Promise<number> {
  return (await listen((_request, response) => { response.writeHead(503).end() })).port
}

function daemonState(pid: number, httpPort: number): DaemonLocallyPersistedState {
  return {
    pid,
    httpPort,
    startTime: '10/24/2026, 1:20:11 AM',
    startedWithCliVersion: '1.1.10-aplus.354',
    daemonLogPath: '/tmp/daemon.log',
    state: 'running',
    trackedSessions: [{ pid: 92817, happySessionId: 'session-1' }] as DaemonLocallyPersistedState['trackedSessions'],
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('bundle handoff replacement health check', () => {
  it('sees no daemon after the old one tore down, and keeps its session records for recovery', async () => {
    // The old daemon is this (live) process; its control server is already gone.
    writeDaemonState(daemonState(process.pid, await closedPort()))
    await clearDaemonState()

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false)
    expect(await readDaemonState()).toMatchObject({ pid: process.pid, state: 'stopped', trackedSessions: [{ pid: 92817 }] })
  })

  it('lets the replacement daemon start wait for its own daemon instead of failing on the old one', async () => {
    writeDaemonState(daemonState(process.pid, await closedPort()))
    await clearDaemonState()
    const { port: replacementPort } = await listen((_request, response) => { response.writeHead(200).end('{}') })

    let polls = 0
    const outcome = await waitForDaemonStart({
      isRunning: checkIfDaemonRunningAndCleanupStaleState,
      childExit: () => undefined,
      now: () => Date.now(),
      sleep: async () => {
        // The replacement's start-sync claims the file during the second wait, so the third check sees it.
        if (++polls === 2) writeDaemonState(daemonState(process.pid, replacementPort))
      },
    }, { timeoutMs: 5_000, pollMs: 0 })

    expect(outcome).toBe('started')
    expect(polls).toBe(2)
  })

  it('keeps the health check while a stopped owner still holds the lock', async () => {
    writeDaemonState({ ...daemonState(process.pid, await closedPort()), state: 'stopped' })
    writeFileSync(configuration.daemonLockFile, String(process.pid))
    await expect(checkIfDaemonRunningAndCleanupStaleState()).rejects.toThrow('DAEMON_HEALTH_UNCONFIRMED')
    await clearDaemonState()
  })

  it('still refuses to replace a live daemon whose control server does not answer', async () => {
    writeDaemonState(daemonState(process.pid, await closedPort()))
    await expect(checkIfDaemonRunningAndCleanupStaleState()).rejects.toThrow('DAEMON_HEALTH_UNCONFIRMED')
  })
})
