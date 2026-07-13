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
export function isNonRetryableError(e: unknown): boolean {
    if (axios.isAxiosError(e)) {
        const status = e.response?.status;
        if (typeof status === 'number' && status >= 400 && status < 500) {
            return status !== 408 && status !== 429;
        }
    }
    return false;
}

export function exponentialBackoffDelay(currentFailureCount: number, minDelay: number, maxDelay: number, maxFailureCount: number) {
    let maxDelayRet = minDelay + ((maxDelay - minDelay) / maxFailureCount) * Math.min(currentFailureCount, maxFailureCount);
    return Math.round(Math.random() * maxDelayRet);
}

export type BackoffFunc = <T>(callback: () => Promise<T>) => Promise<T>;

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
        isNonRetryable?: (e: unknown) => boolean
    }): BackoffFunc {
    return async <T>(callback: () => Promise<T>): Promise<T> => {
        let currentFailureCount = 0;
        const minDelay = opts && opts.minDelay !== undefined ? opts.minDelay : 250;
        const maxDelay = opts && opts.maxDelay !== undefined ? opts.maxDelay : 1000;
        const maxFailureCount = opts && opts.maxFailureCount !== undefined ? opts.maxFailureCount : 50;
        const isNonRetryable = opts && opts.isNonRetryable !== undefined ? opts.isNonRetryable : isNonRetryableError;
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
                // Permanent failures (e.g. 404 after a session is archived/deleted)
                // would otherwise be retried indefinitely — abort and let the caller decide.
                if (isNonRetryable(e)) {
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