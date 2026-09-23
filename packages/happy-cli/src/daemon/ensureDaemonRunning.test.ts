import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', undefined)
    mocks.mockSpawnHappyCLI.mockReturnValue({
      unref: vi.fn(),
    })
    mocks.mockCheckIfDaemonRunningAndCleanupStaleState.mockResolvedValue(true)
    mocks.mockReadSettings.mockResolvedValue({
      schemaVersion: 2,
      onboardingCompleted: true,
    })
  })

  afterEach(() => vi.unstubAllEnvs())

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

  it('forwards the explicit endpoint without changing the invoking session URL', async () => {
    const sessionUrl = 'https://explicit.example/api/me/mcp-config?project_id=session&token=private#secret'
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', sessionUrl)
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)
    mocks.mockReadSettings.mockResolvedValue({ aplusMcpConfigUrl: 'https://old.example/api/me/mcp-config' })

    await ensureDaemonRunning()

    expect(mocks.mockSpawnHappyCLI).toHaveBeenCalledTimes(1)
    expect(mocks.mockSpawnHappyCLI.mock.calls[0][1].env.HAPPY_APLUS_MCP_CONFIG_URL)
      .toBe('https://explicit.example/api/me/mcp-config')
    expect(process.env.HAPPY_APLUS_MCP_CONFIG_URL).toBe(sessionUrl)
    expect(mocks.mockReadSettings).not.toHaveBeenCalled()
    expect(mocks.mockUpdateSettings).not.toHaveBeenCalled()
  })

  it('does not start a replacement daemon when its persisted endpoint is invalid', async () => {
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)
    mocks.mockReadSettings.mockResolvedValue({
      aplusMcpConfigUrl: 'https://user:secret@studio.example/api/me/mcp-config',
    })

    await expect(ensureDaemonRunning()).rejects.toThrow(/^Invalid persisted Aplus MCP config URL$/)
    expect(mocks.mockSpawnHappyCLI).not.toHaveBeenCalled()
    expect(mocks.mockCheckIfDaemonRunningAndCleanupStaleState).not.toHaveBeenCalled()
    expect(JSON.stringify(mocks.mockLoggerDebug.mock.calls)).not.toContain('secret')
  })
})
