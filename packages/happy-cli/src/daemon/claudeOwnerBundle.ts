import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '../claude/utils/claudeAuthOverrideEnv'
/** Versioned access-only Claude OAuth contract. No refresh grant may cross a machine boundary. */
type Account = Record<string, any>
export function claudeOauth(account: Account): Account | undefined {
  const value = account?.credentials?.claudeAiOauth
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}
export function isClaudeOwnerAccount(account: Account): boolean {
  return claudeOauth(account)?.saycodeRefreshOwnerVersion === 1
}
export function hasClaudeOwnerAccounts(payload: string): boolean {
  try { return JSON.parse(payload).accounts.some((a: Account) => claudeOauth(a)?.saycodeRefreshOwnerVersion !== undefined) } catch { return false }
}
export function containsClaudeRefreshSecret(payload: string): boolean {
  try {
    const pending: unknown[] = [JSON.parse(payload)]
    while (pending.length) {
      const node = pending.pop()
      if (!node || typeof node !== 'object') continue
      for (const [key, child] of Object.entries(node)) {
        if (['refreshToken', 'refresh_token'].includes(key) && child !== '' && child !== null) return true
        pending.push(child)
      }
    }
  } catch { /* Payload shape validation owns malformed JSON. */ }
  return false
}
export function holdsNoClaudeRefreshToken(payload: string): boolean {
  try {
    const value = JSON.parse(payload)
    if (value.version !== 1 || value.encrypted !== false || !Array.isArray(value.accounts) || !value.accounts.length) return false
    if (containsClaudeRefreshSecret(payload)) return false
    return value.accounts.every((account: Account) => {
      if (typeof account.credentials === 'string') return account.credentials.startsWith('sk-ant-api')
      const data = claudeOauth(account)
      if (!data || typeof data.accessToken !== 'string' || !data.accessToken) return false
      if (data.saycodeRefreshOwnerVersion === undefined && data.accessToken.startsWith('sk-ant-oat01-')) return true
      return isClaudeOwnerAccount(account) && typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt) && data.expiresAt > 0
    })
  } catch { return false }
}
export function newerClaudeOwnerAccounts(incoming: Account[], local: Account[]): Account[] {
  return incoming.filter(account => {
    const matches = local.filter(candidate => candidate.email === account.email && (candidate.organizationUuid || '') === (account.organizationUuid || ''))
    if (matches.length > 1) throw new Error('CLAUDE_OWNER_IDENTITY_CONFLICT')
    if (!matches.length) return true
    const next = claudeOauth(account)!, previous = claudeOauth(matches[0]!)
    if (!previous || typeof previous.expiresAt !== 'number') throw new Error('CLAUDE_OWNER_LOCAL_CREDENTIAL_UNKNOWN')
    if (next.expiresAt === previous.expiresAt && next.accessToken !== previous.accessToken) throw new Error('CLAUDE_OWNER_GENERATION_CONFLICT')
    if (next.expiresAt < previous.expiresAt && previous.refreshToken) throw new Error('CLAUDE_OWNER_SOURCE_STALE')
    return next.expiresAt > previous.expiresAt || next.expiresAt === previous.expiresAt && next.accessToken === previous.accessToken && !!previous.refreshToken
  })
}

/** A target runs with an explicit bearer, so Claude Code has no refresh grant to consume. */
export function claudeOwnerEnvironment(payload: string, now: number, expectedIdentity?: string): Record<string, string> {
  const value = JSON.parse(payload)
  if (value.version !== 1 || value.encrypted !== false || !Array.isArray(value.accounts)) throw new Error('CLAUDE_OWNER_REFRESH_REQUIRED')
  const active = value.accounts?.find((account: Account) => account.number === value.activeAccountNumber)
  if (!active || !isClaudeOwnerAccount(active)) {
    if (expectedIdentity) throw new Error('CLAUDE_OWNER_REFRESH_REQUIRED')
    return {}
  }
  if (typeof active.email !== 'string' || !active.email.trim() || active.organizationUuid !== undefined && typeof active.organizationUuid !== 'string') throw new Error('CLAUDE_OWNER_REFRESH_REQUIRED')
  const data = claudeOauth(active)!
  const identity = JSON.stringify([active.email, active.organizationUuid || ''])
  if (!holdsNoClaudeRefreshToken(JSON.stringify({ ...value, accounts: [active] })) || data.expiresAt <= now
      || expectedIdentity && expectedIdentity !== identity) throw new Error('CLAUDE_OWNER_REFRESH_REQUIRED')
  return { ...Object.fromEntries(CLAUDE_AUTH_OVERRIDE_ENV_KEYS.map(key => [key, ''])),
    CLAUDE_CODE_OAUTH_TOKEN: data.accessToken, HAPPY_CLAUDE_OWNER_IDENTITY: identity, HAPPY_AI_AUTH_SOURCE: 'org-bundle' }
}
export function hasClaudeSubscriptionAccounts(payload: string): boolean {
  try { return JSON.parse(payload).accounts.some((a: Account) => {
    const data = claudeOauth(a)
    return data && (data.saycodeRefreshOwnerVersion !== undefined || typeof data.accessToken === 'string' && !data.accessToken.startsWith('sk-ant-oat01-'))
  }) } catch { return false }
}
