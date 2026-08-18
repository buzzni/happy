import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DaemonLocallyPersistedState } from '@/persistence'

const mocks = vi.hoisted(() => ({
  mockReadDaemonStateSnapshot: vi.fn(),
  mockWriteDaemonState: vi.fn(),
  mockWriteDaemonStateIfUnchanged: vi.fn(),
  mockClearDaemonState: vi.fn(),
  mockLoggerDebug: vi.fn(),
}))

vi.mock('@/persistence', () => ({
  readDaemonStateSnapshot: mocks.mockReadDaemonStateSnapshot,
  readDaemonState: async () => (await mocks.mockReadDaemonStateSnapshot()).state,
  writeDaemonState: mocks.mockWriteDaemonState,
  writeDaemonStateIfUnchanged: mocks.mockWriteDaemonStateIfUnchanged,
  clearDaemonState: mocks.mockClearDaemonState,
}))

vi.mock('@/ui/logger', () => ({
  logger: { debug: mocks.mockLoggerDebug },
}))

import { checkIfDaemonRunningAndCleanupStaleState } from './controlClient'

const DEAD_PID = 3058947
const HTTP_PORT = 33417

function stateWithPid(pid: number): DaemonLocallyPersistedState {
  return {
    pid,
    httpPort: HTTP_PORT,
    startTime: '8/17/2026, 12:05:29 PM',
    startedWithCliVersion: '1.1.10-aplus.116',
    daemonLogPath: '/tmp/daemon.log',
    state: 'running',
    trackedSessions: [],
  }
}

describe('checkIfDaemonRunningAndCleanupStaleState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockWriteDaemonStateIfUnchanged.mockReturnValue(true)
  })

  it('reports not running and marks the state crashed when the recorded pid is dead', async () => {
    const state = stateWithPid(DEAD_PID)
    mocks.mockReadDaemonStateSnapshot.mockResolvedValue({ state, raw: JSON.stringify(state) })

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false)

    expect(mocks.mockWriteDaemonStateIfUnchanged).toHaveBeenCalledWith(
      JSON.stringify(state),
      { ...state, state: 'crashed', stateReason: 'Daemon PID not running' },
    )
  })

  it('never writes the crashed marker with an unguarded write', async () => {
    // Regression: an unguarded write resurrects the dead pid on top of the state a
    // daemon that started in the meantime just wrote, and that daemon then shuts
    // itself down on its next heartbeat.
    const state = stateWithPid(DEAD_PID)
    mocks.mockReadDaemonStateSnapshot.mockResolvedValue({ state, raw: JSON.stringify(state) })

    await checkIfDaemonRunningAndCleanupStaleState()

    expect(mocks.mockWriteDaemonState).not.toHaveBeenCalled()
  })

  it('skips the crashed marker when another process rewrote the state file first', async () => {
    const state = stateWithPid(DEAD_PID)
    mocks.mockReadDaemonStateSnapshot.mockResolvedValue({ state, raw: JSON.stringify(state) })
    mocks.mockWriteDaemonStateIfUnchanged.mockReturnValue(false)

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false)

    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith(
      '[DAEMON RUN] Daemon state file changed while we were checking it, leaving it to its owner',
    )
  })

  it('returns false without writing when there is no state file', async () => {
    mocks.mockReadDaemonStateSnapshot.mockResolvedValue({ state: null, raw: null })

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false)

    expect(mocks.mockWriteDaemonStateIfUnchanged).not.toHaveBeenCalled()
  })

  it('reports running when the recorded pid is alive and answers the control server', async () => {
    const state = stateWithPid(process.pid)
    mocks.mockReadDaemonStateSnapshot.mockResolvedValue({ state, raw: JSON.stringify(state) })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)

    try {
      await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(true)
      expect(fetchSpy).toHaveBeenCalledWith(
        `http://127.0.0.1:${HTTP_PORT}/list`,
        expect.objectContaining({ method: 'POST' }),
      )
      expect(mocks.mockWriteDaemonStateIfUnchanged).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
