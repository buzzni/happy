import { describe, it, expect, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { createBackoff, isNonRetryableError } from './time';

function axiosErrorWithStatus(status: number): AxiosError {
    const err = new AxiosError('Request failed with status code ' + status);
    err.response = {
        status,
        statusText: '',
        data: {},
        headers: {},
        config: { headers: new AxiosHeaders() },
    } as AxiosError['response'];
    return err;
}

describe('isNonRetryableError', () => {
    it('treats 4xx (except 408/429) as non-retryable', () => {
        expect(isNonRetryableError(axiosErrorWithStatus(404))).toBe(true);
        expect(isNonRetryableError(axiosErrorWithStatus(401))).toBe(true);
        expect(isNonRetryableError(axiosErrorWithStatus(403))).toBe(true);
        expect(isNonRetryableError(axiosErrorWithStatus(400))).toBe(true);
    });

    it('keeps 408/429 and 5xx retryable', () => {
        expect(isNonRetryableError(axiosErrorWithStatus(408))).toBe(false);
        expect(isNonRetryableError(axiosErrorWithStatus(429))).toBe(false);
        expect(isNonRetryableError(axiosErrorWithStatus(500))).toBe(false);
        expect(isNonRetryableError(axiosErrorWithStatus(503))).toBe(false);
    });

    it('keeps non-axios errors retryable (network, socket version-mismatch)', () => {
        expect(isNonRetryableError(new Error('Metadata version mismatch'))).toBe(false);
        expect(isNonRetryableError(new Error('ECONNRESET'))).toBe(false);
    });
});

describe('createBackoff', () => {
    it('aborts immediately on a non-retryable error instead of looping forever', async () => {
        const backoff = createBackoff({ minDelay: 0, maxDelay: 0 });
        const callback = vi.fn(async () => { throw axiosErrorWithStatus(404); });
        await expect(backoff(callback)).rejects.toMatchObject({ response: { status: 404 } });
        // 404 is permanent — the callback must not be retried.
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('retries transient errors then succeeds', async () => {
        const backoff = createBackoff({ minDelay: 0, maxDelay: 0 });
        let attempts = 0;
        const callback = vi.fn(async () => {
            attempts++;
            if (attempts < 3) throw axiosErrorWithStatus(503);
            return 'ok';
        });
        await expect(backoff(callback)).resolves.toBe('ok');
        expect(callback).toHaveBeenCalledTimes(3);
    });
});
