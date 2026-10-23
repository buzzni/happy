import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPermanentRefreshFailuresForTest } from '@/utils/refreshRecovery';
import {
    CALLER_GRANT_EXPIRED_NOTICE,
    grantExpiresWithin,
    onMcpCallerGrantExpired,
    refreshMcpCallerGrantIfExpiring,
    REFRESH_CHECK_INTERVAL_MS,
    REFRESH_THRESHOLD_MS,
    startMcpCallerGrantRefreshTimer,
} from './refreshMcpCallerGrant';

function grantWithExp(exp: number, extra: Record<string, unknown> = {}): string {
    const payload = Buffer.from(JSON.stringify({ exp, ...extra })).toString('base64url');
    return `${payload}.signature`;
}

describe('grantExpiresWithin', () => {
    it('reads the expiry out of the signed payload', () => {
        expect(grantExpiresWithin(grantWithExp(1_000), 100, 950)).toBe(true);
        expect(grantExpiresWithin(grantWithExp(1_000), 100, 800)).toBe(false);
    });

    it('treats an unreadable grant as not refreshable', () => {
        expect(grantExpiresWithin('not-a-grant', 100, 0)).toBe(false);
        expect(grantExpiresWithin('', 100, 0)).toBe(false);
    });
});

describe('refreshMcpCallerGrantIfExpiring', () => {
    beforeEach(() => {
        process.env.HAPPY_APLUS_MCP_CONFIG_URL = 'https://saycode.test/api/me/mcp-config';
        process.env.HAPPY_APLUS_MCP_CALLER_GRANT = grantWithExp(100_000);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.HAPPY_APLUS_MCP_CONFIG_URL;
        delete process.env.HAPPY_APLUS_MCP_CALLER_GRANT;
        resetPermanentRefreshFailuresForTest();
    });

    it('exchanges an expiring grant and updates the child env', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(
            JSON.stringify({ grant: 'fresh-grant', expiresAt: 999_999 }),
            { status: 200 },
        ));
        vi.stubGlobal('fetch', fetchMock);

        const refreshed = await refreshMcpCallerGrantIfExpiring('happy-token', 'machine-1', {
            projectId: 'P-1',
            now: 99_000,
        });

        expect(refreshed).toBe(true);
        expect(process.env.HAPPY_APLUS_MCP_CALLER_GRANT).toBe('fresh-grant');
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('https://saycode.test/api/me/mcp-caller-grant/refresh');
        expect(init?.headers).toMatchObject({
            'X-Aplus-Machine-Id': 'machine-1',
            'X-Aplus-Project-Id': 'P-1',
        });
    });

    it('binds machine renewal to the current project and registered session', async () => {
        const current = process.env.HAPPY_APLUS_MCP_CALLER_GRANT;
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(
            JSON.stringify({ grant: 'fresh-grant' }), { status: 200 },
        ));
        vi.stubGlobal('fetch', fetchMock);
        expect(await refreshMcpCallerGrantIfExpiring('machine-token', 'machine-1', {
            projectId: 'P-1', sessionId: 'session-1', now: 99_000,
        })).toBe(true);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('https://saycode.test/api/projects/P-1/lesson-host/refresh');
        expect(JSON.parse(String(init?.body))).toEqual({
            machineId: 'machine-1', sessionId: 'session-1', callerGrant: current,
        });
        expect(init?.redirect).toBe('error');
    });

    it('takes the project scope from the config URL when the caller does not pass one', async () => {
        process.env.HAPPY_APLUS_MCP_CONFIG_URL = 'https://saycode.test/api/me/mcp-config?project_id=P-9';
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(
            JSON.stringify({ grant: 'fresh-grant', expiresAt: 1 }), { status: 200 },
        ));
        vi.stubGlobal('fetch', fetchMock);

        await refreshMcpCallerGrantIfExpiring('happy-token', 'machine-1', { now: 99_000 });

        // grant 는 발급 시점 scope 에 묶여 있다. 호출부가 추측하지 않고 실제
        // 설정 URL 의 scope 를 그대로 쓴다.
        expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ 'X-Aplus-Project-Id': 'P-9' });
    });

    it('does nothing while the grant still has plenty of life', async () => {
        // 임계값(2시간)보다 훨씬 멀리 있는 만료.
        process.env.HAPPY_APLUS_MCP_CALLER_GRANT = grantWithExp(24 * 60 * 60 * 1000);
        const fetchMock = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch', fetchMock);

        await expect(refreshMcpCallerGrantIfExpiring('happy-token', 'machine-1', { now: 0 }))
            .resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps the existing grant when the exchange is refused', async () => {
        const current = process.env.HAPPY_APLUS_MCP_CALLER_GRANT;
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('no', { status: 403 })));

        await expect(refreshMcpCallerGrantIfExpiring('happy-token', 'machine-1', { now: 99_000 }))
            .resolves.toBe(false);
        expect(process.env.HAPPY_APLUS_MCP_CALLER_GRANT).toBe(current);
    });

    it('keeps the existing grant when the exchange throws', async () => {
        const current = process.env.HAPPY_APLUS_MCP_CALLER_GRANT;
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('offline'); }));

        await expect(refreshMcpCallerGrantIfExpiring('happy-token', 'machine-1', { now: 99_000 }))
            .resolves.toBe(false);
        expect(process.env.HAPPY_APLUS_MCP_CALLER_GRANT).toBe(current);
    });

    it('does nothing when the session has no caller grant', async () => {
        delete process.env.HAPPY_APLUS_MCP_CALLER_GRANT;
        const fetchMock = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch', fetchMock);

        await expect(refreshMcpCallerGrantIfExpiring('happy-token', 'machine-1', { now: 99_000 }))
            .resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('startMcpCallerGrantRefreshTimer', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('checks often enough to land several attempts inside the renewal window', () => {
        // 턴이 없는 세션은 이 타이머가 유일한 갱신 기회다. 창 안에서 한 번 실패해도
        // 다음 시도가 남아 있어야 한다.
        expect(REFRESH_THRESHOLD_MS / REFRESH_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(4);
    });

    it('renews an idle session without waiting for a turn', async () => {
        vi.useFakeTimers();
        const refresh = vi.fn(async () => false);
        const stop = startMcpCallerGrantRefreshTimer(refresh);

        await vi.advanceTimersByTimeAsync(REFRESH_CHECK_INTERVAL_MS * 3);
        expect(refresh).toHaveBeenCalledTimes(3);

        stop();
        await vi.advanceTimersByTimeAsync(REFRESH_CHECK_INTERVAL_MS * 3);
        expect(refresh).toHaveBeenCalledTimes(3);
    });

    it('keeps ticking after a failed attempt and never overlaps a slow one', async () => {
        vi.useFakeTimers();
        let release!: () => void;
        const refresh = vi.fn()
            .mockImplementationOnce(async () => { throw new Error('offline'); })
            .mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }))
            .mockImplementation(async () => false);
        const stop = startMcpCallerGrantRefreshTimer(refresh);

        await vi.advanceTimersByTimeAsync(REFRESH_CHECK_INTERVAL_MS * 3);
        // 1회차 실패 뒤에도 2회차가 돌고, 2회차가 끝나지 않은 동안 3회차는 건너뛴다.
        expect(refresh).toHaveBeenCalledTimes(2);

        release();
        await vi.advanceTimersByTimeAsync(REFRESH_CHECK_INTERVAL_MS);
        expect(refresh).toHaveBeenCalledTimes(3);
        stop();
    });
});

