import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { awaitFileExist } from './awaitFileExist'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('awaitFileExist', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `afe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('finds a file written shortly after the wait began without waiting a full second', async () => {
    // The first Claude turn waits here for its transcript while the message loop is held,
    // so every extra polling interval delays the turn's first streamed text.
    const file = join(testDir, 'session.jsonl')
    const startedAt = Date.now()
    setTimeout(() => { void writeFile(file, '') }, 100)

    const found = await awaitFileExist(file, 5000)

    expect(found).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  it('gives up with false once the timeout passes', async () => {
    const found = await awaitFileExist(join(testDir, 'never.jsonl'), 300)

    expect(found).toBe(false)
  })
})
