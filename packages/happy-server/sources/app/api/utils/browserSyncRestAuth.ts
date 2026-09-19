/**
 * REST 에서 브라우저의 sync 자격을 principal 로 푸는 자리.
 *
 * 브라우저는 더 이상 계정 bearer 를 갖고 있지 않다(`browserSyncToken.ts`).
 * 소켓만 이 자격을 알아보면 세션·메시지 조회와 터미널 승인이 전부 401 이
 * 되므로, `authenticate` 도 같은 자격을 받아야 한다.
 *
 * **이 자격은 계정 권한을 좁히지 않는다** — 브라우저가 원래 갖고 있던 것과
 * 같은 범위를 짧은 수명으로 바꿔 놓은 것이다. 그래서 managed 세션 토큰처럼
 * 라우트별 opt-in 으로 두지 않고 계정 bearer 와 같은 자리에서 받는다.
 * 좁히는 자격이었다면 그렇게 하면 안 된다.
 *
 * 서명만으로는 폐기를 표현할 수 없다. 여기서 보는 것은 **만료**이고, 그것이
 * 로그아웃한 브라우저의 잔여 접근을 자격 수명으로 묶는 장치다.
 */
import type { BrowserSyncTokenIssuer } from '@/app/auth/browserSyncToken';

export async function resolveBrowserSyncRestPrincipal(input: {
    token: string;
    issuer: BrowserSyncTokenIssuer | null;
    now: number;
}): Promise<{ userId: string } | null> {
    if (!input.token || !input.issuer) return null;
    const verified = await input.issuer.verify(input.token, input.now);
    if (!verified.ok) return null;
    return { userId: verified.claims.accountId };
}
