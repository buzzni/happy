/**
 * Model names in an organization LLM endpoint session (aplus specs/org-llm-endpoints r2).
 *
 * The endpoint serves the models its admin registered and nothing else, but a turn can still name a Claude ID:
 * the app's picker, automatic routing and the title job all do. The daemon wrote the endpoint's names into the
 * session environment; every requested model folds onto them.
 */

const TIER_ENV = {
    opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
} as const

const OWN_NAME_ENV = ['ANTHROPIC_MODEL', ...Object.values(TIER_ENV)] as const

type ModelEnv = Record<string, string | undefined>

/** An endpoint session that names its model; without one there is nothing to fold onto. */
export function isOrgEndpointRuntime(env: ModelEnv): boolean {
    return env.HAPPY_AI_AUTH_SOURCE === 'org-endpoint' && !!env.ANTHROPIC_MODEL
}

/** A tier alias maps to the endpoint's tier model, a name the endpoint defines stays, anything else is the endpoint model. */
export function foldModelToOrgEndpoint(model: string | undefined, env: ModelEnv): string | undefined {
    if (!model || !isOrgEndpointRuntime(env)) return model
    if (OWN_NAME_ENV.some((key) => env[key] === model)) return model
    const alias = model.replace(/\[1m\]$/i, '')
    const tierKey = TIER_ENV[alias as keyof typeof TIER_ENV]
    return (tierKey && env[tierKey]) || env.ANTHROPIC_MODEL
}
