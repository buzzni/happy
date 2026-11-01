import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const dbMocks = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock('@/storage/db', () => ({ db: { session: { findFirst: dbMocks.findFirst } } }));

import { sessionOwnershipRoutes } from './sessionOwnershipRoutes';

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any, reply: any) => {
        const userId = request.headers['x-user-id'];
        if (typeof userId !== 'string') return reply.code(401).send({ error: 'Unauthorized' });
        request.userId = userId;
        request.principal = { kind: request.headers['x-principal'] ?? 'account', accountId: userId };
    });
    sessionOwnershipRoutes(typed);
    await typed.ready();
    return typed;
}

const ask = (app: Fastify, body: unknown, headers: Record<string, string> = { 'x-user-id': 'account-a' }) =>
    app.inject({ method: 'POST', url: '/v1/session-ownership/same-account', headers, payload: body as object });

describe('POST /v1/session-ownership/same-account', () => {
    beforeEach(() => vi.clearAllMocks());

    it('answers true only for a session owned by the calling account', async () => {
        const app = await createApp();
        dbMocks.findFirst.mockResolvedValue({ id: 'session-1' });

        const response = await ask(app, { sessionId: 'session-1' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ sameAccount: true });
        expect(dbMocks.findFirst).toHaveBeenCalledWith({ where: { id: 'session-1', accountId: 'account-a' }, select: { id: true } });
        await app.close();
    });

    it('answers false alike for another account\'s session and a missing one, so it is no existence oracle', async () => {
        const app = await createApp();
        dbMocks.findFirst.mockResolvedValue(null);

        const response = await ask(app, { sessionId: 'someone-elses-session' });

        expect(response.json()).toEqual({ sameAccount: false });
        expect(Object.keys(response.json())).toEqual(['sameAccount']);
        await app.close();
    });

    it('requires an account bearer', async () => {
        const app = await createApp();
        expect((await ask(app, { sessionId: 'session-1' }, {})).statusCode).toBe(401);
        expect((await ask(app, { sessionId: 'session-1' }, { 'x-user-id': 'account-a', 'x-principal': 'managed' })).statusCode).toBe(403);
        expect(dbMocks.findFirst).not.toHaveBeenCalled();
        await app.close();
    });

    it('rejects a malformed body before reading the database', async () => {
        const app = await createApp();
        for (const body of [{}, { sessionId: '' }, { sessionId: 'x'.repeat(129) }, { sessionId: 'session-1', accountId: 'account-b' }]) {
            expect((await ask(app, body)).statusCode).toBe(400);
        }
        expect(dbMocks.findFirst).not.toHaveBeenCalled();
        await app.close();
    });
});
