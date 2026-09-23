import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readSettings: vi.fn(),
  updateSettings: vi.fn(),
}))

vi.mock('@/persistence', () => ({
  readSettings: mocks.readSettings,
  updateSettings: mocks.updateSettings,
}))

import { resolveDaemonMcpConfigEnvironment } from './daemonMcpConfig'

describe('resolveDaemonMcpConfigEnvironment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readSettings.mockResolvedValue({
      schemaVersion: 2,
      onboardingCompleted: true,
    })
    mocks.updateSettings.mockImplementation(async updater => updater({
      schemaVersion: 2,
      onboardingCompleted: true,
    }))
  })

  it('uses and persists an explicit config URL before a detached daemon start', async () => {
    const environment = {
      HAPPY_APLUS_MCP_CONFIG_URL: 'https://studio.example/api/me/mcp-config',
      HAPPY_APLUS_MCP_CALLER_GRANT: 'sensitive-grant',
    }

    await expect(resolveDaemonMcpConfigEnvironment(environment, { persistExplicit: true }))
      .resolves.toEqual(environment)
    expect(mocks.readSettings).not.toHaveBeenCalled()
    expect(mocks.updateSettings).toHaveBeenCalledTimes(1)

    const updater = mocks.updateSettings.mock.calls[0]?.[0]
    expect(await updater({ schemaVersion: 2, onboardingCompleted: true })).toEqual({
      schemaVersion: 2,
      onboardingCompleted: true,
      aplusMcpConfigUrl: 'https://studio.example/api/me/mcp-config',
    })
  })

  it('prefers an explicit config URL over a different persisted URL', async () => {
    const environment = {
      HAPPY_APLUS_MCP_CONFIG_URL: 'https://explicit.example/api/me/mcp-config',
    }
    mocks.readSettings.mockResolvedValue({
      schemaVersion: 2,
      onboardingCompleted: true,
      aplusMcpConfigUrl: 'https://persisted.example/api/me/mcp-config',
    })

    await expect(resolveDaemonMcpConfigEnvironment(environment)).resolves.toEqual(environment)
    expect(mocks.readSettings).not.toHaveBeenCalled()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('restores the persisted config URL when the caller environment omits it', async () => {
    mocks.readSettings.mockResolvedValue({
      schemaVersion: 2,
      onboardingCompleted: true,
      aplusMcpConfigUrl: 'https://persisted.example/api/me/mcp-config',
    })

    await expect(resolveDaemonMcpConfigEnvironment({ EXISTING: 'value' })).resolves.toEqual({
      EXISTING: 'value',
      HAPPY_APLUS_MCP_CONFIG_URL: 'https://persisted.example/api/me/mcp-config',
    })
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('does not infer or inject a config URL when none was configured', async () => {
    const environment = { EXISTING: 'value' }

    await expect(resolveDaemonMcpConfigEnvironment(environment)).resolves.toBe(environment)
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it.each([
    'not-a-url',
    'file:///tmp/mcp-config',
    'https://user:password@studio.example/api/me/mcp-config',
  ])('rejects an invalid explicit config URL without persisting it: %s', async invalidUrl => {
    await expect(resolveDaemonMcpConfigEnvironment(
      { HAPPY_APLUS_MCP_CONFIG_URL: invalidUrl },
      { persistExplicit: true },
    )).rejects.toThrow('Invalid HAPPY_APLUS_MCP_CONFIG_URL')
    expect(mocks.readSettings).not.toHaveBeenCalled()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('rejects an invalid persisted URL instead of silently starting without MCP config', async () => {
    mocks.readSettings.mockResolvedValue({
      schemaVersion: 2,
      onboardingCompleted: true,
      aplusMcpConfigUrl: 'not-a-url',
    })

    await expect(resolveDaemonMcpConfigEnvironment({}))
      .rejects.toThrow('Invalid persisted Aplus MCP config URL')
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })
})
