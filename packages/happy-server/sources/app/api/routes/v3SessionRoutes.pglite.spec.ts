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

async function send(messages: Array<{ localId: string; content: string }>) {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    const authenticate = async (request: any) => { request.userId = 'account-1'; };
    typed.decorate('authenticate', authenticate);
    typed.decorate('authenticateSessionScope', authenticate);
    v3SessionRoutes(typed);
    await typed.ready();
    const response = await typed.inject({ method: 'POST', url: '/v3/sessions/session-1/messages', payload: { messages } });
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
