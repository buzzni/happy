import { describe, expect, it, vi } from 'vitest';
import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeAuthStatusCache, observeClaudeQueryPlanTier } from './aiPlanTierObservation';

const login: AccountInfo = {
    email: 'dev@example.com',
    organization: 'Example',
    tokenSource: 'claude.ai',
    apiProvider: 'firstParty',
    subscriptionType: 'max',
};
const status = { authMethod: 'claude.ai', email: 'dev@example.com', orgName: 'Example', planTier: 'max_20x' };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('observeClaudeQueryPlanTier (aplus specs/org-member-ai-plan-usage H2)', () => {
    it('reports nothing until the run login is known, then its plan — for Claude events only', async () => {
        let answer!: (account: AccountInfo) => void;
        const source = observeClaudeQueryPlanTier(
            { accountInfo: () => new Promise((resolve) => { answer = resolve; }) },
            { env: {}, readAuthStatus: async () => status, timeoutMs: 1_000 },
        );
        expect(source.current('anthropic')).toBeNull();

        answer(login);
        await settle();
        await settle();

        expect(source.current('anthropic')).toBe('claude:max_20x');
        expect(source.current('openai')).toBeNull();
    });

    it('does not spawn the status read for a login that is not Max', async () => {
        const readAuthStatus = vi.fn(async () => status);
        const source = observeClaudeQueryPlanTier(
            { accountInfo: async () => ({ ...login, subscriptionType: 'pro' }) },
            { env: {}, readAuthStatus, timeoutMs: 1_000 },
        );
        await settle();
        expect(source.current('anthropic')).toBe('claude:pro');
        expect(readAuthStatus).not.toHaveBeenCalled();
    });

    it('keeps Max without a multiplier when the status read fails, and nothing when accountInfo fails', async () => {
        const failedStatus = observeClaudeQueryPlanTier(
            { accountInfo: async () => login },
            { env: {}, readAuthStatus: async () => { throw new Error('spawn failed'); }, timeoutMs: 1_000 },
        );
        const failedAccount = observeClaudeQueryPlanTier(
            { accountInfo: async () => { throw new Error('closed'); } },
            { env: {}, readAuthStatus: async () => status, timeoutMs: 1_000 },
        );
        await settle();
        await settle();
        expect(failedStatus.current('anthropic')).toBe('claude:max');
        expect(failedAccount.current('anthropic')).toBeNull();
    });
});

describe('createClaudeAuthStatusCache', () => {
    it('spawns once per window and parses the JSON; a failure reads as null', async () => {
        let now = 0;
        const run = vi.fn(async () => JSON.stringify(status));
        const cache = createClaudeAuthStatusCache({ run, now: () => now, ttlMs: 600_000 });

        await expect(cache.read()).resolves.toEqual(status);
        await cache.read();
        expect(run).toHaveBeenCalledTimes(1);

        now = 600_000;
        await cache.read();
        expect(run).toHaveBeenCalledTimes(2);

        const broken = createClaudeAuthStatusCache({ run: async () => 'not json', now: () => 0 });
        await expect(broken.read()).resolves.toBeNull();
    });
});
