import { describe, expect, it } from 'vitest';
import {
    MACHINE_RESOURCE_LEASE_TTL_MS,
    MACHINE_RESOURCE_MAX_SUBSCRIPTIONS,
    MACHINE_RESOURCE_SAMPLE_INTERVAL_MS,
    createMachineResourceService,
} from './machineResourceService';
import type { MachineResourceSampler, MachineResourceSnapshot } from './machineResourceSampler';

function snapshotAt(sampledAt: number): MachineResourceSnapshot {
    return {
        sampledAt,
        cpuPercent: null,
        cpuCount: 8,
        memoryUsedBytes: 600,
        memoryTotalBytes: 1_000,
        loadAverage: [1, 2, 3],
    };
}

/** A fake clock plus a fake interval, so cadence is asserted rather than waited on. */
function harness(options: { sample?: (now: number) => MachineResourceSnapshot | null } = {}) {
    let wallClock = 1_000;
    let monotonic = 50_000;
    let running: { fn: () => void; ms: number } | null = null;
    let started = 0;
    let leaked = 0;
    const samples: number[] = [];
    let resets = 0;

    const sampler: MachineResourceSampler = {
        sample: (at) => {
            samples.push(at);
            return options.sample ? options.sample(at) : snapshotAt(at);
        },
        reset: () => { resets += 1; },
    };

    const service = createMachineResourceService({
        sampler,
        now: () => wallClock,
        monotonicNow: () => monotonic,
        startTimer: (fn, ms) => {
            if (running !== null) leaked += 1;
            started += 1;
            running = { fn, ms };
            return running;
        },
        stopTimer: (handle) => {
            // A stop for a handle that is no longer the live one means an
            // earlier interval was orphaned — exactly the leak being guarded.
            if (handle !== running) leaked += 1;
            running = null;
        },
    });

    return {
        service,
        samples,
        get resets() { return resets; },
        get timerStarts() { return started; },
        get leakedTimers() { return leaked; },
        get timerRunning() { return running !== null; },
        get timerIntervalMs() { return running?.ms ?? null; },
        /** Both clocks move together, as they do on a machine nobody is resetting. */
        advance(ms: number) { wallClock += ms; monotonic += ms; },
        /** Only the wall clock moves — an NTP correction or a manual clock change. */
        setWallClock(value: number) { wallClock = value; },
        advanceMonotonic(ms: number) { monotonic += ms; },
        tick() {
            if (!running) throw new Error('no timer is running');
            running.fn();
        },
        read(subscriptionId: string) {
            return service.handleRequest({ version: 1, action: 'read', subscriptionId });
        },
        release(subscriptionId: string) {
            return service.handleRequest({ version: 1, action: 'release', subscriptionId });
        },
    };
}

describe('machine resource service — subscriptions drive one sampler', () => {
    it('measures a baseline on the first subscription and starts one timer', () => {
        const h = harness();

        const answer = h.read('sub-a');

        expect(answer).toEqual({ version: 1, status: 'ok', snapshot: snapshotAt(1_000) });
        expect(h.samples).toEqual([1_000]);
        expect(h.timerStarts).toBe(1);
        expect(h.timerIntervalMs).toBe(MACHINE_RESOURCE_SAMPLE_INTERVAL_MS);
    });

    it('serves every later reader from the cache — a request never causes a measurement', () => {
        const h = harness();
        h.read('sub-a');

        h.advance(2_000);
        const second = h.read('sub-a');
        const fromAnotherDesktop = h.read('sub-b');

        // Both Desktops see the same reading, and neither produced a sample.
        expect(second.snapshot).toEqual(snapshotAt(1_000));
        expect(fromAnotherDesktop.snapshot).toEqual(snapshotAt(1_000));
        expect(h.samples).toEqual([1_000]);
        expect(h.timerStarts).toBe(1);
    });

    it('gives all subscribers the same cached snapshot object', () => {
        const h = harness();

        const first = h.read('sub-a');
        const second = h.read('sub-b');

        expect(first.snapshot).toBe(second.snapshot);
    });

    it('samples once per tick no matter how many subscriptions exist', () => {
        const h = harness();
        h.read('sub-a');
        h.read('sub-b');
        h.read('sub-c');

        h.advance(MACHINE_RESOURCE_SAMPLE_INTERVAL_MS);
        h.tick();

        expect(h.samples).toEqual([1_000, 11_000]);
        expect(h.read('sub-b').snapshot).toEqual(snapshotAt(11_000));
    });
});

