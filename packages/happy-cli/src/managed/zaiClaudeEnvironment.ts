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
 * Long, and deliberately: a GLM turn routed through the Anthropic wire can sit
 * well past the SDK's own default before its first token arrives.
 */
export const ZAI_CLAUDE_TIMEOUT_MS = '3000000';

/** The six variables, and only those six. */
export function buildZaiClaudeEnvironment(apiKey: string): Record<string, string> {
    return {
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_BASE_URL: MANAGED_AI_AUTH_GLM_BASE_URL,
        API_TIMEOUT_MS: ZAI_CLAUDE_TIMEOUT_MS,
        ANTHROPIC_DEFAULT_OPUS_MODEL: ZAI_CLAUDE_MODELS.opus,
        ANTHROPIC_DEFAULT_SONNET_MODEL: ZAI_CLAUDE_MODELS.sonnet,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: ZAI_CLAUDE_MODELS.haiku,
    };
}
