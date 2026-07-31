import { describe, it, expect, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { createBackoff, isNonRetryableError, isSessionGoneError, SESSION_GONE_MIN_DELAY_MS, SESSION_GONE_MAX_DELAY_MS } from './time';

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

describe('isSessionGoneError', () => {
    it('treats only 404/410 as "session gone"', () => {
        expect(isSessionGoneError(axiosErrorWithStatus(404))).toBe(true);
        expect(isSessionGoneError(axiosErrorWithStatus(410))).toBe(true);
    });

    it('does not treat other non-retryable 4xx as "session gone"', () => {
        // 401/403/400 are non-retryable but may be environmental (expired
        // token, proxy) — the session must stay resumable.
        expect(isSessionGoneError(axiosErrorWithStatus(401))).toBe(false);
        expect(isSessionGoneError(axiosErrorWithStatus(403))).toBe(false);
        expect(isSessionGoneError(axiosErrorWithStatus(400))).toBe(false);
        expect(isSessionGoneError(axiosErrorWithStatus(500))).toBe(false);
        expect(isSessionGoneError(new Error('ECONNRESET'))).toBe(false);
    });
});

describe('createBackoff', () => {
    // 2026-07-23 운영 사고: happy-server 는 "세션 삭제됨"과 "다른 계정
    // 소유"를 같은 404 로 반환한다. 실제 원인이 계정/토큰 불일치였는데도
    // 첫 404 에서 즉시 중단해 세션이 끊긴 것처럼 보였다. 404/410 은 짧은
    // 제한 재시도로 일시적 lookup miss 를 걸러낸 뒤에만 중단한다
    // (무한 재시도 금지는 #64 그대로 유지).
    it('retries 404/410 a bounded number of times before aborting', async () => {
        const backoff = createBackoff({ minDelay: 0, maxDelay: 0, sessionGoneMinDelay: 0, sessionGoneMaxDelay: 0 });
        const callback = vi.fn(async () => { throw axiosErrorWithStatus(404); });
        await expect(backoff(callback)).rejects.toMatchObject({ response: { status: 404 } });
        // Default bound: 3 attempts total — enough to rule out a transient
        // replica/LB miss, nowhere near the old unbounded loop.
        expect(callback).toHaveBeenCalledTimes(3);
    });

    it('recovers when a transient 404 clears within the bounded retries', async () => {
        const backoff = createBackoff({ minDelay: 0, maxDelay: 0, sessionGoneMinDelay: 0, sessionGoneMaxDelay: 0 });
        let attempts = 0;
        const callback = vi.fn(async () => {
            attempts++;
            if (attempts < 3) throw axiosErrorWithStatus(404);
            return 'ok';
        });
        await expect(backoff(callback)).resolves.toBe('ok');
        expect(callback).toHaveBeenCalledTimes(3);
    });

    it('honors a custom sessionGoneMaxAttempts bound', async () => {
        const backoff = createBackoff({ minDelay: 0, maxDelay: 0, sessionGoneMinDelay: 0, sessionGoneMaxDelay: 0, sessionGoneMaxAttempts: 1 });
        const callback = vi.fn(async () => { throw axiosErrorWithStatus(410); });
        await expect(backoff(callback)).rejects.toMatchObject({ response: { status: 410 } });
        expect(callback).toHaveBeenCalledTimes(1);
    });

    // 2026-07-31 운영 사고: 실측 재시도 창이 265ms 에 불과해(minDelay/maxDelay
    // 를 세션-소실용으로 별도 분리하지 않고 재사용) 서버가 한순간 준 404 에도
    // 살아있는 세션이 죽었다. 죽은 세션 3개를 직후 같은 토큰으로 재조회하면
    // 전부 200(active=true) — 삭제가 아니라 순간적인 흔들림이었다. 세션-소실
    // 재시도는 일반 전송 재시도(빠른 네트워크 히컵용)와 분리된, 훨씬 더 긴
    // 기본 지연 창을 써야 한다.
    it('exposes session-gone default delays that are far longer than the old ~265ms window', () => {
        expect(SESSION_GONE_MIN_DELAY_MS).toBeGreaterThanOrEqual(2000);
        expect(SESSION_GONE_MAX_DELAY_MS).toBeGreaterThan(SESSION_GONE_MIN_DELAY_MS);
    });

    it('uses the session-gone delay window (not the fast generic window) by default when retrying 404s', async () => {
        vi.useFakeTimers();
        // exponentialBackoffDelay draws uniformly from [0, maxDelayRet] — pin
        // Math.random so the test isn't flaky against the low end of that range.
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9);
        try {
            // No overrides at all — this is exactly what apiSession.ts's shared
            // `backoff` singleton uses in production.
            const backoff = createBackoff({});
            const callback = vi.fn(async () => { throw axiosErrorWithStatus(404); });
            const result = backoff(callback).catch((e) => e);

            // The old bug: all 3 attempts fit inside ~265ms. Advancing past that
            // old window must NOT be enough to exhaust the retries now.
            await vi.advanceTimersByTimeAsync(500);
            expect(callback).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(30000);
            await expect(result).resolves.toMatchObject({ response: { status: 404 } });
            expect(callback).toHaveBeenCalledTimes(3);
        } finally {
            randomSpy.mockRestore();
            vi.useRealTimers();
        }
    });

    it('still aborts immediately on other non-retryable 4xx (401/403/400)', async () => {
        const backoff = createBackoff({ minDelay: 0, maxDelay: 0 });
        const callback = vi.fn(async () => { throw axiosErrorWithStatus(401); });
        await expect(backoff(callback)).rejects.toMatchObject({ response: { status: 401 } });
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
