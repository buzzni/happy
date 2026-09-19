import { describe, expect, it, vi } from 'vitest';

import { armBrowserSyncDeadline, authenticateBrowserSyncSocket } from '@/app/api/socket/browserSyncSocketAuth';
import { createBrowserSyncTokenIssuer } from '@/app/auth/browserSyncToken';

const NOW = 1_800_000_000_000;
const SEED = 'seed-not-a-production-key';

async function mint(over: { accountId?: string; expiresAt?: number } = {}) {
    const issuer = await createBrowserSyncTokenIssuer({ seed: SEED });
    const minted = await issuer.mint({
        v: 1,
        accountId: over.accountId ?? 'acc-1',
        expiresAt: over.expiresAt ?? NOW + 10 * 60 * 1000,
    }, NOW);
    if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
    return { issuer, token: minted.token };
}

describe('browser sync socket auth', () => {
    it('authenticates a browser as the account its credential names', async () => {
        const { issuer, token } = await mint();

        expect(await authenticateBrowserSyncSocket({
            handshake: { token, clientType: 'user-scoped' },
            issuer,
            now: NOW + 1_000,
        })).toEqual({ accountId: 'acc-1', expiresAt: NOW + 10 * 60 * 1000 });
    });

    it('declines anything that is not a browser sync credential', async () => {
        // 계정 토큰·데몬 토큰은 여기서 걸리면 안 된다 — 다음 분기가 처리한다.
        const { issuer } = await mint();

        expect(await authenticateBrowserSyncSocket({
            handshake: { token: 'some-account-bearer', clientType: 'user-scoped' },
            issuer,
            now: NOW,
        })).toBeNull();
    });

    it('declines an expired credential', async () => {
        const { issuer, token } = await mint({ expiresAt: NOW + 1_000 });

        expect(await authenticateBrowserSyncSocket({
            handshake: { token, clientType: 'user-scoped' },
            issuer,
            now: NOW + 1_001,
        })).toBeNull();
    });

    it('declines a client type a browser never uses', async () => {
        // machine-scoped / session-scoped 는 CLI 와 agent 의 것이다. 브라우저
        // 자격으로 그 자리에 설 수 있으면 그 자리에 달린 핸들러까지 열린다.
        const { issuer, token } = await mint();

        for (const clientType of ['machine-scoped', 'session-scoped'] as const) {
            expect(await authenticateBrowserSyncSocket({
                handshake: { token, clientType },
                issuer,
                now: NOW + 1_000,
            })).toBeNull();
        }
    });

    it('declines when no credential was presented', async () => {
        const { issuer } = await mint();

        expect(await authenticateBrowserSyncSocket({
            handshake: { token: '', clientType: 'user-scoped' },
            issuer,
            now: NOW,
        })).toBeNull();
    });
});

describe('armBrowserSyncDeadline', () => {
    function fakeSocket(data: Record<string, unknown> = {}) {
        const listeners: Record<string, (() => void)[]> = {};
        return {
            data,
            disconnected: false,
            disconnect(_close?: boolean) { this.disconnected = true; },
            on(event: string, cb: () => void) { (listeners[event] ??= []).push(cb); },
            fire(event: string) { for (const cb of listeners[event] ?? []) cb(); },
        };
    }

    it('ends the connection when the credential expires', () => {
        vi.useFakeTimers();
        const socket = fakeSocket({ browserSyncExpiresAt: 10_000 });

        expect(armBrowserSyncDeadline(socket as never, 4_000)).toBe('armed');
        vi.advanceTimersByTime(5_999);
        expect(socket.disconnected).toBe(false);
        vi.advanceTimersByTime(1);

        expect(socket.disconnected).toBe(true);
        vi.useRealTimers();
    });

    it('ends a connection that is already past its credential', () => {
        // socket.io 의 connection state recovery 는 **미들웨어를 건너뛰고**
        // 복구한다(기본 `skipMiddlewares: true`). 그래서 복구된 소켓은 만료를
        // 지난 자격으로 되살아날 수 있고, 그때 여기가 유일한 검사 지점이다.
        const socket = fakeSocket({ browserSyncExpiresAt: 10_000 });

        expect(armBrowserSyncDeadline(socket as never, 10_000)).toBe('expired');
        expect(socket.disconnected).toBe(true);
    });

    it('leaves an account-bearer connection alone', () => {
        const socket = fakeSocket({});

        expect(armBrowserSyncDeadline(socket as never, 1_000)).toBe('none');
        expect(socket.disconnected).toBe(false);
    });

    it('does not fire after the socket is already gone', () => {
        vi.useFakeTimers();
        const socket = fakeSocket({ browserSyncExpiresAt: 10_000 });
        armBrowserSyncDeadline(socket as never, 0);

        socket.fire('disconnect');
        socket.disconnected = false;
        vi.advanceTimersByTime(20_000);

        expect(socket.disconnected).toBe(false);
        vi.useRealTimers();
    });
})
