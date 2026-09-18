import { describe, expect, it } from 'vitest'
import {
  DIFFICULTY_ROUTING_MAX_INPUT_CHARS,
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
