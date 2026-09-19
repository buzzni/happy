import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAplusApiOrigin, resolveDifficultyRouting } from './difficultyRoutingRuntime'
import { logger } from './ui/logger'
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

  // R11 은 원격 분류가 더하는 대기의 상한을 정한다. 실행측 몫은 750ms 인데, 이것은
  // **grant 와 relay 가 나눠 쓰는 하나의 예산**이지 각각의 예산이 아니다. 각자 750ms 를
  // 가지면 총 추가 대기가 1.5초가 되어 상한이 조용히 두 배가 된다 — 오류가 아니라
  // "앱이 느려졌다"로만 나타난다. relay 에 독립 예산을 주는 변이가 기존 60건을 모두
  // 통과했으므로 여기서 직접 고정한다.
  //
  // 프롬프트는 P1 이 확신하지 못하는 것이어야 relay 까지 간다. relay 는 성공시켜
  // 서킷 브레이커(연속 3회 실패)를 건드리지 않는다.
  it('gives the relay only the budget the grant left behind (R11)', async () => {
    const timeouts: number[] = []
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(((ms: number) => {
      timeouts.push(ms)
      return realTimeout(ms)
    }) as typeof AbortSignal.timeout)
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/grant')) {
        vi.advanceTimersByTime(700)
        return Response.json(grantResponse())
      }
      return Response.json({
        version: 1, requestId: 'client-1', policyRevision: 7,
        status: 'ok', difficulty: 'hard', classifierRevision: 'rev-1', elapsedMs: 1,
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await resolveDifficultyRouting({ ...baseInput, contentText: 'Add a save button to the draft form' })

    // 1개뿐이면 relay 까지 가지 않은 것이므로 조용히 통과시키지 않고 여기서 실패한다.
    expect(timeouts.length).toBeGreaterThanOrEqual(2)
    const [grantBudget, relayBudget] = timeouts
    expect(grantBudget).toBe(750)
    // grant 가 700ms 를 썼으므로 relay 에 남은 것은 50ms 뿐이다.
    expect(relayBudget).toBeLessThanOrEqual(50)
    // 0 이하로 접히면 relay 가 즉시 중단되어 P2 가 사실상 꺼진다.
    expect(relayBudget).toBeGreaterThan(0)
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

// 이 경로는 실패해도 기존 모델로 조용히 폴백한다. 운영에서 "라우팅이 안 걸린다"를
// 조사할 때 어느 단계에서 끊겼는지 알 방법이 로그뿐인데, 종전에는 이 파일에 로그
// 호출이 하나도 없어 RPC 응답 바이트 크기로 성패를 추정해야 했다.
describe('difficulty routing diagnostics', () => {
  function captureDebug() {
    const lines: Array<{ message: string; args: unknown[] }> = []
    vi.spyOn(logger, 'debug').mockImplementation((message: string, ...args: unknown[]) => {
      lines.push({ message, args })
    })
    return lines
  }

  it('records why a turn was skipped before any network call', async () => {
    const lines = captureDebug()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const decision = await resolveDifficultyRouting({
      ...baseInput,
      meta: { difficultyRoutingIntent: intent },
    })

    expect(decision).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    const skipped = lines.find((line) => line.message.includes('[difficultyRouting]'))
    expect(skipped, '건너뛴 사유가 로그에 남아야 한다').toBeTruthy()
    expect(JSON.stringify(skipped)).toContain('missing-authorization')
  })

  it('records the applied decision with its classifier source, model and effort', async () => {
    const lines = captureDebug()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(grantResponse())))

    const decision = await resolveDifficultyRouting(baseInput)

    expect(decision?.route.model).toBe('claude-haiku-4-5')
    const applied = lines.filter((line) => line.message.includes('[difficultyRouting]'))
    expect(applied.length, '결정이 로그에 남아야 한다').toBeGreaterThan(0)
    const dump = JSON.stringify(applied)
    expect(dump).toContain('p1-local')
    expect(dump).toContain('claude-haiku-4-5')
  })

  it('never writes the prompt or the turn authorization into the log', async () => {
    const lines = captureDebug()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(grantResponse())))

    await resolveDifficultyRouting({
      ...baseInput,
      contentText: 'SECRET-PROMPT-TEXT-do-not-log',
      meta: {
        difficultyRoutingIntent: intent,
        difficultyRoutingAuthorization: 'SECRET-AUTHORIZATION-do-not-log',
      },
    })

    // 건너뛰는 경로도 함께 본다 — 성공 경로만 덮으면 skip 분기에 프롬프트를 흘려도
    // 초록이다(변이로 확인).
    await resolveDifficultyRouting({
      ...baseInput,
      contentText: 'SECRET-PROMPT-TEXT-do-not-log',
      meta: { difficultyRoutingIntent: intent },
    })

    const dump = JSON.stringify(lines)
    expect(dump).not.toContain('SECRET-PROMPT-TEXT')
    expect(dump).not.toContain('SECRET-AUTHORIZATION')
  })
})

