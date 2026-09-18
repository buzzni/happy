/**
 * The credential a browser uses to open its sync socket.
 *
 * A browser used to carry the account bearer itself, which meant the only way
 * to end its access was to invalidate the credential every other client of that
 * account also holds. This token exists so a browser can be cut off on its own:
 * it is short-lived and reissued by the web app's server only while that
 * browser's login session is still live.
 */
import { describe, expect, it } from 'vitest';

import {
    BROWSER_SYNC_MAX_TTL_MS,
    BROWSER_SYNC_TOKEN_SERVICE,
    createBrowserSyncTokenIssuer,
    type BrowserSyncClaims,
} from '@/app/auth/browserSyncToken';
import {
    MANAGED_DAEMON_TOKEN_SERVICE,
    createManagedDaemonTokenIssuer,
} from '@/app/auth/managedDaemonToken';

const NOW = 1_800_000_000_000;
const SEED = 'shared-seed-not-a-production-key';

function claims(over: Partial<BrowserSyncClaims> = {}): BrowserSyncClaims {
    return {
        v: 1,
        accountId: 'acc-1',
        expiresAt: NOW + 10 * 60 * 1000,
        ...over,
    };
}

function issuer() {
    return createBrowserSyncTokenIssuer({ seed: SEED });
}

describe('browser sync token', () => {
    it('names the account the browser acts as', async () => {
        const tokens = await issuer();

        const minted = await tokens.mint(claims(), NOW);
        expect(minted.ok).toBe(true);
        if (!minted.ok) throw new Error('mint failed');

        const verified = await tokens.verify(minted.token, NOW + 1_000);
        expect(verified).toMatchObject({ ok: true, claims: { accountId: 'acc-1' } });
    });

    it('cannot be presented as a managed daemon credential, or the reverse', async () => {
        // 서명에 service 가 묶이므로 같은 seed 라도 서로의 자리에 못 선다.
        expect(BROWSER_SYNC_TOKEN_SERVICE).not.toBe(MANAGED_DAEMON_TOKEN_SERVICE);

        const browserTokens = await issuer();
        const daemonTokens = await createManagedDaemonTokenIssuer({ seed: SEED });

        const minted = await browserTokens.mint(claims(), NOW);
        expect(minted.ok).toBe(true);
        if (!minted.ok) throw new Error('mint failed');

        const asDaemon = await daemonTokens.verify(minted.token, NOW + 1_000);
        expect(asDaemon.ok).toBe(false);

        const daemonMinted = await daemonTokens.mint({
            v: 1,
            accountId: 'acc-1',
            machineId: 'machine-1',
            runtimeId: 'runtime-1',
            provisioningOperationId: 'op-1',
            daemonGrantId: 'grant-1',
            generation: 0,
            workspaceId: 'ws-1',
            projectId: 'proj-1',
            epoch: 0,
            expiresAt: NOW + 60_000,
        }, NOW);
        expect(daemonMinted.ok).toBe(true);
        if (!daemonMinted.ok) throw new Error('daemon mint failed');

        const asBrowser = await browserTokens.verify(daemonMinted.token, NOW + 1_000);
        expect(asBrowser.ok).toBe(false);
    });

    it('refuses a token that has expired', async () => {
        const tokens = await issuer();
        const minted = await tokens.mint(claims({ expiresAt: NOW + 1_000 }), NOW);
        expect(minted.ok).toBe(true);
        if (!minted.ok) throw new Error('mint failed');

        expect(await tokens.verify(minted.token, NOW + 1_001))
            .toMatchObject({ ok: false, reason: 'expired' });
    });

    it('refuses to mint a credential that is already expired', async () => {
        const tokens = await issuer();

        expect(await tokens.mint(claims({ expiresAt: NOW }), NOW))
            .toMatchObject({ ok: false, reason: 'expired' });
    });

    it('refuses to mint one that outlives the ceiling', async () => {
        // 이 자격은 재발급으로 살아남는 것이지 오래 사는 것이 아니다. 폐기부터
        // 소켓이 끊기기까지의 잔여 노출이 곧 이 수명이다.
        const tokens = await issuer();

        expect(await tokens.mint(claims({ expiresAt: NOW + BROWSER_SYNC_MAX_TTL_MS + 1 }), NOW))
            .toMatchObject({ ok: false, reason: 'ttl-too-long' });
    });

    it('refuses claims shaped like another credential', async () => {
        // session/machine 을 이름 붙일 수 있으면 누군가는 그것을 권한으로 읽는다.
        const tokens = await issuer();

        for (const extra of [{ sessionId: 's-1' }, { grantId: 'g-1' }, { machineId: 'm-1' }]) {
            expect(await tokens.mint({ ...claims(), ...extra } as BrowserSyncClaims, NOW))
                .toMatchObject({ ok: false, reason: 'malformed' });
        }
    });

    it('refuses a malformed account id', async () => {
        const tokens = await issuer();

        expect(await tokens.mint(claims({ accountId: '  ' }), NOW))
            .toMatchObject({ ok: false, reason: 'malformed' });
    });

    it('refuses a bearer that was not issued here', async () => {
        const tokens = await issuer();

        expect(await tokens.verify('not-a-token', NOW))
            .toMatchObject({ ok: false, reason: 'bad-signature' });
    });
});
