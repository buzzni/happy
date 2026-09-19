/** 부모 검증: daemon 주입 → adapter → wire 스키마 종단 사슬. */
import { describe, expect, it } from 'vitest'
import { ProviderUsageEventV1Schema } from '@slopus/happy-wire'
import { createClaudeUsageEvent, createCodexUsageEvent } from './providerUsageAdapters'
import { HAPPY_AI_AUTH_SOURCE_ENV, HAPPY_AI_AUTH_CONNECTION_VERSION_ENV } from './aiAuthSource'
import { applyAppliedAiAuthSourceEnv, scrubSessionLineageEnv } from '../daemon/sessionEnv'

const claudeArgs = {
  sessionId: 's1', occurredAt: 1, transcriptUuid: 'u1', model: 'claude-opus-5',
  usage: { input_tokens: 2, output_tokens: 1 },
}

describe('종단: 적용 원천이 이벤트까지 간다', () => {
  it('daemon 이 심은 원천이 Claude 이벤트를 타고 wire 를 통과한다', () => {
    const env = applyAppliedAiAuthSourceEnv({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'x',
    })
    expect(env[HAPPY_AI_AUTH_SOURCE_ENV]).toBe('platform-glm')
    const event = createClaudeUsageEvent({ ...claudeArgs, env })
    expect(ProviderUsageEventV1Schema.safeParse(event).success).toBe(true)
    expect(event.aiAuth?.appliedSource).toBe('platform-glm')
  })

  it('원천을 모르면 이벤트가 추정하지 않는다', () => {
    const env = applyAppliedAiAuthSourceEnv({ ANTHROPIC_API_KEY: 'sk-x' })
    expect(env[HAPPY_AI_AUTH_SOURCE_ENV]).toBe('unknown')
    const event = createClaudeUsageEvent({ ...claudeArgs, env })
    expect(ProviderUsageEventV1Schema.safeParse(event).success).toBe(true)
    expect(event.aiAuth?.appliedSource ?? 'unknown').toBe('unknown')
  })

  it('managed 가 심은 personal 원천과 연결 버전이 Codex 이벤트에 실린다', () => {
    const env = {
      [HAPPY_AI_AUTH_SOURCE_ENV]: 'personal-subscription',
      [HAPPY_AI_AUTH_CONNECTION_VERSION_ENV]: '7',
    }
    const event = createCodexUsageEvent({
      sessionId: 's1', occurredAt: 1, responseId: 'e1', model: 'gpt-5.6-codex',
      usage: { totalTokens: 3, inputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
      env,
    })
    expect(ProviderUsageEventV1Schema.safeParse(event).success).toBe(true)
    expect(event.aiAuth).toEqual({ appliedSource: 'personal-subscription', connectionVersion: 7 })
  })

  it('보안: 원천 키는 lineage 스크럽으로 제거된다 — 재시작한 daemon 이 남의 원천을 물려주지 않는다', () => {
    const scrubbed = scrubSessionLineageEnv({
      [HAPPY_AI_AUTH_SOURCE_ENV]: 'personal-subscription',
      [HAPPY_AI_AUTH_CONNECTION_VERSION_ENV]: '7',
      PATH: '/usr/bin',
    })
    expect(scrubbed[HAPPY_AI_AUTH_SOURCE_ENV]).toBeUndefined()
    expect(scrubbed[HAPPY_AI_AUTH_CONNECTION_VERSION_ENV]).toBeUndefined()
    expect(scrubbed.PATH).toBe('/usr/bin')
  })
})

/**
 * 배선 가드 (AGENTS §1.13 조용한 실패).
 *
 * 위 사슬 테스트는 헬퍼를 직접 불러서 검증한다. daemon 이 spawn/resume 에서 실제로
 * 그 헬퍼를 통과시키는지는 검사하지 않는다 — 누가 래핑을 벗겨도 테스트는 전부 통과하고
 * 모든 이벤트가 조용히 `unknown` 으로 돌아간다. 통합 테스트는 기준선부터 실패 중이라
 * 여기서는 소스 배선을 직접 본다.
 */
describe('배선 가드: daemon 이 실제로 원천을 심는가', () => {
  it('run.ts 의 spawn·resume 경로가 헬퍼를 통과한다', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const source = await readFile(
      fileURLToPath(new URL('../daemon/run.ts', import.meta.url)),
      'utf8',
    )
    // 호출부 3 곳: tmux spawn / 일반 spawn / resume. import 줄은 괄호가 없어 안 세진다.
    const calls = source.split('applyAppliedAiAuthSourceEnv(').length - 1
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  it('managed 실행이 봉투의 권위 값을 심는다', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const source = await readFile(
      fileURLToPath(new URL('../managed/managedStartup.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toContain('aiAuthSourceForManagedKind')
    expect(source).toContain(HAPPY_AI_AUTH_SOURCE_ENV)
  })
})
