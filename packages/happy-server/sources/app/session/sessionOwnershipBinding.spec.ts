import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import nacl from 'tweetnacl';
import {
  sharedMachineRotationFixture as fixture, SessionExecutionTicketBodySchema, HappySessionCreateProofBodySchema,
  signRotationDocument, rotationDigest, rotationSha256, rotationBase64url, sessionTagHash, sessionCreateBodyHash,
  type HappySessionExecutionProof, type SessionExecutionCreateBody,
} from '@slopus/happy-wire';
import type { Fastify } from '@/app/api/types';

const state = vi.hoisted(() => ({ client: null as unknown, emitted: [] as unknown[] }));
vi.mock('@/storage/db', () => ({ get db() { return state.client; } }));
vi.mock('@/app/events/eventRouter', () => ({
  eventRouter: { emitUpdate: (v: unknown) => state.emitted.push(v) },
  buildNewSessionUpdate: (s: { id: string }, seq: number) => ({ sessionId: s.id, seq }),
}));
vi.mock('@/app/session/sessionDelete', () => ({ sessionDelete: vi.fn() }));
vi.mock('@/app/session/sessionArchive', () => ({ sessionArchive: vi.fn() }));
import { sessionOwnershipRoutes } from '@/app/api/routes/sessionOwnershipRoutes';
import { signOwnership, ownershipDigest, SessionOwnershipProofSchema, type SessionOwnershipProof } from '@session-ownership';
import { sessionRoutes } from '@/app/api/routes/sessionRoutes';
import { machineSessionOwnerRoutes } from '@/app/api/routes/machineSessionOwnerRoutes';

const studio = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
const device = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(2));
let sql: string, migration: string, pg: PGlite, client: PrismaClient, app: Fastify;
const trustNames = ['HAPPY_EXECUTION_STUDIO_ORIGIN', 'HAPPY_EXECUTION_AUDIENCE', 'HAPPY_EXECUTION_STUDIO_PUBLIC_KEY', 'HAPPY_SESSION_OWNERSHIP_ENABLED', 'HAPPY_SESSION_OWNERSHIP_ISSUER', 'HAPPY_SESSION_OWNERSHIP_AUDIENCE', 'HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS'] as const;
const saved = trustNames.map(name => process.env[name]);
beforeAll(async () => {
  const require = createRequire(resolve('package.json'));
  sql = (await promisify(execFile)(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
    { env: { ...process.env, XDG_CACHE_HOME: '/tmp/happy-rotation-prisma-cache', DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused' }, maxBuffer: 1024 * 1024 })).stdout;
  migration = await readFile('prisma/migrations/20261025000000_session_ownership/migration.sql', 'utf8');
});
beforeEach(async () => {
  pg = new PGlite(); await pg.exec(sql);
  // Exercise the actual additive migration against preexisting owner/machine/session rows.
  await pg.exec('DROP TABLE "SessionOwnershipBinding";');
  // Adapter 0.7.2 returns Uint8Array bytea cells; Prisma's Rust bridge expects
  // JSON arrays. Normalize only that adapter result in this test, preserving SQL.
  const adapter = new PrismaPGlite(pg), connect = adapter.connect.bind(adapter);
  adapter.connect = async () => {
    const driver = await connect();
    const normalize = (queryable: any) => {
      const queryRaw = queryable.queryRaw.bind(queryable);
      queryable.queryRaw = async (...args: unknown[]) => {
        const result = await queryRaw(...args);
        result.rows = result.rows.map((row: unknown[]) => row.map(cell => cell instanceof Uint8Array ? Array.from(cell) : cell));
        return result;
      };
      if (queryable.startTransaction) {
        const start = queryable.startTransaction.bind(queryable);
        queryable.startTransaction = async (...args: unknown[]) => normalize(await start(...args));
      }
      return queryable;
    };
    return normalize(driver);
  };
  client = new PrismaClient({ adapter }); state.client = client; state.emitted = [];
  for (const id of ['company-account', 'personal-account', 'outsider']) await client.account.create({ data: { id, publicKey: id } });
  await client.machine.create({ data: { id: 'machine-1', accountId: 'company-account', metadata: 'machine-ciphertext' } });
  await client.machine.create({ data: { id: 'machine-2', accountId: 'company-account', metadata: 'machine-ciphertext-2' } });
  await client.session.create({ data: { id: 'legacy', tag: 'legacy', accountId: 'personal-account', metadata: 'legacy-encrypted' } });
  await pg.exec(migration);
  process.env.HAPPY_EXECUTION_STUDIO_ORIGIN = 'https://studio.example';
  process.env.HAPPY_EXECUTION_AUDIENCE = 'https://happy.example';
  process.env.HAPPY_EXECUTION_STUDIO_PUBLIC_KEY = rotationBase64url(studio.publicKey);
  process.env.HAPPY_SESSION_OWNERSHIP_ENABLED = '1';
  process.env.HAPPY_SESSION_OWNERSHIP_ISSUER = 'https://studio.example';
  process.env.HAPPY_SESSION_OWNERSHIP_AUDIENCE = 'https://happy.example';
  process.env.HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS = JSON.stringify({[await rotationSha256(studio.publicKey)]: rotationBase64url(studio.publicKey)});
  const server = fastify(); server.setValidatorCompiler(validatorCompiler); server.setSerializerCompiler(serializerCompiler);
  app = server.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
  const authenticate = async (request: any, reply: any) => {
    const account = request.headers['x-test-account'];
    if (typeof account !== 'string') return reply.code(401).send({ error: 'Unauthorized' });
    request.userId = account;
    request.principal = { kind: request.headers['x-test-principal'] ?? 'account', accountId: account };
  };
  app.decorate('authenticate', authenticate); app.decorate('authenticateSessionScope', authenticate);
  sessionRoutes(app); machineSessionOwnerRoutes(app); sessionOwnershipRoutes(app); await app.ready();
});
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); await client?.$disconnect(); await pg?.close(); });
afterAll(() => { trustNames.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }); });

