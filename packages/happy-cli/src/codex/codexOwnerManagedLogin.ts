import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Stands in for every refresh token of a refresh-owner Codex bundle (specs/codex-oauth-refresh-owner): only the
 * source machine may rotate a ChatGPT refresh token, since a copy rotated elsewhere fails the owner with
 * "refresh token was already used". Not a secret; long enough to pass codex-multi-auth's non-empty schema,
 * which silently drops accounts with an empty one, and refused by the token endpoint if a target tries it.
 */
export const CODEX_OWNER_MANAGED_REFRESH_TOKEN = 'saycode-owner-managed-refresh-v1'

const AUTHENTICATION_FAILURE = /\b401\b|unauthori[sz]ed|token_expired|could not be refreshed|refresh token|sign in again/i

/**
 * A target machine cannot renew an owner-managed login, so its authentication failures mean the owner has not
 * delivered a renewed one yet. The code lets Desktop show that cause instead of a generic sign-in prompt.
 */
export function withCodexOwnerRefreshNotice(failure: string, authJson: string | null): string {
  if (!AUTHENTICATION_FAILURE.test(failure)) return failure
  let refreshToken: unknown
  try { refreshToken = (JSON.parse(authJson ?? '') as { tokens?: { refresh_token?: unknown } | null }).tokens?.refresh_token } catch { return failure }
  return refreshToken === CODEX_OWNER_MANAGED_REFRESH_TOKEN
    ? `${failure} [CODEX_OWNER_REFRESH_REQUIRED] This account is renewed on its owner machine; check that machine is online.`
    : failure
}

/** The login Codex reads for this process, or null when there is none to inspect. */
export function readCodexLogin(env: NodeJS.ProcessEnv = process.env): string | null {
  try { return readFileSync(join(env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'), 'utf8') } catch { return null }
}
