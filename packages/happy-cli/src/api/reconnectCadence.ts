/**
 * Shared dial cadence for the daemon's two long-lived sockets
 * (specs/machine-socket-duplicate-registration/).
 *
 * Both `apiMachine` and `apiSession` used to retry with a bare
 * `setInterval(3000)` that called `socket.connect()` on every tick regardless
 * of whether the previous dial had resolved. When a handshake is slow — sleep
 * and wake, a VPN flap, a server that is coming back up — several dials overlap
 * and several of them complete. The client keeps one Socket object, so it
 * notices nothing; the server ends up holding more than one live socket for the
 * same machine and routes work into whichever it picks.
 *
 * The cadence here is deliberately boring: one dial at a time, exponential
 * backoff with jitter, and an expiry so a dial that resolves with neither
 * `connect` nor `connect_error` cannot wedge the loop shut.
 */

/** First delay. Matches the old 1s kick, so an ordinary blip still recovers fast. */
export const RECONNECT_BASE_DELAY_MS = 1_000;

/** Ceiling for the doubling. A daemon down this long is waiting on someone else. */
export const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * How long one dial may stay unresolved before the cadence stops waiting for it.
 *
 * Without this, the single-flight guard would become a new way to never
 * reconnect at all — the exact failure class specs/daemon-socket-watchdog
 * exists to prevent.
 */
export const RECONNECT_DIAL_TIMEOUT_MS = 20_000;

/**
 * Delay before dial number `attempts + 1`.
 *
 * `random` is injectable so the jitter is testable; production passes nothing
 * and gets `Math.random`.
 */
export function reconnectDelayMs(attempts: number, random: () => number = Math.random): number {
    const steps = Math.max(0, Math.trunc(attempts));
    const exponential = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** steps, RECONNECT_MAX_DELAY_MS);
    // Half-range jitter: never longer than the nominal delay (so the ceiling
    // stays a real ceiling), never shorter than half of it (so backoff still
    // backs off).
    return Math.round(exponential * (0.5 + random() * 0.5));
}
