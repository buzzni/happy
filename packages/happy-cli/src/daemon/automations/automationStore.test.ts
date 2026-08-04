import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { MAX_AUTOMATIONS, type ScheduledAutomation } from './automationDomain'
import { createAutomationStore } from './automationStore'
import { makeAutomation } from './automationTestFixtures'

describe('automationStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'automation-store-'))
    file = path.join(dir, 'automations.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the store owner-only (0600) — prompts and script commands are sensitive', () => {
    if (process.platform === 'win32') return
    const store = createAutomationStore({ filePath: file })
    store.upsert(makeAutomation())
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // 기존 0644 파일도 다음 쓰기(tmp+rename)에서 0600으로 교체된다.
    chmodSync(file, 0o644)
    store.upsert(makeAutomation({ id: 'auto-2' }))
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('lists an empty array when the file is missing', () => {
    const store = createAutomationStore({ filePath: file })
    expect(store.list()).toEqual([])
  })

  it('lists an empty array when the file is corrupt, and recovers on next write', () => {
    writeFileSync(file, '{ not valid json', 'utf-8')
    const store = createAutomationStore({ filePath: file })
    expect(store.list()).toEqual([])
    store.upsert(makeAutomation())
    expect(store.list()).toEqual([makeAutomation()])
  })

  it('persists upserts across store instances', () => {
    createAutomationStore({ filePath: file }).upsert(makeAutomation())
    expect(createAutomationStore({ filePath: file }).list()).toEqual([makeAutomation()])
  })

  it('upsert replaces the entry with the same id in place', () => {
    const store = createAutomationStore({ filePath: file })
    store.upsert(makeAutomation({ id: 'auto-1', name: 'before' }))
    store.upsert(makeAutomation({ id: 'auto-2' }))
    store.upsert(makeAutomation({ id: 'auto-1', name: 'after' }))
    expect(store.list().map((entry) => [entry.id, entry.name])).toEqual([
      ['auto-1', 'after'],
      ['auto-2', '아침 로그 점검'],
    ])
  })

  it('upsert throws when adding beyond the automation cap', () => {
    const store = createAutomationStore({ filePath: file })
    store.replaceAll(Array.from({ length: MAX_AUTOMATIONS }, (_, index) => makeAutomation({ id: `auto-${index}` })))
    expect(() => store.upsert(makeAutomation({ id: 'one-too-many' }))).toThrow(/automation-limit-reached/)
    // 기존 항목 교체는 상한과 무관하게 허용된다.
    store.upsert(makeAutomation({ id: 'auto-0', name: 'replaced' }))
    expect(store.list()[0]!.name).toBe('replaced')
  })

  it('remove deletes an existing entry and reports missing ids', () => {
    const store = createAutomationStore({ filePath: file })
    store.upsert(makeAutomation())
    expect(store.remove('auto-1')).toBe(true)
    expect(store.list()).toEqual([])
    expect(store.remove('auto-1')).toBe(false)
  })

  it('replaceAll swaps the whole list and caps it at the maximum', () => {
    const store = createAutomationStore({ filePath: file })
    store.upsert(makeAutomation({ id: 'old' }))
    store.replaceAll(Array.from({ length: MAX_AUTOMATIONS + 1 }, (_, index) => makeAutomation({ id: `auto-${index}` })))
    const listed = store.list()
    expect(listed).toHaveLength(MAX_AUTOMATIONS)
    expect(listed.some((entry) => entry.id === 'old')).toBe(false)
  })

  it('update rewrites a single entry and returns it, null for missing ids', () => {
    const store = createAutomationStore({ filePath: file })
    store.upsert(makeAutomation({ id: 'auto-1' }))
    store.upsert(makeAutomation({ id: 'auto-2' }))
    const updated = store.update('auto-1', (entry) => ({ ...entry, paused: true }))
    expect(updated?.paused).toBe(true)
    expect(store.list().map((entry) => entry.paused)).toEqual([true, false])
    expect(store.update('missing', (entry) => entry)).toBeNull()
  })

  // 데몬은 단일 실행자지만 핸들러마다 store 인스턴스가 다를 수 있다 — 쓰기는 항상
  // 최신 파일을 다시 읽어 병합해야 서로의 변경을 덮어쓰지 않는다.
  it('merges onto the latest file contents instead of a stale in-memory copy', () => {
    const first = createAutomationStore({ filePath: file })
    first.list() // 예전 상태(빈 목록)를 읽어둔 뒤에도
    const second = createAutomationStore({ filePath: file })
    second.upsert(makeAutomation({ id: 'from-second' }))
    first.upsert(makeAutomation({ id: 'from-first' }))
    expect(first.list().map((entry) => entry.id).sort()).toEqual(['from-first', 'from-second'])
  })

  it('round-trips future fields through read-modify-write cycles', () => {
    const withExtra = { ...makeAutomation(), futureField: { keep: true } } as unknown as ScheduledAutomation
    writeFileSync(file, JSON.stringify([withExtra]), 'utf-8')
    const store = createAutomationStore({ filePath: file })
    store.update('auto-1', (entry) => ({ ...entry, paused: true }))
    const reread = createAutomationStore({ filePath: file }).list()
    expect((reread[0] as unknown as Record<string, unknown>).futureField).toEqual({ keep: true })
    expect(reread[0]!.paused).toBe(true)
  })

  it('creates parent directories for the store file', () => {
    const nested = path.join(dir, 'nested', 'deeper', 'automations.json')
    createAutomationStore({ filePath: nested }).upsert(makeAutomation())
    expect(JSON.parse(readFileSync(nested, 'utf-8'))).toHaveLength(1)
  })

  it('leaves no tmp files behind after writes', () => {
    const store = createAutomationStore({ filePath: file })
    store.upsert(makeAutomation())
    store.remove('auto-1')
    expect(readdirSync(dir)).toEqual(['automations.json'])
    expect(readFileSync(file, 'utf-8')).toBe('[]')
  })
})
