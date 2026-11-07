import { describe, expect, it } from 'vitest';
import type { UsageLimits } from '@/api/types';
import { fromRateLimitEvent, mergeUsageLimits, synthesizeStatus, windowsFromGetUsage } from './usageLimits';

// specs/cli-usage-limits-snapshot R8-a
describe('synthesizeStatus', () => {
    it('warns from 90% and rejects from 100%', () => {
        expect(synthesizeStatus(0)).toBe('allowed');
        expect(synthesizeStatus(89.9)).toBe('allowed');
        expect(synthesizeStatus(90)).toBe('allowed_warning');
        expect(synthesizeStatus(99.9)).toBe('allowed_warning');
        expect(synthesizeStatus(100)).toBe('rejected');
    });

    it('says nothing without a number', () => {
        expect(synthesizeStatus(null)).toBeUndefined();
        expect(synthesizeStatus(undefined)).toBeUndefined();
        expect(synthesizeStatus(Number.NaN)).toBeUndefined();
    });
});

describe('fromRateLimitEvent', () => {
    it('turns a fraction into a percent and unix seconds into ISO', () => {
        expect(fromRateLimitEvent({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9234, resetsAt: 1_767_225_600 })).toEqual({
            window: { id: 'five_hour', status: 'allowed_warning', utilization: 92.3, resetsAt: '2026-01-01T00:00:00.000Z' },
        });
    });

    it('reads a reset already in milliseconds and keeps a percent above 1 as is', () => {
        expect(fromRateLimitEvent({ status: 'allowed', rateLimitType: 'seven_day', utilization: 42, resetsAt: 1_767_225_600_000 }).window)
            .toMatchObject({ utilization: 42, resetsAt: '2026-01-01T00:00:00.000Z' });
    });

    it('leaves out what the event does not carry', () => {
        expect(fromRateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour' }).window)
            .toEqual({ id: 'five_hour', status: 'allowed', utilization: null, resetsAt: null });
        expect(fromRateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: -1, resetsAt: 0 }).window)
            .toMatchObject({ utilization: 0, resetsAt: null });
    });

    it('marks an event without a window id as unbound', () => {
        expect(fromRateLimitEvent({ status: 'rejected', utilization: 1, resetsAt: 1_767_225_600 })).toEqual({
            unbound: { status: 'rejected', utilization: 100, resetsAt: '2026-01-01T00:00:00.000Z' },
        });
    });

    it('drops an event whose status this build does not know, and reads a non-text window id as unbound', () => {
        expect(fromRateLimitEvent({ status: 'throttled' } as never)).toEqual({});
        expect(fromRateLimitEvent({ status: 'rejected', rateLimitType: 7 } as never))
            .toEqual({ unbound: { status: 'rejected', utilization: null, resetsAt: null } });
    });

    it('does not change the event the account switcher also reads (R8-c)', () => {
        const info = Object.freeze({ status: 'rejected' as const, rateLimitType: 'five_hour', utilization: 0.97, resetsAt: 1_767_225_600 });
        expect(() => fromRateLimitEvent(info)).not.toThrow();
        expect(info).toEqual({ status: 'rejected', rateLimitType: 'five_hour', utilization: 0.97, resetsAt: 1_767_225_600 });
    });
});

describe('windowsFromGetUsage', () => {
    it('keeps percents, normalizes ISO resets and synthesizes a status', () => {
        expect(windowsFromGetUsage({
            five_hour: { utilization: 91, resets_at: '2026-01-01T05:00:00+00:00' },
            seven_day: { utilization: 130, resets_at: null },
            seven_day_opus: { utilization: null, resets_at: 'not a date' },
        })).toEqual([
            { id: 'five_hour', utilization: 91, resetsAt: '2026-01-01T05:00:00.000Z', status: 'allowed_warning' },
            { id: 'seven_day', utilization: 100, resetsAt: null, status: 'rejected' },
            { id: 'seven_day_opus', utilization: null, resetsAt: null },
        ]);
    });

    it('skips extra usage, empty windows and anything not shaped like a window', () => {
        expect(windowsFromGetUsage({
            extra_usage: { utilization: 10, resets_at: null },
            seven_day_sonnet: null,
            other: { is_enabled: true },
            label: 'text',
        })).toEqual([]);
    });
});

