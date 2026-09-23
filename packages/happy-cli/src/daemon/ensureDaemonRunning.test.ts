import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockLoggerDebug: vi.fn(),
  mockIsDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(),
  mockCheckIfDaemonRunningAndCleanupStaleState: vi.fn(),
  mockSpawnHappyCLI: vi.fn(),
  mockReadSettings: vi.fn(),
  mockUpdateSettings: vi.fn(),
}))

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
  },
}))

vi.mock('./controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHappyVersion: mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion,
  checkIfDaemonRunningAndCleanupStaleState: mocks.mockCheckIfDaemonRunningAndCleanupStaleState,
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: mocks.mockSpawnHappyCLI,
  // Keep in sync with the module's exports: this factory replaces the whole
  // module, so any export ensureDaemonRunning starts using must be listed here
  // or the call throws at runtime instead of failing a meaningful assertion.
  captureSpawnOutputStdio: () => 'ignore',
}))

vi.mock('@/persistence', () => ({
  readSettings: mocks.mockReadSettings,
  updateSettings: mocks.mockUpdateSettings,
}))

import { ensureDaemonRunning } from './ensureDaemonRunning'

describe('ensureDaemonRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSpawnHappyCLI.mockReturnValue({
      unref: vi.fn(),
    })
    mocks.mockCheckIfDaemonRunningAndCleanupStaleState.mockResolvedValue(true)
    mocks.mockReadSettings.mockResolvedValue({
      schemaVersion: 2,
      onboardingCompleted: true,
    })
  })

  it('returns without spawning when the daemon is already running', async () => {
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(true)

    await ensureDaemonRunning()

    expect(mocks.mockSpawnHappyCLI).not.toHaveBeenCalled()
    expect(mocks.mockCheckIfDaemonRunningAndCleanupStaleState).not.toHaveBeenCalled()
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith(
      'Ensuring Happy background service is running & matches our version...',
    )
  })

  it('starts the daemon and waits for readiness when the installed version is not running', async () => {
    const mockUnref = vi.fn()
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)
    mocks.mockSpawnHappyCLI.mockReturnValue({
      unref: mockUnref,
    })
    mocks.mockCheckIfDaemonRunningAndCleanupStaleState
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    await ensureDaemonRunning()

    expect(mocks.mockSpawnHappyCLI).toHaveBeenCalledWith(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    expect(mockUnref).toHaveBeenCalled()
    expect(mocks.mockCheckIfDaemonRunningAndCleanupStaleState).toHaveBeenCalledTimes(2)
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith('Starting Happy background service...')
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith('Happy background service is ready')
  })

  it('restores the persisted Aplus MCP config URL when the caller environment omits it', async () => {
    const originalConfigUrl = process.env.HAPPY_APLUS_MCP_CONFIG_URL
    delete process.env.HAPPY_APLUS_MCP_CONFIG_URL
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)
    mocks.mockReadSettings.mockResolvedValue({
      schemaVersion: 2,
      onboardingCompleted: true,
      aplusMcpConfigUrl: 'https://saycode.example/api/me/mcp-config',
    })

    try {
      await ensureDaemonRunning()

      expect(mocks.mockSpawnHappyCLI).toHaveBeenCalledTimes(1)
      expect(mocks.mockSpawnHappyCLI.mock.calls[0]?.[1]?.env?.HAPPY_APLUS_MCP_CONFIG_URL).toBe(
        'https://saycode.example/api/me/mcp-config',
      )
    } finally {
      if (originalConfigUrl === undefined) delete process.env.HAPPY_APLUS_MCP_CONFIG_URL
      else process.env.HAPPY_APLUS_MCP_CONFIG_URL = originalConfigUrl
    }
  })
})
