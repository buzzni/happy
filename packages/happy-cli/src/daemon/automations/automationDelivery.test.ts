import type { AutomationDelivery } from '@slopus/happy-wire'
import { describe, expect, it, vi } from 'vitest'

import {
  AUTOMATION_FAILURE_REPEAT_MS,
  buildAutomationDeliveryText,
  createAutomationDeliveryCoordinator,
  decideFailureAlert,
  failureSignature,
  type AutomationDeliveryRequest,
  type AutomationDeliveryState,
} from './automationDelivery'
import type { ServerAutomationPayload } from './serverAutomationCache'

const HOUR = 60 * 60_000
const target = { machineId: 'machine-1', connectionId: 'connection-1', grantKey: 'grant-1' }
const elsewhere = { machineId: 'machine-1', connectionId: 'connection-2', grantKey: 'grant-2' }

function payload(delivery: AutomationDelivery | undefined, name = 'Morning report'): ServerAutomationPayload {
  return {
    name, schedule: { kind: 'interval', minutes: 15 }, prompt: 'Report', directory: '/chat',
    scriptCommand: null, suppressSilent: false, agent: 'claude',
    conversation: { sessionId: 'session-1' },
    ...(delivery ? { delivery } : {}),
  } as ServerAutomationPayload
}

function harness(options: { delivery?: AutomationDelivery; outcome?: 'sent' | 'failed' | 'unknown' | 'unsupported' } = {}) {
  let state: AutomationDeliveryState = { version: 1, incidents: {}, delivered: [], awaiting: [] }
  let now = 1_000_000
  const sent: AutomationDeliveryRequest[] = []
  let current = payload(options.delivery ?? { version: 1, locale: 'en', result: target, failure: 'same' })
  const h = { outcome: options.outcome ?? 'sent' as 'sent' | 'failed' | 'unknown' | 'unsupported' }
  const coordinator = createAutomationDeliveryCoordinator({
    machineId: 'machine-1',
    store: { read: () => state, write: (next) => { state = JSON.parse(JSON.stringify(next)) } },
    payloadFor: () => current,
    send: async (request) => { sent.push(request); return h.outcome },
    now: () => now,
  })
  return {
    coordinator, sent,
    setOutcome: (outcome: typeof h.outcome) => { h.outcome = outcome },
    state: () => state,
    advance: (ms: number) => { now += ms },
    setPayload: (next: ServerAutomationPayload) => { current = next },
    fail: (runId: string, failureCode: string | null = 'GRANT_EXCHANGE_FAILED') => coordinator.runFailed({
      automationId: 'automation-1', runId, payload: current, failureCode,
    }),
    start: (runId: string) => coordinator.runStarted({
      automationId: 'automation-1', runId, payload: current, sessionId: 'session-1', awaitsTurn: true,
    }),
    finish: (runId: string, status: 'completed' | 'failed' | 'cancelled', finalAnswer: string | null = null, silent = false) =>
      coordinator.turnFinished({ sessionId: 'session-1', result: { runId, status, finalAnswer, silent } }),
  }
}

describe('failureSignature', () => {
  it('treats a failure after unreachable retries as the same cause as the first one', () => {
    expect(failureSignature('GRANT_EXCHANGE_FAILED_AFTER_3_RETRIES')).toBe('GRANT_EXCHANGE_FAILED')
    expect(failureSignature('GRANT_EXCHANGE_FAILED')).toBe('GRANT_EXCHANGE_FAILED')
    expect(failureSignature(null)).toBe('AUTOMATION_FAILED')
    // Not a closed code: never a signature the ledger would refuse to store.
    expect(failureSignature('connect ECONNREFUSED')).toBe('AUTOMATION_FAILED')
  })
})

