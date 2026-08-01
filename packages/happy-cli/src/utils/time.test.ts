import { describe, it, expect, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { backoff, createBackoff, isNonRetryableError, isProxyCircuitBreakerError, isSessionGoneError, SESSION_GONE_MIN_DELAY_MS, SESSION_GONE_MAX_DELAY_MS } from './time';

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

/**
 * aplus web-ui proxy 가 세션 메시지 404 서킷을 열었을 때 돌려주는 합성 응답.
 * 본문은 happy-server 의 진짜 404 와 글자까지 동일하고, 헤더만 다르다.
 */
function axiosErrorFromCircuitBreaker(status = 404, circuit = 'session-messages-404'): AxiosError {
    const err = axiosErrorWithStatus(status);
    err.response!.data = { error: 'Session not found' };
    err.response!.headers = {
        'x-aplus-circuit-breaker': circuit,
    } as NonNullable<AxiosError['response']>['headers'];
    return err;
}

describe('isProxyCircuitBreakerError', () => {
    it('matches only the exact session-messages synthetic 404 contract', () => {
        expect(isProxyCircuitBreakerError(axiosErrorFromCircuitBreaker())).toBe(true);
        expect(isProxyCircuitBreakerError(axiosErrorFromCircuitBreaker(401))).toBe(false);
        expect(isProxyCircuitBreakerError(axiosErrorFromCircuitBreaker(410))).toBe(false);
        expect(isProxyCircuitBreakerError(axiosErrorFromCircuitBreaker(404, 'future-circuit'))).toBe(false);
    });

    it('reads the header case-insensitively from AxiosHeaders', () => {
        const err = axiosErrorWithStatus(404);
        err.response!.headers = new AxiosHeaders({
            'X-Aplus-Circuit-Breaker': 'session-messages-404',
        });

        expect(isProxyCircuitBreakerError(err)).toBe(true);
    });

    it('fails closed on a crafted 404 without response headers instead of throwing', () => {
        // isAxiosError 는 e.isAxiosError === true 만 본다 — 손으로 만든 에러는
        // headers 없이도 여기까지 온다. 분류기는 backoff 의 catch 안에서 돌므로
        // 여기서 throw 하면 원래 오류가 TypeError 로 바뀌어 삼켜진다.
        const err = axiosErrorWithStatus(404);
        err.response!.headers = undefined as unknown as NonNullable<AxiosError['response']>['headers'];

        expect(isProxyCircuitBreakerError(err)).toBe(false);
        expect(isNonRetryableError(err)).toBe(true);
        expect(isSessionGoneError(err)).toBe(true);
    });
});

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

    // 2026-08-01 운영 사고: aplus web-ui proxy 의 세션 메시지 404 서킷이 열리면
    // upstream 에 요청이 가지도 않고 합성 404 가 돌아온다. 이 404 는 세션에
    // 대한 정보가 아니라 프록시 상태이므로 non-retryable 로 보면 안 된다.
    // 실제로 살아있는 세션(같은 토큰으로 직접 조회 시 200)의 CLI 가 27분간
    // 6번 반복해서 죽었다.
    it('keeps a proxy circuit-breaker 404 retryable', () => {
        expect(isNonRetryableError(axiosErrorFromCircuitBreaker())).toBe(false);
    });

    it('keeps unrelated permanent 4xx non-retryable when a circuit header is present', () => {
        expect(isNonRetryableError(axiosErrorFromCircuitBreaker(401))).toBe(true);
        expect(isNonRetryableError(axiosErrorFromCircuitBreaker(404, 'future-circuit'))).toBe(true);
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

    it('does not treat a proxy circuit-breaker 404 as "session gone"', () => {
        // 프록시가 upstream 에 묻지도 않고 만든 404 — 세션 상태에 대한
        // 증거가 전혀 아니다. sessionUnreachable 판정이 오염되면 안 된다.
        expect(isSessionGoneError(axiosErrorFromCircuitBreaker())).toBe(false);
        expect(isSessionGoneError(axiosErrorFromCircuitBreaker(410))).toBe(true);
        expect(isSessionGoneError(axiosErrorFromCircuitBreaker(404, 'future-circuit'))).toBe(true);
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

    // 서킷 차단은 5분간 유지되는데 세션-소실 재시도 창은 수 초에 불과하다.
    // 서킷 404 를 세션-소실로 분류하면 어떤 재시도 창을 잡아도 못 버틴다 —
    // 일시적 장애로 보고 일반 재시도 루프에 태워야 세션이 살아남는다.
    it('keeps retrying a proxy circuit-breaker 404 past the session-gone bound', async () => {
        const backoff = createBackoff({ minDelay: 0, maxDelay: 0, sessionGoneMinDelay: 0, sessionGoneMaxDelay: 0 });
        let attempts = 0;
        const callback = vi.fn(async () => {
            attempts++;
            // 기본 세션-소실 한도(3회)를 넘겨서도 계속 재시도해야 한다.
            if (attempts < 6) throw axiosErrorFromCircuitBreaker();
            return 'ok';
        });
        await expect(backoff(callback)).resolves.toBe('ok');
        expect(callback).toHaveBeenCalledTimes(6);
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
            // Exercise the actual exported singleton apiSession.ts/InvalidateSync
            // use in production (only `onError` overridden), not a fresh
            // createBackoff({}) that could silently drift from it.
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
