/**
 * The machine's single resource sampler, and the subscriptions that keep it alive.
 *
 * Every Desktop window on every computer that wants these numbers talks to this
 * one object, so the measurement cost is a property of the *machine* rather
 * than of how many people are looking. A request never measures: it renews a
 * lease and reads the cache. Only the timer measures, and there is one timer.
 *
 * The lifetime rules are deliberately two, not one:
 *   - a clean `release` stops the timer immediately, because that is the common
 *     case and waiting out a TTL would keep a laptop sampling for no reader;
 *   - a lease TTL stops it anyway, because a window that crashed, lost its
 *     network, or was killed never sends the release. The TTL is the only rule
 *     that holds when the client is gone, so it is the safety net, not the
 *     primary path.
 *
 * specs/machine-resource-metrics
 */
import {
    createMachineResourceSampler,
    type MachineResourceSampler,
    type MachineResourceSnapshot,
} from './machineResourceSampler';

/** RPC method name on the machine-scoped, end-to-end encrypted RPC surface. */
export const MACHINE_RESOURCE_METRICS_RPC = 'machine-resource-metrics';

export const MACHINE_RESOURCE_SAMPLE_INTERVAL_MS = 10_000;

/**
 * Long enough that a client polling on the sample cadence renews roughly three
 * times before expiry — one lost round trip must not stop a machine that is
 * still being watched — and short enough that a crashed window costs at most
 * this much sampling.
 */
export const MACHINE_RESOURCE_LEASE_TTL_MS = 35_000;

/**
 * A ceiling on the subscription table. The ids come from clients, so without a
 * bound a buggy (or hostile) caller could grow this map without limit. Refusing
 * past the ceiling keeps the subscriptions that already work working.
 */
export const MACHINE_RESOURCE_MAX_SUBSCRIPTIONS = 64;

const MAX_SUBSCRIPTION_ID_LENGTH = 128;

/**
 * Every answer this RPC can give. A closed set, because the client branches on
 * it: an `unsupported-version` or `subscription-ended` must never be retried the
 * way a `sample-unavailable` should be.
 */
export type MachineResourceStatus =
    /** A reading is attached, or this was a `release`. */
    | 'ok'
    /** The request named a wire version this daemon does not implement. */
    | 'unsupported-version'
    /** Malformed shape, unknown action, or an unusable subscription id. */
    | 'invalid-request'
    /** A `read` that arrived after its own `release`; the client must re-subscribe under a new id. */
    | 'subscription-ended'
    /** The subscription table is full; existing subscriptions are unaffected. */
    | 'capacity-exceeded'
    /** The latest measurement attempt failed; the old cache is intentionally hidden. */
    | 'sample-unavailable';

export interface MachineResourceResponse {
    version: 1;
    status: MachineResourceStatus;
    snapshot: MachineResourceSnapshot | null;
}

export interface MachineResourceService {
    handleRequest(params: unknown): MachineResourceResponse;
    /** Subscriptions currently holding the sampler open. Diagnostics and tests. */
    subscriptionCount(): number;
    /** Daemon shutdown: drop the timer and every lease. */
    stop(): void;
}

export interface MachineResourceServiceOptions {
    sampler?: MachineResourceSampler;
    /** Wall clock, published as `sampledAt`. Never used to judge elapsed time. */
    now?: () => number;
    /** Monotonic clock, used for every lease and tombstone deadline. */
    monotonicNow?: () => number;
    startTimer?: (fn: () => void, intervalMs: number) => unknown;
    stopTimer?: (handle: unknown) => void;
}

function answer(status: MachineResourceStatus, snapshot: MachineResourceSnapshot | null = null): MachineResourceResponse {
    return { version: 1, status, snapshot };
}

type Request = { action: 'read' | 'release'; subscriptionId: string };

/** `null` when the payload is unusable; the status is decided by the caller. */
function parseRequest(params: unknown): Request | 'unsupported-version' | null {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) return null;
    const { version, action, subscriptionId } = params as Record<string, unknown>;
    if (version !== 1) {
        // A number we do not implement is a different problem from a malformed
        // body: the client should stop asking, not retry.
        return typeof version === 'number' ? 'unsupported-version' : null;
    }
    if (action !== 'read' && action !== 'release') return null;
    if (typeof subscriptionId !== 'string') return null;
    if (subscriptionId.length === 0 || subscriptionId.length > MAX_SUBSCRIPTION_ID_LENGTH) return null;
    return { action, subscriptionId };
}

