import { describe, expect, it } from 'vitest';
import {
    createMachineResourceSampler,
    type MachineResourceProbe,
} from './machineResourceSampler';

/** Per-core cumulative times shaped like `os.cpus()[n].times`. */
function core(idle: number, busy: number) {
    return { user: busy, nice: 0, sys: 0, idle, irq: 0 };
}

function probeOf(overrides: Partial<MachineResourceProbe> = {}): MachineResourceProbe {
    return {
        cpuTimes: () => [core(100, 100)],
        memory: () => ({ total: 1_000, free: 400 }),
        loadAverage: () => [1, 2, 3],
        ...overrides,
    };
}

describe('createMachineResourceSampler', () => {
    it('reports no CPU percentage on the first sample because a delta needs two', () => {
        const sampler = createMachineResourceSampler(probeOf());

        const first = sampler.sample(1_000);

        expect(first).not.toBeNull();
        expect(first!.cpuPercent).toBeNull();
        // The readings that do not need a delta are still published — a missing
        // CPU delta must not blank memory and load as well.
        expect(first!.memoryUsedBytes).toBe(600);
        expect(first!.memoryTotalBytes).toBe(1_000);
        expect(first!.loadAverage).toEqual([1, 2, 3]);
        expect(first!.cpuCount).toBe(1);
        expect(first!.sampledAt).toBe(1_000);
    });

    it('computes CPU percent from the difference between adjacent cumulative samples', () => {
        let times = [core(100, 100)];
        const sampler = createMachineResourceSampler(probeOf({ cpuTimes: () => times }));
        sampler.sample(1_000);

        // +25 idle, +75 busy over the interval -> 75% busy.
        times = [core(125, 175)];
        const second = sampler.sample(11_000);

        expect(second!.cpuPercent).toBe(75);
    });

    it('never turns load average into a CPU percentage', () => {
        const sampler = createMachineResourceSampler(probeOf({
            cpuTimes: () => [core(100, 100)],
            loadAverage: () => [8, 8, 8],
        }));

        expect(sampler.sample(1_000)!.cpuPercent).toBeNull();
    });

    it('re-baselines instead of guessing when the core count changes', () => {
        let times = [core(100, 100), core(100, 100)];
        const sampler = createMachineResourceSampler(probeOf({ cpuTimes: () => times }));
        sampler.sample(1_000);

        times = [core(125, 175)];
        const afterHotplug = sampler.sample(11_000);
        expect(afterHotplug!.cpuPercent).toBeNull();
        expect(afterHotplug!.cpuCount).toBe(1);

        // The discarded pair must not poison the next one.
        times = [core(150, 250)];
        expect(sampler.sample(21_000)!.cpuPercent).toBe(75);
    });

    it('reports no CPU percentage when the counters do not move forward', () => {
        let times = [core(100, 100)];
        const sampler = createMachineResourceSampler(probeOf({ cpuTimes: () => times }));
        sampler.sample(1_000);

        // Counter reset (container restart, suspend/resume) reads as a backwards jump.
        times = [core(10, 10)];
        expect(sampler.sample(11_000)!.cpuPercent).toBeNull();
    });

    it('publishes no load average where the OS has none', () => {
        const sampler = createMachineResourceSampler(probeOf({ loadAverage: () => null }));

        expect(sampler.sample(1_000)!.loadAverage).toBeNull();
    });

    it('rejects a non-finite load average rather than publishing NaN', () => {
        const sampler = createMachineResourceSampler(probeOf({ loadAverage: () => [1, Number.NaN, 3] }));

        expect(sampler.sample(1_000)!.loadAverage).toBeNull();
    });

    it.each([
        ['negative CPU time', () => [core(100, -1)]],
        ['non-finite CPU time', () => [{ user: Number.NaN, nice: 0, sys: 0, idle: 100, irq: 0 }]],
        ['missing idle time', () => [{ user: 100, nice: 0, sys: 0, irq: 0 }]],
        ['empty CPU list', () => []],
    ])('returns no snapshot for %s', (_label, cpuTimes) => {
        const sampler = createMachineResourceSampler(probeOf({ cpuTimes }));

        expect(sampler.sample(1_000)).toBeNull();
    });

    it.each([
        ['non-positive total', { total: 0, free: 0 }],
        ['non-finite total', { total: Number.NaN, free: 0 }],
        ['negative free', { total: 1_000, free: -1 }],
        ['free greater than total', { total: 1_000, free: 1_001 }],
    ])('returns no snapshot for %s memory', (_label, memory) => {
        const sampler = createMachineResourceSampler(probeOf({ memory: () => memory }));

        expect(sampler.sample(1_000)).toBeNull();
    });

    it('rejects negative load averages rather than publishing invalid OS data', () => {
        const sampler = createMachineResourceSampler(probeOf({ loadAverage: () => [-1, 2, 3] }));

        expect(sampler.sample(1_000)!.loadAverage).toBeNull();
    });

    it('resets the CPU baseline after an invalid OS read before recovery', () => {
        let times = [core(100, 100)];
        let fail = false;
        const sampler = createMachineResourceSampler(probeOf({
            cpuTimes: () => times,
            memory: () => fail ? { total: 0, free: 0 } : { total: 1_000, free: 400 },
        }));

        expect(sampler.sample(1_000)!.cpuPercent).toBeNull();
        fail = true;
        expect(sampler.sample(11_000)).toBeNull();
        fail = false;
        times = [core(125, 175)];
        expect(sampler.sample(21_000)!.cpuPercent).toBeNull();
        times = [core(150, 250)];
        expect(sampler.sample(31_000)!.cpuPercent).toBe(75);
    });

    it('returns null when the OS read fails so the caller can say "unavailable"', () => {
        const sampler = createMachineResourceSampler(probeOf({
            memory: () => { throw new Error('read failed'); },
        }));

        expect(sampler.sample(1_000)).toBeNull();
    });

    it('drops the baseline on reset so a resumed sampler cannot span the idle gap', () => {
        let times = [core(100, 100)];
        const sampler = createMachineResourceSampler(probeOf({ cpuTimes: () => times }));
        sampler.sample(1_000);
        sampler.reset();

        times = [core(125, 175)];
        expect(sampler.sample(11_000)!.cpuPercent).toBeNull();
    });
});
