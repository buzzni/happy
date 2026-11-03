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

  it('redacts credential-shaped fields an error carries, keeping its message and stack', () => {
    // An HTTP client error carries the request it was made with — headers
    // included — as enumerable properties. Dumped raw on a 401, the daemon log
    // held the bearer it had just been refused for.
    const error = Object.assign(new Error('Request failed with status code 401'), {
      config: { url: 'https://happy.example/v1/machines/m-1', headers: { Authorization: 'Bearer daemon-secret' } },
      response: { status: 401, data: { error: 'Invalid token' } },
    })

    const line = formatLogLine('[12:00:00.000]', 'fatal', [error])

    expect(line).toContain('Request failed with status code 401')
    expect(line).toContain('at ')
    expect(line).toContain("Authorization: '[REDACTED]'")
    expect(line).toContain('status: 401')
    expect(line).not.toContain('daemon-secret')
    expect((error as { config: { headers: { Authorization: string } } }).config.headers.Authorization)
      .toBe('Bearer daemon-secret')
  })
})

it('redacts reservation message capabilities in socket and HTTP request diagnostics', () => {
  const line = formatLogLine('[time]', 'request', [{ auth: { reservationAuthorization: 'epoch.secret-socket' }, headers: { 'X-Happy-Reservation-Authorization': 'epoch.secret-http' } }]);
  expect(line).not.toContain('secret-socket'); expect(line).not.toContain('secret-http');
  expect(line.match(/REDACTED/g)).toHaveLength(2);
});

it('redacts a reservation bootstrap and encrypted-checkpoint key before provider startup', () => {
  const line = formatLogLine('[time]', 'spawn', [{ env: { HAPPY_RESERVATION_BOOTSTRAP_V1: '{"messageAuthorization":"private-bootstrap-capability"}' }, reservation: { stateKey: 'private-checkpoint-key' } }]);
  expect(line).not.toContain('private-bootstrap-capability'); expect(line).not.toContain('private-checkpoint-key');
  expect(line.match(/REDACTED/g)).toHaveLength(2);
});
