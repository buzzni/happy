import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CODEX_OWNER_MANAGED_REFRESH_TOKEN, readCodexLogin, withCodexOwnerRefreshNotice } from './codexOwnerManagedLogin'

const login = (refreshToken: string) => JSON.stringify({ tokens: { account_id: 'account-a', access_token: 'access', refresh_token: refreshToken } })

describe('Codex owner-managed login failures', () => {
  it.each([
    'workspace routing discovery unauthorized (401)',
    'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
    'Failed to refresh token: token_expired',
  ])('marks an authentication failure of an owner-managed login: %s', (failure) => {
    expect(withCodexOwnerRefreshNotice(failure, login(CODEX_OWNER_MANAGED_REFRESH_TOKEN)))
      .toBe(`${failure} [CODEX_OWNER_REFRESH_REQUIRED] This account is renewed on its owner machine; check that machine is online.`)
  })

  it('leaves failures of a machine that holds its own refresh token unchanged', () => {
    expect(withCodexOwnerRefreshNotice('unauthorized (401)', login('own-refresh-token'))).toBe('unauthorized (401)')
  })

  it.each([null, '', 'not json', JSON.stringify({ tokens: null })])('leaves failures unchanged without a readable login: %s', (raw) => {
    expect(withCodexOwnerRefreshNotice('unauthorized (401)', raw)).toBe('unauthorized (401)')
  })

  it('leaves non-authentication failures of an owner-managed login unchanged', () => {
    expect(withCodexOwnerRefreshNotice('model is overloaded (503)', login(CODEX_OWNER_MANAGED_REFRESH_TOKEN))).toBe('model is overloaded (503)')
  })
})

describe('reading the Codex login', () => {
  it('reads auth.json from CODEX_HOME and returns null when it is missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-login-'))
    try {
      expect(readCodexLogin({ CODEX_HOME: home })).toBeNull()
      await writeFile(join(home, 'auth.json'), login('x'))
      expect(readCodexLogin({ CODEX_HOME: home })).toBe(login('x'))
    } finally { await rm(home, { recursive: true, force: true }) }
  })
})
