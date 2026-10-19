import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { SessionScopedTokenIssuer } from '@/app/auth/sessionScopedToken';

/**
 * Session list routes against the real schema (specs/session-recent-list).
 *
 * The keyset cursor of `GET /v2/sessions/recent` means something only in SQL:
 * a mock would accept any `where` the handler builds. Real auth decorators are
 * used so the managed refusal is the one production applies.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/storage/db', () => ({
    get db() { return state.client; },
}));
vi.mock('@/app/events/eventRouter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/events/eventRouter')>();
    return { ...actual, eventRouter: { emitUpdate: () => {}, emitEphemeral: () => {} } };
});

const priorSecret = process.env.HANDY_MASTER_SECRET;
process.env.HANDY_MASTER_SECRET = 'test-master-secret-not-a-production-key';

import { auth } from '@/app/auth/auth';
import { createSessionScopedTokenIssuer } from '@/app/auth/sessionScopedToken';
import { enableAuthentication, enableSessionScopeAuthentication } from '@/app/api/utils/enableAuthentication';
import { sessionRoutes } from './sessionRoutes';

const ACCOUNT = 'account-1';
const OTHER = 'account-2';
const T0 = Date.UTC(2026, 9, 1);
const MINUTE = 60_000;

let sql: string;
let pg: PGlite;
let client: PrismaClient;
let app: Fastify;
let issuer: SessionScopedTokenIssuer;
let token: string;
let otherToken: string;

interface RecentSession {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: string;
    metadataVersion: number;
    dataEncryptionKey: string | null;
}
interface RecentPage { sessions: RecentSession[]; nextCursor: string | null; hasNext: boolean }

beforeAll(async () => {
    const require = createRequire(resolve('package.json'));
    sql = (await promisify(execFile)(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
        { env: { ...process.env, DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused' }, maxBuffer: 1024 * 1024 })).stdout;
    await auth.init();
    issuer = await createSessionScopedTokenIssuer({ seed: 'test-scoped-seed-not-a-production-key' });
    token = await auth.createToken(ACCOUNT);
    otherToken = await auth.createToken(OTHER);

    const instance = fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    const typed = instance.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    enableAuthentication(typed);
    enableSessionScopeAuthentication(typed, () => issuer);
    sessionRoutes(typed);
    await typed.ready();
    app = typed;
});
afterAll(async () => {
    await app?.close();
    if (priorSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
    else process.env.HANDY_MASTER_SECRET = priorSecret;
});

beforeEach(async () => {
    pg = new PGlite(); await pg.exec(sql);
    client = new PrismaClient({ adapter: new PrismaPGlite(pg) });
    state.client = client;
    await client.account.create({ data: { id: ACCOUNT, publicKey: ACCOUNT } });
    await client.account.create({ data: { id: OTHER, publicKey: OTHER } });
});
afterEach(async () => { await client?.$disconnect(); await pg?.close(); });

/**
 * Inserts a session and pins `updatedAt` with SQL, because Prisma's
 * `@updatedAt` would otherwise stamp the insert time.
 */
async function seed(id: string, updatedAt: number, over: {
    accountId?: string;
    active?: boolean;
    lastActiveAt?: number;
    dataEncryptionKey?: Uint8Array<ArrayBuffer>;
} = {}) {
    await client.session.create({
        data: {
            id,
            tag: `tag-${id}`,
            accountId: over.accountId ?? ACCOUNT,
            metadata: `enc-${id}`,
            metadataVersion: 3,
            agentState: `state-${id}`,
            agentStateVersion: 2,
            seq: 7,
            active: over.active ?? true,
            lastActiveAt: new Date(over.lastActiveAt ?? updatedAt),
            createdAt: new Date(T0 - 1000),
            ...(over.dataEncryptionKey ? { dataEncryptionKey: over.dataEncryptionKey } : {}),
        },
    });
    await pg.query('UPDATE "Session" SET "updatedAt" = $1 WHERE id = $2', [new Date(updatedAt).toISOString(), id]);
}

function get(url: string, bearer: string = token) {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } });
}

async function recent(query: Record<string, string | number> = {}, bearer: string = token): Promise<RecentPage> {
    const search = new URLSearchParams(Object.entries(query).map(([key, value]): [string, string] => [key, String(value)]));
    const response = await get(`/v2/sessions/recent?${search}`, bearer);
    expect(response.statusCode).toBe(200);
    return response.json() as RecentPage;
}

