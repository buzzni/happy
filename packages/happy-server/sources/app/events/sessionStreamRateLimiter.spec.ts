import { describe, expect, it } from 'vitest';
import { createSessionStreamRateLimiter } from './sessionStreamRateLimiter';

describe('sessionStreamRateLimiter', () => {
    it('admits frames up to the per-window cap and drops the rest', () => {
        const limiter = createSessionStreamRateLimiter({ windowMs: 1000, maxPerWindow: 3 });
        const now = 1_000_000;
        expect(limiter.admit('user-1', 'session-1', now)).toBe(true);
        expect(limiter.admit('user-1', 'session-1', now + 10)).toBe(true);
        expect(limiter.admit('user-1', 'session-1', now + 20)).toBe(true);
        expect(limiter.admit('user-1', 'session-1', now + 30)).toBe(false);
        expect(limiter.admit('user-1', 'session-1', now + 40)).toBe(false);
    });

    it('resets the budget once the window elapses', () => {
        const limiter = createSessionStreamRateLimiter({ windowMs: 1000, maxPerWindow: 2 });
        const now = 1_000_000;
        expect(limiter.admit('user-1', 'session-1', now)).toBe(true);
        expect(limiter.admit('user-1', 'session-1', now + 10)).toBe(true);
        expect(limiter.admit('user-1', 'session-1', now + 20)).toBe(false);

        expect(limiter.admit('user-1', 'session-1', now + 1000)).toBe(true);
    });

    it('tracks distinct (user, session) pairs independently', () => {
        const limiter = createSessionStreamRateLimiter({ windowMs: 1000, maxPerWindow: 1 });
        const now = 1_000_000;
        expect(limiter.admit('user-1', 'session-1', now)).toBe(true);
        expect(limiter.admit('user-1', 'session-1', now + 1)).toBe(false);
        expect(limiter.admit('user-1', 'session-2', now + 1)).toBe(true);
        expect(limiter.admit('user-2', 'session-1', now + 1)).toBe(true);
    });

    it('bounds memory by evicting the oldest tracked key once full', () => {
        const limiter = createSessionStreamRateLimiter({ windowMs: 1000, maxPerWindow: 1, maxPerUserWindow: 20_000 });
        const cap = 10_000;
        for (let i = 0; i < cap; i++) limiter.admit(`user-${i}`, 'session-1', 0);
        expect(limiter.size()).toBe(cap);

        limiter.admit('user-overflow', 'session-1', 0);
        expect(limiter.size()).toBe(cap);
    });

    it('caps one user before sid churn can reset every per-session budget', () => {
        const cap = 10_000;
        const limiter = createSessionStreamRateLimiter({
            windowMs: 1000,
            maxPerWindow: 1,
            maxPerUserWindow: cap,
        });
        const now = 1_000_000;

        let admitted = 0;
        for (let cycle = 0; cycle < 3; cycle++) {
            for (let sid = 0; sid <= cap; sid++) {
                if (limiter.admit('user-1', `session-${sid}`, now)) admitted += 1;
            }
        }

        expect(admitted).toBe(cap);
        expect(limiter.size()).toBe(cap);
        expect(limiter.admit('user-2', 'session-overflow', now)).toBe(true);
        expect(limiter.admit('user-1', 'session-overflow', now + 1000)).toBe(true);
    });
});