describe('machine resource service — stopping', () => {
    it('stops measuring the moment the last subscription releases', () => {
        const h = harness();
        h.read('sub-a');
        h.read('sub-b');

        expect(h.release('sub-a')).toEqual({ version: 1, status: 'ok', snapshot: null });
        expect(h.timerRunning).toBe(true);

        h.release('sub-b');
        expect(h.timerRunning).toBe(false);
        // The CPU baseline is dropped: the next delta must not straddle the idle gap.
        expect(h.resets).toBe(1);
    });

    it('stops measuring on lease expiry when release never arrives', () => {
        const h = harness();
        h.read('sub-a');

        // The owning window died: no renewal ever comes.
        h.advance(MACHINE_RESOURCE_LEASE_TTL_MS + 1);
        h.tick();

        expect(h.timerRunning).toBe(false);
        // The sweep runs before the sample, so an expired-only tick measures nothing.
        expect(h.samples).toEqual([1_000]);
    });

    it('keeps measuring while reads renew the lease', () => {
        const h = harness();
        h.read('sub-a');

        for (let elapsed = 0; elapsed < MACHINE_RESOURCE_LEASE_TTL_MS * 3; elapsed += MACHINE_RESOURCE_SAMPLE_INTERVAL_MS) {
            h.advance(MACHINE_RESOURCE_SAMPLE_INTERVAL_MS);
            h.read('sub-a');
            h.tick();
        }

        expect(h.timerRunning).toBe(true);
    });

    it('drops one expired lease without disturbing a live one', () => {
        const h = harness();
        h.read('stale');
        h.advance(MACHINE_RESOURCE_LEASE_TTL_MS - 1_000);
        h.read('live');

        h.advance(2_000);
        h.tick();

        expect(h.timerRunning).toBe(true);
        expect(h.service.subscriptionCount()).toBe(1);
    });

    it('reuses the running timer when a read arrives before the tick that would have swept the lease', () => {
        const h = harness();
        h.read('sub-a');

        // The lease is already expired, but the tick has not run yet — this is
        // the window where a second interval would be created and the first
        // one's handle lost, leaving the machine sampling forever.
        h.advance(MACHINE_RESOURCE_LEASE_TTL_MS + 1);
        h.read('sub-b');

        expect(h.timerRunning).toBe(true);
        expect(h.service.subscriptionCount()).toBe(1);

        // One release must be enough to stop *all* sampling.
        h.release('sub-b');
        expect(h.timerRunning).toBe(false);
        expect(h.leakedTimers).toBe(0);
    });

    it('expires leases on a monotonic clock so a backwards wall-clock jump cannot pin the sampler open', () => {
        const h = harness();
        h.read('sub-a');

        // The machine's wall clock is corrected an hour backwards; the elapsed
        // time the lease is judged on must not go with it.
        h.setWallClock(1_000 - 3_600_000);
        h.advanceMonotonic(MACHINE_RESOURCE_LEASE_TTL_MS + 1);
        h.tick();

        expect(h.timerRunning).toBe(false);
        expect(h.service.subscriptionCount()).toBe(0);
    });

    it('tombstones a release that overtook the read it belongs to', () => {
        const h = harness();

        // The release lands first: the subscription never had a lease here.
        h.release('sub-a');
        const overtakenRead = h.read('sub-a');

        expect(overtakenRead.status).toBe('subscription-ended');
        expect(h.timerRunning).toBe(false);
        expect(h.timerStarts).toBe(0);
    });

    it('releases an unknown subscription without starting anything', () => {
        const h = harness();

        expect(h.release('never-seen')).toEqual({ version: 1, status: 'ok', snapshot: null });
        expect(h.timerStarts).toBe(0);
    });

    it('stop() tears the timer and the subscriptions down', () => {
        const h = harness();
        h.read('sub-a');

        h.service.stop();

        expect(h.timerRunning).toBe(false);
        expect(h.service.subscriptionCount()).toBe(0);
    });

    it('stays stopped: a request that arrives after shutdown cannot restart the sampler', () => {
        const h = harness();
        h.read('sub-a');
        h.service.stop();

        const afterShutdown = h.read('sub-b');

        expect(afterShutdown).toEqual({ version: 1, status: 'sample-unavailable', snapshot: null });
        expect(h.timerRunning).toBe(false);
        expect(h.service.subscriptionCount()).toBe(0);
        expect(h.release('sub-b').status).toBe('ok');
    });
});

