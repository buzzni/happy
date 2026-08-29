import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createDeferredContinuationContextConsumer,
  DEFERRED_CONTINUATION_CONTEXT_MAX_BYTES,
  stageDeferredContinuationContext,
} from './deferredContinuationContext'

describe('deferred continuation context', () => {
  const directories: string[] = []

  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await Promise.all(directories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )))
  })

  it('keeps context for retry and removes it only after the first accepted turn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'happy-deferred-context-'))
    directories.push(home)
    const staged = await stageDeferredContinuationContext('previous answer: use port 4312', home)
    const env = { HAPPY_DEFERRED_CONTINUATION_CONTEXT_FILE: staged.file }
    const consumer = createDeferredContinuationContextConsumer(env)

    const failed = consumer.prepare('continue the work')
    expect(failed?.text).toContain('previous answer: use port 4312')
    expect(failed?.text).toContain('continue the work')
    expect(env.HAPPY_DEFERRED_CONTINUATION_CONTEXT_FILE).toBeUndefined()
    failed?.rollback()

    const retried = consumer.prepare('continue the work')
    expect(retried?.text).toBe(failed?.text)
    expect(existsSync(staged.file)).toBe(true)
    retried?.commit()

    expect(existsSync(staged.file)).toBe(false)
    expect(consumer.prepare('one more question')).toBeNull()
  })

  it('rejects empty and oversized context without writing it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'happy-deferred-context-'))
    directories.push(home)

    await expect(stageDeferredContinuationContext('   ', home)).rejects.toThrow(
      'Deferred continuation context must be a non-empty string',
    )
    await expect(stageDeferredContinuationContext(
      'a'.repeat(DEFERRED_CONTINUATION_CONTEXT_MAX_BYTES + 1),
      home,
    )).rejects.toThrow('Deferred continuation context is too large')
  })

  it('does not consume a context file that disappeared before restart hydration', () => {
    const home = mkdtempSync(join(tmpdir(), 'happy-deferred-context-'))
    directories.push(home)
    const file = join(home, 'missing-context.txt')
    writeFileSync(file, 'context', 'utf8')
    expect(readFileSync(file, 'utf8')).toBe('context')
    rmSync(file)

    const consumer = createDeferredContinuationContextConsumer({
      HAPPY_DEFERRED_CONTINUATION_CONTEXT_FILE: file,
    })

    expect(consumer.prepare('next')).toBeNull()
  })
})