/** Follows `nextCursor` to the end, as a client scanning the window would. */
async function walk(query: Record<string, string | number>): Promise<{ ids: string[]; pages: RecentPage[] }> {
    const pages: RecentPage[] = [];
    let cursor: string | null = null;
    do {
        const page = await recent(cursor ? { ...query, cursor } : query);
        pages.push(page);
        cursor = page.nextCursor;
        expect(pages.length).toBeLessThan(50);
    } while (cursor);
    return { ids: pages.flatMap((page) => page.sessions.map((s) => s.id)), pages };
}

describe('GET /v2/sessions/recent', () => {
    it('lists the account by recent activity, ties by id, archived included, without agent state', async () => {
        await seed('s-a', T0 + 1 * MINUTE);
        await seed('s-b', T0 + 3 * MINUTE, { active: false });
        await seed('s-c', T0 + 2 * MINUTE, { dataEncryptionKey: new Uint8Array([1, 2, 3]) });
        await seed('s-d', T0 + 2 * MINUTE);

        const page = await recent();

        expect(page.sessions.map((s) => s.id)).toEqual(['s-b', 's-d', 's-c', 's-a']);
        expect(page.hasNext).toBe(false);
        expect(page.nextCursor).toBeNull();
        expect(page.sessions[2]).toEqual({
            id: 's-c',
            seq: 7,
            createdAt: T0 - 1000,
            updatedAt: T0 + 2 * MINUTE,
            active: true,
            activeAt: T0 + 2 * MINUTE,
            metadata: 'enc-s-c',
            metadataVersion: 3,
            dataEncryptionKey: Buffer.from([1, 2, 3]).toString('base64'),
        });
        expect(page.sessions[0].active).toBe(false);
        expect(page.sessions[1].dataEncryptionKey).toBeNull();
        for (const session of page.sessions) {
            expect(Object.keys(session).sort()).toEqual([
                'active', 'activeAt', 'createdAt', 'dataEncryptionKey', 'id',
                'metadata', 'metadataVersion', 'seq', 'updatedAt',
            ]);
        }
    });

    it('pages through ties and gaps with a keyset cursor, every row exactly once', async () => {
        const expected: string[] = [];
        // Three rows share each millisecond, so pages of two always split a tie.
        for (let minute = 5; minute >= 1; minute--) {
            for (const suffix of ['z', 'm', 'a']) {
                const id = `s-${minute}-${suffix}`;
                await seed(id, T0 + minute * MINUTE);
                expected.push(id);
            }
        }

        const { ids, pages } = await walk({ limit: 2 });

        expect(ids).toEqual(expected);
        expect(pages).toHaveLength(8);
        for (const page of pages.slice(0, -1)) {
            const last = page.sessions[page.sessions.length - 1];
            expect(page.hasNext).toBe(true);
            expect(page.nextCursor).toBe(`cursor_v2_${last.updatedAt}_${last.id}`);
        }
        expect(pages[pages.length - 1]).toMatchObject({ hasNext: false, nextCursor: null });
    });

    it('keeps rows at exactly `since` and drops older ones, also across pages', async () => {
        await seed('s-new', T0 + 3 * MINUTE);
        await seed('s-edge-b', T0 + 2 * MINUTE);
        await seed('s-edge-a', T0 + 2 * MINUTE);
        await seed('s-old', T0 + 2 * MINUTE - 1);

        expect((await recent({ since: T0 + 2 * MINUTE })).sessions.map((s) => s.id))
            .toEqual(['s-new', 's-edge-b', 's-edge-a']);
        expect((await walk({ since: T0 + 2 * MINUTE, limit: 1 })).ids)
            .toEqual(['s-new', 's-edge-b', 's-edge-a']);
    });

    it('defaults to 100 rows and accepts up to 200', async () => {
        await client.session.createMany({
            data: Array.from({ length: 201 }, (_, i) => ({
                id: `s-${String(i).padStart(3, '0')}`, tag: `t-${i}`, accountId: ACCOUNT, metadata: '',
            })),
        });

        const byDefault = await recent();
        expect(byDefault.sessions).toHaveLength(100);
        expect(byDefault.hasNext).toBe(true);
        const widest = await recent({ limit: 200 });
        expect(widest.sessions).toHaveLength(200);
        expect(widest.hasNext).toBe(true);
    });

    it('never shows another account, whatever cursor is presented', async () => {
        await seed('s-mine-1', T0 + 1 * MINUTE);
        await seed('s-mine-2', T0 + 3 * MINUTE);
        await seed('s-theirs-1', T0 + 2 * MINUTE, { accountId: OTHER });
        await seed('s-theirs-2', T0 + 4 * MINUTE, { accountId: OTHER });

        expect((await recent()).sessions.map((s) => s.id)).toEqual(['s-mine-2', 's-mine-1']);
        expect((await recent({}, otherToken)).sessions.map((s) => s.id)).toEqual(['s-theirs-2', 's-theirs-1']);
        // A cursor naming another account's row is only a position.
        const foreign = `cursor_v2_${T0 + 4 * MINUTE}_s-theirs-2`;
        expect((await recent({ cursor: foreign })).sessions.map((s) => s.id)).toEqual(['s-mine-2', 's-mine-1']);
    });

    it.each([
        ['cursor', 'cursor_v1_s-a'],
        ['cursor', 'cursor_v2_s-a'],
        ['cursor', 'cursor_v2_abc_s-a'],
        ['cursor', 'cursor_v2_123_'],
        ['cursor', 'cursor_v2_-5_s-a'],
        ['cursor', 'cursor_v2_99999999999999999_s-a'],
        ['cursor', ''],
        ['limit', '0'],
        ['limit', '201'],
        ['limit', '1.5'],
        ['limit', 'abc'],
        ['since', '0'],
        ['since', '-1'],
        ['since', '1.5'],
        ['since', 'abc'],
        ['since', '99999999999999999'],
        // Past year 9999: a valid `Date`, but Prisma cannot send it.
        ['since', '253402300800000'],
        ['since', '8640000000000000'],
        ['cursor', 'cursor_v2_253402300800000_s-a'],
        ['cursor', 'cursor_v2_8640000000000000_s-a'],
        // PostgreSQL text cannot hold NUL, so the query itself would fail.
        ['cursor', 'cursor_v2_1790812800123_bad\u0000id'],
        ['cursor', 'cursor_v2_1790812800123_\u0000'],
        ['since', '1790812800123\u0000'],
        ['limit', '10\u0000'],
    ])('refuses %s=%j with 400', async (name, value) => {
        await seed('s-a', T0);
        const response = await get(`/v2/sessions/recent?${name}=${encodeURIComponent(value)}`);
        expect(response.statusCode).toBe(400);
        expect(response.body).not.toContain('s-a');
    });

    it.each([
        // Bytes that are not UTF-8 reach the handler as U+FFFD or stay escaped.
        'cursor_v2_1790812800123_bad%FFid',
        'cursor_v2_1790812800123_bad%ED%A0%80id',
        'cursor_v2_1790812800123_bad%C0%80id',
    ])('answers a cursor with raw bytes %s without a server error', async (raw) => {
        await seed('s-a', T0);
        const response = await get(`/v2/sessions/recent?cursor=${raw}`);
        expect(response.statusCode).toBeLessThan(500);
    });

    it('accepts the last millisecond of year 9999 as since and cursor', async () => {
        await seed('s-a', T0);
        const last = 253_402_300_799_999;
        expect((await recent({ since: last })).sessions).toEqual([]);
        expect((await recent({ cursor: `cursor_v2_${last}_s-z` })).sessions.map((s) => s.id)).toEqual(['s-a']);
    });

    it('refuses a managed session-scoped bearer with 401', async () => {
        await seed('s-granted', T0);
        await seed('s-sibling', T0 + MINUTE);
        const minted = await issuer.mint({
            v: 1,
            grantId: 'grant-1',
            accountId: ACCOUNT,
            sessionId: 's-granted',
            tenantId: 'tenant-1',
            projectId: 'project-1',
            workspaceId: 'ws-1',
            runtimeId: 'runtime-1',
            runId: 'run-1',
            attemptId: 'attempt-1',
            epoch: 1,
            workspaceAuthorityVersion: 1,
            runAuthorityVersion: 1,
            purpose: 'runner',
            expiresAt: Date.now() + 60 * MINUTE,
        } as never, Date.now());
        if (!minted.ok) throw new Error(`fixture mint failed: ${minted.reason}`);

        const response = await get('/v2/sessions/recent', minted.token);

        expect(response.statusCode).toBe(401);
        expect(response.body).not.toContain('s-granted');
        expect(response.body).not.toContain('s-sibling');
    });

    it('refuses a request without a bearer with 401', async () => {
        const response = await app.inject({ method: 'GET', url: '/v2/sessions/recent' });
        expect(response.statusCode).toBe(401);
    });

    it('answers each page with a single database query', async () => {
        await seed('s-a', T0 + MINUTE);
        await seed('s-b', T0);
        const operations: string[] = [];
        state.client = client.$extends({
            query: {
                async $allOperations({ model, operation, args, query }) {
                    operations.push(`${model}.${operation}`);
                    return query(args);
                },
            },
        });

        const first = await recent({ limit: 1 });
        expect(operations).toEqual(['Session.findMany']);
        await recent({ limit: 1, cursor: first.nextCursor!, since: T0 });
        expect(operations).toEqual(['Session.findMany', 'Session.findMany']);
    });

    it('bounds a cursor page by the index on both sides', async () => {
        await seed('s-a', T0 + 2 * MINUTE);
        await seed('s-b', T0 + MINUTE);
        await seed('s-c', T0);
        // Records the SQL Prisma sends, so the plan is the one it really gets.
        const sent: Array<{ sql: string; params: unknown[] }> = [];
        const query = pg.query.bind(pg);
        pg.query = (async (sqlText: string, params?: unknown[], options?: unknown) => {
            sent.push({ sql: sqlText, params: params ?? [] });
            return query(sqlText, params as never, options as never);
        }) as typeof pg.query;

        await recent({ limit: 1, cursor: `cursor_v2_${T0 + 2 * MINUTE}_s-a`, since: T0 });

        const select = sent.find((entry) => /FROM "public"\."Session"/.test(entry.sql));
        expect(select).toBeDefined();
        await query('SET enable_seqscan = off');
        const plan = await query<{ 'QUERY PLAN': string }>(`EXPLAIN ${select!.sql}`, select!.params as never);
        const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
        // Without the upper bound in the index condition every page re-reads
        // all newer rows of the account and filters them away.
        expect(text).toMatch(/Index Cond: .*"accountId" = .*"updatedAt" >= .*"updatedAt" <= /);
    });
});

