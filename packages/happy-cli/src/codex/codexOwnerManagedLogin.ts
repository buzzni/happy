/**
 * Stands in for every refresh token of a refresh-owner Codex bundle (specs/codex-oauth-refresh-owner): only the
 * source machine may rotate a ChatGPT refresh token, since a copy rotated elsewhere fails the owner with
 * "refresh token was already used". Not a secret; long enough to pass codex-multi-auth's non-empty schema,
 * which silently drops accounts with an empty one, and refused by the token endpoint if a target tries it.
 */
export const CODEX_OWNER_MANAGED_REFRESH_TOKEN = 'saycode-owner-managed-refresh-v1'
