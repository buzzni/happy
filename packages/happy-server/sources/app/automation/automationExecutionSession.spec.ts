import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify } from '@/app/api/types';
import { sessionCreateBodyHash, automationExecutionSessionId } from '@slopus/happy-wire';
import { signAutomationExecutionTarget } from '@slopus/happy-wire/automationExecutionToken';

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock('@/storage/db', () => ({ db: new Proxy({}, { get: (_target, key) => {
  const value = state.client[key];
  return typeof value === 'function' ? value.bind(state.client) : value;
} }) }));
import { createAutomationExecutionSession } from './automationExecutionSession';
import { reportAutomationRun } from './automationExecutionService';
import { automationExecutionRoutes } from '@/app/api/routes/automationExecutionRoutes';

let now: Date;
const secret = 'automation-target-test-secret-at-least-thirty-two-bytes';
const bearer = 'machine-account-bearer';
let sql: string, db: PGlite, client: PrismaClient;
beforeAll(async () => {
  const require = createRequire(resolve('package.json'));
  sql = (await promisify(execFile)(process.execPath, [require.resolve('prisma/build/index.js'),
    'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
  { env: { ...process.env, DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused' }, maxBuffer: 1024 * 1024 })).stdout;
});
beforeEach(async () => {
  now = new Date();
  vi.stubEnv('SAYCODE_AUTOMATION_ENABLED', 'true');
  vi.stubEnv('SCRIPT_AUTOMATION_ADMISSION_SECRET', secret);
  db = new PGlite(); await db.exec(sql);
  client = new PrismaClient({ adapter: new PrismaPGlite(db) }); state.client = client;
  await client.account.createMany({ data: [{ id: 'owner', publicKey: 'owner' }, { id: 'other', publicKey: 'other' }] });
  await client.project.create({ data: { id: 'chat:c1', accountId: 'owner', name: 'Chat',
    config: { machineId: 'm1' }, automationViewerKeyVersion: 1 } });
  await client.machine.create({ data: { id: 'm1', accountId: 'owner', metadata: '', automationKeyVersion: 1,
    automationProtocolVersion: 7 } });
  await client.automation.create({ data: { id: 'a1', projectId: 'chat:c1', ownerAccountId: 'owner',
    machineAccountId: 'owner', machineId: 'm1', payloadVersion: 6, payloadCiphertext: new Uint8Array([1]),
    viewerKeyId: 'k', viewerKeyVersion: 1, viewerKeyEnvelope: new Uint8Array([1]), machineKeyVersion: 1,
    machineKeyEnvelope: new Uint8Array([1]) } });
  await client.session.create({ data: { id: 'manual', accountId: 'owner', tag: 'manual',
    metadata: 'existing-manual-provider-and-title', agentState: 'existing-user-queue', seq: 3 } });
  await client.sessionMessage.create({ data: { sessionId: 'manual', localId: 'manual-pending', seq: 3,
    content: { t: 'encrypted', c: 'manual-queue-ciphertext' } } });
  await run('r1');
});
afterEach(async () => { await client?.$disconnect(); await db?.close(); state.client = null; vi.unstubAllEnvs(); });
async function run(id: string) {
  await client.automationRun.create({ data: { id, automationId: 'a1', generation: 1,
    scheduledFor: new Date(now.getTime() + Number(id.slice(1)) * 1000), machineAccountId: 'owner', machineId: 'm1',
    status: 'RUNNING', claimTokenHash: new Uint8Array(createHash('sha256').update(`claim-${id}`).digest()),
    claimExpiresAt: new Date(now.getTime() + 60_000), runLeaseExpiresAt: new Date(now.getTime() + 60_000) } });
}
async function request(runId = 'r1', patch: Record<string, unknown> = {}) {
  const body = { tag: automationExecutionSessionId(runId), metadata: `encrypted-new-context-${runId}`,
    agentState: 'encrypted-empty-state', dataEncryptionKey: Buffer.alloc(105, 1).toString('base64') };
  const proof = await targetProof({ runId, displaySessionId: 'manual', body, executionBindingRequired: false });
  return { runId, machineId: 'm1', claimToken: `claim-${runId}`, displaySessionId: 'manual', body,
    executionBindingRequired: false, targetProof: proof, ...patch };
}
async function targetProof(input: { runId: string; displaySessionId: string;
  body: { tag: string; metadata: string; agentState: string; dataEncryptionKey: string }; executionBindingRequired: boolean }) {
  return signAutomationExecutionTarget({ automationId: 'a1', projectId: 'chat:c1', runId: input.runId,
    generation: 1, revision: 1, machineId: 'm1', machineAccountId: 'owner', displaySessionId: input.displaySessionId,
    executionBindingRequired: input.executionBindingRequired, createBodyHash: await sessionCreateBodyHash(input.body),
    secret, bearer, now: now.getTime() });
}
async function register(runId = 'r1', patch: Record<string, unknown> = {}) {
  return createAutomationExecutionSession('owner', bearer, await request(runId, patch), { secret, now });
}

async function api() {
  const server = fastify(); server.setValidatorCompiler(validatorCompiler); server.setSerializerCompiler(serializerCompiler);
  const app = server.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
  app.decorate('authenticate', async (request: any, reply: any) => {
    if (request.headers.authorization !== `Bearer ${bearer}`) return reply.code(401).send({ error: 'Unauthorized' });
    request.userId = 'owner'; request.principal = { kind: request.headers['x-test-principal'] ?? 'account', accountId: 'owner' };
  });
  automationExecutionRoutes(app); await app.ready(); return app;
}

it('registers and reconciles the same run through the authenticated HTTP path', async () => {
  const app = await api();
  try {
    const { runId, ...payload } = await request();
    const send = () => app.inject({ method: 'POST', url: `/v1/automation-runs/${runId}/execution-session`,
      headers: { authorization: `Bearer ${bearer}` }, payload });
    const first = await send(); expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ sessionId: 'automation-run:r1', displaySessionId: 'manual', created: true });
    const replay = await send(); expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ sessionId: first.json().sessionId, created: false });
    expect(await client.session.count()).toBe(2);
    expect((await client.session.findUniqueOrThrow({ where: { id: 'manual' } })).seq).toBe(3);
  } finally { await app.close(); }
});

it('rejects unauthenticated, limited-principal, wrong-claim and duplicate-key HTTP requests before creation', async () => {
  const app = await api();
  try {
    const { runId, ...payload } = await request();
    const url = `/v1/automation-runs/${runId}/execution-session`;
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${bearer}`, 'x-test-principal': 'browser-sync' }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${bearer}` }, payload: { ...payload, claimToken: 'wrong' } })).statusCode).toBe(403);
    const raw = JSON.stringify(payload).replace('"displaySessionId":"manual"', '"displaySessionId":"other","displaySessionId":"manual"');
    expect((await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, payload: raw })).statusCode).toBe(400);
    expect(await client.session.count()).toBe(1);
  } finally { await app.close(); }
});

