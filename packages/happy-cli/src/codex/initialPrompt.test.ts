import { describe, expect, it, vi } from 'vitest'

import { deliverCodexInitialPrompt } from './initialPrompt'

function makeInput(env: NodeJS.ProcessEnv, reconnectSessionId: string | undefined = undefined) {
  return {
    env,
    reconnectSessionId,
    sendSessionMessage: vi.fn(),
    pushPrompt: vi.fn(),
  }
}

describe('deliverCodexInitialPrompt', () => {
  it('shouldRecordAndQueueDaemonPromptExactlyOnceForFreshSession', () => {
    const input = makeInput({ HAPPY_INITIAL_PROMPT: '  오늘 오류를 확인해줘  ' })

    expect(deliverCodexInitialPrompt(input)).toBe(true)
    expect(input.env.HAPPY_INITIAL_PROMPT).toBeUndefined()
    expect(input.sendSessionMessage).toHaveBeenCalledTimes(1)
    expect(input.sendSessionMessage.mock.calls[0]?.[0]).toMatchObject({
      role: 'user',
      ev: { t: 'text', text: '오늘 오류를 확인해줘' },
    })
    expect(input.pushPrompt).toHaveBeenCalledWith('오늘 오류를 확인해줘')

    expect(deliverCodexInitialPrompt(input)).toBe(false)
    expect(input.sendSessionMessage).toHaveBeenCalledTimes(1)
    expect(input.pushPrompt).toHaveBeenCalledTimes(1)
  })

  it('shouldConsumeWithoutReplayingPromptWhenReconnecting', () => {
    const input = makeInput({ HAPPY_INITIAL_PROMPT: 'stale prompt' }, 'existing-session')

    expect(deliverCodexInitialPrompt(input)).toBe(false)
    expect(input.env.HAPPY_INITIAL_PROMPT).toBeUndefined()
    expect(input.sendSessionMessage).not.toHaveBeenCalled()
    expect(input.pushPrompt).not.toHaveBeenCalled()
  })

  it('shouldIgnoreMissingOrBlankPrompt', () => {
    for (const env of [{}, { HAPPY_INITIAL_PROMPT: '   ' }]) {
      const input = makeInput(env)
      expect(deliverCodexInitialPrompt(input)).toBe(false)
      expect(input.sendSessionMessage).not.toHaveBeenCalled()
      expect(input.pushPrompt).not.toHaveBeenCalled()
    }
  })
})
