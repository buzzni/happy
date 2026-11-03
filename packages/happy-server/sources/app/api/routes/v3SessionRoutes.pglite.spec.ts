import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify } from '../types';

const state = vi.hoisted(() => ({ client: null as unknown, emitted: [] as unknown[] }));
vi.mock('@/storage/db', () => ({
    get db() { return state.client; },
}));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitUpdate: (update: unknown) => { state.emitted.push(update); } },
    buildNewMessageUpdate: (message: unknown, sessionId: string, seq: number) => ({ seq, body: { sid: sessionId, message } }),
}));

import { manageReservationConversationLease } from '@/app/automation/reservationConversationLease';
import { createHash } from 'node:crypto';
import { v3SessionRoutes } from './v3SessionRoutes';

let sql: string;
let pg: PGlite;
let client: PrismaClient;

beforeAll(async () => {
    const require = createRequire(resolve('package.json'));
    sql = (await promisify(execFile)(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
        { env: { ...process.env, DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused' }, maxBuffer: 1024 * 1024 })).stdout;
});
beforeEach(async () => {
    pg = new PGlite(); await pg.exec(sql);
    client = new PrismaClient({ adapter: new PrismaPGlite(pg) });
    state.client = client;
    state.emitted = [];
    await client.account.create({ data: { id: 'account-1', publicKey: 'account-1' } });
    await client.session.create({ data: { id: 'session-1', tag: 'tag', accountId: 'account-1', metadata: '', seq: 1 } });
    await client.sessionMessage.create({ data: { sessionId: 'session-1', seq: 1, localId: 'existing', content: { t: 'encrypted', c: 'old' } } });
});
afterEach(async () => { await client?.$disconnect(); await pg?.close(); });

async function send(messages: Array<{ localId: string; content: string }>, authorization?: string) {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    const authenticate = async (request: any) => { request.userId = 'account-1'; };
    typed.decorate('authenticate', authenticate);
    typed.decorate('authenticateSessionScope', authenticate);
    v3SessionRoutes(typed);
    await typed.ready();
    const response = await typed.inject({ method: 'POST', url: '/v3/sessions/session-1/messages', payload: { messages }, headers: authorization ? { 'x-happy-reservation-authorization': authorization } : {} });
    await typed.close();
    return response;
}

describe('message batch writes against the stored rows', () => {
    it('inserts only new localIds in one batch and a retry of the same batch adds nothing', async () => {
        const batch = [
            { localId: 'existing', content: 'ignored' },
            { localId: 'new-1', content: 'enc-1' },
            { localId: 'new-2', content: 'enc-2' },
        ];

        const first = await send(batch);
        expect(first.statusCode).toBe(200);
        const firstBody = first.json() as { messages: Array<{ id: string; seq: number; localId: string; createdAt: number; updatedAt: number }> };
        expect(firstBody.messages.map((message) => [message.localId, message.seq])).toEqual([['existing', 1], ['new-1', 2], ['new-2', 3]]);
        expect(firstBody.messages.every((message) => message.id && message.createdAt > 0 && message.updatedAt > 0)).toBe(true);

        const rows = await client.sessionMessage.findMany({ where: { sessionId: 'session-1' }, orderBy: { seq: 'asc' } });
        expect(rows.map((row) => [row.localId, row.seq, row.content])).toEqual([
            ['existing', 1, { t: 'encrypted', c: 'old' }],
            ['new-1', 2, { t: 'encrypted', c: 'enc-1' }],
            ['new-2', 3, { t: 'encrypted', c: 'enc-2' }],
        ]);
        expect((await client.session.findUniqueOrThrow({ where: { id: 'session-1' } })).seq).toBe(3);
        expect(state.emitted).toHaveLength(2);

        const retry = await send(batch);
        expect(retry.statusCode).toBe(200);
        expect((retry.json() as typeof firstBody).messages).toEqual(firstBody.messages);
        expect(await client.sessionMessage.count({ where: { sessionId: 'session-1' } })).toBe(3);
        expect(state.emitted).toHaveLength(2);
    });
});

it('holds manual messages without consuming seqs while a reservation owns the conversation, but replays old ACKs', async () => {
    const now = new Date();
    await client.project.create({ data: { id: 'p', accountId: 'account-1', name: 'P', config: { machineId: 'm' }, automationViewerKeyVersion: 1 } });
    await client.machine.create({ data: { id: 'm', accountId: 'account-1', metadata: '', automationKeyVersion: 1 } });
    await client.automation.create({ data: { id: 'a', projectId: 'p', ownerAccountId: 'account-1', machineAccountId: 'account-1', machineId: 'm', payloadVersion: 5, payloadCiphertext: new Uint8Array([1]), viewerKeyId: 'k', viewerKeyVersion: 1, viewerKeyEnvelope: new Uint8Array([1]), machineKeyVersion: 1, machineKeyEnvelope: new Uint8Array([1]) } });
    await client.automationRun.create({ data: { id: 'r', automationId: 'a', generation: 1, scheduledFor: now, machineAccountId: 'account-1', machineId: 'm', status: 'RUNNING', claimTokenHash: new Uint8Array(createHash('sha256').update('claim').digest()), claimExpiresAt: new Date(now.getTime() + 600000), runLeaseExpiresAt: new Date(now.getTime() + 600000) } });
    const base = { wireVersion: 1 as const, runId: 'r', claimToken: 'claim', sessionId: 'session-1' }, descriptorHash = 'a'.repeat(64);
    const admitted = await client.$transaction(tx => manageReservationConversationLease(tx, 'account-1', 'm', { ...base, operation: 'acquire', expectedSeq: 1, descriptorHash }, now));
    if (!admitted.ok) throw new Error('admission failed');
    const blocked = await send([{ localId: 'manual-new', content: 'manual' }]);
    expect(blocked.statusCode).toBe(409); expect(blocked.json()).toMatchObject({ error: 'reservation-busy' });
    expect((await client.session.findUniqueOrThrow({ where: { id: 'session-1' } })).seq).toBe(1);
    expect(state.emitted).toHaveLength(0);
    expect((await send([{ localId: 'existing', content: 'retry' }])).statusCode).toBe(200);
    await client.$transaction(tx => manageReservationConversationLease(tx, 'account-1', 'm', { ...base, operation: 'activate', runtime: { launchId: 'launch', processGroupId: 1, processStartId: 'start' }, epoch: admitted.value.epoch, descriptorHash }, now));
    expect((await send([{ localId: 'runtime-output', content: 'answer' }], admitted.value.messageAuthorization)).statusCode).toBe(200);
    expect(await client.session.count()).toBe(1);
});
