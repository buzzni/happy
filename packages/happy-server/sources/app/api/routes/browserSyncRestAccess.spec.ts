/**
 * 브라우저 sync 자격이 REST 에서 어디까지 닿는가.
 *
 * `authenticate` 가 이 자격을 받기 시작하면서, **계정 bearer 를 발급하는
 * 라우트**까지 같이 열렸다. 자격을 다시 발급받거나(`/v1/auth/browser-sync`),
 * 대기 중인 auth 요청을 승인해 수집 엔드포인트가 `auth.createToken(...)` 을
 * 내주게 만들면, 만료로 묶여 있던 자격이 만료 없는 것으로 바뀐다 — 잔여 노출을
 * 자격 수명으로 묶는다는 전제가 그 순간 사라진다.
 *
 * 반대로 세션·메시지 읽기는 브라우저가 원래 하던 일이고, 그쪽이 막혀 있으면
 * 이 기능은 애초에 켤 수 없다. 두 방향을 한 자리에서 고정한다.
 */
import fastify from 'fastify';
import * as privacyKit from 'privacy-kit';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbState, resetDbState } = vi.hoisted(() => {
    const dbState = {
        accountAuthRequests: [] as { id: string; publicKey: string; response: string | null; responseAccountId: string | null }[],
        terminalAuthRequests: [] as { id: string; publicKey: string; response: string | null; responseAccountId: string | null; supportsV2: boolean }[],
    };
    const resetDbState = () => {
        dbState.accountAuthRequests = [];
        dbState.terminalAuthRequests = [];
    };
    return { dbState, resetDbState };
});

vi.mock('@/storage/db', () => {
    const table = (rows: () => { id: string; publicKey: string; response: string | null; responseAccountId: string | null }[]) => ({
        findUnique: async ({ where }: any) => rows().find((r) => r.publicKey === where.publicKey) ?? null,
        upsert: async ({ where, create }: any) => {
            const found = rows().find((r) => r.publicKey === where.publicKey);
            if (found) return found;
            const row = { id: `row-${rows().length + 1}`, response: null, responseAccountId: null, ...create };
            rows().push(row);
            return row;
        },
        update: async ({ where, data }: any) => {
            const found = rows().find((r) => r.id === where.id)!;
            Object.assign(found, data);
            return found;
        },
        findMany: async () => [],
    });
    return {
        db: {
            accountAuthRequest: table(() => dbState.accountAuthRequests),
            terminalAuthRequest: table(() => dbState.terminalAuthRequests as any),
        },
    };
});

import { auth } from '@/app/auth/auth';
import {
    enableAuthentication,
    enableSessionScopeAuthentication,
    requireAccountPrincipal,
    requireSessionScopeAuth,
} from '@/app/api/utils/enableAuthentication';
import { authRoutes } from '@/app/api/routes/authRoutes';
import type { Fastify } from '@/app/api/types';

const ACCOUNT = 'acc-victim';
/** tweetnacl box public key length: 32 bytes. */
const ATTACKER_PUBLIC_KEY = privacyKit.encodeBase64(new Uint8Array(32).fill(7));

async function buildApp() {
    const instance = fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    const typed = instance.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    enableAuthentication(typed);
    // 이 배포에는 managed 세션 발급자가 없다. 그래도 세션 스코프 데코레이터는
    // 켜 둔다 — 브라우저 자격이 그쪽에서도 풀려야 한다는 게 검증 대상이다.
    enableSessionScopeAuthentication(typed, () => null);
    authRoutes(typed);
    typed.get('/spec/session-scope', {
        preHandler: requireSessionScopeAuth(typed) as never,
    }, async (request: any) => ({ userId: request.userId }));
    // 가드만 달고 `authenticate` 를 빠뜨린 라우트. 통과시키면 가드의 실패
    // 모드가 "그냥 들여보내기" 가 된다.
    typed.get('/spec/guard-without-authenticate', {
        preHandler: requireAccountPrincipal as never,
    }, async () => ({ ok: true }));
    await instance.ready();
    return typed;
}

let app: Fastify;
let accountBearer: string;

async function mintBrowserSyncCredential() {
    const minted = await auth.createBrowserSyncToken(ACCOUNT, Date.now());
    if (!minted) throw new Error('browser sync mint refused');
    return minted.token;
}

beforeAll(async () => {
    process.env.HANDY_MASTER_SECRET ??= 'browser-sync-rest-access-spec-seed';
    await auth.init();
    accountBearer = await auth.createToken(ACCOUNT);
    app = await buildApp();
});

beforeEach(() => {
    resetDbState();
});