export function createMachineResourceService(
    options: MachineResourceServiceOptions = {},
): MachineResourceService {
    const sampler = options.sampler ?? createMachineResourceSampler();
    /**
     * Two clocks on purpose. `sampledAt` has to be a wall-clock time because
     * the client renders it, but a wall clock moves — an NTP correction or a
     * manual change can jump it backwards by an hour, and a lease deadline
     * computed from it would then sit an hour in the future and keep an
     * abandoned sampler running. Elapsed time is judged on a clock that only
     * goes forward.
     */
    const now = options.now ?? (() => Date.now());
    const monotonicNow = options.monotonicNow ?? (() => performance.now());
    const startTimer = options.startTimer ?? ((fn, intervalMs) => {
        const handle = setInterval(fn, intervalMs);
        // Sampling must never be the reason the daemon process stays alive.
        handle.unref?.();
        return handle;
    });
    const stopTimer = options.stopTimer ?? ((handle) => clearInterval(handle as NodeJS.Timeout));

    /** subscriptionId -> lease expiry. */
    const leases = new Map<string, number>();
    /**
     * Subscriptions that released, and when. Without this, a `read` that
     * overtook its own `release` on the way through the relay would recreate
     * the lease and keep the machine sampling for a whole TTL with nobody
     * watching. Entries are forgotten after the same TTL, so an id is reusable
     * once no in-flight request could still be carrying it.
     */
    const ended = new Map<string, number>();
    let cache: MachineResourceSnapshot | null = null;
    let latestMeasurementAvailable = false;
    let timer: unknown = null;
    /** Terminal. `stop()` is daemon shutdown, not a pause. */
    let stopped = false;

    function takeSample(at: number): void {
        try {
            const snapshot = sampler.sample(at);
            latestMeasurementAvailable = snapshot !== null;
            if (snapshot) cache = snapshot;
        } catch {
            // A throwing OS read must not kill the timer. The previous reading
            // stays for the Desktop store, but it is not returned as current.
            latestMeasurementAvailable = false;
        }
    }

    /** Idempotent: called from both the sweep and `release`, often with nothing to do. */
    function stopSampling(): void {
        if (timer === null) return;
        stopTimer(timer);
        timer = null;
        // Drop the CPU baseline: the next delta must not span the idle gap.
        sampler.reset();
    }

    /**
     * Expire leases and tombstones, and stop sampling if that left nobody.
     *
     * Stopping here rather than only in the tick is what keeps the timer
     * single: a `read` that arrives after the last lease expired but before
     * the tick that would have noticed would otherwise see an empty table,
     * treat itself as the first subscription, and start a second interval on
     * top of the first — whose handle is then lost, so it samples forever.
     */
    function sweep(elapsedAt: number): void {
        for (const [id, expiresAt] of leases) {
            if (expiresAt <= elapsedAt) leases.delete(id);
        }
        for (const [id, endedAt] of ended) {
            if (elapsedAt - endedAt >= MACHINE_RESOURCE_LEASE_TTL_MS) ended.delete(id);
        }
        if (leases.size === 0) stopSampling();
    }

    function tick(): void {
        sweep(monotonicNow());
        if (leases.size === 0) return;
        takeSample(now());
    }

    function rememberEnded(id: string, at: number): void {
        if (ended.size >= MACHINE_RESOURCE_MAX_SUBSCRIPTIONS) {
            const oldest = ended.keys().next();
            if (!oldest.done) ended.delete(oldest.value);
        }
        ended.set(id, at);
    }

    function read(subscriptionId: string, elapsedAt: number): MachineResourceResponse {
        if (ended.has(subscriptionId)) return answer('subscription-ended');
        if (!leases.has(subscriptionId) && leases.size >= MACHINE_RESOURCE_MAX_SUBSCRIPTIONS) {
            return answer('capacity-exceeded');
        }

        leases.set(subscriptionId, elapsedAt + MACHINE_RESOURCE_LEASE_TTL_MS);
        if (timer === null) {
            // The only measurement a request ever causes: the baseline that
            // makes the *next* tick able to report a CPU delta. Keyed on the
            // timer rather than on the table size, so a subscription arriving
            // while an interval is still live reuses it.
            timer = startTimer(tick, MACHINE_RESOURCE_SAMPLE_INTERVAL_MS);
            takeSample(now());
        }

        return latestMeasurementAvailable && cache ? answer('ok', cache) : answer('sample-unavailable');
    }

    function release(subscriptionId: string, elapsedAt: number): MachineResourceResponse {
        leases.delete(subscriptionId);
        // Tombstoned whether or not a lease was held here: a `release` that
        // overtook its own `read` would otherwise leave nothing to stop that
        // read from opening a subscription nobody is waiting on.
        rememberEnded(subscriptionId, elapsedAt);
        if (leases.size === 0) stopSampling();
        return answer('ok');
    }

    return {
        handleRequest(params) {
            const parsed = parseRequest(params);
            if (parsed === null) return answer('invalid-request');
            if (parsed === 'unsupported-version') return answer('unsupported-version');

            if (stopped) {
                // Shutdown is terminal: a late request answers honestly and
                // starts nothing. `release` still succeeds — there is nothing
                // left to release.
                return parsed.action === 'read' ? answer('sample-unavailable') : answer('ok');
            }

            const elapsedAt = monotonicNow();
            sweep(elapsedAt);
            return parsed.action === 'read'
                ? read(parsed.subscriptionId, elapsedAt)
                : release(parsed.subscriptionId, elapsedAt);
        },
        subscriptionCount: () => leases.size,
        stop() {
            stopped = true;
            leases.clear();
            ended.clear();
            cache = null;
            latestMeasurementAvailable = false;
            stopSampling();
        },
    };
}
