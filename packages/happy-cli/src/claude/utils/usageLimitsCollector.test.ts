import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUsageLimitsCollector, usageReaderOf } from './usageLimitsCollector';
import type { UsageLimitsPatch } from './usageLimits';

// specs/cli-usage-limits-snapshot R8-b, R8-d
const event = (info: Record<string, unknown>) => ({ type: 'rate_limit_event', uuid: 'rl', session_id: 's', rate_limit_info: info });
const usage = (rateLimits: Record<string, unknown> | null) => ({ rate_limits_available: rateLimits !== null, rate_limits: rateLimits });
const RESET = 1_767_225_600; // 2026-01-01T00:00:00Z

function setup(readUsage: (() => Promise<unknown>) | null = null) {
    const published: UsageLimitsPatch[] = [];
    const collector = createUsageLimitsCollector({ readUsage, publish: (patch) => published.push(patch), now: () => 1000 });
    return { collector, published };
}

describe('createUsageLimitsCollector', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('publishes at most once per turn, with the latest reading of each window', async () => {
        const { collector, published } = setup();
        collector.observe(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: RESET }));
        collector.observe(event({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.91, resetsAt: RESET }));
        collector.observe(event({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.2, resetsAt: RESET }));
        await collector.turnEnded();
        expect(published).toEqual([{
            capturedAt: 1000,
            windows: [
                { id: 'five_hour', status: 'allowed_warning', utilization: 91, resetsAt: '2026-01-01T00:00:00.000Z' },
                { id: 'seven_day', status: 'allowed', utilization: 20, resetsAt: '2026-01-01T00:00:00.000Z' },
            ],
        }]);
        await collector.turnEnded();
        expect(published).toHaveLength(1);
    });

    it('ignores everything but rate limit events', async () => {
        const { collector, published } = setup();
        collector.observe({ type: 'assistant', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
        collector.observe({ type: 'rate_limit_event' });
        collector.observe(null);
        await collector.turnEnded();
        expect(published).toEqual([]);
    });

    it('seeds every window once, on the first result only, without the transcript scan', async () => {
        const readUsage = vi.fn(async () => usage({ five_hour: { utilization: 40, resets_at: '2026-01-01T05:00:00Z' }, extra_usage: { utilization: 1 } }));
        const { collector, published } = setup(readUsage);
        await collector.turnEnded();
        collector.observe(event({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.3 }));
        await collector.turnEnded();
        expect(readUsage).toHaveBeenCalledTimes(1);
        expect(published).toEqual([
            { capturedAt: 1000, replace: true, windows: [{ id: 'five_hour', status: 'allowed', utilization: 40, resetsAt: '2026-01-01T05:00:00.000Z' }] },
            { capturedAt: 1000, windows: [{ id: 'seven_day', status: 'allowed', utilization: 30, resetsAt: null }] },
        ]);
    });

    it('lets the turn event win over the seed but fills in the percent it lacks', async () => {
        const { collector, published } = setup(async () => usage({
            five_hour: { utilization: 40, resets_at: '2026-01-01T05:00:00Z' },
            seven_day: { utilization: 70, resets_at: '2026-01-07T00:00:00Z' },
        }));
        collector.observe(event({ status: 'allowed', rateLimitType: 'five_hour' }));
        collector.observe(event({ status: 'rejected', rateLimitType: 'seven_day', utilization: 1, resetsAt: RESET }));
        await collector.turnEnded();
        expect(published[0].windows).toEqual([
            { id: 'five_hour', status: 'allowed', utilization: 40, resetsAt: '2026-01-01T05:00:00.000Z' },
            { id: 'seven_day', status: 'rejected', utilization: 100, resetsAt: '2026-01-01T00:00:00.000Z' },
        ]);
    });

    it('takes the seed\'s reset for an event that carries only a percent', async () => {
        const { collector, published } = setup(async () => usage({ five_hour: { utilization: 40, resets_at: '2026-01-01T05:00:00Z' } }));
        collector.observe(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 }));
        await collector.turnEnded();
        expect(published[0].windows).toEqual([{ id: 'five_hour', status: 'allowed', utilization: 50, resetsAt: '2026-01-01T05:00:00.000Z' }]);
    });

    it('replaces the stored windows even when the seed reports none, so the previous account\'s do not stay', async () => {
        const { collector, published } = setup(async () => usage({}));
        await collector.turnEnded();
        expect(published).toEqual([{ capturedAt: 1000, windows: [], replace: true }]);
    });

    it('skips a turn whose windows did not change', async () => {
        const { collector, published } = setup();
        const same = event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: RESET });
        collector.observe(same);
        await collector.turnEnded();
        collector.observe(same);
        await collector.turnEnded();
        collector.observe(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.51, resetsAt: RESET }));
        await collector.turnEnded();
        expect(published.map(p => p.windows[0].utilization)).toEqual([50, 51]);
    });

    it('skips a turn that only repeats what an earlier, larger patch already published', async () => {
        const { collector, published } = setup(async () => usage({ seven_day: { utilization: 70, resets_at: null } }));
        collector.observe(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 }));
        await collector.turnEnded();
        collector.observe(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 }));
        collector.observe(event({ status: 'allowed', rateLimitType: 'seven_day' }));
        await collector.turnEnded();
        expect(published).toHaveLength(1);
    });

    it('keeps an unbound event for the launcher to place', async () => {
        const { collector, published } = setup();
        collector.observe(event({ status: 'rejected', resetsAt: RESET }));
        await collector.turnEnded();
        expect(published).toEqual([{ capturedAt: 1000, windows: [], unbound: { status: 'rejected', utilization: null, resetsAt: '2026-01-01T00:00:00.000Z' } }]);
    });

    it.each([
        ['plan limits do not apply', async () => usage(null)],
        ['plan limits do not apply even with windows attached', async () => ({ rate_limits_available: false, rate_limits: { seven_day: { utilization: 70, resets_at: null } } })],
        ['the request fails', async () => { throw new Error('closed'); }],
    ])('publishes the events alone when %s', async (_name, readUsage) => {
        const { collector, published } = setup(readUsage);
        collector.observe(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 }));
        await collector.turnEnded();
        expect(published).toEqual([{ capturedAt: 1000, windows: [{ id: 'five_hour', status: 'allowed', utilization: 50, resetsAt: null }] }]);
    });

    it('stops waiting for a seed that never answers', async () => {
        vi.useFakeTimers();
        const { collector, published } = setup(() => new Promise(() => {}));
        collector.observe(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 }));
        const done = collector.turnEnded();
        await vi.advanceTimersByTimeAsync(10_000);
        await done;
        expect(published).toHaveLength(1);
        expect(published[0].replace).toBeUndefined();
    });

    it('keeps turns in order while the seed is still pending', async () => {
        let answer!: (value: unknown) => void;
        const { collector, published } = setup(() => new Promise((resolve) => { answer = resolve; }));
        collector.observe(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1 }));
        const first = collector.turnEnded();
        collector.observe(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2 }));
        const second = collector.turnEnded();
        await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
        expect(published).toEqual([]);
        answer(usage({ seven_day: { utilization: 70, resets_at: null } }));
        await Promise.all([first, second]);
        expect(published.map(p => p.windows)).toEqual([
            [{ id: 'five_hour', status: 'allowed', utilization: 10, resetsAt: null }, { id: 'seven_day', status: 'allowed', utilization: 70, resetsAt: null }],
            [{ id: 'five_hour', status: 'allowed', utilization: 20, resetsAt: null }],
        ]);
    });

    it('does not let a failing publisher stop later turns', async () => {
        const publish = vi.fn().mockImplementationOnce(() => { throw new Error('socket gone'); });
        const collector = createUsageLimitsCollector({ readUsage: null, publish });
        collector.observe(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1 }));
        await collector.turnEnded();
        collector.observe(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2 }));
        await collector.turnEnded();
        expect(publish).toHaveBeenCalledTimes(2);
    });
});

describe('usageReaderOf', () => {
    it('asks the query for plan limits without scanning transcripts', async () => {
        const query = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async function (this: unknown) { return this; }) };
        const read = usageReaderOf(query)!;
        await expect(read()).resolves.toBe(query);
        expect(query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET).toHaveBeenCalledWith({ skipBehaviors: true });
    });

    it('has nothing to read on an SDK without the method', () => {
        expect(usageReaderOf({})).toBeNull();
        expect(usageReaderOf(null)).toBeNull();
    });
});
