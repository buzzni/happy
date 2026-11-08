import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from './claudeAuthOverrideEnv'

/**
 * The closed key set of an organization LLM endpoint session (aplus specs/org-llm-endpoints C5·r2).
 *
 * Three places need the same answer — the daemon's managed environment, the credential pin that re-asserts it
 * after Claude Code has read the user's and the project's settings, and the scrub that keeps a restarted daemon
 * from inheriting it — so the list lives once, here.
 */

/** Keys the endpoint gives a value; the values come from the synced entry and the selected target. */
export const ORG_ENDPOINT_VALUE_ENV_KEYS = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'API_TIMEOUT_MS',
    // Native host routing: Claude Code then ignores authentication env arriving through settings files.
    'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
] as const

/** Keys written empty: every other route to a model backend, which would otherwise outrank or bypass the endpoint. */
export const ORG_ENDPOINT_CLEARED_ENV_KEYS = [
    ...CLAUDE_AUTH_OVERRIDE_ENV_KEYS.filter((key) => key !== 'ANTHROPIC_AUTH_TOKEN' && key !== 'ANTHROPIC_BASE_URL'),
    'ANTHROPIC_SMALL_FAST_MODEL',
    'ANTHROPIC_PROFILE',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
    'CLAUDE_CODE_USE_MANTLE',
] as const

export const ORG_ENDPOINT_OWNED_ENV_KEYS: readonly string[] = [...ORG_ENDPOINT_VALUE_ENV_KEYS, ...ORG_ENDPOINT_CLEARED_ENV_KEYS]

/**
 * The routing part of an endpoint session's environment as a settings `env` block, or undefined outside one.
 *
 * Passed to the terminal's Claude through `--settings`, which outranks the user's and the project's settings files
 * on any Claude Code version, so those cannot re-point the address or the models. The token is left out on purpose:
 * it would otherwise be written to a file, and without the address a token set elsewhere reaches only the endpoint.
 */
export function orgEndpointRoutingSettingsEnv(env: Record<string, string | undefined>): Record<string, string> | undefined {
    if (env.HAPPY_AI_AUTH_SOURCE !== 'org-endpoint' || !env.ANTHROPIC_BASE_URL) return undefined
    const block: Record<string, string> = {}
    for (const key of ORG_ENDPOINT_OWNED_ENV_KEYS) {
        const value = env[key]
        if (key !== 'ANTHROPIC_AUTH_TOKEN' && value !== undefined) block[key] = value
    }
    return block
}