describe('decideFailureAlert', () => {
  it('alerts once, withholds the same failure for a day, then repeats', () => {
    const first = decideFailureAlert(undefined, 'X', 0)
    expect(first.decision).toBe('alert')
    expect(decideFailureAlert(first.incident, 'X', AUTOMATION_FAILURE_REPEAT_MS - 1).decision).toBe('withhold')
    const repeat = decideFailureAlert(first.incident, 'X', AUTOMATION_FAILURE_REPEAT_MS)
    expect(repeat).toEqual({ decision: 'repeat', incident: { signature: 'X', firstAt: 0, alertedAt: AUTOMATION_FAILURE_REPEAT_MS } })
  })

  it('alerts at once when the cause changes', () => {
    const first = decideFailureAlert(undefined, 'X', 0)
    expect(decideFailureAlert(first.incident, 'Y', HOUR)).toEqual({
      decision: 'alert', incident: { signature: 'Y', firstAt: HOUR, alertedAt: HOUR },
    })
  })

  it('pins a day per repeat so the interval holds', () => {
    expect(AUTOMATION_FAILURE_REPEAT_MS).toBe(24 * HOUR)
  })
})

describe('buildAutomationDeliveryText', () => {
  it('words the result with the task name and the answer only', () => {
    expect(buildAutomationDeliveryText({ kind: 'result', locale: 'ko', name: '아침 보고', answer: '새 이슈 3건' }))
      .toBe('🗓 아침 보고\n\n새 이슈 3건')
  })

  it('words a failure with a closed reason and code, and the elapsed hours on a repeat', () => {
    expect(buildAutomationDeliveryText({ kind: 'failure', locale: 'en', name: 'Report', code: 'TURN_FAILED' }))
      .toBe('⚠️ Scheduled task "Report" failed — the agent could not finish its answer (TURN_FAILED)')
    expect(buildAutomationDeliveryText({ kind: 'failure', locale: 'ko', name: '보고', code: 'GRANT_EXCHANGE_FAILED', repeatHours: 48 }))
      .toBe('⚠️ 예약 "보고" 실행 실패 — 실행을 준비하지 못했습니다 (GRANT_EXCHANGE_FAILED) · 48시간째 같은 이유로 실패 중')
  })

  it('falls back to English for a locale it does not know', () => {
    expect(buildAutomationDeliveryText({ kind: 'failure', locale: 'fr', name: 'R', code: 'X' }))
      .toBe('⚠️ Scheduled task "R" failed — it could not run (X)')
    for (const locale of ['ja', 'zh']) {
      expect(buildAutomationDeliveryText({ kind: 'failure', locale, name: 'R', code: 'X' })).toContain('(X)')
    }
  })
})

