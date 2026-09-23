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
      expiresAt: Date.now() + 60_000,
      sourceMachineId: 'source-1',
      hostMachineId: 'host-1',
      hostProcessKeyId: 'key-1',
      hostProcessPublicKey: encodeBase64(new Uint8Array(32).fill(1)),
      maxInputChars: 8000,
      modelMaxInputTokens: 512,
      relayDeadlineAt: Date.now() + 3000,
      // The client negotiates timing v2, so a compliant server always answers on it.
      timingVersion: 2,
      requestId: 'client-1',
      issuedAt: Date.now(),
      ttlMs: 60_000,
      relayTtlMs: 3_000,
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

  // R11 은 원격 분류가 더하는 대기의 상한을 정한다. 실행측 몫은 3000ms 인데, 이것은
  // **grant 와 relay 가 나눠 쓰는 하나의 예산**이지 각각의 예산이 아니다. 각자 3000ms 를
  // 가지면 총 추가 대기가 6초가 되어 상한이 조용히 두 배가 된다 — 오류가 아니라
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
        vi.advanceTimersByTime(2950)
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
    expect(grantBudget).toBe(3000)
    // grant 가 2950ms 를 썼으므로 relay 에 남은 것은 50ms 뿐이다.
    expect(relayBudget).toBeLessThanOrEqual(50)
    // 0 이하로 접히면 relay 가 즉시 중단되어 P2 가 사실상 꺼진다.
    expect(relayBudget).toBeGreaterThan(0)
  })

  it('accepts a server relay deadline computed after grant response latency', async () => {
    const fetchMock = vi.fn(async () => {
      vi.advanceTimersByTime(50)
      return Response.json(grantResponse({ relayDeadlineAt: Date.now() + 3000 }))
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
      model: 'claude-opus-5-5',
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

// grant 가 거부되면 턴은 조용히 기존 모델로 진행한다. 운영에서 실제로 여기서 끊겼는데
// 로그가 `reason: 'grant-rejected'` 하나뿐이라 원인을 특정할 수 없었다 — reason 이 비는
// 경로가 네 가지(parse/http/response/validation)이고, validation 안에서도 여러 조건이
// 동시에 틀릴 수 있기 때문이다.
describe('grant rejection detail', () => {
  function captureDebug() {
    const lines: Array<{ message: string; args: unknown[] }> = []
    vi.spyOn(logger, 'debug').mockImplementation((message: string, ...args: unknown[]) => {
      lines.push({ message, args })
    })
    return lines
  }
  const dump = (lines: Array<{ message: string; args: unknown[] }>) =>
    JSON.stringify(lines.filter((l) => l.message.includes('[difficultyRouting]')))

  it('names the stage when the response body is not an object', async () => {
    const lines = captureDebug()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))

    expect(await resolveDifficultyRouting(baseInput)).toBeNull()
    expect(dump(lines)).toContain('parse')
  })

  it('names the stage and status when the server answers with an HTTP error', async () => {
    const lines = captureDebug()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 503 })))

    expect(await resolveDifficultyRouting(baseInput)).toBeNull()
    const text = dump(lines)
    expect(text).toContain('http')
    expect(text).toContain('503')
  })

  it('names the stage when the server answers ok:false without a reason', async () => {
    const lines = captureDebug()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false })))

    expect(await resolveDifficultyRouting(baseInput)).toBeNull()
    expect(dump(lines)).toContain('response')
  })

  // 단일 원인을 가정하면 첫 번째 실패만 보고 엉뚱한 곳을 고치게 된다.
  it('collects every failed condition, not just the first', async () => {
    const lines = captureDebug()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(grantResponse({
      maxInputChars: 4000,
      modelMaxInputTokens: 256,
      hostMachineId: '',
    }))))

    expect(await resolveDifficultyRouting(baseInput)).toBeNull()
    const text = dump(lines)
    expect(text).toContain('validation')
    expect(text).toContain('maxInputChars')
    expect(text).toContain('modelMaxInputTokens')
    expect(text).toContain('hostMachineId')
  })

  // 서버 시계가 앞서면 상한을 넘는다. 클라이언트 시계를 고정하고 발급값만 앞당겨
  // 재현한다 — fake timer 를 전진시키면 TTL 이 줄어들 뿐이라 이 결함이 재현되지 않는다.
  // This used to assert the opposite: a server 5s ahead produced `expiresAt-too-far` /
  // `relayDeadlineAt-too-far` and the whole turn fell back to the plain send path. That
  // rejection was the production defect, and timing v2 exists to remove it.
  it('accepts a correctly issued grant from a server whose clock is ahead', async () => {
    const lines = captureDebug()
    const serverNow = Date.now() + 5_000
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(grantResponse({
      issuedAt: serverNow,
      expiresAt: serverNow + 60_000,
      relayDeadlineAt: serverNow + 3_000,
    }))))

    expect(await resolveDifficultyRouting(baseInput)).not.toBeNull()
    const text = dump(lines)
    expect(text).not.toContain('too-far')
  })

  it('still accepts a grant issued exactly at the contract TTL', async () => {
    captureDebug()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(grantResponse())))

    expect(await resolveDifficultyRouting(baseInput)).not.toBeNull()
  })

  it('rejects a self-contradictory grant and a non-numeric deadline', async () => {
    const lines = captureDebug()
    // Rejected because the server's own values disagree, not because of any local clock.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(grantResponse({ expiresAt: Date.now() - 1 }))))
    // Refused as a grant — the relay is never dispatched — so the turn falls back to P1.
    expect((await resolveDifficultyRouting(baseInput))?.event.ev)
      .toMatchObject({ result: { classifierSource: 'fallback-p1' } })
    expect(dump(lines)).toContain('ttlMs-mismatch')

    const other = captureDebug()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(grantResponse({ relayDeadlineAt: 'soon' }))))
    expect(await resolveDifficultyRouting(baseInput)).toBeNull()
    expect(dump(other)).toContain('relayDeadlineAt')
  })

  it('keeps the grant token and keys out of the failure log', async () => {
    const lines = captureDebug()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(grantResponse({ maxInputChars: 1 }))))

    expect(await resolveDifficultyRouting(baseInput)).toBeNull()
    const text = dump(lines)
    // 로그가 0건이면 아래 단언이 모두 무의미해진다.
    expect(text).toContain('validation')
    expect(text).not.toContain('signed-grant')
    expect(text).not.toContain('routing-authorization')
    expect(text).not.toContain(encodeBase64(new Uint8Array(32).fill(1)))
  })
})

