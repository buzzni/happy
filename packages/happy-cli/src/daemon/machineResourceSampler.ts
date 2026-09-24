/**
 * One machine-wide resource reading.
 *
 * The daemon is the only process on the machine that samples, so this module
 * owns the two rules that make a reading honest:
 *
 *  1. CPU usage is the difference between two *adjacent* cumulative
 *     `os.cpus()` readings. It is never derived from `os.loadavg()`, which
 *     measures the run queue rather than utilisation, and it is never produced
 *     by blocking the event loop to manufacture a second reading — the daemon
 *     serves RPC while this runs. Until a usable pair exists the answer is
 *     `null`, not zero.
 *  2. Everything that does not need a delta (memory, load, core count) is
 *     published on the very first sample. A missing CPU delta must not blank
 *     the readings that are already known.
 *
 * specs/machine-resource-metrics
 */
import { cpus, freemem, loadavg, totalmem } from 'node:os';

/** Injection seam: the tests drive cumulative counters, the daemon drives `os`. */
export interface MachineResourceProbe {
    /** Per-core cumulative times, shaped like `os.cpus()[n].times`. */
    cpuTimes(): Array<Record<string, number>>;
    memory(): { total: number; free: number };
    /** `null` where the platform has no load average at all. */
    loadAverage(): [number, number, number] | null;
}

export interface MachineResourceSnapshot {
    /** Daemon wall clock, milliseconds. The client renders it as a remote time. */
    sampledAt: number;
    /** 0–100 across all cores, or `null` while no usable delta exists. */
    cpuPercent: number | null;
    cpuCount: number;
    /** `totalmem() - freemem()` — OS-wide, cache included; not a per-process RSS. */
    memoryUsedBytes: number;
    memoryTotalBytes: number;
    /** 1/5/15-minute averages, or `null` where the platform has none. */
    loadAverage: [number, number, number] | null;
}

export interface MachineResourceSampler {
    /** One reading, or `null` when the OS read itself failed. */
    sample(now: number): MachineResourceSnapshot | null;
    /** Forget the CPU baseline so the next delta cannot span an idle gap. */
    reset(): void;
}

/**
 * Windows reports a constant `[0, 0, 0]`, which is indistinguishable from a
 * genuinely idle machine — so it is reported as "no load average" rather than
 * as zero load.
 */
export const nodeMachineResourceProbe: MachineResourceProbe = {
    cpuTimes: () => cpus().map((cpu) => cpu.times as unknown as Record<string, number>),
    memory: () => ({ total: totalmem(), free: freemem() }),
    loadAverage: () => {
        if (process.platform === 'win32') return null;
        const [one, five, fifteen] = loadavg();
        return [one, five, fifteen];
    },
};

type CpuTotals = { idle: number; total: number; cores: number };

const CPU_TIME_FIELDS = ['user', 'nice', 'sys', 'idle', 'irq'] as const;

function finiteNonNegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function cpuTotals(times: Array<Record<string, number>>): CpuTotals | null {
    if (times.length === 0) return null;
    let idle = 0;
    let total = 0;
    for (const core of times) {
        if (!core || !CPU_TIME_FIELDS.every((field) => finiteNonNegative(core[field]))) return null;
        idle += core.idle;
        for (const field of CPU_TIME_FIELDS) total += core[field];
    }
    return { idle, total, cores: times.length };
}

function finiteLoadAverage(value: [number, number, number] | null): [number, number, number] | null {
    if (!value) return null;
    return value.length === 3 && value.every((entry) => finiteNonNegative(entry)) ? value : null;
}

/**
 * The delta, or `null` when the pair cannot be trusted.
 *
 * A changed core count is refused rather than truncated to the shorter of the
 * two readings: after a hotplug the surviving cores' counters describe a
 * different machine, and averaging them silently reports a number nobody can
 * act on. Non-advancing totals mean the counters were reset (suspend/resume,
 * container restart), which reads as a backwards jump.
 */
export function cpuPercentBetween(previous: CpuTotals, next: CpuTotals): number | null {
    if (
        !finiteNonNegative(previous.idle)
        || !finiteNonNegative(previous.total)
        || !finiteNonNegative(next.idle)
        || !finiteNonNegative(next.total)
    ) return null;
    if (previous.cores !== next.cores) return null;
    const total = next.total - previous.total;
    const idle = next.idle - previous.idle;
    if (!(total > 0) || idle < 0 || idle > total) return null;
    const percent = Math.round((1 - idle / total) * 1000) / 10;
    return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
}

export function createMachineResourceSampler(
    probe: MachineResourceProbe = nodeMachineResourceProbe,
): MachineResourceSampler {
    let baseline: CpuTotals | null = null;

    return {
        sample(now) {
            let totals: CpuTotals | null = null;
            let memory: { total: number; free: number };
            let load: [number, number, number] | null;
            try {
                totals = cpuTotals(probe.cpuTimes());
                memory = probe.memory();
                load = finiteLoadAverage(probe.loadAverage());
                if (!totals) throw new Error('invalid CPU resource reading');
                if (
                    !finiteNonNegative(memory.total)
                    || memory.total <= 0
                    || !finiteNonNegative(memory.free)
                    || memory.free > memory.total
                ) throw new Error('invalid memory resource reading');
            } catch {
                // An OS read that throws is "unavailable", not "zero". The
                // baseline is dropped so the next successful pair does not
                // straddle the gap.
                baseline = null;
                return null;
            }

            if (!totals) return null;

            const cpuPercent = baseline ? cpuPercentBetween(baseline, totals) : null;
            baseline = totals;

            return {
                sampledAt: now,
                cpuPercent,
                cpuCount: totals.cores,
                memoryUsedBytes: Math.max(0, memory.total - memory.free),
                memoryTotalBytes: memory.total,
                loadAverage: load,
            };
        },
        reset() {
            baseline = null;
        },
    };
}