async function signed(body: SessionExecutionCreateBody = fixture.createBody, ticketChanges: Record<string, unknown> = {}, deviceChanges: Record<string, unknown> = {}, studioKey = studio, deviceKey = device): Promise<HappySessionExecutionProof> {
  const now = Date.now();
  const hashes = { sessionTagHash: await sessionTagHash(body.tag), sessionCreateBodyHash: await sessionCreateBodyHash(body) };
  const ticketBody = SessionExecutionTicketBodySchema.parse({ ...fixture.executionProof.ticket.body, ...hashes,
    issuedAt: now, expiresAt: now + 60000, ...ticketChanges });
  const ticket = await signRotationDocument(ticketBody, studioKey.secretKey);
  const deviceBody = HappySessionCreateProofBodySchema.parse({ ...fixture.executionProof.deviceProof.body, ...hashes,
    ticketDigest: await rotationDigest(ticket), sessionOwnerAccountId: ticketBody.sessionOwnerAccountId, issuedAt: now, expiresAt: now + 60000, ...deviceChanges });
  return { ticket, deviceProof: await signRotationDocument(deviceBody, deviceKey.secretKey) };
}
const createBody = { tag: 'owned', metadata: 'ciphertext', agentState: null };
async function proof(body: SessionExecutionCreateBody = createBody, changes: Record<string, unknown> = {}): Promise<SessionOwnershipProof> {
  const now = Date.now();
  return SessionOwnershipProofSchema.parse(signOwnership({ version: 1, type: 'saycode-session-ownership',
    issuer: 'https://studio.example', audience: 'https://happy.example', keyId: await rotationSha256(studio.publicKey),
    intentId: 'intent', operationId: 'op', creationRequestId: 'request', ownershipPolicy: 'prefer-owned',
    subject: { issuer: 'https://studio.example', userId: 'alice' }, companyId: 'company-1', projectId: 'project',
    machineId: 'machine-1', machineAccountId: 'company-account', sessionAccountId: 'personal-account',
    parentHubSessionId: null, spawnDigest: 'a'.repeat(64), nonce: rotationBase64url(new Uint8Array(32)),
    tagHash: await sessionTagHash(body.tag), createBodyHash: await sessionCreateBodyHash(body),
    issuedAt: now, expiresAt: now + 60000, ...changes,
  }, studio.secretKey));
}
function create(ownershipProof: unknown, body: unknown = createBody, extra: object = {}, account = 'personal-account') {
  return app.inject({ method: 'POST', url: '/v1/sessions', headers: { 'x-test-account': account },
    payload: { ...(body as object), ownershipProof, ...extra } });
}
async function assertion(type: string, fields: object) {
  const now = Date.now();
  return signOwnership({ type, version: 1, issuer: 'https://studio.example', audience: 'https://happy.example',
    keyId: await rotationSha256(studio.publicKey), issuedAt: now, expiresAt: now + 60000, ...fields }, studio.secretKey);
}
async function lookup(id: string, account = 'personal-account') {
  return app.inject({ method: 'POST', url: '/v1/session-ownership/lookup', payload: await assertion('saycode-session-ownership-lookup', {
    subject: { issuer: 'https://studio.example', userId: 'alice' }, sessions: [{ sessionId: id, sessionAccountId: account }],
  }) });
}
async function confirm(id: string, bindingId: string, digest: string, userId = 'alice') {
  return app.inject({ method: 'POST', url: `/v1/session-ownership/${id}/confirm`, payload: await assertion('saycode-session-ownership-confirm', {
    requestId: 'confirmation', sessionId: id, bindingId, createDigest: digest, operationId: 'op',
    sessionAccountId: 'personal-account', subject: { issuer: 'https://studio.example', userId },
  }) });
}
async function empty() {
  expect(await client.session.count()).toBe(1);
  expect(await client.sessionOwnershipBinding.count()).toBe(0);
  expect(await client.sessionExecutionBinding.count()).toBe(0);
  expect(state.emitted).toHaveLength(0);
}

