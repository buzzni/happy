import { describe, expect, it, vi } from 'vitest'

import {
  buildInitialPromptUserRecord,
  consumePendingInitialPrompt,
  deliverPreparedClaudeSessionStart,
  deliverInitialPrompt,
  prepareClaudeInitialPrompt,
  type InitialPromptSink,
} from './initialPrompt'
import { TITLE_INSTRUCTION } from '@/utils/titlePrompt'
import { resolveInitialPromptPermissionMode } from '@/utils/initialPrompt'

describe('consumePendingInitialPrompt', () => {
  it('shouldReturnPromptOnceAndDeleteEnvVar', () => {
    const env: NodeJS.ProcessEnv = { HAPPY_INITIAL_PROMPT: '  어제 로그 점검해줘  ' }
    expect(consumePendingInitialPrompt(env)).toBe('어제 로그 점검해줘')
    expect('HAPPY_INITIAL_PROMPT' in env).toBe(false)
    expect(consumePendingInitialPrompt(env)).toBeNull()
  })

  it('shouldReturnNullForMissingOrBlankPrompt', () => {
    expect(consumePendingInitialPrompt({})).toBeNull()
    expect(consumePendingInitialPrompt({ HAPPY_INITIAL_PROMPT: '   ' })).toBeNull()
  })
})

describe('resolveInitialPromptPermissionMode', () => {
  it('elevates only the explicit automation resume prompt', () => {
    expect(resolveInitialPromptPermissionMode('default', true)).toBe('bypassPermissions')
    expect(resolveInitialPromptPermissionMode('default', false)).toBe('default')
  })
})

describe('prepareClaudeInitialPrompt', () => {
  it('requiresAndActivatesRunOnceOnlyForAFreshAutomationPrompt', () => {
    const env = { HAPPY_INITIAL_PROMPT: '  업무 브리핑  ' }

    expect(prepareClaudeInitialPrompt({
      env,
      automationRunOnceRequested: true,
    })).toEqual({
      prompt: '업무 브리핑',
      exitAfterFirstTurn: true,
    })
    expect(env.HAPPY_INITIAL_PROMPT).toBeUndefined()
  })

  it('rejectsRunOnceAutomationWhenItsInitialPromptIsMissing', () => {
    expect(() => prepareClaudeInitialPrompt({
      env: {},
      automationRunOnceRequested: true,
    })).toThrow('Claude automation cannot start without a fresh initial prompt')
  })

  it('rejectsRunOnceAutomationInsteadOfReplayingItsPromptOnReconnect', () => {
    const env = { HAPPY_INITIAL_PROMPT: 'stale prompt' }

    expect(() => prepareClaudeInitialPrompt({
      env,
      reconnectSessionId: 'existing-session',
      automationRunOnceRequested: true,
    })).toThrow('Claude automation cannot start without a fresh initial prompt')
    expect(env.HAPPY_INITIAL_PROMPT).toBeUndefined()
  })

  it('allowsAFreshRunOncePromptForAnExplicitAutomationResume', () => {
    const env = { HAPPY_INITIAL_PROMPT: 'apply reviewed findings' }

    expect(prepareClaudeInitialPrompt({
      env,
      reconnectSessionId: 'existing-session',
      automationRunOnceRequested: true,
      allowAutomationReconnectPrompt: true,
    })).toEqual({ prompt: 'apply reviewed findings', exitAfterFirstTurn: true })
    expect(env.HAPPY_INITIAL_PROMPT).toBeUndefined()
  })

  it('rejectsAnExplicitAutomationResumeWithoutItsPrompt', () => {
    expect(() => prepareClaudeInitialPrompt({
      env: {},
      reconnectSessionId: 'existing-session',
      automationRunOnceRequested: false,
      allowAutomationReconnectPrompt: true,
    })).toThrow('Claude automation cannot start without a fresh initial prompt')
  })

  it('consumesAStaleInteractiveReconnectPromptWithoutActivatingRunOnce', () => {
    const env = { HAPPY_INITIAL_PROMPT: 'stale prompt' }

    expect(prepareClaudeInitialPrompt({
      env,
      reconnectSessionId: 'existing-session',
      automationRunOnceRequested: false,
    })).toEqual({ prompt: null, exitAfterFirstTurn: false })
    expect(env.HAPPY_INITIAL_PROMPT).toBeUndefined()
  })
})

