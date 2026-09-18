import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAplusApiOrigin, resolveDifficultyRouting } from './difficultyRoutingRuntime'
import { configuration } from './configuration'
import { encodeBase64 } from './api/encryption'

const intent = {
  version: 1,
  mode: 'auto',
  policy: 'org-shared-difficulty-routing.v1',
  clientRequestId: 'client-1',
  clientRouteSource: 'default-auto',
}

const baseInput = {
  agent: 'claude' as const,
  sourceMachineId: 'source-1',
  sessionId: 'session-1',
  contentText: 'rename this variable',
  meta: {
    difficultyRoutingIntent: intent,
    difficultyRoutingAuthorization: 'routing-authorization',
  },
  current: {},
}

function grantResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    grant: {
      version: 1,
      grantId: 'grant-1',
      policyRevision: 7,
      expiresAt: Date.now() + 10_000,
      sourceMachineId: 'source-1',
      hostMachineId: 'host-1',
      hostProcessKeyId: 'key-1',
      hostProcessPublicKey: encodeBase64(new Uint8Array(32).fill(1)),
      maxInputChars: 8000,
      modelMaxInputTokens: 512,
      relayDeadlineAt: Date.now() + 1000,
      ...overrides,
    },
    aiModelPolicy: {
      source: 'unrestricted',
      allowedSelectionKeys: null,
      defaultSelectionKey: null,
    },
    signedGrant: 'signed-grant',
  }
}

