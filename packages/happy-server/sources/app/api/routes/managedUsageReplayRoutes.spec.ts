import fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, expect, it, vi } from 'vitest';
import { managedUsageReplayRoutes } from './managedUsageReplayRoutes';
import { deriveGrantFamily } from '@/app/managed/managedSessionGrant';
const s = vi.hoisted(() => ({ claims: {} as any, daemon: {} as any, workspace: {} as any, run: {} as any, grant: {} as any, session: {} as any, history: [] as any[],
    verify: vi.fn(), resolve: vi.fn(), upsert: vi.fn(), outbox: vi.fn(), locks: vi.fn() }));
vi.mock('@/storage/db', () => ({ db: {} }));
vi.mock('@/storage/inTx', () => ({ inTx: async (fn: any) => fn({ $queryRaw: s.locks,
    managedWorkspaceAuthority: { findUnique: async () => s.workspace }, managedRunAuthority: { findUnique: async () => s.run },
    managedSessionGrant: { findMany: async ({ where }: any) => [...s.history, ...(s.grant ? [s.grant] : [])].filter(g => where.grantId.in.includes(g.grantId)) }, session: { findUnique: async () => s.session },
    providerUsageEvent: { upsert: s.upsert }, usageDeliveryOutbox: { upsert: s.outbox } }) }));
vi.mock('@/app/managed/managedDaemonGrant', () => ({ resolveManagedDaemonGrant: s.resolve }));
const event = { schemaVersion: 1, source: 'happy-cli', sourceEventId: 'event', sessionId: 'session', occurredAt: 123456,
    provider: 'anthropic', agent: 'claude', measurement: 'delta', cost: null, model: 'claude', tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 3 }, quality: 'exact' };
beforeEach(() => {
    vi.clearAllMocks(); s.history = [];
    s.claims = { v: 1, daemonGrantId: 'daemon', generation: 2, machineId: 'machine', accountId: 'account', workspaceId: 'workspace', projectId: 'project', runtimeId: 'runtime', epoch: 3, provisioningOperationId: 'provision', expiresAt: Date.now() + 60000 };
    s.daemon = { ...s.claims };
    s.workspace = { workspaceId: 'workspace', tenantId: 'tenant', projectId: 'project', runtimeId: 'runtime', epoch: 3, version: 4 };
    s.run = { runId: 'run', workspaceId: 'workspace', accountId: 'account', currentAttemptId: 'attempt', cancelledAt: null, version: 5 };
    s.grant = { grantId: 'grant', purpose: 'runner', sessionId: 'session', workspaceId: 'workspace', accountId: 'account', runId: 'run', attemptId: 'attempt', epoch: 3, workspaceAuthorityVersion: 4, runAuthorityVersion: 5, revokedAt: null, tombstone: false, expiresAt: 1n,
        family: deriveGrantFamily({ tenantId: 'tenant', projectId: 'project', workspaceId: 'workspace', runtimeId: 'runtime', epoch: 3, runId: 'run', attemptId: 'attempt', sessionId: 'session', accountId: 'account', workspaceAuthorityVersion: 4, runAuthorityVersion: 5 }) };
    s.session = { id: 'session', accountId: 'account' };
    s.verify.mockImplementation(async () => ({ ok: true, claims: s.claims }));
    s.resolve.mockImplementation(async () => ({ ok: true, grant: s.daemon }));
    s.locks.mockResolvedValue([{ grantId: 'grant' }]);
    s.upsert.mockResolvedValue({ id: 'stored', accountId: 'account', sessionId: 'session' }); s.outbox.mockResolvedValue({});
});
async function request(payload: unknown = event) {
    const app = fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    managedUsageReplayRoutes(app as never, () => ({ daemonTokens: { verify: s.verify } } as never));
    try { return await app.inject({ method: 'POST', url: '/v1/machines/machine/usage-replay', headers: { authorization: 'Bearer current-daemon', 'content-type': 'application/json' }, payload: JSON.stringify(payload) }); }
    finally { await app.close(); }
}
it('accepts only telemetry under current daemon authority, including after runner expiration', async () => {
    expect((await request()).statusCode).toBe(200);
    expect(s.resolve).toHaveBeenCalledWith(expect.objectContaining({ tx: expect.any(Object), generation: 2 }));
    expect(s.locks).toHaveBeenCalled(); expect(s.upsert).toHaveBeenCalledOnce(); expect(s.outbox).toHaveBeenCalledOnce();
});
it.each(['expired-token', 'revoked-daemon', 'old-generation', 'wrong-machine', 'workspace', 'tenant', 'project', 'runtime', 'epoch', 'session-owner', 'run-owner', 'attempt', 'cancelled', 'revoked-runner', 'tombstone', 'workspace-version', 'run-version', 'missing-binding', 'read-purpose', 'foreign-id'])('rejects %s without writes', async kind => {
    if (kind === 'expired-token') s.verify.mockResolvedValue({ ok: false });
    if (kind === 'revoked-daemon') s.resolve.mockResolvedValue({ ok: false });
    if (kind === 'old-generation') s.daemon.generation++;
    if (kind === 'wrong-machine') s.claims.machineId = 'foreign';
    if (kind === 'workspace') s.grant.workspaceId = 'foreign';
    if (kind === 'tenant') s.workspace.tenantId = 'foreign';
    if (kind === 'project') s.workspace.projectId = 'foreign';
    if (kind === 'runtime') s.workspace.runtimeId = 'foreign';
    if (kind === 'epoch') s.grant.epoch++;
    if (kind === 'session-owner') s.session.accountId = 'foreign';
    if (kind === 'run-owner') s.run.accountId = 'foreign';
    if (kind === 'attempt') s.run.currentAttemptId = 'next';
    if (kind === 'cancelled') s.run.cancelledAt = 1n;
    if (kind === 'revoked-runner') s.grant.revokedAt = 1n;
    if (kind === 'tombstone') s.grant.tombstone = true;
    if (kind === 'workspace-version') s.workspace.version++;
    if (kind === 'run-version') s.run.version++;
    if (kind === 'missing-binding') s.grant = null;
    if (kind === 'read-purpose') s.grant.purpose = 'transcript-read';
    expect((await request(kind === 'foreign-id' ? { ...event, sessionId: 'foreign' } : event)).statusCode).toBeGreaterThanOrEqual(400);
    expect(s.verify).toHaveBeenCalledOnce(); expect(s.upsert).not.toHaveBeenCalled(); expect(s.outbox).not.toHaveBeenCalled();
});
it('rejects arbitrary commands', async () => { expect((await request({ ...event, command: 'resume' })).statusCode).toBe(400); expect(s.verify).not.toHaveBeenCalled(); });
it('ACKs duplicates but rejects cross-session source ID collisions', async () => {
    expect((await request()).statusCode).toBe(200); expect((await request()).statusCode).toBe(200);
    s.upsert.mockResolvedValue({ id: 'stored', accountId: 'other', sessionId: 'foreign' }); expect((await request()).statusCode).toBe(403);
});

