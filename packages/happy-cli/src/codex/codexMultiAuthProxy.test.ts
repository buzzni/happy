import { describe, expect, it, vi } from 'vitest'
import {
  getCodexMultiAuthProxyStatus,
  prepareCodexMultiAuthProxy,
} from './codexMultiAuthProxy'

describe('Codex multi-auth proxy adapter', () => {
  it('starts a loopback proxy at the 5% cutoff and returns official Codex config arguments', async () => {
    const close = vi.fn(async () => undefined)
    const startProxy = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:4567', close }))
    const prepared = await prepareCodexMultiAuthProxy({
      CODEX_HOME: '/fixed/codex',
      PATH: '/usr/bin',
    }, {
      readFile: vi.fn(async () => JSON.stringify({
        version: 1,
        pluginConfig: {
          codexRuntimeRotationProxy: true,
          schedulingStrategy: 'sequential',
          preemptiveQuotaEnabled: true,
          preemptiveQuotaRemainingPercent5h: 5,
          preemptiveQuotaRemainingPercent7d: 5,
          routingMutex: 'enabled',
          sessionAffinity: false,
          pidOffsetEnabled: false,
        },
      })),
      startProxy,
      createClientKey: () => 'local-client-key',
    })

    expect(startProxy).toHaveBeenCalledWith({
      clientApiKey: 'local-client-key',
      quotaRemainingPercentThreshold: 5,
    })
    expect(prepared).toMatchObject({
      env: {
        CODEX_HOME: '/fixed/codex',
        CODEX_MULTI_AUTH_DIR: '/fixed/codex/multi-auth',
        OPENAI_API_KEY: 'local-client-key',
      },
      args: expect.arrayContaining([
        '-c', 'model_provider="codex-multi-auth-runtime-proxy"',
      ]),
    })
    expect(getCodexMultiAuthProxyStatus()).toEqual({ activeRoutes: 1 })

    await prepared?.cleanup()

    expect(close).toHaveBeenCalledOnce()
    expect(getCodexMultiAuthProxyStatus()).toEqual({ activeRoutes: 0 })
  })

  it('does not route machines without an enabled managed configuration', async () => {
    const startProxy = vi.fn()
    const prepared = await prepareCodexMultiAuthProxy({}, {
      readFile: vi.fn(async () => JSON.stringify({ version: 1, pluginConfig: {} })),
      startProxy,
      createClientKey: () => 'unused',
    })

    expect(prepared).toBeNull()
    expect(startProxy).not.toHaveBeenCalled()
  })

  it('fails closed when a managed proxy configuration drifts from the 5% policy', async () => {
    const startProxy = vi.fn()

    await expect(prepareCodexMultiAuthProxy({}, {
      readFile: vi.fn(async () => JSON.stringify({
        version: 1,
        pluginConfig: {
          codexRuntimeRotationProxy: true,
          schedulingStrategy: 'sequential',
          preemptiveQuotaEnabled: false,
          preemptiveQuotaRemainingPercent5h: 5,
          preemptiveQuotaRemainingPercent7d: 5,
          routingMutex: 'enabled',
          sessionAffinity: false,
          pidOffsetEnabled: false,
        },
      })),
      startProxy,
      createClientKey: () => 'unused',
    })).rejects.toThrow(/settings/i)
    expect(startProxy).not.toHaveBeenCalled()
  })

  it('fails closed when the managed settings file is malformed', async () => {
    await expect(prepareCodexMultiAuthProxy({}, {
      readFile: vi.fn(async () => '{not-json'),
      startProxy: vi.fn(),
      createClientKey: () => 'unused',
    })).rejects.toThrow(/settings/i)
  })
})