/**
 * The production failure: a correctly issued grant was rejected because the client compared
 * the server's absolute instants against its own wall clock. With `timingVersion: 2` the
 * server ships durations and the client only checks server values against each other.
 */
describe('timing v2 grant negotiation', () => {
  const originalConfigUrl = process.env.HAPPY_APLUS_MCP_CONFIG_URL

  // The circuit breaker is module state and earlier failing tests in this file leave it armed.
  // A tripped breaker short-circuits to P1 before the relay, which would make these tests pass
  // without ever exercising what they claim to. Each one starts from a fresh module.
  let resolve: typeof resolveDifficultyRouting

  beforeEach(async () => {
    vi.resetModules()
    resolve = (await import('./difficultyRoutingRuntime')).resolveDifficultyRouting
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    process.env.HAPPY_APLUS_MCP_CONFIG_URL = 'https://web.example.test/api/me/mcp-config?project_id=p1'
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (originalConfigUrl === undefined) delete process.env.HAPPY_APLUS_MCP_CONFIG_URL
    else process.env.HAPPY_APLUS_MCP_CONFIG_URL = originalConfigUrl
  })

  /** Built entirely from the server's own clock, which may sit anywhere relative to ours. */
  function v2Grant(serverNow: number, over: Record<string, unknown> = {}) {
    return {
      ok: true,
      grant: {
        version: 1,
        grantId: 'grant-1',
        policyRevision: 7,
        expiresAt: serverNow + 60_000,
        sourceMachineId: 'source-1',
        hostMachineId: 'host-1',
        hostProcessKeyId: 'key-1',
        hostProcessPublicKey: encodeBase64(new Uint8Array(32).fill(1)),
        maxInputChars: 8000,
        modelMaxInputTokens: 512,
        relayDeadlineAt: serverNow + 3_000,
        timingVersion: 2,
        requestId: 'client-1',
        issuedAt: serverNow,
        ttlMs: 60_000,
        relayTtlMs: 3_000,
        ...over,
      },
      aiModelPolicy: { source: 'unrestricted', allowedSelectionKeys: null, defaultSelectionKey: null },
      signedGrant: 'signed-grant',
    }
  }

  function bodyOf(mock: ReturnType<typeof vi.fn>, call = 0) {
    return JSON.parse((mock.mock.calls[call][1] as { body: string }).body)
  }

  it('asks for the duration contract', async () => {
    const fetchMock = vi.fn(async () => Response.json(v2Grant(Date.now())))
    vi.stubGlobal('fetch', fetchMock)
    await resolve(baseInput)
    expect(bodyOf(fetchMock).timingVersion).toBe(2)
    expect(bodyOf(fetchMock).maxRelayTtlMs).toBe(3000)
  })

  // The exact production numbers: 60002 / 1002 against ceilings of 60000 / 1000.
  it('accepts the grant that the absolute-instant check used to reject', async () => {
    const fetchMock = vi.fn(async () => Response.json(v2Grant(Date.now() + 2)))
    vi.stubGlobal('fetch', fetchMock)

    const decision = await resolve(baseInput)
    expect(decision?.event.ev).toMatchObject({ result: { classifierSource: 'p1-local' } })
  })

  it('decides the same way however far the two clocks sit apart', async () => {
    for (const skewMs of [2, -2, 2_000, -2_000, 86_400_000, -86_400_000]) {
      const fetchMock = vi.fn(async () => Response.json(v2Grant(Date.now() + skewMs)))
      vi.stubGlobal('fetch', fetchMock)
      const decision = await resolve(baseInput)
      expect(decision?.event.ev, `skew ${skewMs}`).toMatchObject({ result: { classifierSource: 'p1-local' } })
    }
  })

  // Server values must agree with each other; that is the only arithmetic left. Refusing the
  // grant means refusing to relay against it — the relay is never dispatched — but the turn
  // still gets the local decision, which needs no grant and no budget.
  it('refuses a grant whose own durations contradict its instants', async () => {
    for (const over of [
      { ttlMs: 59_999 },
      { relayTtlMs: 999 },
      { issuedAt: 1 },
      { ttlMs: 60_001, expiresAt: 1 },
      { relayTtlMs: 0 },
      { relayTtlMs: 3_001 },
      { ttlMs: '60000' },
      { issuedAt: -1 },
    ]) {
      const fetchMock = vi.fn(async () => Response.json(v2Grant(Date.now(), over)))
      vi.stubGlobal('fetch', fetchMock)
      const decision = await resolve(baseInput)
      expect(fetchMock, JSON.stringify(over)).toHaveBeenCalledTimes(1)
      expect(decision?.event.ev, JSON.stringify(over)).toMatchObject({
        result: { classifierSource: 'fallback-p1', policyRevision: null },
      })
    }
  })

  // An old server answers the v2 request on the v1 contract. That is not a negotiated v2
  // grant, and a client that treated it as one would be back to comparing foreign instants.
  it('refuses a grant that claims any contract but the negotiated one', async () => {
    for (const timingVersion of [1, 3, '2', null, undefined]) {
      const body = grantResponse() as { grant: Record<string, unknown> }
      if (timingVersion === undefined) delete body.grant.timingVersion
      else body.grant.timingVersion = timingVersion
      const fetchMock = vi.fn(async () => Response.json(body))
      vi.stubGlobal('fetch', fetchMock)
      const decision = await resolve(baseInput)
      expect(fetchMock, String(timingVersion)).toHaveBeenCalledTimes(1)
      expect(decision?.event.ev, String(timingVersion)).toMatchObject({
        result: { classifierSource: 'fallback-p1' },
      })
    }
  })

  it('does not read a legacy answer as a successful negotiation', async () => {
    const legacy = grantResponse() as { grant: Record<string, unknown> }
    for (const field of ['timingVersion', 'requestId', 'issuedAt', 'ttlMs', 'relayTtlMs']) {
      delete legacy.grant[field]
    }
    const fetchMock = vi.fn(async () => Response.json(legacy))
    vi.stubGlobal('fetch', fetchMock)
    const decision = await resolve(baseInput)
    // No relay: the grant was not accepted.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(decision?.event.ev).toMatchObject({ result: { classifierSource: 'fallback-p1' } })
  })

  // The CLI is published to npm and upgraded independently of the aplus API, so a client can
  // run ahead of the deployment. Refusing the legacy grant is intended; losing routing for the
  // whole turn because the refusal also threw away the policy snapshot is not.
  it('keeps routing locally when the server has not shipped the negotiated contract', async () => {
    const legacy = grantResponse() as { grant: Record<string, unknown> }
    for (const field of ['timingVersion', 'requestId', 'issuedAt', 'ttlMs', 'relayTtlMs']) {
      delete legacy.grant[field]
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(legacy)))

    const decision = await resolve(baseInput)
    expect(decision).not.toBeNull()
    expect(decision?.route.source).toBe('p1')
  })

  // A grant that is malformed outside the timing contract is a broken server, not an older
  // one, and still carries no authority to route.
  it('does not read an unrelated validation failure as a contract mismatch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(grantResponse({ hostMachineId: '' }))))
    expect(await resolve(baseInput)).toBeNull()
  })

  // `unsupported` carries no policy snapshot, so there is no authority for a local override.
  it('keeps the existing send path when the host cannot speak the contract', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: false, reason: 'unsupported', timingVersion: 2 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await resolve(baseInput)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

/**
 * One deadline is taken when the turn starts and is never extended. Everything downstream is
 * measured against it on the monotonic clock, so a wall-clock adjustment mid-turn cannot buy
 * or destroy budget, and a result that lands after it is never applied.
 */
describe('timing v2 execution budget', () => {
  const originalConfigUrl = process.env.HAPPY_APLUS_MCP_CONFIG_URL
  const RELAY_PROMPT = 'Add a save button to the draft form'

  // The circuit breaker is module state and earlier failing tests in this file leave it armed.
  // A tripped breaker short-circuits to P1 before the relay, which would make these tests pass
  // without ever exercising what they claim to. Each one starts from a fresh module.
  let resolve: typeof resolveDifficultyRouting

  beforeEach(async () => {
    vi.resetModules()
    resolve = (await import('./difficultyRoutingRuntime')).resolveDifficultyRouting
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    process.env.HAPPY_APLUS_MCP_CONFIG_URL = 'https://web.example.test/api/me/mcp-config?project_id=p1'
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (originalConfigUrl === undefined) delete process.env.HAPPY_APLUS_MCP_CONFIG_URL
    else process.env.HAPPY_APLUS_MCP_CONFIG_URL = originalConfigUrl
  })

  function relayOk() {
    return {
      ok: true,
      result: {
        version: 1, timingVersion: 2, requestId: 'client-1', policyRevision: 7,
        status: 'ok', difficulty: 'hard', classifierRevision: 'rev-1', elapsedMs: 1,
      },
    }
  }

  /** `grantMs` is spent answering the grant, `relayMs` answering the relay. */
  function wire(over: { grantMs?: number; relayMs?: number; relayBody?: unknown } = {}) {
    const relayBodies: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
      if (String(url).includes('/grant')) {
        if (over.grantMs) await vi.advanceTimersByTimeAsync(over.grantMs)
        return Response.json(grantResponse())
      }
      relayBodies.push(JSON.parse(init.body))
      if (over.relayMs) await vi.advanceTimersByTimeAsync(over.relayMs)
      return Response.json(over.relayBody ?? relayOk())
    })
    vi.stubGlobal('fetch', fetchMock)
    return { fetchMock, relayBodies }
  }

  it('sends the relay a duration, never an instant borrowed from the grant', async () => {
    const { relayBodies } = wire({ grantMs: 200 })
    await resolve({ ...baseInput, contentText: RELAY_PROMPT })

    expect(relayBodies).toHaveLength(1)
    expect(relayBodies[0]).not.toHaveProperty('deadlineAt')
    expect(relayBodies[0].timingVersion).toBe(2)
    // 3000 total, 200 already spent on the grant, and sealing costs a little more.
    expect(relayBodies[0].remainingMs).toBeGreaterThan(0)
    expect(relayBodies[0].remainingMs).toBeLessThanOrEqual(2800)
  })

  // Receiving the grant must not restart the TTL: the server issued it before we saw it.
  it('does not restart the budget when the grant arrives', async () => {
    const { relayBodies } = wire({ grantMs: 2950 })
    await resolve({ ...baseInput, contentText: RELAY_PROMPT })
    expect(relayBodies[0]?.remainingMs).toBeLessThanOrEqual(50)
  })

  // With the default 3000ms relay budget the 3000ms turn deadline always wins, so the
  // round-trip deduction is invisible. A server that issues a tighter budget exposes it.
  it('charges the grant round trip against the budget the server issued', async () => {
    const relayBodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
      if (String(url).includes('/grant')) {
        await vi.advanceTimersByTimeAsync(200)
        const now = Date.now()
        return Response.json(grantResponse({
          issuedAt: now, relayTtlMs: 400, relayDeadlineAt: now + 400,
        }))
      }
      relayBodies.push(JSON.parse(init.body))
      return Response.json(relayOk())
    }))

    await resolve({ ...baseInput, contentText: RELAY_PROMPT })
    expect(relayBodies).toHaveLength(1)
    // 400 issued, 200 already spent on the round trip → at most 200 left, not a fresh 400.
    expect(relayBodies[0].remainingMs).toBeLessThanOrEqual(200)
    expect(relayBodies[0].remainingMs).toBeGreaterThan(0)
  })

  it('never dispatches a relay once the budget is spent', async () => {
    for (const grantMs of [3000, 3200]) {
      const { fetchMock, relayBodies } = wire({ grantMs })
      const decision = await resolve({ ...baseInput, contentText: RELAY_PROMPT })
      expect(relayBodies, `grant took ${grantMs}ms`).toHaveLength(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(decision).toBeNull()
    }
  })

  // The budget is checked when the grant lands and again right before the relay. Asserting
  // WHICH one fired keeps either from silently covering for the other being deleted.
  it('stops as soon as the grant itself exhausted the budget', async () => {
    const lines: unknown[] = []
    // The runtime under test came from a reset module graph, so it holds a different logger
    // instance than this file's top-level import. Spy on the one it actually calls.
    const freshLogger = (await import('./ui/logger')).logger
    vi.spyOn(freshLogger, 'debug').mockImplementation((message: string, ...args: unknown[]) => {
      lines.push({ message, args })
    })
    wire({ grantMs: 3100 })
    expect(await resolve({ ...baseInput, contentText: RELAY_PROMPT })).toBeNull()
    expect(JSON.stringify(lines)).toContain('budget-spent')
    expect(JSON.stringify(lines)).not.toContain('budget-spent-before-relay')
  })

  // Asserting `not.toMatchObject` on a possibly-undefined event passes when nothing at all is
  // returned, so it cannot tell "the late answer was dropped" from "the turn lost its routing".
  // Name the outcome instead: the remote answer is discarded, the local decision still applies.
  it('discards a relay answer that lands after the deadline', async () => {
    for (const relayMs of [3000, 3200]) {
      const { relayBodies } = wire({ relayMs })
      const decision = await resolve({ ...baseInput, contentText: RELAY_PROMPT })
      expect(relayBodies, `relay took ${relayMs}ms`).toHaveLength(1)
      expect(decision?.event.ev, `relay took ${relayMs}ms`).toMatchObject({
        result: { classifierSource: 'fallback-p1' },
      })
    }
  })

  // A late answer costs the same wall time as no answer, and the branch right below this one
  // already degrades an unusable answer to the free local decision. Returning null instead
  // means one slow server turn silently removes routing from the turn entirely.
  it('keeps routing the turn when the relay answers past the deadline', async () => {
    const { relayBodies } = wire({ relayMs: 3000 })
    const decision = await resolve({ ...baseInput, contentText: RELAY_PROMPT })
    expect(relayBodies).toHaveLength(1)
    expect(decision).not.toBeNull()
    expect(decision?.route.source).toBe('p1')
  })

  it('still applies a relay answer that lands just inside the deadline', async () => {
    const { relayBodies } = wire({ relayMs: 2900 })
    const decision = await resolve({ ...baseInput, contentText: RELAY_PROMPT })
    expect(relayBodies).toHaveLength(1)
    expect(decision?.event.ev).toMatchObject({ result: { classifierSource: 'p2-org-shared' } })
  })

  // The breaker counts real elapsed time, so a wall-clock jump can neither arm nor release it.
  it('holds the circuit breaker open on the monotonic clock', async () => {
    const relayCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/classify')).length
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/grant')) return Response.json(grantResponse())
      return Response.json({ ok: true, result: { version: 1, timingVersion: 2, requestId: 'client-1', policyRevision: 7, status: 'error' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    for (let i = 0; i < 3; i++) await resolve({ ...baseInput, contentText: RELAY_PROMPT })
    expect(relayCalls()).toBe(3)

    // Armed: the next turn short-circuits to P1 without a relay.
    await resolve({ ...baseInput, contentText: RELAY_PROMPT })
    expect(relayCalls()).toBe(3)

    // A wall clock leap is not elapsed time.
    vi.setSystemTime(1_700_000_000_000 + 3_600_000)
    await resolve({ ...baseInput, contentText: RELAY_PROMPT })
    expect(relayCalls()).toBe(3)
    vi.setSystemTime(1_700_000_000_000)

    // Real elapsed time does release it.
    await vi.advanceTimersByTimeAsync(30_001)
    await resolve({ ...baseInput, contentText: RELAY_PROMPT })
    expect(relayCalls()).toBe(4)
  })

  // A wall-clock adjustment mid-turn must not move the deadline in either direction.
  it('ignores a wall clock jump in the middle of the turn', async () => {
    for (const jumpMs of [3_600_000, -3_600_000]) {
      const relayBodies: Record<string, unknown>[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
        if (String(url).includes('/grant')) {
          await vi.advanceTimersByTimeAsync(200)
          vi.setSystemTime(1_700_000_000_000 + jumpMs)
          return Response.json(grantResponse())
        }
        relayBodies.push(JSON.parse(init.body))
        return Response.json(relayOk())
      }))

      const decision = await resolve({ ...baseInput, contentText: RELAY_PROMPT })
      expect(relayBodies, `jump ${jumpMs}`).toHaveLength(1)
      expect(relayBodies[0].remainingMs).toBeLessThanOrEqual(2800)
      expect(relayBodies[0].remainingMs).toBeGreaterThan(2600)
      expect(decision?.event.ev).toMatchObject({ result: { classifierSource: 'p2-org-shared' } })
      vi.setSystemTime(1_700_000_000_000)
    }
  })
})
