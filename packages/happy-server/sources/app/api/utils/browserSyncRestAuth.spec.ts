/**
 * 브라우저가 REST 에도 sync 자격을 실어 보낸다.
 *
 * 소켓만 이 자격을 알아보면 세션·메시지 조회와 터미널 승인이 전부 401 이
 * 된다 — 브라우저는 계정 bearer 를 더 이상 갖고 있지 않기 때문이다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createBrowserSyncTokenIssuer } from '@/app/auth/browserSyncToken';
import { resolveBrowserSyncRestPrincipal } from '@/app/api/utils/browserSyncRestAuth';

const NOW = 1_800_000_000_000;
const SEED = 'seed-not-a-production-key';

async function mint(expiresAt = NOW + 10 * 60 * 1000) {
    const issuer = await createBrowserSyncTokenIssuer({ seed: SEED });
    const minted = await issuer.mint({ v: 1, accountId: 'acc-1', expiresAt }, NOW);
    if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
    return { issuer, token: minted.token };
}

describe('browser sync REST principal', () => {
    it('resolves the account the credential names', async () => {
        const { issuer, token } = await mint();

        expect(await resolveBrowserSyncRestPrincipal({ token, issuer, now: NOW + 1_000 }))
            .toEqual({ userId: 'acc-1' });
    });

    it('refuses an expired credential', async () => {
        // 만료를 보지 않으면 로그아웃한 브라우저가 REST 를 계속 쓴다 —
        // 잔여 노출을 자격 수명으로 묶는다는 전제가 무너진다.
        const { issuer, token } = await mint(NOW + 1_000);

        expect(await resolveBrowserSyncRestPrincipal({ token, issuer, now: NOW + 1_001 }))
            .toBeNull();
    });

    it('declines anything that is not one of these credentials', async () => {
        // 계정 bearer 는 여기서 걸리면 안 된다 — 기존 검증기가 처리한다.
        const { issuer } = await mint();

        expect(await resolveBrowserSyncRestPrincipal({
            token: 'some-account-bearer', issuer, now: NOW,
        })).toBeNull();
    });

    it('declines when the deployment has no issuer configured', async () => {
        const { token } = await mint();

        expect(await resolveBrowserSyncRestPrincipal({ token, issuer: null, now: NOW }))
            .toBeNull();
    });
});

describe('REST decorator wiring', () => {
    it('offers a rejected bearer to the browser sync resolver', () => {
        // 위 단위 테스트는 헬퍼만 본다. 데코레이터가 이 헬퍼를 부르지 않으면
        // 그 테스트들은 통과하는데 브라우저는 여전히 401 을 받는다.
        const decorator = readFileSync(
            join(import.meta.dirname, 'enableAuthentication.ts'), 'utf8',
        );

        expect(decorator).toContain('resolveBrowserSyncRestPrincipal(');
        // 계정 검증기가 먼저 돌아야 기존 호출자의 동작이 그대로다.
        expect(decorator.indexOf('auth.verifyToken(token)'))
            .toBeLessThan(decorator.indexOf('resolveBrowserSyncRestPrincipal('));
    });
});
