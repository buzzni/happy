import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAutomationRpcHandlers } from './automationRpcHandlers'
import { createAutomationStore, type AutomationStore } from './automationStore'
import { makeAutomation } from './automationTestFixtures'

const NOW = 1_000_000_000

let dir: string
let store: AutomationStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'automation-rpc-'))
  store = createAutomationStore({ filePath: join(dir, 'automations.json') })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function handlers(allowedRoot = '/repo') {
  return createAutomationRpcHandlers({ store, allowedRoot, now: () => NOW })
}

describe('automation-upsert', () => {
  it('shouldRejectInvalidAutomationPayload', async () => {
    await expect(handlers().upsert({ automation: { id: 'x' } })).rejects.toThrow('missing required fields')
    await expect(handlers().upsert(undefined)).rejects.toThrow('missing required fields')
  })

  it('shouldRejectDirectoryOutsideAllowedRoot', async () => {
    const automation = makeAutomation({ directory: '/etc' })
    await expect(handlers('/repo').upsert({ automation })).rejects.toThrow('outside the working directory')
    expect(store.list()).toHaveLength(0)
  })

  it('shouldRecomputeNextRunAtWhenNullOrPast', async () => {
    const interval = { kind: 'interval', minutes: 30 } as const

    const nullCase = await handlers().upsert({
      automation: makeAutomation({ id: 'a-null', schedule: interval, nextRunAt: null }),
    })
    expect(nullCase.automation.nextRunAt).toBe(NOW + 30 * 60_000)

    const pastCase = await handlers().upsert({
      automation: makeAutomation({ id: 'a-past', schedule: interval, nextRunAt: NOW - 1 }),
    })
    expect(pastCase.automation.nextRunAt).toBe(NOW + 30 * 60_000)
  })

  it('shouldKeepFutureNextRunAt', async () => {
    const future = NOW + 60_000
    const result = await handlers().upsert({
      automation: makeAutomation({ nextRunAt: future }),
    })
    expect(result.automation.nextRunAt).toBe(future)
  })

  it('shouldPersistUpsertedAutomationWithResolvedDirectory', async () => {
    await handlers('/repo').upsert({
      automation: makeAutomation({ directory: '/repo/../repo/project-1' }),
    })
    const stored = store.list()
    expect(stored).toHaveLength(1)
    expect(stored[0].directory).toBe('/repo/project-1')
  })

  it('shouldReplaceExistingAutomationById', async () => {
    await handlers().upsert({ automation: makeAutomation({ name: 'before' }) })
    await handlers().upsert({ automation: makeAutomation({ name: 'after' }) })
    const stored = store.list()
    expect(stored).toHaveLength(1)
    expect(stored[0].name).toBe('after')
  })
})

describe('automation-remove', () => {
  it('shouldRequireId', async () => {
    await expect(handlers().remove({})).rejects.toThrow('id is required')
    await expect(handlers().remove(undefined)).rejects.toThrow('id is required')
  })

  it('shouldRemoveAutomationAndAckEvenWhenAbsent', async () => {
    await handlers().upsert({ automation: makeAutomation() })
    expect(await handlers().remove({ id: 'auto-1' })).toEqual({ ok: true })
    expect(store.list()).toHaveLength(0)
    // 멱등: 이미 없는 id도 ok — 중복 삭제 요청이 에러 토스트가 되지 않게.
    expect(await handlers().remove({ id: 'auto-1' })).toEqual({ ok: true })
  })
})

describe('automation-list', () => {
  it('shouldReturnAllAutomationsIncludingRunHistory', async () => {
    const withHistory = makeAutomation({
      nextRunAt: NOW + 60_000,
      runHistory: [{ at: NOW - 1, outcome: 'woke', sessionId: 'session-1' }],
    })
    store.upsert(withHistory)
    const result = await handlers().list(undefined)
    expect(result.automations).toEqual([withHistory])
  })
})