it('registers two run-owned contexts against one display session without changing its provider or pending input', async () => {
  const manual = await client.session.findUniqueOrThrow({ where: { id: 'manual' } });
  const first = await register(); await run('r2'); const second = await register('r2');
  expect(first).toMatchObject({ created: true, session: { id: 'automation-run:r1', seq: 0 } });
  expect(second).toMatchObject({ created: true, session: { id: 'automation-run:r2', seq: 0 } });
  expect(await client.session.findUniqueOrThrow({ where: { id: 'manual' } })).toEqual(manual);
  expect(await client.sessionMessage.count()).toBe(1);
  const runs = await client.automationRun.findMany({ orderBy: { id: 'asc' } });
  expect(runs.map(row => [row.id, row.sessionId, row.displaySessionId])).toEqual([
    ['r1', 'automation-run:r1', 'manual'], ['r2', 'automation-run:r2', 'manual'],
  ]);
});

it('reads run records from the original display chat with stable pagination and no claim secrets', async () => {
  await register(); await run('r2'); await register('r2');
  const app = await api();
  try {
    const first = await app.inject({ method: 'GET', url: '/v1/sessions/manual/automation-runs?limit=1',
      headers: { authorization: `Bearer ${bearer}` } });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const page = first.json();
    expect(page.runs).toEqual([expect.objectContaining({ id: 'r2', displaySessionId: 'manual', executionSessionId: 'automation-run:r2',
      schedulerStatus: 'RUNNING' })]);
    expect(page.nextCursor).toEqual(expect.any(String));
    for (const secret of ['claimTokenHash', 'claim-r2', 'executionCreateBodyHash', 'payloadCiphertext', 'encrypted-new-context-r2']) expect(first.body).not.toContain(secret);
    const second = await app.inject({ method: 'GET', url: `/v1/sessions/manual/automation-runs?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
      headers: { authorization: `Bearer ${bearer}` } });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ runs: [{ id: 'r1' }], nextCursor: null });
    expect((await client.session.findUniqueOrThrow({ where: { id: 'manual' } })).seq).toBe(3);
    expect(await client.sessionMessage.count()).toBe(1);
  } finally { await app.close(); }
});

it('does not expose run records through a foreign display chat, internal ID or lost project access', async () => {
  await register();
  await client.session.create({ data: { id: 'foreign', accountId: 'other', tag: 'foreign', metadata: '' } });
  const app = await api();
  try {
    for (const displayId of ['foreign', 'automation-run:r1', 'missing']) {
      const response = await app.inject({ method: 'GET', url: `/v1/sessions/${displayId}/automation-runs`,
        headers: { authorization: `Bearer ${bearer}` } });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.body).not.toContain('r1');
    }
    await client.project.update({ where: { id: 'chat:c1' }, data: { accountId: 'other' } });
    const response = await app.inject({ method: 'GET', url: '/v1/sessions/manual/automation-runs',
      headers: { authorization: `Bearer ${bearer}` } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ runs: [], nextCursor: null });
  } finally { await app.close(); }
});

it('returns the same immutable session on an unknown registration ACK without creating a second context', async () => {
  const first = await register(); const replay = await register();
  expect(replay).toMatchObject({ created: false, session: { id: first.session.id, metadata: first.session.metadata } });
  expect(await client.session.count()).toBe(2);
});

function report(sessionId: string | null, patch: Record<string, unknown> = {}) {
  return { runId: 'r1', claimToken: 'claim-r1', reportId: 'receipt-r1', status: 'COMPLETED' as const,
    outcome: 'WOKE' as const, sessionId, detailCiphertext: null, failureCode: null, ...patch };
}

it.each(['manual', null])('does not replace a registered execution with report target %s', async sessionId => {
  await register();
  const input = sessionId ? report(sessionId) : report(null, { status: 'FAILED', outcome: 'ERROR', failureCode: 'START_FAILED' });
  await expect(reportAutomationRun(client, 'owner', 'm1', input, now))
    .resolves.toEqual({ ok: false, error: 'report-conflict' });
  expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } }))
    .toMatchObject({ sessionId: 'automation-run:r1', displaySessionId: 'manual', reportId: null, status: 'RUNNING' });
});

it('keeps the registered execution identity after definition edits and on report ACK replay', async () => {
  await register();
  await client.automation.update({ where: { id: 'a1' }, data: { payloadVersion: 4, generation: 2 } });
  await expect(reportAutomationRun(client, 'owner', 'm1', report('automation-run:r1'), now))
    .resolves.toMatchObject({ ok: true, value: { idempotent: false } });
  await expect(reportAutomationRun(client, 'owner', 'm1', report('manual'), now))
    .resolves.toEqual({ ok: false, error: 'report-conflict' });
  await expect(reportAutomationRun(client, 'owner', 'm1', report('automation-run:r1'), now))
    .resolves.toMatchObject({ ok: true, value: { idempotent: true } });
});

it('requires registration before a v6 report can name an execution', async () => {
  await expect(reportAutomationRun(client, 'owner', 'm1', report('manual'), now))
    .resolves.toEqual({ ok: false, error: 'report-conflict' });
  await expect(reportAutomationRun(client, 'owner', 'm1', report(null, {
    status: 'FAILED', outcome: 'ERROR', failureCode: 'ISOLATED_CONTEXT_UNSUPPORTED',
  }), now)).resolves.toMatchObject({ ok: true });
});

it('applies the additive migration without changing legacy definitions, runs or manual messages', async () => {
  await client.automation.update({ where: { id: 'a1' }, data: { payloadVersion: 4 } });
  await client.automationRun.update({ where: { id: 'r1' }, data: { sessionId: 'manual', status: 'COMPLETED', outcome: 'WOKE' } });
  const definition = await client.automation.findUniqueOrThrow({ where: { id: 'a1' } });
  const legacy = await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } });
  const manual = await client.session.findUniqueOrThrow({ where: { id: 'manual' } });
  const messages = await client.sessionMessage.findMany();
  await db.exec('DROP INDEX "AutomationRun_displaySessionId_createdAt_idx"; ALTER TABLE "AutomationRun" DROP COLUMN "displaySessionId", DROP COLUMN "executionCreateBodyHash", DROP COLUMN "executionSeedMetadata";');
  await db.exec(await readFile('prisma/migrations/20261104080000_automation_execution_display_target/migration.sql', 'utf8'));
  expect(await client.automation.findUniqueOrThrow({ where: { id: 'a1' } })).toEqual(definition);
  expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } }))
    .toEqual({ ...legacy, displaySessionId: null, executionCreateBodyHash: null, executionSeedMetadata: null });
  expect(await client.session.findUniqueOrThrow({ where: { id: 'manual' } })).toEqual(manual);
  expect(await client.sessionMessage.findMany()).toEqual(messages);
});

it('reconciles an original creation receipt after provider metadata and agent state have changed', async () => {
  const first = await register();
  const originalMetadata = first.session.metadata;
  await client.session.update({ where: { id: first.session.id }, data: {
    metadata: 'encrypted-provider-native-id-and-title', agentState: 'encrypted-running-state', seq: 4,
  } });
  await expect(register()).resolves.toMatchObject({ created: false, session: {
    id: first.session.id, metadata: 'encrypted-provider-native-id-and-title', seq: 4,
  } });
  expect(await client.session.count()).toBe(2);
  expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } }))
    .toHaveProperty('executionSeedMetadata', originalMetadata);
});

it('reads only run-owned encrypted evidence with a fixed sequence ceiling and immutable seed', async () => {
  const registered = await register();
  const execution = registered.session.id;
  await client.sessionMessage.createMany({ data: [
    { sessionId: execution, seq: 1, localId: 'automation-seed:r1', content: { t: 'encrypted', c: 'question-ciphertext' } },
    { sessionId: execution, seq: 2, localId: 'automation-evidence:r1:start', content: { t: 'encrypted', c: 'start-ciphertext' } },
    { sessionId: execution, seq: 3, localId: 'tool-output', content: { t: 'encrypted', c: 'PRIVATE_TOOL_HISTORY' } },
    { sessionId: execution, seq: 4, localId: 'automation-evidence:r1:final', content: { t: 'encrypted', c: 'final-ciphertext' } },
    { sessionId: execution, seq: 5, localId: 'automation-evidence:r1:end', content: { t: 'encrypted', c: 'end-ciphertext' } },
  ] });
  await client.session.update({ where: { id: execution }, data: { seq: 5, metadata: 'mutable-native-id' } });
  const app = await api();
  try {
    const get = (query = '') => app.inject({ method: 'GET', url: `/v1/sessions/manual/automation-runs/r1/evidence${query}`,
      headers: { authorization: `Bearer ${bearer}` } });
    const first = await get('?limit=1'); expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.json()).toMatchObject({ runId: 'r1', executionSessionId: execution, displaySessionId: 'manual',
      seedManifestCiphertext: registered.session.metadata, dataEncryptionKey: Buffer.alloc(105, 1).toString('base64'),
      seedMessage: { seq: 1, localId: 'automation-seed:r1', content: { c: 'question-ciphertext' } },
      throughSeq: 5, nextAfterSeq: 2, messages: [{ seq: 2, localId: 'automation-evidence:r1:start' }] });
    await client.sessionMessage.create({ data: { sessionId: execution, seq: 6, localId: 'automation-evidence:r1:later',
      content: { t: 'encrypted', c: 'later-turn-ciphertext' } } });
    await client.session.update({ where: { id: execution }, data: { seq: 6 } });
    const rest = await get('?after_seq=2&through_seq=5&limit=2'); expect(rest.statusCode, rest.body).toBe(200);
    expect(rest.json()).toMatchObject({ throughSeq: 5, nextAfterSeq: null, seedMessage: null, messages: [{ seq: 4 }, { seq: 5 }] });
    for (const text of ['PRIVATE_TOOL_HISTORY', 'later-turn-ciphertext', 'mutable-native-id', 'claim-r1']) {
      expect(first.body + rest.body).not.toContain(text);
    }
    expect((await get('?through_seq=999')).statusCode).toBe(400);
    expect((await get('?after_seq=4&through_seq=3')).statusCode).toBe(400);
    expect((await client.session.findUniqueOrThrow({ where: { id: 'manual' } })).seq).toBe(3);
    expect((await client.sessionMessage.findMany({ where: { sessionId: 'manual' } })).map(row => row.localId)).toEqual(['manual-pending']);
  } finally { await app.close(); }
});

it('rechecks run, display and project ownership on every evidence page', async () => {
  await register();
  await client.session.create({ data: { id: 'other-display', accountId: 'owner', tag: 'other-display', metadata: '' } });
  const app = await api();
  try {
    const get = (display = 'manual', runId = 'r1', principal = 'account') => app.inject({ method: 'GET',
      url: `/v1/sessions/${display}/automation-runs/${runId}/evidence`,
      headers: { authorization: `Bearer ${bearer}`, 'x-test-principal': principal } });
    expect((await get()).statusCode).toBe(200);
    expect((await get('other-display')).statusCode).toBe(404);
    expect((await get('automation-run:r1')).statusCode).toBe(404);
    expect((await get('manual', 'missing')).statusCode).toBe(404);
    expect((await get('manual', 'r1', 'browser-sync')).statusCode).toBe(403);
    await client.project.update({ where: { id: 'chat:c1' }, data: { accountId: 'other' } });
    expect((await get()).statusCode).toBe(404);
  } finally { await app.close(); }
});

it('does not redefine the creation receipt from current mutable provider metadata', async () => {
  const first = await register(); const input = await request();
  input.body.metadata = 'encrypted-provider-native-id-and-title';
  await client.session.update({ where: { id: first.session.id }, data: { metadata: input.body.metadata } });
  input.targetProof = await targetProof(input);
  await expect(createAutomationExecutionSession('owner', bearer, input, { secret, now }))
    .rejects.toMatchObject({ statusCode: 409 });
  expect(await client.session.count()).toBe(2);
});

it('does not accept another valid display target after the first registration', async () => {
  await register();
  await client.session.create({ data: { id: 'manual-2', accountId: 'owner', tag: 'manual-2', metadata: 'other-manual-context' } });
  const input = await request(); input.displaySessionId = 'manual-2'; input.targetProof = await targetProof(input);
  await expect(createAutomationExecutionSession('owner', bearer, input, { secret, now }))
    .rejects.toMatchObject({ statusCode: 409 });
  expect((await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } })).displaySessionId).toBe('manual');
});

it('does not redirect a registered run or overwrite its encrypted creation body', async () => {
  await register();
  await expect(register('r1', { displaySessionId: 'other-target' })).rejects.toMatchObject({ statusCode: 403 });
  const input = await request();
  input.body.metadata = 'changed-body';
  await expect(createAutomationExecutionSession('owner', bearer, input, { secret, now }))
    .rejects.toMatchObject({ statusCode: 403 });
  expect(await client.session.count()).toBe(2);
});

it.each(['paused', 'generation', 'key', 'expired', 'wrong-claim', 'display-owner', 'legacy-policy'])(
  'refuses %s before retaining an execution session', async reason => {
    if (reason === 'paused') await client.automation.update({ where: { id: 'a1' }, data: { paused: true } });
    if (reason === 'generation') await client.automation.update({ where: { id: 'a1' }, data: { generation: 2 } });
    if (reason === 'key') await client.machine.update({ where: { accountId_id: { accountId: 'owner', id: 'm1' } }, data: { automationKeyVersion: 2 } });
    if (reason === 'expired') await client.automationRun.update({ where: { id: 'r1' }, data: { runLeaseExpiresAt: new Date(0) } });
    if (reason === 'display-owner') await client.session.update({ where: { id: 'manual' }, data: { accountId: 'other' } });
    if (reason === 'legacy-policy') await client.automation.update({ where: { id: 'a1' }, data: { payloadVersion: 4 } });
    await expect(register('r1', reason === 'wrong-claim' ? { claimToken: 'wrong' } : {})).rejects.toMatchObject({ statusCode: 403 });
    expect(await client.session.count()).toBe(1);
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } })).toMatchObject({ sessionId: null, displaySessionId: null });
  });

it('does not downgrade a required execution binding into ordinary session creation', async () => {
  const input = await request(); input.executionBindingRequired = true;
  input.targetProof = await targetProof(input);
  await expect(createAutomationExecutionSession('owner', bearer, input, { secret, now })).rejects.toMatchObject({ statusCode: 403 });
  expect(await client.session.count()).toBe(1);
});
