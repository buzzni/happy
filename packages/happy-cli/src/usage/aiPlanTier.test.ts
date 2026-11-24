import { describe, expect, it } from 'vitest';
import { claudePlanTier, codexPlanTier } from './aiPlanTier';

const ownLogin = {
    email: 'dev@example.com',
    organization: 'Example',
    tokenSource: 'claude.ai',
    apiProvider: 'firstParty' as const,
};

const authStatus = (overrides: Record<string, unknown> = {}) => ({
    loggedIn: true,
    authMethod: 'claude.ai',
    email: 'dev@example.com',
    orgName: 'Example',
    subscriptionType: 'max',
    planTier: 'max_20x',
    ...overrides,
});

describe('claudePlanTier (aplus specs/org-member-ai-plan-usage P2·P3·P5)', () => {
    it('reports the live login subscription', () => {
        expect(claudePlanTier({ account: { ...ownLogin, subscriptionType: 'pro' } })).toBe('claude:pro');
        expect(claudePlanTier({ account: { ...ownLogin, subscriptionType: 'team' } })).toBe('claude:team');
    });

    it('refines Max with the CLI plan tier when the status names the same login', () => {
        expect(claudePlanTier({ account: { ...ownLogin, subscriptionType: 'max' }, authStatus: authStatus() }))
            .toBe('claude:max_20x');
        expect(claudePlanTier({
            account: { ...ownLogin, subscriptionType: 'max' },
            authStatus: authStatus({ planTier: 'max_5x' }),
        })).toBe('claude:max_5x');
    });

    it('keeps Max without a multiplier when the status is missing, older or about another login', () => {
        const account = { ...ownLogin, subscriptionType: 'max' };
        expect(claudePlanTier({ account })).toBe('claude:max');
        // Claude Code before planTier existed in `auth status`.
        expect(claudePlanTier({ account, authStatus: authStatus({ planTier: undefined }) })).toBe('claude:max');
        expect(claudePlanTier({ account, authStatus: authStatus({ planTier: 'max_other' }) })).toBe('claude:max');
        // Another account logged in on the machine must not lend its tier to this run.
        expect(claudePlanTier({ account, authStatus: authStatus({ email: 'other@example.com' }) })).toBe('claude:max');
        expect(claudePlanTier({ account, authStatus: authStatus({ orgName: 'Other' }) })).toBe('claude:max');
        expect(claudePlanTier({ account, authStatus: authStatus({ authMethod: 'oauth_token' }) })).toBe('claude:max');
    });

    it('reports nothing when the run is not spending a stored claude.ai login', () => {
        // A setup-token or pinned personal OAuth token arrives through the environment.
        expect(claudePlanTier({ account: { ...ownLogin, tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', subscriptionType: 'max' } }))
            .toBeNull();
        // An API key pays per request whatever login also exists.
        expect(claudePlanTier({ account: { ...ownLogin, apiKeySource: 'ANTHROPIC_API_KEY', subscriptionType: 'max' } }))
            .toBeNull();
        expect(claudePlanTier({ account: { ...ownLogin, apiProvider: 'bedrock', subscriptionType: 'max' } })).toBeNull();
        expect(claudePlanTier({ account: { ...ownLogin } })).toBeNull();
        expect(claudePlanTier({ account: undefined })).toBeNull();
    });

    it('reports nothing when the run environment authenticates or routes Claude elsewhere', () => {
        // accountInfo() still names the stored login, but the requests go where the env says (Z.AI, an org endpoint).
        const account = { ...ownLogin, subscriptionType: 'max' };
        expect(claudePlanTier({ account, env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } })).toBeNull();
        expect(claudePlanTier({ account, env: { ANTHROPIC_API_KEY: 'sk-x' } })).toBeNull();
        expect(claudePlanTier({ account, env: { ANTHROPIC_BASE_URL: '' } })).toBe('claude:max');
    });

    it('never forwards a subscription string outside the ledger token shape', () => {
        expect(claudePlanTier({ account: { ...ownLogin, subscriptionType: 'Max Plan' } })).toBeNull();
    });
});

describe('codexPlanTier', () => {
    it('reports a ChatGPT sign-in plan', () => {
        expect(codexPlanTier({ type: 'chatgpt', email: null, planType: 'plus', workspaceName: null })).toBe('chatgpt:plus');
        expect(codexPlanTier({ type: 'chatgpt', planType: 'self_serve_business_prolite' }))
            .toBe('chatgpt:self_serve_business_prolite');
    });

    it('reports nothing for an API key, another provider or an unknown plan', () => {
        expect(codexPlanTier({ type: 'apiKey' })).toBeNull();
        expect(codexPlanTier({ type: 'amazonBedrock', usesCodexManagedCredentials: true })).toBeNull();
        expect(codexPlanTier({ type: 'chatgpt', planType: 'unknown' })).toBeNull();
        expect(codexPlanTier({ type: 'chatgpt', planType: null })).toBeNull();
        expect(codexPlanTier(null)).toBeNull();
    });
});
