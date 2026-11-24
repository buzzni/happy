import { describe, expect, it } from 'vitest';
import { AiUsageEventV1Schema, ProviderUsageEventV1Schema } from './usage';

const providerEvent = {
    source: 'happy-cli',
    sourceEventId: 'session-1:anthropic:msg-1',
    schemaVersion: 1,
    occurredAt: 1_788_000_000_000,
    sessionId: 'session-1',
    provider: 'anthropic',
    agent: 'claude',
    model: 'claude-sonnet-4-5',
    measurement: 'delta',
    tokens: {
        input: 100,
        output: 20,
        cacheRead: 300,
        cacheWrite: 40,
        reasoning: 0,
        total: 460,
    },
    cost: {
        amountMicros: 1_234,
        currency: 'USD',
        kind: 'estimated',
        pricingVersion: 'anthropic-2026-08-31',
    },
    quality: 'exact',
} as const;

describe('ProviderUsageEventV1Schema', () => {
    it('accepts an exclusive token breakdown whose buckets equal total', () => {
        expect(ProviderUsageEventV1Schema.parse(providerEvent)).toEqual(providerEvent);
    });

    it.each([
        ['a mismatched total', { ...providerEvent.tokens, total: 459 }],
        ['a negative token count', { ...providerEvent.tokens, input: -1, total: 359 }],
        ['a fractional token count', { ...providerEvent.tokens, output: 20.5, total: 460.5 }],
    ])('rejects %s', (_label, tokens) => {
        expect(() => ProviderUsageEventV1Schema.parse({ ...providerEvent, tokens })).toThrow();
    });

    it('rejects an empty stable source event id', () => {
        expect(() => ProviderUsageEventV1Schema.parse({
            ...providerEvent,
            sourceEventId: '',
        })).toThrow();
    });

    it('rejects cumulative snapshots until a stable delta adapter exists', () => {
        expect(() => ProviderUsageEventV1Schema.parse({
            ...providerEvent,
            measurement: 'cumulative',
        })).toThrow();
    });
});

describe('AiUsageEventV1Schema', () => {
    it('adds the authenticated Happy account identity at the server boundary', () => {
        const event = { ...providerEvent, happyAccountId: 'happy-account-1' };

        expect(AiUsageEventV1Schema.parse(event)).toEqual(event);
    });

    it('rejects an event without the authenticated Happy account identity', () => {
        expect(() => AiUsageEventV1Schema.parse(providerEvent)).toThrow();
    });
});

describe('aiAuth report on a usage event', () => {
    it('accepts an event from a CLI that does not report an auth source', () => {
        expect(ProviderUsageEventV1Schema.parse(providerEvent)).toEqual(providerEvent);
        expect(ProviderUsageEventV1Schema.parse({ ...providerEvent, aiAuth: null }).aiAuth).toBeNull();
    });

    it('keeps an applied source the receiver does not know yet', () => {
        const event = {
            ...providerEvent,
            aiAuth: { appliedSource: 'some-future-source', connectionVersion: 3 },
        };

        expect(ProviderUsageEventV1Schema.parse(event)).toEqual(event);
    });

    it('carries the report through the server boundary schema too', () => {
        const event = {
            ...providerEvent,
            happyAccountId: 'happy-account-1',
            aiAuth: { appliedSource: 'platform-glm', connectionVersion: null },
        };

        expect(AiUsageEventV1Schema.parse(event)).toEqual(event);
    });

    it('stays on schema version 1 so older CLI events keep parsing', () => {
        expect(ProviderUsageEventV1Schema.parse({
            ...providerEvent,
            aiAuth: { appliedSource: 'platform-glm' },
        }).schemaVersion).toBe(1);
    });

    it.each([
        ['a non-string applied source', { appliedSource: 7 }],
        ['a fractional connection version', { appliedSource: 'org-bundle', connectionVersion: 1.5 }],
        ['a negative connection version', { appliedSource: 'org-bundle', connectionVersion: -1 }],
        ['an unexpected field', { appliedSource: 'org-bundle', ownerUserId: 'u1' }],
    ])('rejects %s', (_label, aiAuth) => {
        expect(() => ProviderUsageEventV1Schema.parse({ ...providerEvent, aiAuth })).toThrow();
    });
});

