import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { RotatingLogWriter, readLogRotationPolicy } from './logRotation'

describe('RotatingLogWriter', () => {
  it('keeps the current path and at most three completed segments', () => {
    const directory = mkdtempSync(join(tmpdir(), 'happy-log-rotation-'))
    const logPath = join(directory, 'daemon.log')
    const writer = new RotatingLogWriter(logPath, {
      maxFileBytes: 10,
      maxArchives: 3,
    })

    for (let index = 0; index < 9; index += 1) writer.append(`${index}abc\n`)

    expect(readFileSync(logPath, 'utf8')).toBe('8abc\n')
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('6abc\n7abc\n')
    expect(readFileSync(`${logPath}.2`, 'utf8')).toBe('4abc\n5abc\n')
    expect(readFileSync(`${logPath}.3`, 'utf8')).toBe('2abc\n3abc\n')
    expect(existsSync(`${logPath}.4`)).toBe(false)
    expect(readdirSync(directory)).toHaveLength(4)
  })

  it('uses safe defaults when environment overrides are invalid', () => {
    expect(readLogRotationPolicy({
      HAPPY_LOG_MAX_FILE_BYTES: '-1',
      HAPPY_LOG_MAX_ARCHIVES: 'not-a-number',
    })).toEqual({
      maxFileBytes: 25 * 1024 * 1024,
      maxArchives: 3,
    })
  })

  it('falls back to the current file when archive rotation fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'happy-log-rotation-failure-'))
    const logPath = join(directory, 'daemon.log')
    const writer = new RotatingLogWriter(logPath, { maxFileBytes: 10, maxArchives: 1 })
    writer.append('1234567890')
    mkdirSync(`${logPath}.1`)

    expect(() => writer.append('fallback')).not.toThrow()
    expect(readFileSync(logPath, 'utf8')).toBe('1234567890fallback')
  })
})
