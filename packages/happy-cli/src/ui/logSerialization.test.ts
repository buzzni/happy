import { describe, expect, it } from 'vitest'

import { formatLogLine } from './logSerialization'

describe('formatLogLine', () => {
  it('preserves the existing string and inspected-object file format', () => {
    expect(formatLogLine('[12:00:00.000]', 'event', [
      'plain',
      { nested: { ok: true } },
    ])).toBe("[12:00:00.000] event plain { nested: { ok: true } }\n")
  })
})