describe('caller grant renewal across the timer and turn boundaries (D4 C2)', () => {
    const EXP = 10 * 24 * 60 * 60 * 1000;

    beforeEach(() => {
        vi.useFakeTimers();
        // 만료 1시간 전: 2시간 갱신 창 안.
        vi.setSystemTime(EXP - 60 * 60 * 1000);
        process.env.HAPPY_APLUS_MCP_CONFIG_URL = 'https://saycode.test/api/me/mcp-config';
        process.env.HAPPY_APLUS_MCP_CALLER_GRANT = grantWithExp(EXP);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        delete process.env.HAPPY_APLUS_MCP_CONFIG_URL;
        delete process.env.HAPPY_APLUS_MCP_CALLER_GRANT;
        resetPermanentRefreshFailuresForTest();
    });

    const refresh = () => refreshMcpCallerGrantIfExpiring('happy-token', 'machine-1');

    it('renews from the timer inside the window and sends one POST when a turn boundary overlaps it', async () => {
        const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => {
            setTimeout(() => resolve(new Response(JSON.stringify({ grant: grantWithExp(EXP + 86_400_000) }), { status: 200 })), 1_000);
        }));
        vi.stubGlobal('fetch', fetchMock);
        const stop = startMcpCallerGrantRefreshTimer(refresh);

        await vi.advanceTimersByTimeAsync(REFRESH_CHECK_INTERVAL_MS);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // 타이머의 교환이 아직 돌아오지 않은 사이에 턴이 시작된다.
        const turnBoundary = refresh();
        await vi.advanceTimersByTimeAsync(1_000);

        await expect(turnBoundary).resolves.toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(process.env.HAPPY_APLUS_MCP_CALLER_GRANT).toBe(grantWithExp(EXP + 86_400_000));
        stop();
    });

    it('treats the 7-day chain limit as permanent: one notice, then no more POSTs for that grant', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(
            JSON.stringify({ error: 'Caller grant is not renewable' }), { status: 403 },
        ));
        vi.stubGlobal('fetch', fetchMock);
        const notice = vi.fn();
        const unsubscribe = onMcpCallerGrantExpired(notice);
        const stop = startMcpCallerGrantRefreshTimer(refresh);

        await vi.advanceTimersByTimeAsync(REFRESH_CHECK_INTERVAL_MS);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(notice).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(REFRESH_CHECK_INTERVAL_MS * 3);
        await refresh();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(notice).toHaveBeenCalledTimes(1);
        stop();
        unsubscribe();
    });

    it('reads the lesson-host refusal code as permanent too', async () => {
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
            JSON.stringify({ error: 'caller_grant_not_renewable' }), { status: 403 },
        )));
        const notice = vi.fn();
        const unsubscribe = onMcpCallerGrantExpired(notice);
        await refresh();
        expect(notice).toHaveBeenCalledTimes(1);
        unsubscribe();
    });

    it('keeps retrying without a notice when the refusal is not about the grant itself', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(
            JSON.stringify({ error: 'lesson_host_session_denied' }), { status: 403 },
        ));
        vi.stubGlobal('fetch', fetchMock);
        const notice = vi.fn();
        const unsubscribe = onMcpCallerGrantExpired(notice);
        await refresh();
        await refresh();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(notice).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('keeps the grant and retries on a server or network failure', async () => {
        const fetchMock = vi.fn<typeof fetch>()
            .mockImplementationOnce(async () => new Response('down', { status: 503 }))
            .mockImplementationOnce(async () => { throw new TypeError('fetch failed'); })
            .mockImplementation(async () => new Response(JSON.stringify({ grant: 'fresh-grant' }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const current = process.env.HAPPY_APLUS_MCP_CALLER_GRANT;
        await expect(refresh()).resolves.toBe(false);
        await expect(refresh()).resolves.toBe(false);
        expect(process.env.HAPPY_APLUS_MCP_CALLER_GRANT).toBe(current);
        await expect(refresh()).resolves.toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('names the notice the Desktop translates', () => {
        expect(CALLER_GRANT_EXPIRED_NOTICE).toBe('Connector access for this conversation has expired. Start the conversation again to restore it.');
    });
});
