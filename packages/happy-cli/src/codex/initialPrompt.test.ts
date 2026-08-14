import { describe, expect, it, vi } from 'vitest'

import {
  assertCodexAutomationServerAvailable,
  deliverCodexInitialPrompt,
  prepareCodexInitialPrompt,
  prepareCodexSessionStart,
} from './initialPrompt'

function makeInput(env: NodeJS.ProcessEnv, reconnectSessionId: string | undefined = undefined) {
  const prepared = prepareCodexInitialPrompt({
    env,
    reconnectSessionId,
    automationRunOnceRequested: false,
  })
  return {
    prepared,
    sendSessionMessage: vi.fn(),
    pushPrompt: vi.fn(),
  }
}

describe('deliverCodexInitialPrompt', () => {
  it('shouldRecordAndQueueDaemonPromptExactlyOnceForFreshSession', () => {
    const input = makeInput({ HAPPY_INITIAL_PROMPT: '  오늘 오류를 확인해줘  ' })

    expect(deliverCodexInitialPrompt(input)).toBe(true)
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
    const prepared = prepareCodexInitialPrompt({
      env: { HAPPY_INITIAL_PROMPT: '오늘 오류를 확인해줘' },
      automationRunOnceRequested: true,
    })

    const delivered = await prepareCodexSessionStart({
      prepared,
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
      prepared: { prompt: null, exitAfterFirstTurn: false },
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
      prepared: { prompt: '오늘 오류를 확인해줘', exitAfterFirstTurn: true },
      sendSessionMessage: vi.fn(),
      pushPrompt: () => {
        throw new Error('queue failed')
      },
      reportStarted,
    })).rejects.toThrow('queue failed')

    expect(reportStarted).not.toHaveBeenCalled()
  })
})

describe('prepareCodexInitialPrompt', () => {
  it('forwards the web optimistic local id to the persisted user envelope', () => {
    const sendSessionMessage = vi.fn()
    const env = {
      HAPPY_INITIAL_PROMPT: '복구 후 이어서 작업해줘',
      HAPPY_INITIAL_PROMPT_LOCAL_ID: 'web-local-1',
    }
    const prepared = prepareCodexInitialPrompt({
      env,
      automationRunOnceRequested: false,
    })

    deliverCodexInitialPrompt({
      prepared,
      sendSessionMessage,
      pushPrompt: vi.fn(),
    })

    expect(sendSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user' }),
      'web-local-1',
    )
    expect(env.HAPPY_INITIAL_PROMPT_LOCAL_ID).toBeUndefined()
  })

  it('requiresAndActivatesRunOnceOnlyForAFreshAutomationPrompt', () => {
    const env = { HAPPY_INITIAL_PROMPT: '  업무 브리핑  ' }

    expect(prepareCodexInitialPrompt({
      env,
      automationRunOnceRequested: true,
    })).toEqual({ prompt: '업무 브리핑', exitAfterFirstTurn: true })
    expect(env.HAPPY_INITIAL_PROMPT).toBeUndefined()
  })

  it('rejectsRunOnceAutomationWhenItsInitialPromptIsMissing', () => {
    expect(() => prepareCodexInitialPrompt({
      env: {},
      automationRunOnceRequested: true,
    })).toThrow('Codex automation cannot start without a fresh initial prompt')
  })

  it('rejectsRunOnceAutomationInsteadOfReplayingItsPromptOnReconnect', () => {
    const env = { HAPPY_INITIAL_PROMPT: 'stale prompt' }

    expect(() => prepareCodexInitialPrompt({
      env,
      reconnectSessionId: 'existing-session',
      automationRunOnceRequested: true,
    })).toThrow('Codex automation cannot start without a fresh initial prompt')

    expect(env.HAPPY_INITIAL_PROMPT).toBeUndefined()
  })

  it('allowsAFreshRunOncePromptForAnExplicitAutomationResume', () => {
    const env = { HAPPY_INITIAL_PROMPT: 'apply reviewed findings' }

    expect(prepareCodexInitialPrompt({
      env,
      reconnectSessionId: 'existing-session',
      automationRunOnceRequested: true,
      allowAutomationReconnectPrompt: true,
    })).toEqual({ prompt: 'apply reviewed findings', exitAfterFirstTurn: true })
    expect(env.HAPPY_INITIAL_PROMPT).toBeUndefined()
  })

  it('rejectsAnExplicitAutomationResumeWithoutItsPrompt', () => {
    expect(() => prepareCodexInitialPrompt({
      env: {},
      reconnectSessionId: 'existing-session',
      automationRunOnceRequested: false,
      allowAutomationReconnectPrompt: true,
    })).toThrow('Codex automation cannot start without a fresh initial prompt')
  })
})

describe('assertCodexAutomationServerAvailable', () => {
  it('failsClosedForOfflineRunOnceAutomation', () => {
    expect(() => assertCodexAutomationServerAvailable({
      automationRunOnceRequested: true,
      serverAvailable: false,
    })).toThrow('Codex automation cannot start while the Happy server is unavailable')
  })

  it('allowsInteractiveOfflineMode', () => {
    expect(() => assertCodexAutomationServerAvailable({
      automationRunOnceRequested: false,
      serverAvailable: false,
    })).not.toThrow()
  })
})
