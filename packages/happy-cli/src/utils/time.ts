import axios from 'axios';
import { logger } from '@/ui/logger';

export async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Classify an error as permanently non-retryable.
 *
 * Retrying is meant for transient failures (network down, 5xx, socket
 * version-mismatch). A 4xx means the request itself is wrong/gone and will
 * fail identically forever — e.g. a 404 "Session not found" after the session
 * was archived/deleted server-side. Retrying those spins the backoff loop
 * indefinitely (observed: 757k requests / 90MB log from a single dead session).
 *
 * 408 (Request Timeout) and 429 (Too Many Requests) are 4xx but transient, so
 * they remain retryable.
 */
/**
 * The aplus web-ui proxy short-circuits repeated session-message 404s: once
 * open it answers locally, byte-identical to happy-server's real
 * `{"error":"Session not found"}`, without asking upstream at all. The only
 * thing that tells the two apart is this header.
 *
 * Such a 404 carries no information about the session — it is the proxy's own
 * state. 2026-08-01 incident: a session that returned 200 to a direct query
 * with the same token had its CLI killed 6 times over 27 minutes, because the
 * synthetic 404 was read as "session gone".
 */
const PROXY_CIRCUIT_BREAKER_HEADER = 'x-aplus-circuit-breaker';

export function isProxyCircuitBreakerError(e: unknown): boolean {
    if (!axios.isAxiosError(e)) {
        return false;
    }
    const headers = e.response?.headers as Record<string, unknown> | undefined;
    return typeof headers?.[PROXY_CIRCUIT_BREAKER_HEADER] === 'string';
}

export function isNonRetryableError(e: unknown): boolean {
    // The proxy's block is time-bounded (minutes) and never reaches upstream,
    // so retrying is both correct and cheap — far cheaper than tearing the
    // session down and having the app respawn it into the same wall.
    if (isProxyCircuitBreakerError(e)) {
        return false;
    }
    if (axios.isAxiosError(e)) {
        const status = e.response?.status;
        if (typeof status === 'number' && status >= 400 && status < 500) {
            return status !== 408 && status !== 429;
        }
    }
    return false;
}

/**
 * True when the server says the requested resource no longer exists (404/410)
 * — e.g. the session row was deleted or the endpoint is gone for good. This is
 * a stronger claim than {@link isNonRetryableError}: a 401/403/400 is also
 * non-retryable, but the session itself may still be alive and the failure
 * environmental (expired token, misbehaving proxy), so callers should not
 * treat those as "the session is gone".
 */
export function isSessionGoneError(e: unknown): boolean {
    // A proxy-synthesized 404 never reached the session store — it must not
    // feed the sessionUnreachable verdict either.
    if (isProxyCircuitBreakerError(e)) {
        return false;
    }
    if (axios.isAxiosError(e)) {
        const status = e.response?.status;
        return status === 404 || status === 410;
    }
    return false;
}

export function exponentialBackoffDelay(currentFailureCount: number, minDelay: number, maxDelay: number, maxFailureCount: number) {
    let maxDelayRet = minDelay + ((maxDelay - minDelay) / maxFailureCount) * Math.min(currentFailureCount, maxFailureCount);
    return Math.round(Math.random() * maxDelayRet);
}

export type BackoffFunc = <T>(callback: () => Promise<T>) => Promise<T>;

/**
 * Total attempts allowed for a 404/410 before the backoff aborts.
 *
 * A 404 is NOT proof the session is gone: happy-server returns the same 404
 * for "row deleted" and "row exists under another account" (2026-07-23
 * incident: the session was alive, the credentials were mismatched), and a
 * replica/LB lookup miss can 404 transiently. A short bounded retry rules out
 * the transient case; the bound keeps the #64 guarantee (no unbounded loop).
 */
export const SESSION_GONE_MAX_ATTEMPTS = 3;

/**
 * Default delay window for session-gone-class (404/410) retries, kept
 * separate from the generic transient-retry window (minDelay 250 /
 * maxDelay 1000, tuned for fast network hiccups).
 *
 * 2026-07-31 incident: with the generic window reused for 404/410, all 3
 * bounded attempts fit inside ~265ms of wall-clock time. Three sessions were
 * killed by a 404 that, re-queried moments later with the same token, came
 * back 200 (active=true) — the "session gone" signal was a momentary blip,
 * not a deletion, and 265ms wasn't enough time for it to clear.
 */