describe('browser sync credential on account-bearer-issuing routes', () => {
    it('cannot mint its own successor', async () => {
        // 자기 자신을 재발급할 수 있으면 재발급이 더 이상 웹앱의 로그인
        // 세션에 달려 있지 않다. 로그아웃해도 자격이 스스로 연장된다.
        const credential = await mintBrowserSyncCredential();

        const response = await (app as any).inject({
            method: 'POST',
            url: '/v1/auth/browser-sync',
            headers: { authorization: `Bearer ${credential}` },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ reason: 'account-bearer-required' });
    });

    it('still mints for the account bearer the web app server holds', async () => {
        const response = await (app as any).inject({
            method: 'POST',
            url: '/v1/auth/browser-sync',
            headers: { authorization: `Bearer ${accountBearer}` },
        });

        expect(response.statusCode).toBe(200);
        expect(typeof response.json().token).toBe('string');
    });

    it('cannot approve an account auth request into a permanent bearer', async () => {
        // 승인되면 `/v1/auth/account/request` 가 만료 없는 계정 bearer 를
        // 내준다. 15분짜리 자격이 그것을 살 수 있으면 만료는 아무것도 묶지
        // 못한다.
        const credential = await mintBrowserSyncCredential();
        // 공격자가 고른 공개키로 요청을 걸어 둔다. 승인만 붙으면 수집
        // 엔드포인트가 계정 bearer 를 내준다.
        await (app as any).inject({
            method: 'POST',
            url: '/v1/auth/account/request',
            payload: { publicKey: ATTACKER_PUBLIC_KEY },
        });

        const approve = await (app as any).inject({
            method: 'POST',
            url: '/v1/auth/account/response',
            headers: { authorization: `Bearer ${credential}` },
            payload: { response: 'sealed-answer', publicKey: ATTACKER_PUBLIC_KEY },
        });
        expect(approve.statusCode).toBe(403);

        const collect = await (app as any).inject({
            method: 'POST',
            url: '/v1/auth/account/request',
            payload: { publicKey: ATTACKER_PUBLIC_KEY },
        });
        expect(collect.json()).toEqual({ state: 'requested' });
    });

    it('cannot approve a terminal auth request', async () => {
        // `/v1/auth/request` 도 승인된 뒤에는 계정 bearer 를 내준다.
        const credential = await mintBrowserSyncCredential();
        await (app as any).inject({
            method: 'POST',
            url: '/v1/auth/request',
            payload: { publicKey: ATTACKER_PUBLIC_KEY },
        });

        const approve = await (app as any).inject({
            method: 'POST',
            url: '/v1/auth/response',
            headers: { authorization: `Bearer ${credential}` },
            payload: { response: 'sealed-answer', publicKey: ATTACKER_PUBLIC_KEY },
        });
        expect(approve.statusCode).toBe(403);

        const collect = await (app as any).inject({
            method: 'POST',
            url: '/v1/auth/request',
            payload: { publicKey: ATTACKER_PUBLIC_KEY },
        });
        expect(collect.json()).toEqual({ state: 'requested' });
    });

    it('refuses when no decorator resolved a principal at all', async () => {
        const response = await (app as any).inject({
            method: 'GET',
            url: '/spec/guard-without-authenticate',
            headers: { authorization: `Bearer ${accountBearer}` },
        });

        expect(response.statusCode).toBe(403);
    });

    it('still lets the account bearer approve an account auth request', async () => {
        await (app as any).inject({
            method: 'POST',
            url: '/v1/auth/account/request',
            payload: { publicKey: ATTACKER_PUBLIC_KEY },
        });

        const approve = await (app as any).inject({
            method: 'POST',
            url: '/v1/auth/account/response',
            headers: { authorization: `Bearer ${accountBearer}` },
            payload: { response: 'sealed-answer', publicKey: ATTACKER_PUBLIC_KEY },
        });

        expect(approve.statusCode).toBe(200);
    });
});

describe('browser sync credential on session-scope routes', () => {
    it('resolves to the account it names', async () => {
        // `/v2/sessions/lookup`, `/v3` 메시지·이벤트 읽기, 첨부 라우트가 전부
        // 이 데코레이터 뒤에 있다. 여기서 401 이면 브라우저는 여전히 못 쓴다.
        const credential = await mintBrowserSyncCredential();

        const response = await (app as any).inject({
            method: 'GET',
            url: '/spec/session-scope',
            headers: { authorization: `Bearer ${credential}` },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ userId: ACCOUNT });
    });

    it('still refuses a bearer nothing issued', async () => {
        const response = await (app as any).inject({
            method: 'GET',
            url: '/spec/session-scope',
            headers: { authorization: 'Bearer not-a-credential' },
        });

        expect(response.statusCode).toBe(401);
    });
});
