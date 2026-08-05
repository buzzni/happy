/**
 * Guards that make resume-happy-session idempotent.
 *
 * 2026-08-05 incident: two resume RPCs 6.7 seconds apart each spawned a CLI
 * process for the same happy session. Two children attached to one session
 * corrupt each other's runtime reports and get empty-reaped together. A resume
 * request must reuse a live child, and concurrent requests must share one
 * in-flight spawn.
 */

/**
 * True when a daemon child with a running process is already attached to the
 * happy session.
 *
 * The tracked-session map alone is not proof of liveness: adopted/external
 * sessions carry no childProcess handle, so no exit event evicts them and only
 * the periodic health check prunes their PID. Answering "already running" for a
 * dead entry would turn a resume into a no-op, so the PID is verified here.
 */
export function hasLiveDaemonChild(
    happySessionId: string,
    trackedSessions: Iterable<{ happySessionId?: string; pid: number }>,
    isPidAlive: (pid: number) => boolean,
): boolean {
    for (const session of trackedSessions) {
        if (session.happySessionId === happySessionId && isPidAlive(session.pid)) return true;
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