describe('mergeUsageLimits', () => {
    const base: UsageLimits = {
        capturedAt: 1,
        windows: [
            { id: 'five_hour', status: 'allowed', utilization: 40, resetsAt: '2026-01-01T05:00:00.000Z' },
            { id: 'seven_day', status: 'allowed', utilization: 70, resetsAt: '2026-01-07T00:00:00.000Z' },
        ],
    };

    it('replaces windows by id and adds new ones', () => {
        expect(mergeUsageLimits(base, {
            capturedAt: 2,
            windows: [
                { id: 'five_hour', status: 'allowed_warning', utilization: 91, resetsAt: '2026-01-01T06:00:00.000Z' },
                { id: 'seven_day_opus', status: 'allowed', utilization: 5, resetsAt: null },
            ],
        })).toEqual({
            capturedAt: 2,
            windows: [
                { id: 'five_hour', status: 'allowed_warning', utilization: 91, resetsAt: '2026-01-01T06:00:00.000Z' },
                base.windows[1],
                { id: 'seven_day_opus', status: 'allowed', utilization: 5, resetsAt: null },
            ],
        });
    });

    it('keeps the last known percent and reset when the event carries none', () => {
        const merged = mergeUsageLimits(base, { capturedAt: 2, windows: [{ id: 'five_hour', status: 'allowed', utilization: null, resetsAt: null }] });
        expect(merged.windows[0]).toEqual(base.windows[0]);
    });

    it('starts from the patch when it is a full snapshot', () => {
        expect(mergeUsageLimits(base, { capturedAt: 2, replace: true, windows: [base.windows[1]] }))
            .toEqual({ capturedAt: 2, windows: [base.windows[1]] });
    });

    it('applies an unbound event to the fullest window', () => {
        const merged = mergeUsageLimits(base, { capturedAt: 2, windows: [], unbound: { status: 'rejected', utilization: null, resetsAt: '2026-01-02T00:00:00.000Z' } });
        expect(merged.windows).toEqual([
            base.windows[0],
            { id: 'seven_day', status: 'rejected', utilization: 70, resetsAt: '2026-01-02T00:00:00.000Z' },
        ]);
    });

    it('keeps one synthetic plan window when no window has a percent', () => {
        const patch = { capturedAt: 2, windows: [], unbound: { status: 'rejected' as const, utilization: null, resetsAt: null } };
        const once = mergeUsageLimits(undefined, patch);
        expect(once.windows).toEqual([{ id: 'plan', status: 'rejected', utilization: null, resetsAt: null }]);
        expect(mergeUsageLimits(once, { ...patch, unbound: { status: 'allowed', utilization: null, resetsAt: null } }).windows)
            .toEqual([{ id: 'plan', status: 'allowed', utilization: null, resetsAt: null }]);
    });

    it('gives the same result when applied again, as a state write retry does', () => {
        const patch = { capturedAt: 2, windows: [{ id: 'five_hour', status: 'allowed' as const, utilization: null, resetsAt: null }], unbound: { status: 'rejected' as const, utilization: 99, resetsAt: null } };
        const once = mergeUsageLimits(base, patch);
        expect(mergeUsageLimits(once, patch)).toEqual(once);
    });

    it('reads what it can from a malformed or foreign state without throwing', () => {
        const foreign = { capturedAt: 'x', windows: [null, 'w', { utilization: 3 }, { id: 'seven_day', utilization: 70, resetsAt: 7 }] } as unknown as UsageLimits;
        expect(mergeUsageLimits(foreign, { capturedAt: 2, windows: [] }).windows).toEqual([{ id: 'seven_day', utilization: 70, resetsAt: null }]);
        expect(mergeUsageLimits({ windows: 'nope' } as unknown as UsageLimits, { capturedAt: 2, windows: [] })).toEqual({ capturedAt: 2, windows: [] });
    });

    it('does not change the current state', () => {
        const current = structuredClone(base);
        mergeUsageLimits(current, { capturedAt: 2, windows: [{ id: 'five_hour', status: 'rejected', utilization: 100, resetsAt: null }], unbound: { status: 'rejected', utilization: null, resetsAt: null } });
        expect(current).toEqual(base);
    });
});
