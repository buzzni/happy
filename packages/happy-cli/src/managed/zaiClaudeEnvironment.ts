/**
 * The environment Claude Code is given to spend a Z.AI (GLM) key.
 *
 * GLM has no login of its own: a key is spent by Claude Code against Z.AI's
 * Anthropic-compatible endpoint, which means the whole configuration is an
 * environment — the base URL, the token, and the three model ids that map
 * Claude's tiers onto GLM's.
 *
 * Extracted because two callers now need exactly the same block and neither is
 * the other's neighbour: the trial lease applies it to a whole machine
 * (`daemon/aiCredentialRuntime`), and a managed Cloud run applies it to one
 * child (`managed/managedStartup`). A second copy of these ids is a second
 * place to forget when a model is renamed.
 *
 * Pure on purpose: no filesystem, no environment, nothing to inject.
 */
import { MANAGED_AI_AUTH_GLM_BASE_URL } from '@/managed/managedAiAuth';

/**
 * The models Claude Code's three tiers are served by on the GLM route.
 *
 * Named here rather than left inline because they are the part that changes:
 * the base URL is Z.AI's and stable, the model ids follow GLM releases.
 */
export const ZAI_CLAUDE_MODELS = {
    opus: 'glm-5.3',
    sonnet: 'glm-4.7',
    haiku: 'glm-4.7',
} as const;

/**
 * The model a GLM run uses when nothing more specific was picked.
 *
 * Not one of the three tiers above: GLM-5.3-Flash is a distinct, much cheaper
 * model (see aiUsagePricing.ts in web-ui) offered as its own catalog entry.
 *
 * Declared as the environment's default rather than translated at each call
 * site, so that "nothing picked" lands here no matter which path asked —
 * including the ones neither the selector nor the message loop owns (an
 * inherited default, a turn that carries no model, a Claude Code internal
 * call). Per-path handling still exists for the values that do arrive, but
 * this is the floor underneath all of them.
 */
export const ZAI_CLAUDE_DEFAULT_MODEL = 'glm-5.3-flash';

/**
 * Long, and deliberately: a GLM turn routed through the Anthropic wire can sit
 * well past the SDK's own default before its first token arrives.
 */
export const ZAI_CLAUDE_TIMEOUT_MS = '3000000';

/**
 * The seven variables, and only those seven.
 *
 * ANTHROPIC_MODEL names the default; the three ANTHROPIC_DEFAULT_*_MODEL
 * entries map Claude's tier aliases onto GLM for the turns that ask for a
 * tier by name. An explicitly selected model is passed to the SDK as an
 * option and takes precedence over this variable — the same layering the
 * inherited ANTHROPIC_MODEL this replaces already relied on.
 */
export function buildZaiClaudeEnvironment(apiKey: string): Record<string, string> {
    return {
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_BASE_URL: MANAGED_AI_AUTH_GLM_BASE_URL,
        API_TIMEOUT_MS: ZAI_CLAUDE_TIMEOUT_MS,
        ANTHROPIC_MODEL: ZAI_CLAUDE_DEFAULT_MODEL,
        ANTHROPIC_DEFAULT_OPUS_MODEL: ZAI_CLAUDE_MODELS.opus,
        ANTHROPIC_DEFAULT_SONNET_MODEL: ZAI_CLAUDE_MODELS.sonnet,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: ZAI_CLAUDE_MODELS.haiku,
    };
}