describe('machine resource service — races and bounds', () => {
    it('refuses a read that overtook its own release instead of resurrecting the sampler', () => {
        const h = harness();
        h.read('sub-a');
        h.release('sub-a');
        expect(h.timerRunning).toBe(false);

        // The delayed `read` for the same subscription arrives after the release.
        const late = h.read('sub-a');

        expect(late.status).toBe('subscription-ended');
        expect(late.snapshot).toBeNull();
        expect(h.timerRunning).toBe(false);
        expect(h.service.subscriptionCount()).toBe(0);
    });

    it('lets the same subscription id be used again once the race window has passed', () => {
        const h = harness();
        h.read('sub-a');
        h.release('sub-a');

        h.advance(MACHINE_RESOURCE_LEASE_TTL_MS + 1);

        expect(h.read('sub-a').status).toBe('ok');
        expect(h.timerRunning).toBe(true);
    });

    it('bounds the subscription table and leaves the existing subscriptions working', () => {
        const h = harness();
        for (let i = 0; i < MACHINE_RESOURCE_MAX_SUBSCRIPTIONS; i++) h.read(`sub-${i}`);

        const overflow = h.read('one-too-many');

        expect(overflow).toEqual({ version: 1, status: 'capacity-exceeded', snapshot: null });
        expect(h.service.subscriptionCount()).toBe(MACHINE_RESOURCE_MAX_SUBSCRIPTIONS);
        expect(h.read('sub-0').status).toBe('ok');
        // A refused subscription must not have cost a measurement.
        expect(h.samples).toEqual([1_000]);
    });
});

describe('machine resource service — request validation', () => {
    it('separates "I do not speak this version" from "this request is malformed"', () => {
        const h = harness();

        expect(h.service.handleRequest({ version: 2, action: 'read', subscriptionId: 'a' }).status)
            .toBe('unsupported-version');
        expect(h.service.handleRequest({ version: 1, action: 'subscribe', subscriptionId: 'a' }).status)
            .toBe('invalid-request');
        expect(h.service.handleRequest({ version: 1, action: 'read', subscriptionId: '' }).status)
            .toBe('invalid-request');
        expect(h.service.handleRequest(null).status).toBe('invalid-request');
        expect(h.service.handleRequest({ version: 1, action: 'read' }).status).toBe('invalid-request');
        expect(h.timerStarts).toBe(0);
    });

    it('refuses an oversized subscription id rather than storing it', () => {
        const h = harness();

        expect(h.service.handleRequest({
            version: 1,
            action: 'read',
            subscriptionId: 'x'.repeat(200),
        }).status).toBe('invalid-request');
    });
});

describe('machine resource service — measurement failures', () => {
    it('reports "unavailable" rather than zero when no reading has ever succeeded', () => {
        const h = harness({ sample: () => null });

        const answer = h.read('sub-a');

        expect(answer).toEqual({ version: 1, status: 'sample-unavailable', snapshot: null });
        // The lease still exists, so the next tick can recover.
        expect(h.service.subscriptionCount()).toBe(1);
        expect(h.timerRunning).toBe(true);
    });

    it('hides the last good reading when the latest measurement fails', () => {
        let failing = false;
        const h = harness({ sample: (at) => (failing ? null : snapshotAt(at)) });
        h.read('sub-a');

        failing = true;
        h.advance(MACHINE_RESOURCE_SAMPLE_INTERVAL_MS);
        h.tick();

        // The Desktop keeps its own last good value, but a fresh read must not
        // mistake an unrefreshed daemon cache for a current measurement.
        const answer = h.read('sub-a');
        expect(answer).toEqual({ version: 1, status: 'sample-unavailable', snapshot: null });

        failing = false;
        h.advance(MACHINE_RESOURCE_SAMPLE_INTERVAL_MS);
        h.tick();
        expect(h.read('sub-a')).toEqual({ version: 1, status: 'ok', snapshot: snapshotAt(21_000) });
    });

    it('survives a sampler that throws inside the timer', () => {
        const h = harness({ sample: () => { throw new Error('os read exploded'); } });

        expect(h.read('sub-a').status).toBe('sample-unavailable');
        h.advance(MACHINE_RESOURCE_SAMPLE_INTERVAL_MS);
        expect(() => h.tick()).not.toThrow();
        expect(h.timerRunning).toBe(true);
    });
});
