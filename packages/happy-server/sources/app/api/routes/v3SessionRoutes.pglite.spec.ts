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
afterEach(async () => { delete process.env.HAPPY_OBSERVATION_COHORT;  await client?.$disconnect(); await pg?.close(); });

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

async function observe(query = 'observation_version=1&after_seq=0&limit=1', accountId = 'account-1') {
    const app = fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    const authenticate = async (request: any) => { request.userId = accountId; };
    typed.decorate('authenticate', authenticate); typed.decorate('authenticateSessionScope', authenticate);
    v3SessionRoutes(typed); await typed.ready();
    try { return await typed.inject({ method: 'GET', url: '/v3/sessions/session-1/messages?' + query }); }
    finally { await typed.close(); }
}
it('refuses observation until all writers are explicitly opted into a cohort', async () => {
    const response = await observe(); expect(response.statusCode).toBe(503);
})
it('fixes a committed upper bound, includes revisions, and fences encryption generations', async () => {
    process.env.HAPPY_OBSERVATION_COHORT = 'test-cohort';
    const response = await observe(); expect(response.statusCode).toBe(200);
    const first = response.json();
    expect(first.observation).toMatchObject({ version: 1, coveredThroughSeq: 1, retention: 'full' });
    expect(first.messages[0].contentRevision).toMatch(/^[a-f0-9]{64}$/);
    await send([{ localId: 'new', content: 'new' }]);
    const fixed = (await observe('observation_version=1&after_seq=1&through_seq=1')).json();
    expect(fixed.messages).toEqual([]); expect(fixed.hasMore).toBe(false);
    expect(fixed.observation.coveredThroughSeq).toBe(1);
    await client.session.update({ where: { id: 'session-1' }, data: { dataEncryptionKey: new Uint8Array([1, 2, 3]) } });
    expect((await observe()).json().observation.generation).not.toBe(first.observation.generation);
})
it('does not expose coverage of another account and preserves the legacy response', async () => {
    process.env.HAPPY_OBSERVATION_COHORT = 'test-cohort';
    expect((await observe(undefined, 'other')).statusCode).toBe(404);
    const legacy = (await observe('after_seq=0&limit=1')).json();
    expect(legacy.observation).toBeUndefined(); expect(legacy.messages[0].contentRevision).toBeUndefined();
})

it('changes a same-seq content revision without declaring response finality', async () => {
    process.env.HAPPY_OBSERVATION_COHORT = 'test-cohort';
    const first = (await observe()).json();
    await client.sessionMessage.updateMany({ where: { sessionId: 'session-1', seq: 1 }, data: { content: { t: 'encrypted', c: 'final' } } });
    const next = (await observe()).json();
    expect(next.messages[0].contentRevision).not.toBe(first.messages[0].contentRevision);
    expect(next.observation.responseFinality).toBe('unknown');
    expect((await observe('observation_version=1&after_seq=0&through_seq=9')).statusCode).toBe(409);
})
it('does not expose an allocated watermark before its message transaction commits', async () => {
    process.env.HAPPY_OBSERVATION_COHORT = 'test-cohort';
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const write = client.$transaction(async tx => {
        await tx.session.update({ where: { id: 'session-1' }, data: { seq: { increment: 1 } } });
        entered(); await barrier;
        await tx.sessionMessage.create({ data: { sessionId: 'session-1', seq: 2, content: { t: 'encrypted', c: 'committed' } } });
    });
    await started;
    let observed = false;
    const read = observe().then(response => { observed = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(observed).toBe(false);
    release(); await write;
    const result = (await read).json();
    expect(result.observation.coveredThroughSeq).toBe(2);
    expect(result.hasMore).toBe(true);
})
