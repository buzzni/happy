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
    // Each time a Claude provider starts, its message loop waits here for the transcript,
    // so every extra polling interval delays that turn's first streamed text.
    const file = join(testDir, 'session.jsonl')
    const startedAt = Date.now()
    setTimeout(() => { writeFile(file, '').catch(() => {}) }, 100)

    const found = await awaitFileExist(file, 5000)

    expect(found).toBe(true)
    // The old one-second poll could not finish before about 1000ms; leave room for a busy event loop.
    expect(Date.now() - startedAt).toBeLessThan(900)
  })

  it('gives up with false once the timeout passes', async () => {
    const found = await awaitFileExist(join(testDir, 'never.jsonl'), 300)

    expect(found).toBe(false)
  })
})
