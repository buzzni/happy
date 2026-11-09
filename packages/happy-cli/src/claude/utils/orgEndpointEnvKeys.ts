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
    // Not a model backend but the transport: with a socket Claude Code sends every request there under the same address
    // and token (observed with the real SDK, credentialPin.integration.test.ts), so a listener on the machine reads both.
    'ANTHROPIC_UNIX_SOCKET',
    // Not a route to a model but a second way for the conversation to leave: with the switch on, Claude Code posts prompts
    // and API bodies to whatever OTEL_EXPORTER_OTLP_ENDPOINT / BETA_TRACING_ENDPOINT name (observed with the real SDK).
    // Only the gates are owned; the exporter variables are inert without them and a developer's own app may use them.
    'CLAUDE_CODE_ENABLE_TELEMETRY',
    'ENABLE_BETA_TRACING_DETAILED',
    'BETA_TRACING_ENDPOINT',
] as const

export const ORG_ENDPOINT_OWNED_ENV_KEYS: readonly string[] = [...ORG_ENDPOINT_VALUE_ENV_KEYS, ...ORG_ENDPOINT_CLEARED_ENV_KEYS]

/**
 * The transport the machine itself chose: its proxy and TLS trust. A project's settings file must not route the
 * endpoint's requests through a proxy of its own (with the token, and the conversation in plain text to an http target),
 * so these hold the session's own values — empty when it has none — above the settings files. They stay out of the
 * pinned set: a managed policy that sets a proxy outranks the flag layer and is the administrator's to set, and the
 * daemon has no reason to drop them from a restarted daemon either. Requests cannot carry them (sessionEnv drops them).
 */
export const ORG_ENDPOINT_MACHINE_ENV_KEYS = [
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
    'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS',
] as const

/**
 * The routing part of an endpoint session's environment as a settings `env` block, or undefined outside one.
 *
 * Passed to Claude Code as flag settings at startup (`--settings`), which outrank the user's and the project's settings
 * files on any Claude Code version — and are in force before the SDK pin can apply its own after start-up, which is too
 * late for what Claude Code initialises from the files' env (telemetry). The token is left out on purpose: it would
 * otherwise be written to a file or an argument. A closed route is written empty whether or not the daemon's
 * environment carried it, so a daemon that predates a key still closes it.
 */
export function orgEndpointRoutingSettingsEnv(env: Record<string, string | undefined>): Record<string, string> | undefined {
    if (env.HAPPY_AI_AUTH_SOURCE !== 'org-endpoint' || !env.ANTHROPIC_BASE_URL) return undefined
    const block: Record<string, string> = {}
    for (const key of ORG_ENDPOINT_VALUE_ENV_KEYS) {
        const value = env[key]
        if (key !== 'ANTHROPIC_AUTH_TOKEN' && value !== undefined) block[key] = value
    }
    for (const key of ORG_ENDPOINT_CLEARED_ENV_KEYS) block[key] = ''
    for (const key of ORG_ENDPOINT_MACHINE_ENV_KEYS) block[key] = env[key] ?? ''
    return block
}
