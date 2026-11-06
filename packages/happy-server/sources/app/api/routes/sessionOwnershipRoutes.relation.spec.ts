import fastify from 'fastify';
import { createServer, type Server } from 'node:http';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const dbMocks = vi.hoisted(() => ({ sessionFindFirst: vi.fn(), sessionFindMany: vi.fn(), machineFindUnique: vi.fn() }));
vi.mock('@/storage/db', () => ({ db: {
    session: { findFirst: dbMocks.sessionFindFirst, findMany: dbMocks.sessionFindMany },
    machine: { findUnique: dbMocks.machineFindUnique },
} }));

import { sessionOwnershipRoutes } from './sessionOwnershipRoutes';

// Stand-in for A+ `POST /api/internal/agent-ownership/eligibility` (aplus-dev-studio #5857).
let studio: Server, studioUrl: string, studioCalls: Array<{ authorization?: string; body: unknown }>;
let studioAnswer: (body: { happyAccountId: string; machineId: string }) => { status: number; body: unknown; delayMs?: number; redirect?: string };
beforeAll(async () => {
    studio = createServer(async (req, res) => {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        studioCalls.push({ authorization: req.headers.authorization, body });
        const answer = studioAnswer(body);
        if (answer.delayMs) await new Promise(resolve => setTimeout(resolve, answer.delayMs));
        if (answer.redirect) { res.writeHead(307, { Location: answer.redirect }); res.end(); return; }
        res.writeHead(answer.status, { 'Content-Type': 'application/json' });
        res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
    await new Promise<void>(resolve => studio.listen(0, '127.0.0.1', resolve));
    studioUrl = 'http://127.0.0.1:' + (studio.address() as { port: number }).port + '/api/internal/agent-ownership/eligibility';
});
afterAll(async () => { vi.unstubAllEnvs(); await new Promise<void>(resolve => studio.close(() => resolve())); });

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

const request = { v: 1, callerSessionId: 'hub', machineId: 'machine-1', sessionIds: ['hub', 'mine', 'theirs', 'missing'] };
const ask = (app: Fastify, body: unknown = request, headers: Record<string, string> = { 'x-user-id': 'account-a' }) =>
    app.inject({ method: 'POST', url: '/v1/session-ownership/relation', headers, payload: body as object });

describe('POST /v1/session-ownership/relation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        studioCalls = [];
        studioAnswer = () => ({ status: 200, body: { eligible: true, reason: 'personal-machine' } });
        vi.stubEnv('SAYCODE_AGENT_OWNERSHIP_RELATION_ENABLED', '1');
        vi.stubEnv('SAYCODE_AGENT_OWNERSHIP_ELIGIBILITY_URL', studioUrl);
        vi.stubEnv('SAYCODE_AGENT_OWNERSHIP_ELIGIBILITY_TOKEN', 'internal-secret');
        dbMocks.sessionFindFirst.mockResolvedValue({ id: 'hub' });
        dbMocks.machineFindUnique.mockResolvedValue({ id: 'machine-1', accountId: 'account-a' });
        dbMocks.sessionFindMany.mockResolvedValue([{ id: 'hub' }, { id: 'mine' }]);
    });

    it('marks only the caller account\'s other sessions own after A+ confirms the personal machine', async () => {
        const app = await createApp();
        const response = await ask(app);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ v: 1, callerAccountId: 'account-a', proof: 'personal-same-account',
            relations: { hub: 'not-own', mine: 'own', theirs: 'not-own', missing: 'not-own' } });
        expect(studioCalls).toEqual([{ authorization: 'Bearer internal-secret', body: { happyAccountId: 'account-a', machineId: 'machine-1' } }]);
        expect(dbMocks.sessionFindFirst).toHaveBeenCalledWith({ where: { id: 'hub', accountId: 'account-a' }, select: { id: true } });
        expect(dbMocks.sessionFindMany).toHaveBeenCalledWith({ where: { id: { in: ['hub', 'mine', 'theirs', 'missing'] }, accountId: 'account-a' }, select: { id: true } });
        await app.close();
    });

    it('asks A+ again on every lookup so a revoked personal machine closes at once', async () => {
        const app = await createApp();
        expect((await ask(app)).json().proof).toBe('personal-same-account');
        studioAnswer = () => ({ status: 200, body: { eligible: false, reason: 'ownership-access-denied' } });
        expect((await ask(app)).json()).toEqual({ v: 1, callerAccountId: 'account-a', proof: null,
            relations: { hub: 'not-own', mine: 'not-own', theirs: 'not-own', missing: 'not-own' } });
        expect(studioCalls).toHaveLength(2);
        await app.close();
    });

    it('holds a negative answer briefly so one account cannot amplify into A+ lookups', async () => {
        const app = await createApp();
        studioAnswer = () => ({ status: 200, body: { eligible: false, reason: 'not-personal-machine' } });
        await ask(app); await ask(app);
        expect(studioCalls).toHaveLength(1);
        await app.close();
    });

    it.each([
        ['the switch is off', () => vi.stubEnv('SAYCODE_AGENT_OWNERSHIP_RELATION_ENABLED', '0')],
        ['no A+ address is configured', () => vi.stubEnv('SAYCODE_AGENT_OWNERSHIP_ELIGIBILITY_URL', '')],
        ['no internal secret is configured', () => vi.stubEnv('SAYCODE_AGENT_OWNERSHIP_ELIGIBILITY_TOKEN', '')],
        ['A+ fails', () => { studioAnswer = () => ({ status: 503, body: { error: 'eligibility-unavailable' } }); }],
        ['A+ answers out of shape', () => { studioAnswer = () => ({ status: 200, body: { eligible: 'yes' } }); }],
        ['A+ answers too much', () => { studioAnswer = () => ({ status: 200, body: JSON.stringify({ eligible: true, reason: 'personal-machine' }) + ' '.repeat(5000) }); }],
        ['A+ redirects', () => { studioAnswer = () => ({ status: 307, body: null, redirect: studioUrl + '?again' }); }],
        ['A+ is slower than two seconds', () => { studioAnswer = () => ({ status: 200, body: { eligible: true, reason: 'personal-machine' }, delayMs: 2500 }); }],
    ])('answers unavailable with no relations when %s', async (_name, arrange) => {
        arrange();
        const app = await createApp();
        const response = await ask(app);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ v: 1, callerAccountId: 'account-a', proof: null, unavailable: true });
        expect(dbMocks.sessionFindMany).not.toHaveBeenCalled();
        await app.close();
    }, 10_000);

    it('does not ask A+ while the switch is off', async () => {
        vi.stubEnv('SAYCODE_AGENT_OWNERSHIP_RELATION_ENABLED', '0');
        const app = await createApp();
        expect((await ask(app)).json()).toMatchObject({ unavailable: true });
        expect(studioCalls).toHaveLength(0);
        await app.close();
    });

    it('refuses a caller session or machine that is not the caller account\'s before asking A+', async () => {
        const app = await createApp();
        dbMocks.sessionFindFirst.mockResolvedValueOnce(null);
        expect((await ask(app)).statusCode).toBe(403);
        dbMocks.machineFindUnique.mockResolvedValueOnce({ id: 'machine-1', accountId: 'account-b' });
        expect((await ask(app)).statusCode).toBe(403);
        dbMocks.machineFindUnique.mockResolvedValueOnce(null);
        expect((await ask(app)).statusCode).toBe(403);
        expect(studioCalls).toHaveLength(0);
        await app.close();
    });

    it('requires an account bearer', async () => {
        const app = await createApp();
        expect((await ask(app, request, {})).statusCode).toBe(401);
        expect((await ask(app, request, { 'x-user-id': 'account-a', 'x-principal': 'managed' })).statusCode).toBe(403);
        expect(dbMocks.sessionFindFirst).not.toHaveBeenCalled();
        await app.close();
    });

    it('rejects a malformed body before reading the database', async () => {
        const app = await createApp();
        for (const body of [{}, { ...request, v: 2 }, { ...request, sessionIds: [] },
            { ...request, sessionIds: Array.from({ length: 101 }, (_, i) => 's' + i) }, { ...request, sessionIds: [''] },
            { ...request, machineId: 'x'.repeat(129) }, { ...request, accountId: 'account-b' }]) {
            expect((await ask(app, body)).statusCode).toBe(400);
        }
        expect(dbMocks.sessionFindFirst).not.toHaveBeenCalled();
        await app.close();
    });

    it('limits lookups per account', async () => {
        const app = await createApp();
        studioAnswer = () => ({ status: 200, body: { eligible: false, reason: 'not-personal-machine' } });
        const codes: number[] = [];
        for (let i = 0; i < 121; i++) codes.push((await ask(app)).statusCode);
        expect(codes.slice(0, 120).every(code => code === 200)).toBe(true);
        expect(codes[120]).toBe(429);
        expect((await ask(app, request, { 'x-user-id': 'account-c' })).statusCode).not.toBe(429);
        await app.close();
    });
});