/**
 * The CLI and happy-server each bundle their own copy of this schema, and it is
 * `.strict()`. A field that a deployed peer does not know sinks the whole event:
 * `usageHandler.ts` drops it with a single warn line that does not name the
 * field. The release runbook fixes the deploy order (server first); this guard
 * fixes the shape, so the runbook only ever has to cover one direction.
 */
describe('wire compatibility guard', () => {
    /** Exactly the keys a peer must send. Adding one here breaks every older CLI. */
    const REQUIRED_KEYS = [
        'source',
        'sourceEventId',
        'schemaVersion',
        'occurredAt',
        'sessionId',
        'provider',
        'agent',
        'model',
        'measurement',
        'tokens',
        'cost',
        'quality',
    ] as const;

    it('parses an event carrying only the required keys — an older CLI still reports', () => {
        const minimal = Object.fromEntries(
            REQUIRED_KEYS.map((key) => [key, providerEvent[key]]),
        );
        expect(ProviderUsageEventV1Schema.safeParse(minimal).success).toBe(true);
    });

    it.each(REQUIRED_KEYS)('still requires %s', (key) => {
        const missing = Object.fromEntries(
            REQUIRED_KEYS.filter((other) => other !== key).map((other) => [other, providerEvent[other]]),
        );
        expect(ProviderUsageEventV1Schema.safeParse(missing).success).toBe(false);
    });

});

// aplus specs/org-member-ai-plan-usage P1 — mirrors packages/web-ui/server/aiUsageContract.ts.
describe('planTier', () => {
    it('is optional — an event without it parses unchanged', () => {
        const parsed = ProviderUsageEventV1Schema.parse(providerEvent);
        expect(parsed.planTier).toBeUndefined();
    });

    it('carries the run login plan tier on both event shapes', () => {
        expect(ProviderUsageEventV1Schema.parse({ ...providerEvent, planTier: 'claude:max_20x' }).planTier)
            .toBe('claude:max_20x');
        expect(AiUsageEventV1Schema.parse({ ...providerEvent, happyAccountId: 'acct', planTier: 'chatgpt:plus' }).planTier)
            .toBe('chatgpt:plus');
    });

    it('accepts a tier this build does not know — the ledger validates the shape', () => {
        expect(ProviderUsageEventV1Schema.safeParse({ ...providerEvent, planTier: 'chatgpt:a_future_plan' }).success)
            .toBe(true);
        expect(ProviderUsageEventV1Schema.safeParse({ ...providerEvent, planTier: null }).success).toBe(true);
    });

    it('rejects a non-string or an over-long value', () => {
        expect(ProviderUsageEventV1Schema.safeParse({ ...providerEvent, planTier: 1 }).success).toBe(false);
        expect(ProviderUsageEventV1Schema.safeParse({ ...providerEvent, planTier: `claude:${'x'.repeat(60)}` }).success)
            .toBe(false);
    });
});

// aplus specs/org-member-ai-plan-usage P10 — mirrors packages/web-ui/server/aiUsageContract.ts.
describe('rateLimits', () => {
    it('is optional and carries the five-hour and weekly windows', () => {
        expect(ProviderUsageEventV1Schema.parse(providerEvent).rateLimits).toBeUndefined();
        const rateLimits = { fiveHour: { usedPercent: 42.5, resetsAt: 1_788_000_000_000 }, weekly: { usedPercent: 10, resetsAt: null } };
        expect(ProviderUsageEventV1Schema.parse({ ...providerEvent, rateLimits }).rateLimits).toEqual(rateLimits);
    });

    it('strips a window this build does not know instead of refusing the event', () => {
        const parsed = ProviderUsageEventV1Schema.safeParse({
            ...providerEvent,
            rateLimits: { fiveHour: { usedPercent: 140, resetsAt: null }, sevenDayOpus: { usedPercent: 1, resetsAt: null } },
        });
        expect(parsed.success && parsed.data.rateLimits).toEqual({ fiveHour: { usedPercent: 140, resetsAt: null } });
    });
});

