/**
 * 브라우저 sync 자격이 **자기보다 오래 사는 것으로 바뀌지 못하게** 한다.
 *
 * 이 자격의 안전성은 전부 "짧은 수명 + web-ui 가 재발급을 거부하면 끝" 에
 * 걸려 있다(specs/web-ui-auth-session-tokens). 그런데 자격을 계정 bearer 와
 * 같은 자리에서 받으면, **자격을 발급하는 라우트**와 **계정 bearer 를 내주는
 * 승인 라우트**에도 그대로 닿는다. 그 둘에 닿는 순간
 *
 *   - 브라우저가 스스로 무한히 재발급할 수 있어 로그아웃이 아무것도 못 끊고,
 *   - 15분짜리 자격이 폐기 불가능한 계정 bearer 로 바뀐다.
 *
 * 그래서 요청을 만든 자격의 **종류**를 기록하고, 그 두 종류의 라우트는
 * 계정 bearer 만 받는다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyToken = vi.fn();
const browserSyncIssuer: { verify: ReturnType<typeof vi.fn> } = { verify: vi.fn() };
const resolvePrincipal = vi.fn();

vi.mock('@/app/auth/auth', () => ({
    auth: {
        get browserSyncIssuer() { return browserSyncIssuer; },
        verifyToken: (token: string) => verifyToken(token),
        resolvePrincipal: (token: string, options: unknown) => resolvePrincipal(token, options),
    },
}));

vi.mock('@/app/managed/managedSessionAccess', () => ({
    authorizeManagedSessionRequest: vi.fn(async () => ({ ok: true, grant: {} })),
}));

import {
    enableAuthentication,
    enableSessionScopeAuthentication,
    requireAccountPrincipal,
} from '@/app/api/utils/enableAuthentication';

const ACCOUNT = 'acc-1';

async function appWithRoutes() {
    const app = fastify();
    enableAuthentication(app as never);
    enableSessionScopeAuthentication(app as never, () => null);
    const typed = app as never as {
        authenticate: never;
        authenticateSessionScope: never;
    };
    app.get('/open', { preHandler: typed.authenticate }, async (request) => ({
        userId: (request as { userId?: string }).userId,
        kind: (request as { principal?: { kind: string } }).principal?.kind,
    }));
    app.get('/account-only', {
        preHandler: [typed.authenticate, requireAccountPrincipal as never],
    }, async () => ({ ok: true }));
    app.get('/session-scope', { preHandler: typed.authenticateSessionScope }, async (request) => ({
        userId: (request as { userId?: string }).userId,
        kind: (request as { principal?: { kind: string } }).principal?.kind,
    }));
    await app.ready();
    return app;
}

function asAccount() {
    verifyToken.mockResolvedValue({ userId: ACCOUNT });
    resolvePrincipal.mockResolvedValue({ kind: 'account', accountId: ACCOUNT });
}

function asBrowserSync() {
    verifyToken.mockResolvedValue(null);
    resolvePrincipal.mockResolvedValue(null);
    browserSyncIssuer.verify.mockResolvedValue({ ok: true, claims: { accountId: ACCOUNT } });
}

describe('principal kind on the REST decorators', () => {
    beforeEach(() => {
        verifyToken.mockReset();
        resolvePrincipal.mockReset();
        browserSyncIssuer.verify.mockReset();
    });

    it('names the account bearer as such', async () => {
        asAccount()
        const app = await appWithRoutes();

        const res = await app.inject({ url: '/open', headers: { authorization: 'Bearer account' } });

        expect(res.json()).toEqual({ userId: ACCOUNT, kind: 'account' });
        await app.close();
    });

    it('names the browser sync credential as its own kind, not as an account bearer', async () => {
        // 같은 계정을 가리키지만 같은 자격이 아니다. 이 구분이 없으면 아래 두
        // 라우트가 그것을 계정 bearer 로 읽는다.
        asBrowserSync();
        const app = await appWithRoutes();

        const res = await app.inject({ url: '/open', headers: { authorization: 'Bearer bsync' } });

        expect(res.json()).toEqual({ userId: ACCOUNT, kind: 'browser-sync' });
        await app.close();
    });

    it('lets the account bearer through an account-only route', async () => {
        asAccount();
        const app = await appWithRoutes();

        const res = await app.inject({ url: '/account-only', headers: { authorization: 'Bearer account' } });

        expect(res.statusCode).toBe(200);
        await app.close();
    });

    it('refuses the browser sync credential on an account-only route', async () => {
        asBrowserSync();
        const app = await appWithRoutes();

        const res = await app.inject({ url: '/account-only', headers: { authorization: 'Bearer bsync' } });

        expect(res.statusCode).toBe(403);
        await app.close();
    });

    it('accepts the browser sync credential on session-scoped routes', async () => {
        // `/v3/sessions/:id/messages` 와 `/v2/sessions/lookup` 이 여기 있다.
        // 이게 없으면 브라우저의 메시지 조회·전송이 그대로 401 이다.
        asBrowserSync();
        const app = await appWithRoutes();

        const res = await app.inject({ url: '/session-scope', headers: { authorization: 'Bearer bsync' } });

        expect(res.json()).toEqual({ userId: ACCOUNT, kind: 'browser-sync' });
        await app.close();
    });
});

describe('account-only routes', () => {
    const authRoutes = readFileSync(
        join(process.cwd(), 'sources/app/api/routes/authRoutes.ts'), 'utf8',
    );

    function preHandlerOf(route: string): string {
        const at = authRoutes.indexOf(`app.post('${route}'`);
        expect(at).toBeGreaterThanOrEqual(0);
        const preHandler = authRoutes.indexOf('preHandler:', at);
        expect(preHandler).toBeGreaterThan(at);
        return authRoutes.slice(preHandler, authRoutes.indexOf('\n', preHandler));
    }

    it.each([
        // 자기 자신을 무한히 재발급하는 경로. 이게 열려 있으면 로그아웃이
        // 아무것도 끊지 못한다 — 이 spec 의 수용 기준이 무너진다.
        ['/v1/auth/browser-sync'],
        // 승인하면 요청자가 계정 bearer 를 받아 간다. 15분짜리 자격이 폐기
        // 불가능한 자격으로 바뀌는 자리다.
        ['/v1/auth/response'],
        ['/v1/auth/account/response'],
    ])('refuses anything but an account bearer: %s', (route) => {
        expect(preHandlerOf(route)).toContain('requireAccountPrincipal');
    });
});
