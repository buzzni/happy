import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Logger } from './logger'

const originalDebug = process.env.DEBUG

afterEach(() => {
  vi.useRealTimers()
  if (originalDebug === undefined) delete process.env.DEBUG
  else process.env.DEBUG = originalDebug
})

describe('Logger content policy', () => {
  it('does not serialize large JSON payloads in production mode', () => {
    delete process.env.DEBUG
    const directory = mkdtempSync(join(tmpdir(), 'happy-logger-'))
    const logPath = join(directory, 'test.log')
    const logger = new Logger(logPath)

    logger.debugLargeJson('[RPC] request', {
      params: 'prompt body that must not reach production logs',
      token: 'credential-that-must-not-leak',
    })

    const contents = readFileSync(logPath, 'utf8')
    expect(contents).toContain('[large payload omitted in production]')
    expect(contents).not.toContain('prompt body')
    expect(contents).not.toContain('credential-that-must-not-leak')
  })

  it('keeps one hour of high-frequency production payload events below the idle log budget', () => {
    delete process.env.DEBUG
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'))
    const directory = mkdtempSync(join(tmpdir(), 'happy-logger-volume-'))
    const logPath = join(directory, 'test.log')
    const logger = new Logger(logPath)

    for (let minute = 0; minute < 60; minute += 1) {
      for (let event = 0; event < 100; event += 1) {
        logger.debugLargeJson('[API MACHINE] Received RPC request:', {
          params: `payload-${minute}-${event}`,
        })
      }
      vi.advanceTimersByTime(60_000)
    }

    const contents = readFileSync(logPath, 'utf8')
    expect(Buffer.byteLength(contents, 'utf8')).toBeLessThan(5 * 1024 * 1024)
    expect(contents.trim().split('\n')).toHaveLength(60)
    expect(contents).not.toContain('payload-')
  })
})
