/**
 * What `happy auth login` does when a check on its pending pairing code fails
 * (aplus-dev-studio-desktop specs/headless-standalone-server R30). Approval can take minutes,
 * so a busy server or a dropped request must not end the wait; an expired code must.
 */
export const AUTH_POLL_MAX_CONSECUTIVE_FAILURES = 10

const RETRY_AFTER_DEFAULT_MS = 5_000
const RETRY_AFTER_MAX_MS = 60_000
const BACKOFF_MAX_MS = 30_000
const GENERIC_FAILURE = 'Failed to check authentication status. Please try again.'

export type AuthPollFailure = { status?: number; retryAfter?: string | number | null }
export type AuthPollStep =
    | { action: 'retry'; delayMs: number; countsAsFailure: boolean }
    | { action: 'stop'; message: string }

/** `consecutiveFailures` already includes this failure when it is a network or 5xx one. */
export function authPollStep(failure: AuthPollFailure, consecutiveFailures: number): AuthPollStep {
    if (failure.status === 429) {
        const seconds = Number(failure.retryAfter)
        const delayMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, RETRY_AFTER_MAX_MS) : RETRY_AFTER_DEFAULT_MS
        return { action: 'retry', delayMs, countsAsFailure: false }
    }
    if (failure.status === 410) {
        return { action: 'stop', message: 'This connection code expired before it was approved. Run happy auth login again.' }
    }
    if (failure.status === undefined || failure.status >= 500) {
        if (consecutiveFailures >= AUTH_POLL_MAX_CONSECUTIVE_FAILURES) {
            return { action: 'stop', message: 'Could not reach the server to check the approval. Run happy auth login again.' }
        }
        return { action: 'retry', delayMs: Math.min(1000 * 2 ** Math.max(0, consecutiveFailures - 1), BACKOFF_MAX_MS), countsAsFailure: true }
    }
    return { action: 'stop', message: GENERIC_FAILURE }
}