it('selects the current proven grant instead of denying recovery because prior attempts coexist', async () => {
    // The locking query chooses current run/attempt/version rows; historical rows are not
    // authorization candidates even when they share this session id.
    const response = await request();
    expect(response.statusCode).toBe(200);
    const query = s.locks.mock.calls.find(([strings]) => strings.join('').includes('currentAttemptId'));
    expect(query?.[0].join('')).toContain('g."revokedAt" IS NULL');
    expect(query?.[0].join('')).toContain('r."currentAttemptId" = g."attemptId"');
});

it('PostgreSQL selects a current grant despite revoked and stale previous attempts for the same session', async () => {
    const pg = new PGlite();
    try {
        await pg.exec(`CREATE TABLE "ManagedDaemonGrant" ("daemonGrantId" text);
            CREATE TABLE "Machine" (id text);
            CREATE TABLE "ManagedWorkspaceAuthority" ("workspaceId" text, version int);
            CREATE TABLE "Session" (id text, "accountId" text);
            CREATE TABLE "ManagedRunAuthority" ("runId" text, "accountId" text, "workspaceId" text, "currentAttemptId" text, "cancelledAt" bigint, version int);
            CREATE TABLE "ManagedSessionGrant" ("grantId" text, "runId" text, "sessionId" text, "workspaceId" text, purpose text, "accountId" text, "attemptId" text,
                "revokedAt" bigint, tombstone boolean, epoch int, "runAuthorityVersion" int, "workspaceAuthorityVersion" int);
            INSERT INTO "ManagedDaemonGrant" VALUES ('daemon'); INSERT INTO "Machine" VALUES ('machine');
            INSERT INTO "ManagedWorkspaceAuthority" VALUES ('workspace',4); INSERT INTO "Session" VALUES ('session','account');
            INSERT INTO "ManagedRunAuthority" VALUES ('run','account','workspace','attempt',null,5);
            INSERT INTO "ManagedSessionGrant" VALUES
            ('revoked-old','run','session','workspace','runner','account','old-attempt',1,false,3,5,4),
            ('stale-old','run','session','workspace','runner','account','old-attempt',null,false,3,5,4),
            ('grant','run','session','workspace','runner','account','attempt',null,false,3,5,4);`);
        s.history = [{ ...s.grant, grantId: 'revoked-old', revokedAt: 1n }, { ...s.grant, grantId: 'stale-old', attemptId: 'old-attempt' }];
        s.locks.mockImplementation(async (parts: TemplateStringsArray, ...values: unknown[]) => {
            const sql = parts.reduce((text, part, i) => text + part + (i < values.length ? `$${i + 1}` : ''), '');
            return (await pg.query(sql, values)).rows;
        });
        expect((await request()).statusCode).toBe(200);
        await pg.exec(`UPDATE "ManagedSessionGrant" SET "revokedAt"=1 WHERE "grantId"='grant'`);
        expect((await request()).statusCode).toBe(403);
        expect(s.upsert).toHaveBeenCalledTimes(1); // historical rows cannot revive the revoked current grant
    } finally { await pg.close(); s.locks.mockReset(); }
}, 20000);
