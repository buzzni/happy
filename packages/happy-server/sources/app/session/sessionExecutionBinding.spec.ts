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
import { sessionRoutes } from '@/app/api/routes/sessionRoutes';
import { machineSessionOwnerRoutes } from '@/app/api/routes/machineSessionOwnerRoutes';

const studio = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
const device = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(2));
let sql: string, migration: string, pg: PGlite, client: PrismaClient, app: Fastify;
const trustNames = ['HAPPY_EXECUTION_STUDIO_ORIGIN', 'HAPPY_EXECUTION_AUDIENCE', 'HAPPY_EXECUTION_STUDIO_PUBLIC_KEY'] as const;
const saved = trustNames.map(name => process.env[name]);
beforeAll(async () => {
  const require = createRequire(resolve('package.json'));
  sql = (await promisify(execFile)(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
    { env: { ...process.env, XDG_CACHE_HOME: '/tmp/happy-rotation-prisma-cache', DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused' }, maxBuffer: 1024 * 1024 })).stdout;
  migration = await readFile('prisma/migrations/20261019000000_session_execution_binding/migration.sql', 'utf8');
});
beforeEach(async () => {
  pg = new PGlite(); await pg.exec(sql);
  // Exercise the actual additive migration against preexisting owner/machine/session rows.
  await pg.exec('DROP TABLE "SessionExecutionBinding"; DROP INDEX "Session_id_accountId_key"; DROP INDEX "Machine_id_accountId_key";');
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
  const server = fastify(); server.setValidatorCompiler(validatorCompiler); server.setSerializerCompiler(serializerCompiler);
  app = server.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
  const authenticate = async (request: any, reply: any) => {
    const account = request.headers['x-test-account'];
    if (typeof account !== 'string') return reply.code(401).send({ error: 'Unauthorized' });
    request.userId = account;
    request.principal = { kind: request.headers['x-test-principal'] ?? 'account', accountId: account };
  };
  app.decorate('authenticate', authenticate); app.decorate('authenticateSessionScope', authenticate);
  sessionRoutes(app); machineSessionOwnerRoutes(app); await app.ready();
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
function create(proof: unknown, body: unknown = fixture.createBody, account: string | null = 'personal-account') {
  return app.inject({ method: 'POST', url: '/v1/sessions', headers: account ? { 'x-test-account': account } : {}, payload: { ...(body as object), executionProof: proof } });
}
function owner(sessionId: string, account = 'company-account', changes: Record<string, unknown> = {}, suffix = 'execution-owner') {
  const t = fixture.executionProof.ticket.body;
  return app.inject({ method: 'POST', url: `/v1/machine-sessions/${sessionId}/${suffix}`, headers: { 'x-test-account': account },
    payload: suffix === 'owner' ? { machineId: t.machineId } : { companyId: t.companyId, machineId: t.machineId, launchId: t.launchId, initialNonce: t.initialNonce, ...changes } });
}
async function unchanged() {
  expect(await client.session.count()).toBe(1); expect(await client.sessionExecutionBinding.count()).toBe(0);
  expect((await client.account.findUniqueOrThrow({ where: { id: 'personal-account' } })).seq).toBe(0);
  expect(state.emitted).toHaveLength(0);
}

describe('Happy execution create / lookup boundary against isolated PostgreSQL', () => {
  it('rejects repeated JSON keys before normalization can hide a conflicting signed claim', async () => {
    const proof = await signed();
    const raw = JSON.stringify({ ...fixture.createBody, executionProof: proof })
      .replace('"companyId":"company-1"', '"companyId":"other-company","companyId":"company-1"');
    const response = await app.inject({ method: 'POST', url: '/v1/sessions',
      headers: { 'x-test-account': 'personal-account', 'content-type': 'application/json' }, payload: raw });
    expect(response.statusCode).toBe(400);
    await unchanged();
  });

  it('atomically binds a new cross-account session; exact retry emits/increments once', async () => {
    const proof = await signed(); const first = await create(proof); expect(first.statusCode, first.body).toBe(200);
    const sessionId = first.json().session.id;
    const retry = await create(proof); expect(retry.statusCode).toBe(200); expect(retry.json().session.id).toBe(sessionId);
    expect(await client.sessionExecutionBinding.count()).toBe(1); expect(state.emitted).toHaveLength(1);
    expect((await client.account.findUniqueOrThrow({ where: { id: 'personal-account' } })).seq).toBe(1);
    expect((await owner(sessionId)).json()).toEqual({ owner: {
      companyId: 'company-1', machineId: 'machine-1', sessionId, launchId: 'launch-1', initialNonce: proof.ticket.body.initialNonce,
      machineOwnerAccountId: 'company-account', sessionOwnerAccountId: 'personal-account',
    } });
    expect((await owner(sessionId, 'company-account', {}, 'owner')).json()).toEqual({ owner: null });
    expect((await owner('legacy', 'personal-account', {}, 'owner')).json()).toEqual({ owner: null });
    // The original same-account endpoint still refuses this cross-account relation.
  });
  it('preserves message ACL and does not expose execution relation to another machine/account/scope', async () => {
    const first = await create(await signed()); const id = first.json().session.id;
    await client.sessionMessage.create({ data: { sessionId: id, seq: 1, content: { t: 'encrypted', c: 'private' } } });
    const messages = (account: string) => app.inject({ method: 'GET', url: `/v1/sessions/${id}/messages`, headers: { 'x-test-account': account } });
    expect((await messages('company-account')).statusCode).toBe(404);
    expect((await messages('personal-account')).json().messages).toHaveLength(1);
    for (const change of [{ machineId: 'machine-2' }, { companyId: 'other' }, { launchId: 'other' }, { initialNonce: rotationBase64url(new Uint8Array(32).fill(8)) }]) expect((await owner(id, 'company-account', change)).json()).toEqual({ owner: null });
    expect((await owner(id, 'outsider')).json()).toEqual({ owner: null });
    expect((await owner(id, 'personal-account')).json()).toEqual({ owner: null });
  });
  it.each(['metadata', 'tag', 'agentState', 'dataEncryptionKey'])('rejects altered encrypted create field %s before writes', async field => {
    expect((await create(await signed(), { ...fixture.createBody, [field]: 'altered' })).statusCode).toBe(403); await unchanged();
  });
  it('rejects forged Studio key even if the attacker supplies their own matching key ID', async () => {
    const attacker = nacl.sign.keyPair();
    const proof = await signed(undefined, { keyId: await rotationSha256(attacker.publicKey) }, {}, attacker);
    expect((await create(proof)).statusCode).toBe(403); await unchanged();
  });
  it('rejects a forged device proof and an altered signed ticket', async () => {
    expect((await create(await signed(undefined, {}, {}, studio, nacl.sign.keyPair()))).statusCode).toBe(403);
    const proof = await signed(); proof.ticket.body.launchId = 'tampered';
    expect((await create(proof)).statusCode).toBe(403); await unchanged();
  });
  it('requires original session-owner bearer and current machine-owner binding', async () => {
    const proof = await signed();
    expect((await create(proof, undefined, null)).statusCode).toBe(401);
    expect((await create(proof, undefined, 'company-account')).statusCode).toBe(403);
    expect((await create(await signed(undefined, { machineOwnerAccountId: 'outsider' }))).statusCode).toBe(403);
    expect((await create(await signed(undefined, { machineId: 'missing' }))).statusCode).toBe(403); await unchanged();
  });
  it('requires an account bearer rather than a browser-sync or session-scoped principal', async () => {
    const proof = await signed();
    for (const principal of ['browser-sync', 'managed-session']) {
    const request = { method: 'POST' as const, url: '/v1/sessions', headers: { 'x-test-account': 'personal-account', 'x-test-principal': principal }, payload: { ...fixture.createBody, executionProof: proof } };
    expect((await app.inject(request)).statusCode).toBe(403);
    const lookup = await app.inject({ method: 'POST', url: '/v1/machine-sessions/legacy/execution-owner', headers: { 'x-test-account': 'company-account', 'x-test-principal': principal }, payload: { companyId: 'company-1', machineId: 'machine-1', launchId: 'launch-1', initialNonce: proof.ticket.body.initialNonce } });
    expect(lookup.statusCode).toBe(403);
    }
    await unchanged();
  });
  it('converges concurrent exact creates to one session and one execution binding', async () => {
    const proof = await signed();
    const responses = await Promise.all([create(proof), create(proof)]);
    expect(responses.map(r => r.statusCode)).toEqual([200, 200]);
    expect(responses[0].json().session.id).toBe(responses[1].json().session.id);
    expect(await client.sessionExecutionBinding.count()).toBe(1); expect(state.emitted).toHaveLength(1);
  });
  it('fails closed with missing trust config and wrong origin/audience; legacy create is unchanged', async () => {
    const proof = await signed(); delete process.env.HAPPY_EXECUTION_STUDIO_PUBLIC_KEY;
    expect((await create(proof)).statusCode).toBe(503);
    const legacy = await app.inject({ method: 'POST', url: '/v1/sessions', headers: { 'x-test-account': 'personal-account' }, payload: { tag: 'legacy', metadata: 'ignored' } });
    expect(legacy.statusCode).toBe(200); expect(legacy.json().session.id).toBe('legacy');
    process.env.HAPPY_EXECUTION_STUDIO_PUBLIC_KEY = rotationBase64url(studio.publicKey);
    for (const change of [{ studioOrigin: 'https://attacker.example' }, { audience: 'https://other.example' }]) expect((await create(await signed(undefined, change))).statusCode).toBe(403);
    await unchanged();
  });
  it('preserves legacy new-session and same-account owner behavior with execution trust disabled', async () => {
    delete process.env.HAPPY_EXECUTION_STUDIO_PUBLIC_KEY;
    await client.machine.create({ data: { id: 'personal-machine', accountId: 'personal-account', metadata: 'encrypted' } });
    const created = await app.inject({ method: 'POST', url: '/v1/sessions', headers: { 'x-test-account': 'personal-account', 'x-test-principal': 'browser-sync' }, payload: { tag: 'plain', metadata: 'encrypted' } });
    expect(created.statusCode).toBe(200);
    expect(await client.sessionExecutionBinding.count()).toBe(0);
    const result = await app.inject({ method: 'POST', url: `/v1/machine-sessions/${created.json().session.id}/owner`, headers: { 'x-test-account': 'personal-account' }, payload: { machineId: 'personal-machine' } });
    expect(result.json()).toEqual({ owner: { ownerAccountId: 'personal-account' } });
  });
  it('rejects expired ticket/device proof, oversized TTL and unknown/null proof without fallback', async () => {
    const now = Date.now();
    expect((await create(await signed(undefined, { issuedAt: now - 60000, expiresAt: now - 1 }))).statusCode).toBe(403);
    expect((await create(await signed(undefined, {}, { issuedAt: now - 60000, expiresAt: now - 1 }))).statusCode).toBe(403);
    const proof = await signed(); proof.ticket.body.expiresAt = proof.ticket.body.issuedAt + 60001;
    expect((await create(proof)).statusCode).toBe(400);
    expect((await create(null)).statusCode).toBe(400);
    expect((await create(await signed(), { ...fixture.createBody, extra: true })).statusCode).toBe(400); await unchanged();
  });
  it('never attaches to a preexisting legacy session even with a valid ticket for its tag', async () => {
    const body = { ...fixture.createBody, tag: 'legacy' };
    expect((await create(await signed(body), body)).statusCode).toBe(409); await unchanged();
  });
  it('allows only exact replay; rejects new proof, altered body, replayed launch/nonce/operation and changed owner', async () => {
    const proof = await signed(); expect((await create(proof)).statusCode).toBe(200);
    const other = { ...fixture.createBody, tag: 'another' };
    const nonce = rotationBase64url(new Uint8Array(32).fill(9));
    for (const changes of [
      { initialNonce: nonce, operationId: 'new-op' }, // same launch
      { launchId: 'new-launch', operationId: 'new-op' }, // same initial nonce
      { launchId: 'new-launch', initialNonce: nonce }, // same operation
      { sessionOwnerAccountId: 'outsider' },
    ]) {
      const account = changes.sessionOwnerAccountId ?? 'personal-account';
      expect((await create(await signed(other, changes), other, account)).statusCode).toBe(409);
    }
    expect((await create(await signed(undefined, { approvalId: 'approval-2' }))).statusCode).toBe(409);
    expect(await client.session.count()).toBe(2); expect(await client.sessionExecutionBinding.count()).toBe(1);
  });
  it('rolls back session, binding, sequence and notification together on a failed binding insert', async () => {
    await pg.exec('ALTER TABLE "SessionExecutionBinding" ADD CONSTRAINT fail_test CHECK ("companyId" <> \'company-1\');');
    expect((await create(await signed())).statusCode).toBe(500); await unchanged();
  });
  it('keeps replay evidence through deletion; tombstones cannot be queried or recreated', async () => {
    const proof = await signed(); const first = await create(proof); const id = first.json().session.id;
    await client.session.delete({ where: { id } });
    const binding = await client.sessionExecutionBinding.findUniqueOrThrow({ where: { sessionId: id } });
    expect(binding.sessionRowId).toBeNull(); expect(binding.sessionId).toBe(id);
    expect((await owner(id)).json()).toEqual({ owner: null });
    expect((await create(proof)).statusCode).toBe(409);
    expect(await client.session.count()).toBe(1);
  });
  it('denies owner lookup/replay after machine deletion/recreation and preserves original unique evidence', async () => {
    const proof = await signed(); const id = (await create(proof)).json().session.id;
    await client.machine.delete({ where: { id: 'machine-1' } });
    await client.machine.create({ data: { id: 'machine-1', accountId: 'company-account', metadata: 'replacement' } });
    expect((await owner(id)).json()).toEqual({ owner: null });
    expect((await create(proof)).statusCode).toBe(409);
  });
  it('accepts exact replay after mutable metadata changes without rebinding the original hashes', async () => {
    const proof = await signed(); const id = (await create(proof)).json().session.id;
    await client.session.update({ where: { id }, data: { metadata: 'new-ciphertext' } });
    const retry = await create(proof); expect(retry.statusCode).toBe(200); expect(retry.json().session.metadata).toBe('new-ciphertext');
    expect(await client.sessionExecutionBinding.count()).toBe(1);
  });
});
