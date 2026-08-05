/**
 * Guards that make resume-happy-session idempotent.
 *
 * 2026-08-05 incident: two resume RPCs 6.7 seconds apart each spawned a CLI
 * process for the same happy session. Two children attached to one session
 * corrupt each other's runtime reports and get empty-reaped together. A resume
 * request must reuse a live child, and concurrent requests must share one
 * in-flight spawn.
 */

/** True when a live daemon child is already attached to the happy session. */
export function hasLiveDaemonChild(
    happySessionId: string,
    liveSessions: Iterable<{ happySessionId?: string }>,
): boolean {
    for (const session of liveSessions) {
        if (session.happySessionId === happySessionId) return true;
    }
    return false;
}

/**
 * Deduplicates concurrent async work by key: callers arriving while a call for
 * the same key is still pending share its promise. The slot is cleared once the
 * call settles, so later calls run fresh.
 */
export function shareInFlight<T>(
    inflight: Map<string, Promise<T>>,
    key: string,
    factory: () => Promise<T>,
): Promise<T> {
    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = factory().finally(() => {
        inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
}
