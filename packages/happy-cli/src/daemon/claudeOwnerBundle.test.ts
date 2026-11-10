import { describe, expect, it } from 'vitest'
import { claudeOwnerEnvironment, holdsNoClaudeRefreshToken, isClaudeOwnerAccount, newerClaudeOwnerAccounts } from './claudeOwnerBundle'
const account = (expiresAt: number, token = 'fake') => ({ email: 'a@example.com', organizationUuid: '', credentials: { claudeAiOauth: { accessToken: token, expiresAt, saycodeRefreshOwnerVersion: 1 } } })
describe('Claude owner transfer contract', () => {
  it('rejects secrets anywhere, unknown markers and missing expiry', () => {
    const payload = (a: unknown) => JSON.stringify({ version: 1, encrypted: false, accounts: [a] })
    expect(holdsNoClaudeRefreshToken(payload(account(100)))).toBe(true)
    expect(holdsNoClaudeRefreshToken(payload({ ...account(100), refresh_token: 'secret' }))).toBe(false)
    expect(holdsNoClaudeRefreshToken(payload({ credentials: { claudeAiOauth: { accessToken: 'fake' } } }))).toBe(false)
    expect(isClaudeOwnerAccount({ credentials: { claudeAiOauth: { saycodeRefreshOwnerVersion: true } } })).toBe(false)
  })
  it('only advances a captured account and preserves a newer local login', () => {
    expect(newerClaudeOwnerAccounts([account(300)], [account(200)])).toEqual([account(300)])
    expect(newerClaudeOwnerAccounts([account(100)], [account(200)])).toEqual([])
    expect(() => newerClaudeOwnerAccounts([account(200, 'other')], [account(200)])).toThrow('CLAUDE_OWNER_GENERATION_CONFLICT')
    expect(newerClaudeOwnerAccounts([account(200)], [account(200)])).toEqual([])
  })
})

it('removes an equal-generation refresh copy only through explicit target migration', () => {
  const local = account(200)
  Object.assign(local.credentials.claudeAiOauth, { refreshToken: 'copied-secret' })
  expect(newerClaudeOwnerAccounts([account(200)], [local])).toEqual([account(200)])
})
it('pins only a fresh owner bearer and refuses another account on resume', () => {
  const payload = JSON.stringify({ version: 1, encrypted: false, activeAccountNumber: 1, accounts: [{ ...account(200), number: 1 }] })
  const environment = claudeOwnerEnvironment(payload, 100)
  expect(environment).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'fake', HAPPY_CLAUDE_OWNER_IDENTITY: JSON.stringify(['a@example.com', '']), ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', HAPPY_AI_AUTH_SOURCE: 'org-bundle' })
  expect(() => claudeOwnerEnvironment(payload, 200)).toThrow('CLAUDE_OWNER_REFRESH_REQUIRED')
  expect(() => claudeOwnerEnvironment(payload, 100, 'other-account')).toThrow('CLAUDE_OWNER_REFRESH_REQUIRED')
  expect(JSON.stringify(environment)).not.toContain('refreshToken')
})
