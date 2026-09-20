import { describe, expect, it } from 'vitest'
import {
  DIFFICULTY_ROUTING_MAX_INPUT_CHARS,
  DIFFICULTY_ROUTING_MAX_INPUT_TOKENS,
  DIFFICULTY_ROUTING_POLICY_VERSION,
  DifficultyRoutingCapabilitySchema,
  isDelegatedDifficultyRoutingMessage,
  pickDifficultyRoutingPrompt,
} from './difficultyRouting'

const intent = {
  version: 1,
  mode: 'auto',
  policy: 'org-shared-difficulty-routing.v1',
  clientRequestId: 'client-1',
  clientRouteSource: 'default-auto',
}

describe('difficulty routing prompt selection', () => {
  it('uses the routing-only prompt override when explicit intent exists', () => {
    expect(pickDifficultyRoutingPrompt({
      intent,
      contentText: '<AX>wrapped</AX>',
      metaPrompt: 'original user text',
    })).toBe('original user text')
  })

  it('treats an explicit empty routing prompt as the original input and skips routing', () => {
    expect(pickDifficultyRoutingPrompt({
      intent,
      contentText: '<AX>wrapped system content</AX>',
      metaPrompt: '',
    })).toBeNull()
    expect(pickDifficultyRoutingPrompt({
      intent,
      contentText: '<AX>wrapped system content</AX>',
      metaPrompt: '   \n\t',
    })).toBeNull()
  })

  it('fails closed for malformed explicit routing prompt overrides', () => {
    expect(pickDifficultyRoutingPrompt({
      intent,
      contentText: '<AX>wrapped system content</AX>',
      metaPrompt: null,
    })).toBeNull()
    expect(pickDifficultyRoutingPrompt({
      intent,
      contentText: '<AX>wrapped system content</AX>',
      metaPrompt: { text: 'original' },
    })).toBeNull()
  })

  it('ignores prompt overrides without a valid intent', () => {
    expect(pickDifficultyRoutingPrompt({
      intent: undefined,
      contentText: '<AX>wrapped</AX>',
      metaPrompt: 'original user text',
    })).toBeNull()
  })

  it('skips remote routing when prompt text exceeds the routing limit', () => {
    const prompt = pickDifficultyRoutingPrompt({
      intent,
      contentText: 'x'.repeat(DIFFICULTY_ROUTING_MAX_INPUT_CHARS + 10),
    })
    expect(prompt).toBeNull()
  })
})

// 이 판정이 false 로 뒤집히면 러너는 위임 턴이 아니라고 보고 클라이언트 모델/effort 를
// 그대로 쓰며 조직 라우팅을 건너뛴다 — 오류는 어디에도 남지 않는다. 종전에는 이 규칙이
// runClaude·runCodex 에 손으로 복제돼 있었고 Codex 쪽 복사본은 어떤 테스트도 지키지
// 않았다(변이로 확인: Codex 판정을 깨도 라우팅 관련 실패가 0건이었다).
describe('isDelegatedDifficultyRoutingMessage', () => {
  const delegated = {
    meta: {
      modelSource: 'auto',
      difficultyRoutingAuthorization: 'turn-authority',
      difficultyRoutingIntent: { ...intent },
    },
  }

  it('accepts a turn the client delegated to organization-shared routing', () => {
    expect(isDelegatedDifficultyRoutingMessage(delegated)).toBe(true)
  })

  it.each([
    ['no meta at all', { meta: undefined }],
    ['a model the user picked by hand', { meta: { ...delegated.meta, modelSource: 'user' } }],
    ['a missing turn authorization', { meta: { ...delegated.meta, difficultyRoutingAuthorization: undefined } }],
    ['an empty turn authorization', { meta: { ...delegated.meta, difficultyRoutingAuthorization: '' } }],
    ['no intent', { meta: { ...delegated.meta, difficultyRoutingIntent: undefined } }],
    ['a future intent version', { meta: { ...delegated.meta, difficultyRoutingIntent: { ...intent, version: 2 } } }],
    ['a foreign policy', { meta: { ...delegated.meta, difficultyRoutingIntent: { ...intent, policy: 'someone-elses.v1' } } }],
    ['a manual intent mode', { meta: { ...delegated.meta, difficultyRoutingIntent: { ...intent, mode: 'manual' } } }],
    ['an empty client request id', { meta: { ...delegated.meta, difficultyRoutingIntent: { ...intent, clientRequestId: '' } } }],
    ['an unexpected route source', { meta: { ...delegated.meta, difficultyRoutingIntent: { ...intent, clientRouteSource: 'elsewhere' } } }],
  ])('does not treat %s as a delegated turn', (_label, message) => {
    expect(isDelegatedDifficultyRoutingMessage(message as never)).toBe(false)
  })
})

// The server reads timing support out of decrypted machine metadata. A schema that parses the
// block but drops this field leaves the daemon advertising v2 and the server never seeing it.
describe('capability timing contracts survive the schema', () => {
  const base = {
    version: 1,
    protocol: DIFFICULTY_ROUTING_POLICY_VERSION,
    hostProcessKeyId: 'key-1',
    hostProcessPublicKey: 'pub-1',
    classifier: {
      kind: 'transformers-binary',
      modelMaxInputTokens: DIFFICULTY_ROUTING_MAX_INPUT_TOKENS,
      maxInputChars: DIFFICULTY_ROUTING_MAX_INPUT_CHARS,
      onnxSha256: '444c99b6f4d417e50859f73e1557db11943a2ad073ce4050a65f1b7d39403038',
      tokenizerJsonSha256: 'acadd7d076a55a97edf9fb0521a0a2e9cf8cbbdd62e4d793f2aa3d1900916356',
      revision: 'rev-1',
    },
    limits: { concurrency: 1, queueSize: 8, requestDeadlineMs: 1000 },
  }

  it('keeps the advertised contracts through parse and re-serialization', () => {
    const parsed = DifficultyRoutingCapabilitySchema.parse({ ...base, timingVersions: [1, 2] })
    expect(parsed.timingVersions).toEqual([1, 2])
    expect(JSON.parse(JSON.stringify(parsed)).timingVersions).toEqual([1, 2])
  })

  it('treats an older daemon as legacy rather than guessing', () => {
    expect(DifficultyRoutingCapabilitySchema.parse(base).timingVersions).toBeUndefined()
  })

  it('refuses a contract list it cannot honour', () => {
    for (const timingVersions of [[], [3], [1, 3], ['2'], 2, null, [1, null]]) {
      expect(DifficultyRoutingCapabilitySchema.safeParse({ ...base, timingVersions }).success, JSON.stringify(timingVersions)).toBe(false)
    }
  })
})