/*
 * S8: the new route is an addition. The existing list routes keep their
 * order, page shape and fields (including `agentState`) unchanged.
 */
describe('existing session list routes are unchanged', () => {
    beforeEach(async () => {
        const now = Date.now();
        await seed('s-1', now - 3 * MINUTE);
        await seed('s-2', now - 1 * MINUTE, { active: false });
        await seed('s-3', now - 2 * MINUTE, { lastActiveAt: now - 20 * MINUTE });
        await seed('s-x', now, { accountId: OTHER });
    });

    const v1Keys = [
        'active', 'activeAt', 'agentState', 'agentStateVersion', 'createdAt', 'dataEncryptionKey',
        'id', 'lastMessage', 'metadata', 'metadataVersion', 'seq', 'updatedAt',
    ];
    const v2Keys = v1Keys.filter((key) => key !== 'lastMessage');

    it('GET /v1/sessions: account rows by updatedAt desc with agent state and lastMessage', async () => {
        const response = await get('/v1/sessions');
        expect(response.statusCode).toBe(200);
        const body = response.json() as { sessions: Array<Record<string, unknown>> };
        expect(Object.keys(body)).toEqual(['sessions']);
        expect(body.sessions.map((s) => s.id)).toEqual(['s-2', 's-3', 's-1']);
        expect(Object.keys(body.sessions[0]).sort()).toEqual(v1Keys);
        expect(body.sessions[0]).toMatchObject({ agentState: 'state-s-2', agentStateVersion: 2, lastMessage: null });
    });

    it('GET /v2/sessions: id-ordered cursor_v1 pages with agent state', async () => {
        const first = (await get('/v2/sessions?limit=2')).json() as { sessions: Array<Record<string, unknown>>; nextCursor: string | null; hasNext: boolean };
        expect(first.sessions.map((s) => s.id)).toEqual(['s-3', 's-2']);
        expect(first).toMatchObject({ hasNext: true, nextCursor: 'cursor_v1_s-2' });
        expect(Object.keys(first.sessions[0]).sort()).toEqual(v2Keys);
        const second = (await get(`/v2/sessions?limit=2&cursor=${first.nextCursor}`)).json() as typeof first;
        expect(second.sessions.map((s) => s.id)).toEqual(['s-1']);
        expect(second).toMatchObject({ hasNext: false, nextCursor: null });
        expect((await get('/v2/sessions?cursor=cursor_v2_1_s-1')).statusCode).toBe(400);
    });

    it('GET /v2/sessions/active: active rows seen in the last 15 minutes, by lastActiveAt', async () => {
        const body = (await get('/v2/sessions/active')).json() as { sessions: Array<Record<string, unknown>> };
        expect(Object.keys(body)).toEqual(['sessions']);
        expect(body.sessions.map((s) => s.id)).toEqual(['s-1']);
        expect(Object.keys(body.sessions[0]).sort()).toEqual(v2Keys);
    });

    it('POST /v2/sessions/lookup: requested order, own account only, with agent state', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/v2/sessions/lookup',
            headers: { authorization: `Bearer ${token}` },
            payload: { ids: ['s-1', 's-x', 's-3'] },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as { sessions: Array<Record<string, unknown>> };
        expect(body.sessions.map((s) => s.id)).toEqual(['s-1', 's-3']);
        expect(Object.keys(body.sessions[0]).sort()).toEqual(v2Keys);
    });
});
