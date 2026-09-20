/**
 * The socket handshake for a browser that no longer carries the account bearer.
 *
 * Runs before the account verifier and declines anything it does not recognise,
 * so a credential it cannot read falls through to the existing path unchanged —
 * the CLI, the desktop app and the agent are not in this branch at all.
 *
 * What it does not do is decide how long the connection may live. The
 * credential's expiry is returned so the caller can end an already-open socket
 * at that moment: a check that only runs at connect would let a browser stay
 * connected long after the logout that was meant to disconnect it.
 */
import type { BrowserSyncTokenIssuer } from '@/app/auth/browserSyncToken';

export type BrowserSyncSocketHandshake = {
    token: string;
    clientType: 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
};

export type BrowserSyncSocketIdentity = {
    accountId: string;
    expiresAt: number;
};

export async function authenticateBrowserSyncSocket(input: {
    handshake: BrowserSyncSocketHandshake;
    issuer: BrowserSyncTokenIssuer | null;
    now: number;
}): Promise<BrowserSyncSocketIdentity | null> {
    const { token, clientType } = input.handshake;
    // A browser is a user-scoped client. The other two client types carry
    // machine and session authority whose handlers this credential must not
    // reach, so it is refused there rather than quietly accepted.
    if (clientType !== 'user-scoped' || !token || !input.issuer) return null;

    const verified = await input.issuer.verify(token, input.now);
    if (!verified.ok) return null;

    return { accountId: verified.claims.accountId, expiresAt: verified.claims.expiresAt };
}

/** 만료 시각을 `socket.data` 에 두는 키. 복구된 연결이 이 값을 되살린다. */
export const BROWSER_SYNC_EXPIRES_AT = 'browserSyncExpiresAt';

type DeadlineSocket = {
    data: Record<string, unknown>;
    disconnect: (close?: boolean) => void;
    on: (event: 'disconnect', listener: () => void) => void;
};

/**
 * 연결의 수명을 자격의 만료에 묶는다. **연결 이벤트에서** 호출한다.
 *
 * 인증 미들웨어에서만 걸면 안 된다. socket.io 의 connection state recovery 는
 * 복구된 연결에서 미들웨어를 통째로 건너뛰고(`connectionStateRecovery` 를 주면
 * `skipMiddlewares` 기본값이 `true`), 앞선 disconnect 에서 타이머는 이미
 * 해제된 뒤다. 그러면 복구된 소켓은 **만료가 없는 채로** 살아남는다 — 이
 * 기능이 폐기를 표현하는 유일한 수단이 그 순간 사라진다.
 *
 * `socket.data` 는 복구 시 이전 세션에서 그대로 되살아나므로, 만료 시각을
 * 거기 두고 새 연결과 복구된 연결이 같은 경로를 지나게 한다.
 *
 * 남는 한 가지: socket.io 는 놓친 패킷을 `Socket` 생성자에서 재생하므로,
 * 여기서 끊어도 그 재생분은 이미 나간 뒤다. 그 창은
 * `connectionStateRecovery.maxDisconnectionDuration` 으로 묶여 있다.
 */
export function armBrowserSyncDeadline(
    socket: DeadlineSocket,
    now: number,
): 'none' | 'armed' | 'expired' {
    const expiresAt = socket.data[BROWSER_SYNC_EXPIRES_AT];
    // 계정 bearer 로 붙은 연결에는 이 값이 없다 — 그쪽 수명은 이 기능의 것이 아니다.
    if (typeof expiresAt !== 'number') return 'none';
    if (now >= expiresAt) {
        socket.disconnect(true);
        return 'expired';
    }
    const deadline = setTimeout(() => socket.disconnect(true), expiresAt - now);
    // 이 타이머가 프로세스 종료를 막을 이유가 없다.
    deadline.unref?.();
    socket.on('disconnect', () => clearTimeout(deadline));
    return 'armed';
}
