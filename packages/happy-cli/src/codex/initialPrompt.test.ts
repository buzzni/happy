import { describe, expect, it, vi } from 'vitest'

import { deliverCodexInitialPrompt, prepareCodexSessionStart } from './initialPrompt'

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

describe('prepareCodexSessionStart', () => {
  it('shouldReportDaemonStartOnlyAfterTheAutomationPromptIsQueued', async () => {
    const events: string[] = []
    const env = { HAPPY_INITIAL_PROMPT: '오늘 오류를 확인해줘' }

    const delivered = await prepareCodexSessionStart({
      env,
      sendSessionMessage: () => events.push('record-prompt'),
      pushPrompt: () => events.push('queue-prompt'),
      reportStarted: async () => {
        events.push('report-started')
      },
    })

    expect(delivered).toBe(true)
    expect(events).toEqual(['record-prompt', 'queue-prompt', 'report-started'])
  })

  it('shouldStillReportDaemonStartWhenThereIsNoAutomationPrompt', async () => {
    const reportStarted = vi.fn()

    const delivered = await prepareCodexSessionStart({
      env: {},
      sendSessionMessage: vi.fn(),
      pushPrompt: vi.fn(),
      reportStarted,
    })

    expect(delivered).toBe(false)
    expect(reportStarted).toHaveBeenCalledOnce()
  })

  it('shouldNotReportDaemonStartWhenTheAutomationPromptCannotBeQueued', async () => {
    const reportStarted = vi.fn()

    await expect(prepareCodexSessionStart({
      env: { HAPPY_INITIAL_PROMPT: '오늘 오류를 확인해줘' },
      sendSessionMessage: vi.fn(),
      pushPrompt: () => {
        throw new Error('queue failed')
      },
      reportStarted,
    })).rejects.toThrow('queue failed')

    expect(reportStarted).not.toHaveBeenCalled()
  })
})
