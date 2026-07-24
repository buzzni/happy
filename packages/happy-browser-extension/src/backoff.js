/** Reconnect pacing for the bridge WebSocket: 1s doubling up to 30s. */

export const MAX_RECONNECT_DELAY_MS = 30_000

export function reconnectDelayMs(consecutiveFailures) {
    return Math.min(1000 * 2 ** consecutiveFailures, MAX_RECONNECT_DELAY_MS)
}
