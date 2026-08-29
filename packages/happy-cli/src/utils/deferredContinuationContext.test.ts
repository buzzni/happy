import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('fails closed when a staged context file disappears before the child reads it', () => {
    const home = mkdtempSync(join(tmpdir(), 'happy-deferred-context-'))
    directories.push(home)
    const file = join(home, 'missing-context.txt')
    writeFileSync(file, 'context', 'utf8')
    expect(readFileSync(file, 'utf8')).toBe('context')
    rmSync(file)

    expect(() => createDeferredContinuationContextConsumer({
      HAPPY_DEFERRED_CONTINUATION_CONTEXT_FILE: file,
    })).toThrow('Deferred continuation context could not be loaded')
  })

  it('fails closed when a staged context file is empty', () => {
    const home = mkdtempSync(join(tmpdir(), 'happy-deferred-context-'))
    directories.push(home)
    const file = join(home, 'empty-context.txt')
    writeFileSync(file, '   ', 'utf8')

    expect(() => createDeferredContinuationContextConsumer({
      HAPPY_DEFERRED_CONTINUATION_CONTEXT_FILE: file,
    })).toThrow('Deferred continuation context could not be loaded')
  })

  it('does not replay accepted context when staged file cleanup fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'happy-deferred-context-'))
    directories.push(home)
    const staged = await stageDeferredContinuationContext('previous context', home)
    const consumer = createDeferredContinuationContextConsumer({
      HAPPY_DEFERRED_CONTINUATION_CONTEXT_FILE: staged.file,
    })
    const prepared = consumer.prepare('first explicit turn')

    rmSync(staged.file)
    mkdirSync(staged.file)

    expect(() => prepared?.commit()).not.toThrow()
    expect(consumer.prepare('second turn')).toBeNull()
  })

  it('discards pending context when the first explicit input clears the conversation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'happy-deferred-context-'))
    directories.push(home)
    const staged = await stageDeferredContinuationContext('previous context', home)
    const consumer = createDeferredContinuationContextConsumer({
      HAPPY_DEFERRED_CONTINUATION_CONTEXT_FILE: staged.file,
    })

    expect(consumer.prepare('/clear')).toBeNull()
    expect(existsSync(staged.file)).toBe(false)
    expect(consumer.prepare('start fresh')).toBeNull()
  })
})
