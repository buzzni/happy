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
