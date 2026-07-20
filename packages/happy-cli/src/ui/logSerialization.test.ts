import { describe, expect, it } from 'vitest'

import { formatLogLine } from './logSerialization'

describe('formatLogLine', () => {
  it('preserves the existing string and inspected-object file format', () => {
    expect(formatLogLine('[12:00:00.000]', 'event', [
      'plain',
      { nested: { ok: true } },
    ])).toBe("[12:00:00.000] event plain { nested: { ok: true } }\n")
  })

  it('redacts credential-shaped fields recursively without mutating the input', () => {
    const input = {
      token: 'top-secret-token',
      nested: {
        authorization: 'Bearer private-value',
        encryptionKey: 'private-encryption-key',
        safe: 'visible',
      },
    }

    const line = formatLogLine('[12:00:00.000]', 'event', [input])

    expect(line).toContain("token: '[REDACTED]'")
    expect(line).toContain("authorization: '[REDACTED]'")
    expect(line).toContain("encryptionKey: '[REDACTED]'")
    expect(line).toContain("safe: 'visible'")
    expect(line).not.toContain('top-secret-token')
    expect(input.token).toBe('top-secret-token')
  })
})
