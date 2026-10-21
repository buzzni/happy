// Fence a replica whose cluster-bus reader is stuck while the rest of Redis works for it.
//
// Why: the streams adapter counts a peer as alive whenever *any* message from it
// arrives (socket.io-adapter ClusterAdapterWithHeartbeat nodesMap), and every
// fetchSockets() waits for every live peer. On 2026-10-21 one replica sat on a
// node whose path to Redis was ~300x slower: each XREAD reply (6-10MB for
// COUNT 2000) hit the 5s commandTimeout, so its reader never advanced, yet its
// heartbeats (small XADDs) kept succeeding. Every other replica waited on it and
// daemon lookups failed cluster-wide until the pod was removed by hand.
//
// Readiness cannot fix this (it does not touch bus membership) and must stay
// decoupled from shared dependencies (specs/readiness-probe-decoupling). So the
// fence only fires on a *local* asymmetry: reads stalled while this replica's
// own writes to the same Redis are still fast, *and* at least one other
// replica reports that it is reading fine. A shared Redis slowdown makes writes
// slow or failing; Redis-side egress throttling (which hits large reads while
// small writes stay fast) stalls every reader. Either way no replica fences.

export type BusReaderFenceOptions = {
    now?: () => number;
    onFence: (reason: string) => void;
    enabled?: boolean;
    /** Consecutive failed stream reads that count as a stall. */
    consecutiveReadFailures?: number;
    /** Reader lag behind the stream head that counts as a stall. */
    maxLagMs?: number;
    /** A write at or under this duration proves Redis is healthy for this replica. */
    fastWriteSeconds?: number;
    /** How recent that fast write must be. */
    writeFreshMs?: number;
    /** How long the stall must hold, with healthy writes, before fencing. */
    sustainMs?: number;
    /** A lag sample older than this is unknown, not a stall (the 5s XINFO tick can fail). */
    lagFreshMs?: number;
};

export type BusReaderFence = {
    recordRead(result: 'success' | 'failure'): void;
    recordWrite(result: 'success' | 'failure', seconds: number): void;
    recordLag(lagMs: number): void;
    /** Other replicas whose own reader succeeded recently (from the shared reader-health hash). */
    recordHealthyPeerReaders(count: number): void;
    evaluate(): void;
    readonly fenced: boolean;
};

export function createBusReaderFence(options: BusReaderFenceOptions): BusReaderFence {
    const now = options.now ?? Date.now;
    const enabled = options.enabled ?? true;
    const maxFailures = options.consecutiveReadFailures ?? 3;
    const maxLagMs = options.maxLagMs ?? 15_000;
    const fastWriteSeconds = options.fastWriteSeconds ?? 1;
    const writeFreshMs = options.writeFreshMs ?? 15_000;
    const sustainMs = options.sustainMs ?? 15_000;
    const lagFreshMs = options.lagFreshMs ?? 12_000;

    let consecutiveFailures = 0;
    let lagMs = 0;
    let lagAt: number | null = null;
    let lastFastWriteAt: number | null = null;
    let lastBadWriteAt: number | null = null;
    let stallSince: number | null = null;
    let healthyPeerReaders = 0;
    let fenced = false;

    const writesHealthy = (at: number) =>
        lastFastWriteAt !== null
        && at - lastFastWriteAt <= writeFreshMs
        && (lastBadWriteAt === null || lastBadWriteAt < lastFastWriteAt);

    const stallReason = (at: number): string | null => {
        const parts: string[] = [];
        if (consecutiveFailures >= maxFailures) parts.push(`${consecutiveFailures} consecutive read failures`);
        const lagFresh = lagAt !== null && at - lagAt <= lagFreshMs;
        if (lagFresh && lagMs >= maxLagMs) parts.push(`stream lag ${Math.round(lagMs)}ms`);
        return parts.length > 0 ? parts.join(', ') : null;
    };

    return {
        recordRead(result) {
            consecutiveFailures = result === 'success' ? 0 : consecutiveFailures + 1;
        },
        recordWrite(result, seconds) {
            const at = now();
            if (result === 'success' && seconds <= fastWriteSeconds) lastFastWriteAt = at;
            else lastBadWriteAt = at;
        },
        recordLag(value) {
            lagMs = value;
            lagAt = now();
        },
        recordHealthyPeerReaders(count) {
            healthyPeerReaders = count;
        },
        evaluate() {
            if (!enabled || fenced) return;
            const at = now();
            const reason = stallReason(at);
            if (reason === null || !writesHealthy(at) || healthyPeerReaders < 1) {
                stallSince = null;
                return;
            }
            stallSince ??= at;
            if (at - stallSince < sustainMs) return;
            fenced = true;
            const prefix = consecutiveFailures >= maxFailures ? 'reads stalled' : 'reader behind';
            options.onFence(`${prefix}: ${reason} for ${Math.round((at - stallSince) / 1000)}s while writes stay fast`
                + ` and ${healthyPeerReaders} other replica(s) read fine`);
        },
        get fenced() {
            return fenced;
        },
    };
}

/** Kill switch without a code change: HAPPY_BUS_READER_FENCE=0 (or off/false) disables fencing. */
export function busReaderFenceEnabled(env: { HAPPY_BUS_READER_FENCE?: string }): boolean {
    const value = env.HAPPY_BUS_READER_FENCE?.trim().toLowerCase();
    return !(value === '0' || value === 'off' || value === 'false');
}
