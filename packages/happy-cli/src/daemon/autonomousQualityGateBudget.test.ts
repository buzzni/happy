import { describe, expect, it } from 'vitest';
import {
    DEFAULT_AUTONOMOUS_QUALITY_GATE_LIMITS,
    consumeAutonomousQualityGateBudget,
    createAutonomousQualityGateBudgetUsage,
    findAutonomousQualityGateLimit,
    normalizeAutonomousQualityGateLimits,
} from './autonomousQualityGateBudget';

describe('normalizeAutonomousQualityGateLimits', () => {
    it.each([
        ['missing values', undefined, DEFAULT_AUTONOMOUS_QUALITY_GATE_LIMITS],
        ['invalid values', {
            maxContinuations: 0,
            maxTurns: -1,
            maxTokens: Number.NaN,
            timeoutMs: Number.POSITIVE_INFINITY,
            maxGateAttempts: 0,
        }, DEFAULT_AUTONOMOUS_QUALITY_GATE_LIMITS],
        ['fractional values', {
            maxContinuations: 2.9,
            maxTurns: 4.8,
            maxTokens: 5_000.7,
            timeoutMs: 12_345.6,
            maxGateAttempts: 2.2,
        }, {
            maxContinuations: 2,
            maxTurns: 4,
            maxTokens: 5_000,
            timeoutMs: 12_345,
            maxGateAttempts: 2,
        }],
        ['wire boundaries', {
            maxContinuations: 99,
            maxTurns: 999,
            maxTokens: 99_000_000,
            timeoutMs: 500,
            maxGateAttempts: 99,
        }, {
            maxContinuations: 20,
            maxTurns: 100,
            maxTokens: 10_000_000,
            timeoutMs: 1_000,
            maxGateAttempts: 10,
        }],
    ])('normalizes %s', (_label, input, expected) => {
        expect(normalizeAutonomousQualityGateLimits(input)).toEqual(expected);
    });
});

describe('autonomous quality gate budget consumption', () => {
    it('returns new usage and counts provider-neutral total tokens', () => {
        const initial = createAutonomousQualityGateBudgetUsage(1_000);

        const next = consumeAutonomousQualityGateBudget(initial, {
            continuations: 1,
            turns: 1,
            providerTokens: { total: 450 },
            startedAt: 1_000,
            now: 3_500,
        });

        expect(initial).toEqual({ continuations: 0, turns: 0, tokens: 0, elapsedMs: 0 });
        expect(next).toEqual({ continuations: 1, turns: 1, tokens: 450, elapsedMs: 2_500 });
    });

    it('never decreases elapsed time when an older event is observed', () => {
        const usage = { continuations: 1, turns: 2, tokens: 3, elapsedMs: 4_000 };

        expect(consumeAutonomousQualityGateBudget(usage, {
            startedAt: 10_000,
            now: 12_000,
        })).toEqual(usage);
    });
});

describe('findAutonomousQualityGateLimit', () => {
    const limits = {
        maxContinuations: 3,
        maxTurns: 12,
        maxTokens: 80_000,
        timeoutMs: 30 * 60_000,
        maxGateAttempts: 3,
    };

    it.each([
        ['below every limit', { continuations: 2, turns: 11, tokens: 79_999, elapsedMs: 1_799_999 }, undefined],
        ['continuation boundary', { continuations: 3, turns: 0, tokens: 0, elapsedMs: 0 }, 'max-continuations'],
        ['turn boundary', { continuations: 0, turns: 12, tokens: 0, elapsedMs: 0 }, 'max-turns'],
        ['token boundary', { continuations: 0, turns: 0, tokens: 80_000, elapsedMs: 0 }, 'max-tokens'],
        ['time boundary', { continuations: 0, turns: 0, tokens: 0, elapsedMs: 1_800_000 }, 'timeout'],
    ])('%s', (_label, usage, expected) => {
        expect(findAutonomousQualityGateLimit(usage, limits)).toBe(expected);
    });
});