describe('difficulty routing runtime', () => {
  const originalConfigUrl = process.env.HAPPY_APLUS_MCP_CONFIG_URL
  const originalWebappUrl = configuration.webappUrl

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    process.env.HAPPY_APLUS_MCP_CONFIG_URL = 'https://web.example.test/api/me/mcp-config?project_id=p1'
    configuration.webappUrl = 'https://fallback-web.example.test'
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (originalConfigUrl === undefined) {
      delete process.env.HAPPY_APLUS_MCP_CONFIG_URL
    } else {
      process.env.HAPPY_APLUS_MCP_CONFIG_URL = originalConfigUrl
    }
    configuration.webappUrl = originalWebappUrl
  })

  it('uses the APlus web API origin from the configured MCP URL instead of Happy serverUrl', () => {
    expect(resolveAplusApiOrigin()).toBe('https://web.example.test')
  })

  it('falls back to the configured webapp URL when no APlus API URL is injected', () => {
    delete process.env.HAPPY_APLUS_MCP_CONFIG_URL
    expect(resolveAplusApiOrigin()).toBe('https://fallback-web.example.test')
  })

  it('validates the grant before applying a confident local P1 decision', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://web.example.test/api/me/difficulty-routing/grant')
      return Response.json(grantResponse())
    })
    vi.stubGlobal('fetch', fetchMock)

    const decision = await resolveDifficultyRouting(baseInput)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(decision?.route).toMatchObject({
      model: 'claude-haiku-4-5',
      effort: 'low',
      source: 'p1',
      difficulty: 'trivial',
    })
    expect(decision?.event.ev).toMatchObject({
      t: 'difficulty-routing',
      result: {
        clientRequestId: 'client-1',
        classifierSource: 'p1-local',
        policyRevision: 7,
      },
    })
  })

  it('preserves the original send path when authorization cannot be validated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down')
    }))

    await expect(resolveDifficultyRouting(baseInput)).resolves.toBeNull()
  })

  it('does not route wrapped content when the explicit original prompt is empty', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveDifficultyRouting({
      ...baseInput,
      contentText: '<AX>system wrapped content that must not be classified</AX>',
      meta: {
        ...baseInput.meta,
        difficultyRoutingPrompt: '   \n',
      },
    })).resolves.toBeNull()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a grant bound to a different source machine before routing locally', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(grantResponse({ sourceMachineId: 'other-source' }))))

    await expect(resolveDifficultyRouting(baseInput)).resolves.toBeNull()
  })

  it('rejects malformed host process keys before sealing prompt text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(grantResponse({
      hostProcessPublicKey: encodeBase64(new Uint8Array(31).fill(1)),
    }))))

    await expect(resolveDifficultyRouting(baseInput)).resolves.toBeNull()
  })

  it('rejects grants without an effective AI model policy snapshot', async () => {
    const response = grantResponse()
    delete (response as Record<string, unknown>).aiModelPolicy
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)))

    await expect(resolveDifficultyRouting(baseInput)).resolves.toBeNull()
  })

  it('preserves the original path when host-unavailable lacks a valid policy snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      ok: false,
      reason: 'host-unavailable',
      aiModelPolicy: {
        source: 'organization',
        allowedSelectionKeys: null,
        defaultSelectionKey: null,
      },
    })))

    await expect(resolveDifficultyRouting(baseInput)).resolves.toBeNull()
  })

  it('falls back to the current allowed model when routing selects a disallowed model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      ...grantResponse(),
      aiModelPolicy: {
        source: 'member',
        allowedSelectionKeys: ['claude:claude-sonnet-5'],
        defaultSelectionKey: 'claude:claude-sonnet-5',
      },
    })))

    const decision = await resolveDifficultyRouting({
      ...baseInput,
      current: { model: 'claude-sonnet-5', effort: 'high' },
    })

    expect(decision?.route).toMatchObject({
      model: 'claude-sonnet-5',
      effort: 'high',
      source: 'p1',
    })
    expect(decision?.event.ev).toMatchObject({
      t: 'difficulty-routing',
      result: {
        model: 'claude-sonnet-5',
        effort: 'high',
        classifierSource: 'p1-local',
      },
    })
  })

  it('falls back to the allowed default model when the current model is also disallowed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      ...grantResponse(),
      aiModelPolicy: {
        source: 'organization',
        allowedSelectionKeys: ['claude:claude-sonnet-5'],
        defaultSelectionKey: 'claude:claude-sonnet-5',
      },
    })))

    const decision = await resolveDifficultyRouting({
      ...baseInput,
      current: { model: 'claude-opus-5', effort: 'high' },
    })

    expect(decision?.route.model).toBe('claude-sonnet-5')
    expect(decision?.event.ev).toMatchObject({
      t: 'difficulty-routing',
      result: { model: 'claude-sonnet-5' },
    })
  })

  it('accepts a server relay deadline computed after grant response latency', async () => {
    const fetchMock = vi.fn(async () => {
      vi.advanceTimersByTime(50)
      return Response.json(grantResponse({ relayDeadlineAt: Date.now() + 1000 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const decision = await resolveDifficultyRouting(baseInput)

    expect(decision?.event.ev).toMatchObject({
      t: 'difficulty-routing',
      result: { classifierSource: 'p1-local' },
    })
  })

  it('does not carry an expired sticky floor into a new local decision', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(grantResponse())))

    const decision = await resolveDifficultyRouting({
      ...baseInput,
      state: {
        difficulty: 'hard',
        hardTurns: 2,
        updatedAt: Date.now() - 60 * 60 * 1000 - 1,
      },
    })

    expect(decision?.route).toMatchObject({
      difficulty: 'trivial',
      model: 'claude-haiku-4-5',
      effort: 'low',
    })
    expect(decision?.state.hardTurns).toBe(0)
  })

  it('uses the prior difficulty for short continuation without making a P2 relay request', async () => {
    const fetchMock = vi.fn(async () => Response.json(grantResponse()))
    vi.stubGlobal('fetch', fetchMock)

    const decision = await resolveDifficultyRouting({
      ...baseInput,
      contentText: 'continue',
      state: {
        difficulty: 'hard',
        hardTurns: 1,
        updatedAt: Date.now(),
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(decision?.route).toMatchObject({
      difficulty: 'hard',
      rawDifficulty: 'hard',
      model: 'claude-opus-5',
      effort: 'high',
    })
    expect(decision?.event.ev).toMatchObject({
      t: 'difficulty-routing',
      result: { classifierSource: 'p1-local' },
    })
  })
})