describe('buildInitialPromptUserRecord', () => {
  it('shouldBuildNonSidechainUserRecordWithStringContent', () => {
    const record = buildInitialPromptUserRecord('hello', 'session-1') as any
    expect(record.type).toBe('user')
    expect(record.isSidechain).toBe(false)
    expect(record.sessionId).toBe('session-1')
    expect(record.message).toEqual({ role: 'user', content: 'hello' })
    expect(typeof record.uuid).toBe('string')
  })

  it('shouldFallBackToUnknownSessionId', () => {
    expect((buildInitialPromptUserRecord('hello', null) as any).sessionId).toBe('unknown')
  })
})

function makeSink(overrides: Partial<InitialPromptSink> = {}) {
  const sent: unknown[] = []
  const recorded: string[] = []
  const pushed: string[] = []
  const sink: InitialPromptSink = {
    sessionId: 'session-1',
    hasTitle: () => false,
    sendClaudeSessionMessage: (record) => { sent.push(record) },
    recordAppPrompt: (text) => { recorded.push(text) },
    pushPrompt: (text) => { pushed.push(text) },
    ...overrides,
  }
  return { sink, sent, recorded, pushed }
}

describe('deliverInitialPrompt', () => {
  it('shouldSendOriginalPromptToServerHistoryAndPushTitledCopy', () => {
    const { sink, sent, recorded, pushed } = makeSink()
    deliverInitialPrompt('배포 상태 확인해줘', sink)

    // (b) 서버 히스토리: 원문 그대로의 user 레코드 한 건
    expect(sent).toHaveLength(1)
    expect((sent[0] as any).message.content).toBe('배포 상태 확인해줘')

    // (a) 턴 시작: 제목 지시가 덧붙은 모델 사본 한 건
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toContain('배포 상태 확인해줘')
    expect(pushed[0]).toContain(TITLE_INSTRUCTION)

    // 스캐너 dedupe 스탬프: 원문 + 변형본 둘 다
    expect(recorded).toEqual(['배포 상태 확인해줘', pushed[0]])
  })

  it('shouldSkipTitleInstructionWhenSessionAlreadyTitled', () => {
    const { sink, recorded, pushed } = makeSink({ hasTitle: () => true })
    deliverInitialPrompt('prompt', sink)
    expect(pushed).toEqual(['prompt'])
    expect(recorded).toEqual(['prompt'])
  })
})

describe('deliverPreparedClaudeSessionStart', () => {
  it('forwards the web optimistic local id to the persisted user message', async () => {
    const sendClaudeSessionMessage = vi.fn()
    const { sink } = makeSink({ sendClaudeSessionMessage })

    await deliverPreparedClaudeSessionStart({
      prepared: {
        prompt: '복구 후 이어서 작업해줘',
        localId: 'web-local-1',
        exitAfterFirstTurn: false,
      },
      sink,
    })

    expect(sendClaudeSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user' }),
      'web-local-1',
    )
  })

  it('reportsDaemonStartOnlyAfterThePromptIsRecordedAndQueued', async () => {
    const events: string[] = []
    const prepared = { prompt: '업무 브리핑', exitAfterFirstTurn: true }
    const { sink } = makeSink({
      sendClaudeSessionMessage: () => { events.push('record-prompt') },
      recordAppPrompt: () => {},
      pushPrompt: () => { events.push('queue-prompt') },
    })

    await expect(deliverPreparedClaudeSessionStart({
      prepared,
      sink,
      reportStarted: async () => { events.push('report-started') },
    })).resolves.toBe(true)

    expect(events).toEqual(['record-prompt', 'queue-prompt', 'report-started'])
    await expect(deliverPreparedClaudeSessionStart({
      prepared,
      sink,
    })).resolves.toBe(false)
    expect(events).toEqual(['record-prompt', 'queue-prompt', 'report-started'])
  })
})