describe('T4o creation ownership at the HTTP and SQL boundary', () => {
  it.skipIf(!process.env.OWNERSHIP_PRODUCER_FIXTURE)('accepts the actual A+ intent/seal output without re-signing', async () => {
    const artifact = JSON.parse(await readFile(process.env.OWNERSHIP_PRODUCER_FIXTURE!, 'utf8')) as {
      publicKey: string; body: SessionExecutionCreateBody; proof: SessionOwnershipProof;
    };
    const p = artifact.proof;
    vi.spyOn(Date, 'now').mockReturnValue(p.issuedAt);
    process.env.HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS = JSON.stringify({ [p.keyId]: artifact.publicKey });
    await client.machine.create({ data: { id: p.machineId, accountId: p.machineAccountId, metadata: 'synthetic' } });
    const created = await create(p, artifact.body, {}, p.sessionAccountId);
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().ownership).toMatchObject({ registrationState: 'pending', createDigest: p.createBodyHash });
    expect((await create(p, artifact.body, {}, p.sessionAccountId)).json().session.id).toBe(created.json().session.id);
    expect(await ownershipDigest(p)).toBe((await client.sessionOwnershipBinding.findFirstOrThrow()).proofDigest);
  });
  it('leaves legacy creation unowned and refuses malformed proofs instead of unsigned downgrade', async () => {
    const legacy = await app.inject({ method: 'POST', url: '/v1/sessions', headers: { 'x-test-account': 'personal-account' },
      payload: { tag: 'legacy', metadata: 'legacy-encrypted' } });
    expect(legacy.statusCode).toBe(200);
    expect((await lookup('legacy')).json().sessions[0].ownership).toMatchObject({ state: 'unknown', ownerSubject: null });
    for (const bad of [{}, null, { subject: 'alice' }]) expect((await create(bad)).statusCode).toBe(400);
    await empty();
  });
  it('holds the immutable candidate pending, confirms only the original subject, and retries exactly', async () => {
    const p = await proof(); const first = await create(p); expect(first.statusCode, first.body).toBe(200);
    const { session, ownership } = first.json();
    expect(ownership.registrationState).toBe('pending');
    expect((await lookup(session.id)).json().sessions[0].ownership).toMatchObject({ state: 'pending', ownerSubject: null });
    expect((await create(p)).json().session.id).toBe(session.id);
    expect(state.emitted).toHaveLength(1);
    expect((await confirm(session.id, ownership.ownershipBindingId, ownership.createDigest, 'bob')).statusCode).toBe(403);
    expect((await confirm(session.id, ownership.ownershipBindingId, ownership.createDigest)).json().ownership)
      .toMatchObject({ state: 'confirmed', ownerSubject: { userId: 'alice' } });
    const time = (await client.sessionOwnershipBinding.findUniqueOrThrow({ where: { sessionId: session.id } })).confirmedAt;
    expect((await confirm(session.id, ownership.ownershipBindingId, ownership.createDigest)).statusCode).toBe(200);
    expect((await client.sessionOwnershipBinding.findUniqueOrThrow({ where: { sessionId: session.id } })).confirmedAt).toEqual(time);
    expect((await lookup(session.id, 'outsider')).json().sessions[0]).toMatchObject({ binding: null, ownership: { state: 'unavailable', ownerSubject: null } });
  });
  it('rejects preemption, re-registration and attaching a new operation to an old session', async () => {
    const legacyBody = { ...createBody, tag: 'legacy' };
    expect((await create(await proof(legacyBody), legacyBody)).statusCode).toBe(409);
    await empty();
    const p = await proof(); expect((await create(p)).statusCode).toBe(200);
    expect((await create(await proof(createBody, { subject: { issuer: 'https://studio.example', userId: 'bob' } }))).statusCode).toBe(409);
    expect((await create(await proof(createBody, { operationId: 'new-op', intentId: 'new-intent' }))).statusCode).toBe(409);
    expect(await client.sessionOwnershipBinding.count()).toBe(1);
  });
  it('rejects tampered, expired, wrong-account, wrong-machine, foreign-subject and untrusted-key documents', async () => {
    const p = await proof();
    expect((await create({ ...p, subject: { ...p.subject, userId: 'bob' } })).statusCode).toBe(403);
    expect((await create(p, { ...createBody, metadata: 'changed' })).statusCode).toBe(403);
    expect((await create(p, createBody, {}, 'company-account')).statusCode).toBe(403);
    for (const changes of [{ machineAccountId: 'outsider' }, { machineId: 'absent' },
      { subject: { issuer: 'https://other.example', userId: 'alice' } },
      { issuedAt: Date.now() - 120000, expiresAt: Date.now() - 60001 }]) {
      expect((await create(await proof(createBody, changes))).statusCode).toBe(403);
    }
    expect((await create(await proof(createBody, { keyId: 'f'.repeat(64) }))).statusCode).toBe(503);
    expect((await create({ ...p, metadata: 'not-in-contract' })).statusCode).toBe(400);
    await empty();
  });
  it('rolls back both proofs on a mismatched machine and preserves the strict execution body validator', async () => {
    const body = fixture.createBody;
    const execution = await signed(body);
    expect((await create(await proof(body, { machineId: 'machine-2' }), body, { executionProof: execution })).statusCode).toBe(403);
    await empty();
    expect((await create(await proof(body), body, { executionProof: { ...execution, ticket: {} } })).statusCode).toBe(400);
    await empty();
    expect((await create(await proof(body), { ...body, extra: 1 }, { executionProof: execution })).statusCode).toBe(400);
    await empty();
    const p = await proof(body); const result = await create(p, body, { executionProof: execution });
    expect(result.statusCode, result.body).toBe(200);
    expect((await create(p, body, { executionProof: execution })).json().session.id).toBe(result.json().session.id);
    expect(await client.sessionExecutionBinding.count()).toBe(1);
    expect(await client.sessionOwnershipBinding.count()).toBe(1);
  });
  it('rejects shared account confirmations without a signed A+ assertion', async () => {
    const result = await create(await proof());
    const response = await app.inject({ method: 'POST', url: `/v1/session-ownership/${result.json().session.id}/confirm`,
      headers: { 'x-test-account': 'company-account' }, payload: {} });
    expect(response.statusCode).toBe(400);
  });
  it('checks ownership freshness again at commit when an execution proof is also present', async () => {
    const body = fixture.createBody, p = await proof(body, { expiresAt: Date.now() + 1000 });
    const execution = await signed(body);
    state.client = client.$extends({ query: { account: {
      async update({ args, query }) {
        const result = await query(args);
        vi.spyOn(Date, 'now').mockReturnValue(p.expiresAt);
        return result;
      },
    } } });
    expect((await create(p, body, { executionProof: execution })).statusCode).toBe(403);
    await empty();
  });
  it('does not resurrect a deleted session or allow direct owner replacement', async () => {
    const p = await proof(); const first = await create(p); const id = first.json().session.id;
    await expect(client.sessionOwnershipBinding.update({ where: { sessionId: id }, data: { ownerUserId: 'bob' } })).rejects.toThrow();
    await client.session.delete({ where: { id } });
    expect((await create(p)).statusCode).toBe(409);
    expect(await client.sessionOwnershipBinding.count()).toBe(1);
    expect((await lookup(id)).json().sessions[0].ownership.state).toBe('unavailable');
  });
  it('converges concurrent identical creates and refuses operation reuse for another ciphertext/tag', async () => {
    const p = await proof(); const results = await Promise.all([create(p), create(p)]);
    expect(results.map(r => r.statusCode)).toEqual([200, 200]);
    expect(results[0].json().session.id).toBe(results[1].json().session.id);
    const body = { ...createBody, tag: 'other' };
    expect((await create(await proof(body), body)).statusCode).toBe(409);
    expect(state.emitted).toHaveLength(1);
  });
  it('advertises only configured capability and keeps ordinary creation available when disabled', async () => {
    expect((await app.inject('/v1/session-ownership/capabilities')).json().sessionOwnershipV1).toBe(true);
    process.env.HAPPY_SESSION_OWNERSHIP_ENABLED = '0';
    expect((await app.inject('/v1/session-ownership/capabilities')).json().sessionOwnershipV1).toBe(false);
    expect((await create(await proof())).statusCode).toBe(503);
    const legacy = await app.inject({ method: 'POST', url: '/v1/sessions', headers: { 'x-test-account': 'personal-account' },
      payload: { tag: 'legacy', metadata: 'legacy-encrypted' } });
    expect(legacy.statusCode).toBe(200);
  });
  it('checks private machine credentials against the authoritative Happy account', async () => {
    const query = (account: string) => app.inject({ method: 'POST', url: '/v1/session-ownership/machine-identity',
      headers: { 'x-test-account': account }, payload: { machineId: 'machine-1' } });
    expect((await query('company-account')).json().machine).toEqual({ machineId: 'machine-1', accountId: 'company-account' });
    expect((await query('personal-account')).json().machine).toBeNull();
  });
});
