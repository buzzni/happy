/**
 * GitHub OAuth 콜백의 state 는 인증 없이 들어오는 외부 입력이다. 검증에 실패한 값을
 * 그대로 로그에 쓰면 누구나 서버 로그에 임의 문자열을 남길 수 있다(CASA 리뷰 지적).
 */
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';

const { logCalls } = vi.hoisted(() => ({ logCalls: [] as unknown[][] }));

vi.mock('@/utils/log', () => ({
    log: (...args: unknown[]) => { logCalls.push(args); },
    warn: () => {},
    error: () => {},
    debug: () => {},
}));
vi.mock('@/storage/db', () => ({ db: {} }));
vi.mock('@/app/auth/auth', () => ({
    auth: { verifyGithubToken: async () => null },
}));

import { connectRoutes } from '@/app/api/routes/connectRoutes';
import type { Fastify } from '@/app/api/types';

async function buildApp() {
    const instance = fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    const typed = instance.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async () => {});
    connectRoutes(typed);
    await instance.ready();
    return typed;
}

describe('GitHub OAuth callback with an invalid state', () => {
    it('rejects the callback without writing the state value to the log', async () => {
        const app = await buildApp();
        const state = 'attacker-controlled-state-9f3c';

        const response = await (app as any).inject({
            method: 'GET',
            url: `/v1/connect/github/callback?code=x&state=${state}`,
        });

        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toContain('error=invalid_state');
        expect(logCalls.length).toBeGreaterThan(0);
        expect(JSON.stringify(logCalls)).not.toContain(state);
        await (app as any).close();
    });
});
