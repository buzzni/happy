/**
 * Per-(user, session) rate limit for the `session-stream` relay.
 *
 * happy-cli's own `streamDeltaRelay` coalesces to at most ~12-13 frames/sec
 * per block (80ms flush), but the server cannot trust that a connected
 * client is well-behaved — a modified/compromised CLI holding a valid
 * session token could emit as fast as the transport allows. Each admitted
 * frame here already costs an `isSessionValid` cache lookup plus an
 * ephemeral fan-out, so an unbounded client can still spend real server
 * work even though nothing is ever persisted.
 *
 * Fixed window, not token bucket: simpler, and a `session-stream` frame is
 * a discardable preview — a client mildly over budget just drops the excess
 * for a moment instead of anything visibly breaking.
 */

const WINDOW_MS = 1_000;
/** A single active text block flushes at ~12-13 Hz (streamDeltaRelay's 80ms
 * window). Claude's content blocks stream sequentially, not concurrently, so
 * one session rarely has more than one or two text-bearing blocks in flight
 * at once — 40/sec leaves ~3x headroom over that realistic ceiling while
 * still meaningfully capping a client that ignores the CLI's own
 * coalescing. */
const MAX_PER_WINDOW = 40;
/** Bounded like errorLogThrottle — a long-lived server must not grow this
 * map without limit across many distinct sessions. */
const MAX_TRACKED_KEYS = 10_000;

export interface SessionStreamRateLimiter {
    /** true if this frame may proceed; false if it must be dropped. */
    admit(userId: string, sid: string, now?: number): boolean;
    /** Tracked key count — memory-bound regression test hook. */
    size(): number;
}

export function createSessionStreamRateLimiter(
    opts: { windowMs?: number; maxPerWindow?: number } = {},
): SessionStreamRateLimiter {
    const windowMs = opts.windowMs ?? WINDOW_MS;
    const maxPerWindow = opts.maxPerWindow ?? MAX_PER_WINDOW;
    const state = new Map<string, { windowStart: number; count: number }>();

    const evictOldestIfFull = () => {
        if (state.size < MAX_TRACKED_KEYS) return;
        const oldestKey = state.keys().next().value;
        if (oldestKey !== undefined) state.delete(oldestKey);
    };

    return {
        admit(userId, sid, now = Date.now()) {
            const key = `${userId}:${sid}`;
            const entry = state.get(key);
            if (!entry || now - entry.windowStart >= windowMs) {
                evictOldestIfFull();
                state.set(key, { windowStart: now, count: 1 });
                return true;
            }
            if (entry.count >= maxPerWindow) return false;
            entry.count += 1;
            return true;
        },
        size() {
            return state.size;
        },
    };
}

/** Process-wide instance — the socket handler is re-entered per event, not
 * per connection, so state must live above any single handler invocation. */
export const sessionStreamRateLimiter = createSessionStreamRateLimiter();