describe('createAutomationDeliveryCoordinator', () => {
  it('sends the final answer of a finished scheduled turn to the chosen pairing', async () => {
    const h = harness()
    h.start('run-1')
    await h.finish('run-1', 'completed', 'Three new issues.')
    expect(h.sent).toEqual([{
      v: 1, connectionId: 'connection-1', grantKey: 'grant-1', kind: 'result',
      text: '🗓 Morning report\n\nThree new issues.', dedupeKey: 'run-1:result',
    }])
    expect(h.state().awaiting).toEqual([])
  })

  it('sends nothing for a silent, empty or cancelled turn', async () => {
    const h = harness()
    h.start('run-1')
    await h.finish('run-1', 'completed', null, true)
    h.start('run-2')
    await h.finish('run-2', 'completed', null)
    h.start('run-3')
    await h.finish('run-3', 'cancelled')
    expect(h.sent).toEqual([])
  })

  it('ignores a turn result for a run it did not start or from another session', async () => {
    const h = harness()
    h.start('run-1')
    await h.coordinator.turnFinished({ sessionId: 'other-session', result: { runId: 'run-1', status: 'completed', finalAnswer: 'x', silent: false } })
    await h.finish('run-9', 'completed', 'x')
    expect(h.sent).toEqual([])
  })

  it('reads the delivery choice again when the turn ends', async () => {
    const h = harness()
    h.start('run-1')
    h.setPayload(payload(undefined))
    await h.finish('run-1', 'completed', 'answer')
    expect(h.sent).toEqual([])
  })

  it('alerts a repeated failure once a day, a new cause at once, and starts over after a success', async () => {
    const h = harness({ delivery: { version: 1, locale: 'en', result: null, failure: elsewhere } })
    await h.fail('run-1')
    h.advance(HOUR)
    await h.fail('run-2', 'GRANT_EXCHANGE_FAILED_AFTER_3_RETRIES')
    expect(h.sent.map((request) => request.dedupeKey)).toEqual(['run-1:failure'])
    expect(h.sent[0].connectionId).toBe('connection-2')

    h.advance(AUTOMATION_FAILURE_REPEAT_MS)
    await h.fail('run-3')
    expect(h.sent.at(-1)?.text).toContain('25h')

    h.advance(HOUR)
    h.start('run-4')
    await h.finish('run-4', 'failed')
    expect(h.sent.at(-1)?.dedupeKey).toBe('run-4:failure')

    h.start('run-5')
    await h.finish('run-5', 'completed', 'fine')
    expect(h.state().incidents).toEqual({})
    await h.fail('run-6', 'TURN_FAILED')
    expect(h.sent.map((request) => request.dedupeKey)).toEqual(['run-1:failure', 'run-3:failure', 'run-4:failure', 'run-6:failure'])
  })

  it('closes the incident on a started run that does not wait for a turn', async () => {
    const h = harness()
    await h.fail('run-1')
    await h.coordinator.runStarted({ automationId: 'automation-1', runId: 'run-2', payload: payload({ version: 1, result: target, failure: 'same' }), sessionId: null, awaitsTurn: false })
    expect(h.state().incidents).toEqual({})

    // Alerts turned off meanwhile: the next start forgets the open group, so turning them on again starts over.
    await h.fail('run-3')
    h.coordinator.runStarted({ automationId: 'automation-1', runId: 'run-4', payload: payload(undefined), sessionId: 'session-1', awaitsTurn: true })
    expect(h.state()).toMatchObject({ incidents: {}, awaiting: [] })
  })

  it('does not start the quiet day with an alert that was never sent', async () => {
    const h = harness({ outcome: 'unsupported' })
    await h.fail('run-1')
    expect(h.state().incidents).toEqual({})
    h.setOutcome('failed')
    await h.fail('run-2')
    h.setOutcome('sent')
    await h.fail('run-3')
    expect(h.sent.map((request) => request.dedupeKey)).toEqual(['run-1:failure', 'run-2:failure', 'run-3:failure'])
    expect(h.state().incidents['automation-1']).toMatchObject({ signature: 'GRANT_EXCHANGE_FAILED' })
    await h.fail('run-4')
    expect(h.sent).toHaveLength(3)
  })

  it('keeps a turn result that arrives before its run is recorded as started', async () => {
    const h = harness()
    await h.finish('run-1', 'completed', 'Fast answer.')
    expect(h.sent).toEqual([])
    h.start('run-1')
    await vi.waitFor(() => expect(h.sent.map((request) => request.dedupeKey)).toEqual(['run-1:result']))
    expect(h.state().awaiting).toEqual([])
  })

  it('never sends the same alert twice, even when the send was ambiguous', async () => {
    const h = harness({ outcome: 'unknown' })
    await h.fail('run-1')
    await h.fail('run-1')
    expect(h.sent).toHaveLength(1)
  })

  it('sends nothing when alerts are off, or the pairing belongs to another machine', async () => {
    const off = harness({ delivery: { version: 1, result: target, failure: null } })
    await off.fail('run-1')
    const moved = harness({ delivery: { version: 1, result: null, failure: { ...target, machineId: 'machine-2' } } })
    await moved.fail('run-1')
    const none = harness()
    none.setPayload(payload(undefined))
    await none.fail('run-1')
    expect([...off.sent, ...moved.sent, ...none.sent]).toEqual([])
  })

  it('keeps only closed codes, keys and times in its state', async () => {
    const h = harness()
    await h.fail('run-1')
    h.start('run-2')
    const persisted = JSON.stringify(h.state())
    expect(persisted).not.toContain('Morning report')
    expect(persisted).not.toContain('grant-1')
  })

  it('treats a throwing transport as an ambiguous send and carries on', async () => {
    let state: AutomationDeliveryState = { version: 1, incidents: {}, delivered: [], awaiting: [] }
    const coordinator = createAutomationDeliveryCoordinator({
      machineId: 'machine-1',
      store: { read: () => state, write: (next) => { state = next } },
      payloadFor: () => null,
      send: async () => { throw new Error('pipe closed') },
      now: () => 0,
    })
    await expect(coordinator.runFailed({
      automationId: 'a', runId: 'r', payload: payload({ version: 1, result: target, failure: 'same' }), failureCode: null,
    })).resolves.toBe('unknown')
  })
})
