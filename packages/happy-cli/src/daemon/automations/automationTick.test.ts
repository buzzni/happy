import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { SCRIPT_TIMEOUT_MS, type ScheduledAutomation } from './automationDomain'
import { makeAutomation } from './automationTestFixtures'
import { createAutomationStore, type AutomationStore } from './automationStore'
import { runAutomationTick, type AutomationTickInput } from './automationTick'

const NOW = new Date(2026, 0, 15, 14, 0).getTime()

function makeDueAutomation(patch: Partial<ScheduledAutomation> = {}): ScheduledAutomation {
  return makeAutomation({
    schedule: { kind: 'interval', minutes: 30 },
    nextRunAt: NOW - 60_000,
    ...patch,
  })
}

describe('runAutomationTick', () => {
  let dir: string
  let store: AutomationStore

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'automation-tick-'))
    store = createAutomationStore({ filePath: path.join(dir, 'automations.json') })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeInput(patch: Partial<AutomationTickInput> = {}): AutomationTickInput {
    return {
      store,
      now: NOW,
      runScript: vi.fn(async () => ({ ok: true, stdout: '' })),
      spawnSession: vi.fn(async () => ({ ok: true as const, sessionId: 'session-new' })),
      isSessionRunning: vi.fn(() => false),
      ...patch,
    }
  }

  it('ignores automations that are not due', async () => {
    const notDue = makeAutomation({ nextRunAt: NOW + 60_000 })
    const paused = makeDueAutomation({ id: 'paused', paused: true })
    store.replaceAll([notDue, paused])
    const input = makeInput()

    expect(await runAutomationTick(input)).toEqual([])
    expect(input.runScript).not.toHaveBeenCalled()
    expect(input.spawnSession).not.toHaveBeenCalled()
    expect(store.list()).toEqual([notDue, paused])
  })

  it('wakes a due automation without a script and records the session', async () => {
    store.replaceAll([makeDueAutomation()])
    const input = makeInput()

    const outcomes = await runAutomationTick(input)

    expect(outcomes).toEqual([{ id: 'auto-1', outcome: 'woke' }])
    expect(input.runScript).not.toHaveBeenCalled()
    expect(input.spawnSession).toHaveBeenCalledWith({
      directory: '/repo/project-1',
      initialPrompt: '어제 로그를 점검해줘',
    })
    const [saved] = store.list()
    expect(saved!.runHistory[0]).toEqual({ at: NOW, outcome: 'woke', sessionId: 'session-new' })
    // claim이 nextRunAt을 now 기준으로 전진시킨다.
    expect(saved!.nextRunAt).toBe(NOW + 30 * 60_000)
  })

  it('runs the script in the automation directory with the standard timeout', async () => {
    store.replaceAll([makeDueAutomation({ scriptCommand: 'curl -sf https://staging/health', directory: '/repo/staging' })])
    const input = makeInput({ runScript: vi.fn(async () => ({ ok: true, stdout: 'healthy' })) })

    await runAutomationTick(input)

    expect(input.runScript).toHaveBeenCalledWith({
      command: 'curl -sf https://staging/health',
      cwd: '/repo/staging',
      timeout: SCRIPT_TIMEOUT_MS,
    })
  })

  it('injects fenced script output into the spawned prompt', async () => {
    store.replaceAll([makeDueAutomation({ scriptCommand: 'probe' })])
    const input = makeInput({ runScript: vi.fn(async () => ({ ok: true, stdout: 'HTTP 503 from staging' })) })

    await runAutomationTick(input)

    const call = vi.mocked(input.spawnSession).mock.calls[0]![0]
    expect(call.initialPrompt).toContain('```\nHTTP 503 from staging\n```')
    expect(call.initialPrompt).toContain('어제 로그를 점검해줘')
  })

  it('records skipped-gate without spawning when the wake gate opts out', async () => {
    store.replaceAll([makeDueAutomation({ scriptCommand: 'probe' })])
    const input = makeInput({ runScript: vi.fn(async () => ({ ok: true, stdout: 'no change\n{"wakeAgent": false}' })) })

    const outcomes = await runAutomationTick(input)

    expect(outcomes).toEqual([{ id: 'auto-1', outcome: 'skipped-gate' }])
    expect(input.spawnSession).not.toHaveBeenCalled()
    expect(store.list()[0]!.runHistory[0]).toEqual({ at: NOW, outcome: 'skipped-gate', sessionId: null })
  })

  // fail-closed: 스크립트 실패는 게이트 판정 없이 error — 부분 stdout으로
  // 게이트를 통과시키면 반쯤 실패한 스크립트가 세션을 깨우거나 조용히 삼킨다.
  it('records error without gating or spawning when the script fails', async () => {
    store.replaceAll([makeDueAutomation({ scriptCommand: 'probe' })])
    const input = makeInput({
      runScript: vi.fn(async () => ({ ok: false, stdout: '{"wakeAgent": false}', error: 'script-exit-1' })),
    })

    const outcomes = await runAutomationTick(input)

    expect(outcomes).toEqual([{ id: 'auto-1', outcome: 'error' }])
    expect(input.spawnSession).not.toHaveBeenCalled()
    expect(store.list()[0]!.runHistory[0]).toEqual({ at: NOW, outcome: 'error', sessionId: null })
  })

  it('records error when the session spawn fails', async () => {
    store.replaceAll([makeDueAutomation()])
    const input = makeInput({ spawnSession: vi.fn(async () => ({ ok: false as const, error: 'no-machine' })) })

    const outcomes = await runAutomationTick(input)

    expect(outcomes).toEqual([{ id: 'auto-1', outcome: 'error' }])
    expect(store.list()[0]!.runHistory[0]).toEqual({ at: NOW, outcome: 'error', sessionId: null })
  })

  describe('overlap guard', () => {
    it('skips with the running session id when the last woke session is still running', async () => {
      store.replaceAll([makeDueAutomation({
        scriptCommand: 'probe',
        runHistory: [
          { at: NOW - 60_000, outcome: 'skipped-gate', sessionId: null },
          { at: NOW - 120_000, outcome: 'woke', sessionId: 'session-busy' },
        ],
      })])
      const isSessionRunning = vi.fn((sessionId: string) => sessionId === 'session-busy')
      const input = makeInput({ isSessionRunning })

      const outcomes = await runAutomationTick(input)

      expect(outcomes).toEqual([{ id: 'auto-1', outcome: 'skipped-overlap' }])
      // 겹침 스킵은 스크립트조차 실행하지 않는다.
      expect(input.runScript).not.toHaveBeenCalled()
      expect(input.spawnSession).not.toHaveBeenCalled()
      expect(store.list()[0]!.runHistory[0]).toEqual({ at: NOW, outcome: 'skipped-overlap', sessionId: 'session-busy' })
      // nextRunAt은 스킵이어도 전진한다 — 같은 due의 재시도 폭주 방지.
      expect(store.list()[0]!.nextRunAt).toBe(NOW + 30 * 60_000)
    })

    it('proceeds when the last woke session has already finished', async () => {
      store.replaceAll([makeDueAutomation({
        runHistory: [{ at: NOW - 120_000, outcome: 'woke', sessionId: 'session-done' }],
      })])
      const input = makeInput({ isSessionRunning: vi.fn(() => false) })

      const outcomes = await runAutomationTick(input)

      expect(outcomes).toEqual([{ id: 'auto-1', outcome: 'woke' }])
      expect(vi.mocked(input.isSessionRunning)).toHaveBeenCalledWith('session-done')
    })
  })

  it('auto-pauses after the third consecutive error', async () => {
    store.replaceAll([makeDueAutomation({
      runHistory: [
        { at: NOW - 60_000, outcome: 'error', sessionId: null },
        { at: NOW - 120_000, outcome: 'error', sessionId: null },
      ],
    })])
    const input = makeInput({ spawnSession: vi.fn(async () => ({ ok: false as const, error: 'still-broken' })) })

    await runAutomationTick(input)

    const [saved] = store.list()
    expect(saved!.paused).toBe(true)
    expect(saved!.runHistory.slice(0, 3).every((record) => record.outcome === 'error')).toBe(true)
  })

  it('isolates a throwing automation from the rest and records its error', async () => {
    store.replaceAll([
      makeDueAutomation({ id: 'auto-throws', scriptCommand: 'probe' }),
      makeDueAutomation({ id: 'auto-fine' }),
    ])
    const input = makeInput({
      runScript: vi.fn(async () => {
        throw new Error('rpc transport died')
      }),
    })

    const outcomes = await runAutomationTick(input)

    expect(outcomes).toEqual([
      { id: 'auto-throws', outcome: 'error' },
      { id: 'auto-fine', outcome: 'woke' },
    ])
    const byId = new Map(store.list().map((entry) => [entry.id, entry]))
    expect(byId.get('auto-throws')!.runHistory[0]!.outcome).toBe('error')
    expect(byId.get('auto-fine')!.runHistory[0]).toEqual({ at: NOW, outcome: 'woke', sessionId: 'session-new' })
  })

  it('advances nextRunAt via claim before running, so a mid-run crash cannot refire', async () => {
    store.replaceAll([makeDueAutomation()])
    let nextRunAtDuringSpawn: number | null = null
    const input = makeInput({
      spawnSession: vi.fn(async () => {
        nextRunAtDuringSpawn = store.list()[0]!.nextRunAt
        return { ok: true as const, sessionId: 'session-new' }
      }),
    })

    await runAutomationTick(input)

    // 실행(스폰) 시점에 이미 store의 nextRunAt이 전진해 있어야 한다.
    expect(nextRunAtDuringSpawn).toBe(NOW + 30 * 60_000)
  })

  it('reports debug details through the injected logger', async () => {
    store.replaceAll([makeDueAutomation({ scriptCommand: 'probe' })])
    const logDebug = vi.fn()
    const input = makeInput({
      runScript: vi.fn(async () => ({ ok: false, stdout: '', error: 'script-exit-7' })),
      logDebug,
    })

    await runAutomationTick(input)

    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('script-exit-7'))
  })
})
