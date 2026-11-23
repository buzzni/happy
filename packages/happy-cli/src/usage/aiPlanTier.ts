/**
 * The plan tier of the login a run spent, as the usage ledger names it
 * (`<family>:<tier>`: `claude:max_20x`, `chatgpt:plus`).
 *
 * aplus-dev-studio `packages/web-ui/server/aiPlanTier.ts` validates the shape and
 * downgrades anything else to NULL; this side only decides **whether** the CLI
 * stated a plan for the login the run actually used (aplus
 * specs/org-member-ai-plan-usage P2·P3).
 *
 * Pure on purpose: the run hands in what Claude Code / Codex reported. No
 * credential store is read here — the official CLIs already decided the tier.
 *
 * ## Not guessing is the point
 *
 * A machine can hold one login while a run spends another (a setup-token or a
 * pinned personal OAuth token in the child's environment, an API key). Reporting
 * the machine login's plan for such a run names somebody else's subscription,
 * so every doubt reports nothing.
 */
import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderUsageEventV1 } from '@slopus/happy-wire';
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '@/claude/utils/claudeAuthOverrideEnv';

/** What a session's usage events are stamped with, per provider. */
export type AiPlanTierSource = {
    current(provider: ProviderUsageEventV1['provider']): string | null;
};

const TIER = /^[a-z0-9_]{1,40}$/;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The Max multiplier from `claude auth status --json` (Claude Code ≥ 2.1.319
 * reports `planTier`), accepted only when that status describes the very login
 * the run reported — `auth status` reads the machine's store, not the run.
 */
function maxMultiplier(account: AccountInfo, status: unknown): 'max_5x' | 'max_20x' | null {
    if (!isObject(status) || status.authMethod !== 'claude.ai') return null;
    if (status.email !== account.email) return null;
    if ((status.orgName ?? '') !== (account.organization ?? '')) return null;
    return status.planTier === 'max_5x' || status.planTier === 'max_20x' ? status.planTier : null;
}

/**
 * `account` is the live run's `accountInfo()`; `authStatus` the parsed
 * `claude auth status --json`, when one was read; `env` the environment the
 * run's Claude child was spawned with.
 */
export function claudePlanTier(input: {
    account: AccountInfo | undefined;
    authStatus?: unknown;
    env?: Record<string, string | undefined>;
}): string | null {
    const { account } = input;
    if (!account) return null;
    // accountInfo() names the stored login even when the env sends requests elsewhere
    // (src/claude/aiAuthObservation.ts) — that login's plan is not what this run spends.
    if (CLAUDE_AUTH_OVERRIDE_ENV_KEYS.some((key) => input.env?.[key])) return null;
    if (account.apiProvider !== undefined && account.apiProvider !== 'firstParty') return null;
    // Only a stored claude.ai login carries a subscription. A token from the environment
    // (setup-token, pinned personal OAuth) or an API key does not say whose plan pays.
    if (account.tokenSource !== undefined && account.tokenSource !== 'claude.ai') return null;
    if (account.apiKeySource !== undefined && account.apiKeySource !== 'none') return null;
    const subscription = account.subscriptionType?.trim();
    if (!subscription || !TIER.test(subscription)) return null;
    if (subscription !== 'max') return `claude:${subscription}`;
    return `claude:${maxMultiplier(account, input.authStatus) ?? 'max'}`;
}

/** `account` from Codex app-server `account/read` (`Account` in its v2 protocol). */
export function codexPlanTier(account: unknown): string | null {
    if (!isObject(account) || account.type !== 'chatgpt') return null;
    const plan = typeof account.planType === 'string' ? account.planType.trim() : '';
    if (!plan || plan === 'unknown' || !TIER.test(plan)) return null;
    return `chatgpt:${plan}`;
}