export const SESSION_GONE_MIN_DELAY_MS = 2000;
export const SESSION_GONE_MAX_DELAY_MS = 8000;

export function createBackoff(
    opts?: {
        onError?: (e: any, failuresCount: number) => void,
        minDelay?: number,
        maxDelay?: number,
        maxFailureCount?: number,
        /**
         * Decides whether an error is permanently non-retryable. When it returns
         * true the backoff loop aborts and rethrows instead of retrying forever.
         * Defaults to {@link isNonRetryableError} (axios 4xx except 408/429).
         */
        isNonRetryable?: (e: unknown) => boolean,
        /**
         * Total attempts allowed for session-gone-class errors (404/410)
         * before aborting. Defaults to {@link SESSION_GONE_MAX_ATTEMPTS}.
         */
        sessionGoneMaxAttempts?: number,
        /**
         * Delay window used between session-gone-class (404/410) retries.
         * Defaults to {@link SESSION_GONE_MIN_DELAY_MS} / {@link SESSION_GONE_MAX_DELAY_MS}
         * — deliberately much longer than minDelay/maxDelay, which are tuned
         * for fast transient network retries, not for waiting out a
         * replica/LB blip on a resource-gone signal.
         */
        sessionGoneMinDelay?: number,
        sessionGoneMaxDelay?: number
    }): BackoffFunc {
    return async <T>(callback: () => Promise<T>): Promise<T> => {
        let currentFailureCount = 0;
        const minDelay = opts && opts.minDelay !== undefined ? opts.minDelay : 250;
        const maxDelay = opts && opts.maxDelay !== undefined ? opts.maxDelay : 1000;
        const maxFailureCount = opts && opts.maxFailureCount !== undefined ? opts.maxFailureCount : 50;
        const isNonRetryable = opts && opts.isNonRetryable !== undefined ? opts.isNonRetryable : isNonRetryableError;
        const sessionGoneMaxAttempts = opts && opts.sessionGoneMaxAttempts !== undefined
            ? opts.sessionGoneMaxAttempts
            : SESSION_GONE_MAX_ATTEMPTS;
        const sessionGoneMinDelay = opts && opts.sessionGoneMinDelay !== undefined
            ? opts.sessionGoneMinDelay
            : SESSION_GONE_MIN_DELAY_MS;
        const sessionGoneMaxDelay = opts && opts.sessionGoneMaxDelay !== undefined
            ? opts.sessionGoneMaxDelay
            : SESSION_GONE_MAX_DELAY_MS;
        while (true) {
            try {
                return await callback();
            } catch (e) {
                if (currentFailureCount < maxFailureCount) {
                    currentFailureCount++;
                }
                if (opts && opts.onError) {
                    opts.onError(e, currentFailureCount);
                }
                // Permanent failures would otherwise be retried indefinitely —
                // abort and let the caller decide. Exception: 404/410 get a
                // short bounded retry first, because the same 404 covers
                // deleted-row, account-mismatch, and transient lookup miss.
                if (isNonRetryable(e)) {
                    if (isSessionGoneError(e) && currentFailureCount < sessionGoneMaxAttempts) {
                        await delay(exponentialBackoffDelay(currentFailureCount, sessionGoneMinDelay, sessionGoneMaxDelay, sessionGoneMaxAttempts));
                        continue;
                    }
                    logger.debug(`[BACKOFF] non-retryable error, aborting after ${currentFailureCount} attempt(s):`, (e as Error)?.message || e);
                    throw e;
                }
                let waitForRequest = exponentialBackoffDelay(currentFailureCount, minDelay, maxDelay, maxFailureCount);
                await delay(waitForRequest);
            }
        }
    };
}

export let backoff = createBackoff({
    onError: (e, failuresCount) => {
        logger.debug(`[BACKOFF] retry ${failuresCount}:`, (e as Error)?.message || e);
    }
});