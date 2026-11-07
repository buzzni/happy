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
import nacl from 'tweetnacl';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify } from '@/app/api/types';
import { sessionCreateBodyHash, sessionTagHash, automationExecutionSessionId, signRotationDocument,
  rotationDigest, rotationSha256, rotationBase64url, sessionExecutionAuthorityDigest, SessionExecutionTicketBodySchema, HappySessionCreateProofBodySchema } from '@slopus/happy-wire';
import { signAutomationExecutionTarget } from '@slopus/happy-wire/automationExecutionToken';

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock('@/storage/db', () => ({ db: new Proxy({}, { get: (_target, key) => {
  const value = state.client[key];
  return typeof value === 'function' ? value.bind(state.client) : value;
} }) }));
import { createAutomationExecutionSession, recordAutomationExecutionExit } from './automationExecutionSession';
import { claimAutomationRun, heartbeatAutomationRun, registerAutomationMachineKey, reportAutomationRun, resolveAutomationRunMcpContext, startAutomationRun, syncAutomations } from './automationExecutionService';
import { createRegisteredAutomation, getAutomationTarget, updateAutomation } from './automationService';
import { automationExecutionRoutes } from '@/app/api/routes/automationExecutionRoutes';
import { transitionChatAutomations } from './automationChatLifecycle';
import { queueAutomationExecutionQuestion } from './automationExecutionQuestionService';

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
  await db.exec(`CREATE UNIQUE INDEX "AutomationRun_scheduled_slot" ON "AutomationRun"("automationId", "generation", "scheduledFor") WHERE "kind" = 'SCHEDULED'`);
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

it('migrates readiness as unsupported without changing existing manual or automation records', async () => {
  const machine = await client.machine.findUniqueOrThrow({ where: { id: 'm1' } });
  const automation = await client.automation.findUniqueOrThrow({ where: { id: 'a1' } });
  const manual = await client.session.findUniqueOrThrow({ where: { id: 'manual' } });
  await db.exec('ALTER TABLE "Machine" DROP COLUMN "automationContextIsolationVersion";');
  await db.exec(await readFile('prisma/migrations/20261107010000_automation_context_capability/migration.sql', 'utf8'));
  expect(await client.machine.findUniqueOrThrow({ where: { id: 'm1' } })).toEqual({ ...machine, automationContextIsolationVersion: 0 });
  expect(await client.automation.findUniqueOrThrow({ where: { id: 'a1' } })).toEqual(automation);
  expect(await client.session.findUniqueOrThrow({ where: { id: 'manual' } })).toEqual(manual);
});

it('registers one isolated reservation and fences a claimed start when an older daemon replaces readiness', async () => {
  const publicKey = new Uint8Array(32).fill(3);
  await client.project.update({ where: { id: 'chat:c1' }, data: { automationViewerPublicKey: publicKey } });
  await client.machine.update({ where: { id: 'm1' }, data: { automationPublicKey: publicKey } });
  const key = { expectedKeyVersion: 1, publicKey, protocolVersion: 4, contextIsolationVersion: 1 as const };
  expect(await registerAutomationMachineKey(client, 'owner', 'm1', key)).toMatchObject({ ok: true, value: { keyVersion: 1 } });
  expect(await getAutomationTarget(client, 'owner', 'chat:c1')).toMatchObject({ ok: true, value: { contextIsolationVersion: 1 } });
  const input = { payloadVersion: 6, payloadCiphertext: new Uint8Array([2]), viewerKeyId: 'k', viewerKeyVersion: 1,
    viewerKeyEnvelope: publicKey, machineKeyVersion: 1, machineKeyEnvelope: publicKey, paused: true };
  const created = await createRegisteredAutomation(client, 'owner', 'chat:c1', 'isolated-register-1', input);
  if (!created.ok) throw new Error(created.error);
  const retry = await createRegisteredAutomation(client, 'owner', 'chat:c1', 'isolated-register-1', input);
  expect(retry).toEqual(created);
  const enabled = await updateAutomation(client, 'owner', 'chat:c1', created.value.id, { expectedRevision: created.value.revision, paused: false });
  if (!enabled.ok) throw new Error(enabled.error);
  expect(await syncAutomations(client, 'owner', 'm1', { afterSeq: 0n, limit: 100, payloadVersions: [1, 4, 6] }))
    .toMatchObject({ ok: true, value: { changes: expect.arrayContaining([expect.objectContaining({ automationId: created.value.id, kind: 'UPSERT', payloadVersion: 6 })]) } });
  const claimed = await claimAutomationRun(client, 'owner', 'm1', { automationId: created.value.id,
    generation: enabled.value.generation, scheduledFor: new Date() });
  if (!claimed.ok) throw new Error(claimed.error);
  const { contextIsolationVersion: _supported, ...oldKey } = key;
  expect(await registerAutomationMachineKey(client, 'owner', 'm1', oldKey)).toMatchObject({ ok: true, value: { keyVersion: 1, targetChanged: true } });
  expect(await getAutomationTarget(client, 'owner', 'chat:c1')).toMatchObject({ ok: true, value: { contextIsolationVersion: 0 } });
  expect(await startAutomationRun(client, 'owner', 'm1', { runId: claimed.value.runId, claimToken: claimed.value.claimToken }))
    .toMatchObject({ ok: false });
  const unsupported = await syncAutomations(client, 'owner', 'm1', { afterSeq: 0n, limit: 100, payloadVersions: [1, 4, 6] });
  if (!unsupported.ok) throw new Error(unsupported.error);
  expect(unsupported.value.changes.every(row => row.kind === 'TOMBSTONE')).toBe(true);
  const restored = await registerAutomationMachineKey(client, 'owner', 'm1', key);
  expect(restored).toMatchObject({ ok: true, value: { contextIsolationVersion: 1, syncFromStart: true } });
  expect((await registerAutomationMachineKey(client, 'owner', 'm1', key))).toMatchObject({ ok: true, value: { contextIsolationVersion: 1, syncFromStart: true, targetChanged: false } });
  expect(await syncAutomations(client, 'owner', 'm1', { afterSeq: 0n, limit: 100, payloadVersions: [1, 4, 6] }))
    .toMatchObject({ ok: true, value: { changes: expect.arrayContaining([expect.objectContaining({ automationId: created.value.id,
      kind: 'UPSERT', payloadVersion: 6, revision: enabled.value.revision, generation: enabled.value.generation })]) } });
  expect(await client.session.count()).toBe(1);
  expect(await client.sessionMessage.count({ where: { sessionId: 'manual' } })).toBe(1);
});
async function request(runId = 'r1', patch: Record<string, unknown> = {}) {
  const body = { tag: automationExecutionSessionId(runId), metadata: `encrypted-new-context-${runId}`,
    agentState: 'encrypted-empty-state', dataEncryptionKey: Buffer.alloc(105, 1).toString('base64') };
  const proof = await targetProof({ runId, displaySessionId: 'manual', body, executionBindingRequired: false });
  return { runId, machineId: 'm1', claimToken: `claim-${runId}`, displaySessionId: 'manual', body,
    executionBindingRequired: false, targetProof: proof, ...patch };
}
async function targetProof(input: { runId: string; displaySessionId: string;
  body: { tag: string; metadata: string; agentState: string; dataEncryptionKey: string }; executionBindingRequired: boolean; executionAuthorityDigest?: string }) {
  return signAutomationExecutionTarget({ automationId: 'a1', projectId: 'chat:c1', runId: input.runId,
    generation: 1, revision: 1, machineId: 'm1', machineAccountId: 'owner', displaySessionId: input.displaySessionId,
    executionBindingRequired: input.executionBindingRequired, createBodyHash: await sessionCreateBodyHash(input.body),
    ...(input.executionAuthorityDigest !== undefined ? { executionAuthorityDigest: input.executionAuthorityDigest } : {}),
    secret, bearer, now: now.getTime() });
}
async function register(runId = 'r1', patch: Record<string, unknown> = {}) {
  return createAutomationExecutionSession('owner', bearer, await request(runId, patch), { secret, now });
}

async function boundRequest(ticketMachineId = 'm1') {
  const studio = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
  const device = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(2));
  vi.stubEnv('HAPPY_EXECUTION_STUDIO_ORIGIN', 'https://studio.test');
  vi.stubEnv('HAPPY_EXECUTION_AUDIENCE', 'https://happy.test');
  vi.stubEnv('HAPPY_EXECUTION_STUDIO_PUBLIC_KEY', rotationBase64url(studio.publicKey));
  const input = await request();
  input.executionBindingRequired = true;
  input.targetProof = await targetProof({ runId: 'r1', displaySessionId: 'manual', body: input.body, executionBindingRequired: true });
  const hashes = { sessionTagHash: await sessionTagHash(input.body.tag), sessionCreateBodyHash: await sessionCreateBodyHash(input.body) };
  const ticket = await signRotationDocument(SessionExecutionTicketBodySchema.parse({ version: 1, type: 'saycode-session-execution',
    audience: 'https://happy.test', studioOrigin: 'https://studio.test', keyId: await rotationSha256(studio.publicKey),
    companyId: 'company-1', machineId: ticketMachineId, approvalId: 'approval-1', deviceKeyId: await rotationSha256(device.publicKey),
    machineOwnerAccountId: 'owner', sessionOwnerAccountId: 'owner', launchId: 'launch-1', initialNonce: rotationBase64url(new Uint8Array(32).fill(3)),
    operationId: 'operation-1', deviceSigningPublicKey: rotationBase64url(device.publicKey), ...hashes,
    issuedAt: now.getTime(), expiresAt: now.getTime() + 60000 }), studio.secretKey);
  const deviceProof = await signRotationDocument(HappySessionCreateProofBodySchema.parse({ version: 1, type: 'happy-session-create-proof',
    audience: 'https://happy.test', method: 'POST', path: '/v1/sessions', ticketDigest: await rotationDigest(ticket),
    sessionOwnerAccountId: 'owner', ...hashes, issuedAt: now.getTime(), expiresAt: now.getTime() + 60000 }), device.secretKey);
  const { companyId, approvalId, deviceKeyId, launchId, operationId, initialNonce } = ticket.body;
  const executionAuthorityDigest = await sessionExecutionAuthorityDigest(ticket.body);
  const proof = await targetProof({ runId: 'r1', displaySessionId: 'manual', body: input.body, executionBindingRequired: true, executionAuthorityDigest });
  return { input: { ...input, executionAuthorityDigest, targetProof: proof, executionProof: { ticket, deviceProof } },
    recoveryIdentity: { companyId, approvalId, deviceKeyId, launchId, operationId, initialNonce } };
}

it('refuses another approved machine ticket instead of combining two independent machine authorities', async () => {
  await client.machine.create({ data: { id: 'm2', accountId: 'owner', metadata: '' } });
  const { input } = await boundRequest('m2');
  const { runId, ...payload } = input;
  const app = await api();
  try {
    const result = await app.inject({ method: 'POST', url: `/v1/automation-runs/${runId}/execution-session`,
      headers: { authorization: `Bearer ${bearer}` }, payload });
    expect(result.statusCode, result.body).toBe(403);
    expect(await client.session.count()).toBe(1);
    expect(await client.sessionExecutionBinding.count()).toBe(0);
  } finally { await app.close(); }
});

it.each(['missing', 'different'] as const)('refuses a company target with a different original authority digest: %s', async mismatch => {
  const { input } = await boundRequest();
  const executionAuthorityDigest = mismatch === 'missing' ? undefined : 'f'.repeat(64);
  const target = await targetProof({ runId: input.runId, displaySessionId: input.displaySessionId, body: input.body,
    executionBindingRequired: true, executionAuthorityDigest });
  const { runId, ...payload } = { ...input, executionAuthorityDigest, targetProof: target };
  const app = await api();
  try {
    const result = await app.inject({ method: 'POST', url: `/v1/automation-runs/${runId}/execution-session`,
      headers: { authorization: `Bearer ${bearer}` }, payload });
    expect(result.statusCode, result.body).toBe(403);
    expect(await client.session.count()).toBe(1); expect(await client.sessionExecutionBinding.count()).toBe(0);
  } finally { await app.close(); }
});

it.each([false, true])('recovers only the original registered run without reissuing an expired company proof (bound=%s)', async bound => {
  const prepared = bound ? await boundRequest() : { input: await request(), recoveryIdentity: null };
  await createAutomationExecutionSession('owner', bearer, prepared.input, { secret, now });
  const { runId, executionProof: _proof, ...payload } = prepared.input as typeof prepared.input & { executionProof?: unknown; executionAuthorityDigest?: string };
  const before = await client.session.findMany(), app = await api();
  try {
    if (bound) {
      now = new Date(now.getTime() + 61000);
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
      await client.automationRun.update({ where: { id: runId }, data: { runLeaseExpiresAt: new Date(now.getTime() + 60000) } });
      payload.targetProof = await targetProof({ runId, displaySessionId: 'manual', body: payload.body, executionBindingRequired: true,
        executionAuthorityDigest: payload.executionAuthorityDigest });
      await expect(createAutomationExecutionSession('owner', bearer, { ...prepared.input, targetProof: payload.targetProof }, { secret, now }))
        .rejects.toMatchObject({ statusCode: 403 });
    }
    const result = await app.inject({ method: 'POST', url: `/v1/automation-runs/${runId}/execution-session/recover`,
      headers: { authorization: `Bearer ${bearer}` }, payload: { ...payload, recoveryIdentity: prepared.recoveryIdentity } });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual({ status: 'REGISTERED', sessionId: 'automation-run:r1', displaySessionId: 'manual',
      createBodyHash: await sessionCreateBodyHash(payload.body) });
    expect(await client.session.findMany()).toEqual(before);
  } finally { vi.useRealTimers(); await app.close(); }
});

it('proves an unregistered recovery only after claim and current target authorization', async () => {
  const { runId, ...payload } = await request(), app = await api();
  try {
    const send = (value: unknown) => app.inject({ method: 'POST', url: `/v1/automation-runs/${runId}/execution-session/recover`,
      headers: { authorization: `Bearer ${bearer}` }, payload: value as any });
    const result = await send({ ...payload, recoveryIdentity: null });
    expect(result.statusCode, result.body).toBe(200); expect(result.json()).toEqual({ status: 'NOT_REGISTERED' });
    expect((await send({ ...payload, claimToken: 'wrong', recoveryIdentity: null })).statusCode).toBe(403);
    expect(await client.session.count()).toBe(1);
  } finally { await app.close(); }
});

it.each(['nonce', 'company', 'missing'] as const)('refuses mismatched original company recovery identity: %s', async mismatch => {
  const prepared = await boundRequest();
  await createAutomationExecutionSession('owner', bearer, prepared.input, { secret, now });
  const { runId, executionProof: _proof, ...payload } = prepared.input;
  const identity = mismatch === 'missing' ? null : { ...prepared.recoveryIdentity,
    ...(mismatch === 'nonce' ? { initialNonce: rotationBase64url(new Uint8Array(32).fill(4)) } : { companyId: 'another-company' }) };
  const app = await api();
  try {
    const result = await app.inject({ method: 'POST', url: `/v1/automation-runs/${runId}/execution-session/recover`,
      headers: { authorization: `Bearer ${bearer}` }, payload: { ...payload, recoveryIdentity: identity } });
    expect(result.statusCode).toBe(mismatch === 'missing' ? 403 : 409);
    expect(await client.session.count()).toBe(2); expect(await client.sessionExecutionBinding.count()).toBe(1);
  } finally { await app.close(); }
});

async function api() {
  const server = fastify(); server.setValidatorCompiler(validatorCompiler); server.setSerializerCompiler(serializerCompiler);
  const app = server.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
  app.decorate('authenticate', async (request: any, reply: any) => {
    if (request.headers.authorization !== `Bearer ${bearer}`) return reply.code(401).send({ error: 'Unauthorized' });
    request.userId = 'owner'; request.principal = { kind: request.headers['x-test-principal'] ?? 'account', accountId: 'owner' };
  });
  automationExecutionRoutes(app); await app.ready(); return app;
}

it('queues an idempotent encrypted question about one completed run without editing its definition or manual session', async () => {
  await register();
  await reportAutomationRun(client, 'owner', 'm1', report('automation-run:r1'), now);
  await recordAutomationExecutionExit('owner', { runId: 'r1', ...await exitRequest() });
  await client.machine.update({ where: { id: 'm1' }, data: { automationContextIsolationVersion: 1 } });
  const definition = await client.automation.findUniqueOrThrow({ where: { id: 'a1' } });
  const manual = await client.session.findUniqueOrThrow({ where: { id: 'manual' } });
  const one = (size: number) => Buffer.concat([Buffer.from([1]), Buffer.alloc(size - 1)]).toString('base64');
  const payload = { requestId: '9cc41d26-562e-4b48-8e2f-a38dc2c85a78', sourceRunId: 'r1', expectedRevision: definition.revision,
    generation: definition.generation, displaySessionId: 'manual', encrypted: { payloadVersion: 6, payloadCiphertext: one(41),
      viewerKeyId: 'k', viewerKeyVersion: 1, viewerKeyEnvelope: one(105), machineKeyVersion: 1, machineKeyEnvelope: one(105) } };
  const app = await api(), send = (body = payload) => app.inject({ method: 'POST', url: '/v1/projects/chat:c1/automations/a1/execution-questions',
    headers: { authorization: `Bearer ${bearer}` }, payload: body });
  try {
    const first = await send(); expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ requestId: payload.requestId, sourceRunId: 'r1', runId: null, state: 'QUEUED' });
    expect((await send()).json()).toEqual(first.json());
    const conflict = await send({ ...payload, encrypted: { ...payload.encrypted, viewerKeyId: 'other' } });
    expect(conflict.statusCode).toBe(409);
    expect(await client.automation.findUniqueOrThrow({ where: { id: 'a1' } })).toEqual(definition);
    expect(await client.session.findUniqueOrThrow({ where: { id: 'manual' } })).toEqual(manual);
    expect(await client.automationRun.count()).toBe(1);
    const question = await client.automationExecutionQuestion.findUniqueOrThrow({ where: { id: payload.requestId } });
    const original = await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } });
    await db.exec(`CREATE UNIQUE INDEX "AutomationRun_one_active_run_per_automation" ON "AutomationRun"("automationId") WHERE "status" IN ('CLAIMED', 'RUNNING')`);
    await client.automationRun.create({ data: { id: 'regular-slot', automationId: 'a1', generation: definition.generation, scheduledFor: question.createdAt,
      machineAccountId: 'owner', machineId: 'm1', status: 'COMPLETED', claimExpiresAt: original.claimExpiresAt,
      claimTokenHash: new Uint8Array(createHash('sha256').update('regular-slot').digest()) } });
    const claimUrl = `/v1/machines/m1/automation-questions/${payload.requestId}/claim`;
    const claim = () => app.inject({ method: 'POST', url: claimUrl, headers: { authorization: `Bearer ${bearer}` }, payload: { claimToken: 'a'.repeat(43) } });
    await client.automationRun.create({ data: { id: 'active-slot', automationId: 'a1', generation: definition.generation, scheduledFor: new Date(1),
      machineAccountId: 'owner', machineId: 'm1', status: 'CLAIMED', claimExpiresAt: original.claimExpiresAt,
      claimTokenHash: new Uint8Array(createHash('sha256').update('active-slot').digest()) } });
    const busy = await claim(); expect(busy.statusCode).toBe(409); expect(busy.json()).toEqual({ error: 'AUTOMATION_QUESTION_BUSY' });
    expect((await client.automationExecutionQuestion.findUniqueOrThrow({ where: { id: payload.requestId } })).runId).toBeNull();
    await client.automationRun.update({ where: { id: 'active-slot' }, data: { status: 'COMPLETED' } });
    const claimed = await claim(); expect(claimed.statusCode, claimed.body).toBe(200);
    expect(claimed.json()).toMatchObject({ requestId: payload.requestId, runId: payload.requestId, sourceRunId: 'r1', state: 'CLAIMED' });
    expect((await claim()).json()).toEqual(claimed.json());
    const conflictClaim = await app.inject({ method: 'POST', url: claimUrl, headers: { authorization: `Bearer ${bearer}` }, payload: { claimToken: 'b'.repeat(43) } });
    expect(conflictClaim.statusCode).toBe(409);
    expect(await client.automationRun.count()).toBe(4);
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: payload.requestId } })).toMatchObject({ kind: 'QUESTION', previousExecutionRunId: 'r1', scheduledFor: question.createdAt });
    expect(await client.automation.findUniqueOrThrow({ where: { id: 'a1' } })).toEqual(definition);
    expect(await client.session.findUniqueOrThrow({ where: { id: 'manual' } })).toEqual(manual);
    // Paused schedules have no regular claim loop to clear an expired question's active slot.
    await client.automation.update({ where: { id: 'a1' }, data: { paused: true } });
    await client.automationRun.update({ where: { id: payload.requestId }, data: { claimExpiresAt: new Date(0) } });
    const expired = await claim(); expect(expired.statusCode, expired.body).toBe(200);
    expect(expired.json()).toMatchObject({ runId: payload.requestId, state: 'EXPIRED' });
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: payload.requestId } })).status).toBe('EXPIRED');
    const nextQuestion = { ...payload, requestId: 'd23e9200-51d4-4f8a-adf7-4ed3dc7d26d6' };
    expect((await send(nextQuestion)).statusCode).toBe(200);
    const nextClaim = await app.inject({ method: 'POST', url: `/v1/machines/m1/automation-questions/${nextQuestion.requestId}/claim`,
      headers: { authorization: `Bearer ${bearer}` }, payload: { claimToken: 'c'.repeat(43) } });
    expect(nextClaim.statusCode, nextClaim.body).toBe(200); expect(nextClaim.json()).toMatchObject({ runId: nextQuestion.requestId, state: 'CLAIMED' });
    expect((await client.automation.findUniqueOrThrow({ where: { id: 'a1' } })).paused).toBe(true);
    // No retry of B is necessary: C also clears B's expired running lease before taking a new slot.
    await client.automationRun.update({ where: { id: nextQuestion.requestId }, data: { status: 'RUNNING', runLeaseExpiresAt: new Date(0) } });
    const thirdQuestion = { ...payload, requestId: 'cfcf32a2-a102-4aef-b282-4e35699d4f3a' };
    const requester = await client.projectMember.create({ data: { projectId: 'chat:c1', accountId: 'other', invitedBy: 'owner', role: 'editor', status: 'accepted' } });
    expect(await queueAutomationExecutionQuestion(client, 'other', 'chat:c1', 'a1', thirdQuestion)).toMatchObject({ state: 'QUEUED' });
    expect((await send(thirdQuestion)).statusCode).toBe(409); // An accepted collaborator cannot replay another requester's identity.
    await client.projectMember.update({ where: { id: requester.id }, data: { status: 'removed' } });
    const revokedClaim = await app.inject({ method: 'POST', url: `/v1/machines/m1/automation-questions/${thirdQuestion.requestId}/claim`,
      headers: { authorization: `Bearer ${bearer}` }, payload: { claimToken: 'd'.repeat(43) } });
    expect(revokedClaim.statusCode).toBe(403);
    expect((await client.automationExecutionQuestion.findUniqueOrThrow({ where: { id: thirdQuestion.requestId } })).runId).toBeNull();
    await client.projectMember.update({ where: { id: requester.id }, data: { status: 'accepted' } });
    const thirdClaim = await app.inject({ method: 'POST', url: `/v1/machines/m1/automation-questions/${thirdQuestion.requestId}/claim`,
      headers: { authorization: `Bearer ${bearer}` }, payload: { claimToken: 'd'.repeat(43) } });
    expect(thirdClaim.statusCode, thirdClaim.body).toBe(200);
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: nextQuestion.requestId } })).status).toBe('ABANDONED');
    expect((await claim()).json()).toMatchObject({ runId: payload.requestId, state: 'EXPIRED' });
    expect(await client.automationRun.count()).toBe(6);
    const pausedDefinition = await client.automation.findUniqueOrThrow({ where: { id: 'a1' } });
    expect(await startAutomationRun(client, 'owner', 'm1', { runId: thirdQuestion.requestId, claimToken: 'd'.repeat(43) }))
      .toMatchObject({ ok: true });
    expect(await resolveAutomationRunMcpContext(client, 'owner', 'm1', { runId: thirdQuestion.requestId, claimToken: 'd'.repeat(43), executionAdmission: true, questionProtocol: 1 }))
      .toMatchObject({ ok: true, value: { ownerAccountId: 'other', questionRequestId: thirdQuestion.requestId, executionBindingId: `automation-question:${thirdQuestion.requestId}` } });
    const { runId: _runId, ...execution } = await request(thirdQuestion.requestId, { claimToken: 'd'.repeat(43) });
    const executionUrl = `/v1/automation-runs/${thirdQuestion.requestId}/execution-session`;
    const oldProof = await app.inject({ method: 'POST', url: executionUrl, headers: { authorization: `Bearer ${bearer}` }, payload: execution });
    expect(oldProof.statusCode).toBe(403);
    const questionProof = signAutomationExecutionTarget({ automationId: 'a1', projectId: 'chat:c1', runId: thirdQuestion.requestId,
      generation: 1, revision: 1, machineId: 'm1', machineAccountId: 'owner', displaySessionId: 'manual', questionRequestId: thirdQuestion.requestId,
      executionBindingRequired: false, createBodyHash: await sessionCreateBodyHash(execution.body), secret, bearer, now: Date.now() });
    await client.projectMember.update({ where: { id: requester.id }, data: { status: 'removed' } });
    const revoked = await app.inject({ method: 'POST', url: executionUrl, headers: { authorization: `Bearer ${bearer}` }, payload: { ...execution, targetProof: questionProof } });
    expect(revoked.statusCode).toBe(403);
    expect(await client.session.findUnique({ where: { id: automationExecutionSessionId(thirdQuestion.requestId) } })).toBeNull();
    await client.projectMember.update({ where: { id: requester.id }, data: { status: 'accepted' } });
    const created = await app.inject({ method: 'POST', url: executionUrl, headers: { authorization: `Bearer ${bearer}` }, payload: { ...execution, targetProof: questionProof } });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ sessionId: automationExecutionSessionId(thirdQuestion.requestId), displaySessionId: 'manual', created: true });
    expect(await client.automation.findUniqueOrThrow({ where: { id: 'a1' } })).toEqual(pausedDefinition);
    expect(await client.session.findUniqueOrThrow({ where: { id: 'manual' } })).toEqual(manual);
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: thirdQuestion.requestId } })).previousExecutionRunId).toBe('r1');
    const selectedReference = `/v1/automations/a1/execution-reference?machineId=m1&generation=1&revision=1&displaySessionId=manual&questionRequestId=${thirdQuestion.requestId}`;
    await client.automation.update({ where: { id: 'a1' }, data: { lastExecutionRunId: 'unrelated-latest' } });
    const selected = await app.inject({ method: 'GET', url: selectedReference, headers: { authorization: `Bearer ${bearer}` } });
    expect(selected.statusCode, selected.body).toBe(200);
    expect(selected.json()).toMatchObject({ status: 'CANDIDATE', runId: 'r1', executionSessionId: 'automation-run:r1' });
    const wrongAnchor = await app.inject({ method: 'GET', url: selectedReference + '&beforeRunId=other-run', headers: { authorization: `Bearer ${bearer}` } });
    expect(wrongAnchor.statusCode).toBe(403);
    const preclaim = { ...payload, requestId: 'f84ba6f1-f662-440b-a758-3ff972551bb0' };
    await queueAutomationExecutionQuestion(client, 'owner', 'chat:c1', 'a1', preclaim);
    const preclaimReference = selectedReference.replace(thirdQuestion.requestId, preclaim.requestId);
    expect((await app.inject({ method: 'GET', url: preclaimReference, headers: { authorization: `Bearer ${bearer}` } })).statusCode).toBe(200);
    expect((await client.automationExecutionQuestion.findUniqueOrThrow({ where: { id: preclaim.requestId } })).runId).toBeNull();
    await client.projectMember.update({ where: { id: requester.id }, data: { status: 'removed' } });
    expect((await app.inject({ method: 'GET', url: selectedReference, headers: { authorization: `Bearer ${bearer}` } })).statusCode).toBe(403);
    await client.projectMember.update({ where: { id: requester.id }, data: { status: 'accepted' } });
    await client.session.delete({ where: { id: 'automation-run:r1' } });
    const lostSource = await app.inject({ method: 'GET', url: selectedReference, headers: { authorization: `Bearer ${bearer}` } });
    expect(lostSource.statusCode).toBe(409); expect(lostSource.json()).toEqual({ error: 'AUTOMATION_REFERENCE_UNAVAILABLE' });
  } finally { await app.close(); }
});

it('adds a separate question queue through the migration while preserving saved definitions, native metadata and run history', async () => {
  const definition = await client.automation.findUniqueOrThrow({ where: { id: 'a1' } });
  const manual = await client.session.findUniqueOrThrow({ where: { id: 'manual' } });
  const originalRun = await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } });
  await db.exec('DROP TABLE "AutomationExecutionQuestion"');
  await db.exec(await readFile('prisma/migrations/20261107020000_automation_execution_questions/migration.sql', 'utf8'));
  expect(await client.automationExecutionQuestion.count()).toBe(0);
  expect(await client.automation.findUniqueOrThrow({ where: { id: 'a1' } })).toEqual(definition);
  expect(await client.session.findUniqueOrThrow({ where: { id: 'manual' } })).toEqual(manual);
  expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } })).toEqual(originalRun);
});

it('preserves scheduled slot uniqueness while giving questions a separate slot in the migration', async () => {
  const original = await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } });
  const manual = await client.session.findUniqueOrThrow({ where: { id: 'manual' } });
  await db.exec(`DROP INDEX "AutomationRun_scheduled_slot";
    DROP INDEX "AutomationRun_automationId_generation_scheduledFor_idx";
    ALTER TABLE "AutomationRun" DROP COLUMN "kind";
    DROP TYPE "AutomationRunKind";
    CREATE UNIQUE INDEX "AutomationRun_automationId_generation_scheduledFor_key" ON "AutomationRun"("automationId", "generation", "scheduledFor");`);
  await db.exec(await readFile('prisma/migrations/20261107021000_automation_question_run_slots/migration.sql', 'utf8'));
  expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } })).toEqual(original);
  expect(await client.session.findUniqueOrThrow({ where: { id: 'manual' } })).toEqual(manual);
  const row = { automationId: 'a1', generation: 1, scheduledFor: original.scheduledFor, machineAccountId: 'owner', machineId: 'm1',
    status: 'COMPLETED' as const, claimExpiresAt: original.claimExpiresAt };
  const token = (id: string) => new Uint8Array(createHash('sha256').update(id).digest());
  await client.automationRun.create({ data: { ...row, id: 'question', kind: 'QUESTION', claimTokenHash: token('question') } });
  await expect(client.automationRun.create({ data: { ...row, id: 'scheduled-copy', kind: 'SCHEDULED', claimTokenHash: token('scheduled-copy') } }))
    .rejects.toThrow(/Unique constraint/);
  expect(await client.automationRun.count()).toBe(2);
});

it('rejects question requests with lost authority, changed generation, unsupported target or unconfirmed source', async () => {
  await register();
  await client.machine.update({ where: { id: 'm1' }, data: { automationContextIsolationVersion: 1 } });
  const one = (size: number) => Buffer.concat([Buffer.from([1]), Buffer.alloc(size - 1)]).toString('base64');
  const payload = { requestId: '9cc41d26-562e-4b48-8e2f-a38dc2c85a78', sourceRunId: 'r1', expectedRevision: 1,
    generation: 1, displaySessionId: 'manual', encrypted: { payloadVersion: 6, payloadCiphertext: one(41), viewerKeyId: 'k',
      viewerKeyVersion: 1, viewerKeyEnvelope: one(105), machineKeyVersion: 1, machineKeyEnvelope: one(105) } };
  const app = await api(), url = '/v1/projects/chat:c1/automations/a1/execution-questions', headers = { authorization: `Bearer ${bearer}` };
  const send = (body: Record<string, unknown> = payload) => app.inject({ method: 'POST', url, headers, payload: body });
  try {
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'x-test-principal': 'browser-sync' }, payload })).statusCode).toBe(403);
    expect((await send({ ...payload, encrypted: { ...payload.encrypted, payloadVersion: 4 } })).statusCode).toBe(400);
    expect((await send()).statusCode).toBe(409); // No positive owned exit, even though dispatch can be accepted.
    await recordAutomationExecutionExit('owner', { runId: 'r1', ...await exitRequest() });
    expect((await send({ ...payload, sourceRunId: 'absent' })).statusCode).toBe(404);
    expect((await send({ ...payload, displaySessionId: 'other-display' })).statusCode).toBe(404);
    expect((await send({ ...payload, generation: 2 })).statusCode).toBe(409);
    await client.machine.update({ where: { id: 'm1' }, data: { automationContextIsolationVersion: 0 } });
    expect((await send()).statusCode).toBe(409);
    await client.machine.update({ where: { id: 'm1' }, data: { automationContextIsolationVersion: 1 } });
    await client.project.update({ where: { id: 'chat:c1' }, data: { config: { machineId: 'm1', chatAutomationState: 'archived' } } });
    expect((await send()).statusCode).toBe(409);
    expect(await client.automationExecutionQuestion.count()).toBe(0);
    expect(await client.automationRun.count()).toBe(1);
  } finally { await app.close(); }
});

async function exitRequest(runId = 'r1') {
  return { machineId: 'm1', claimToken: `claim-${runId}`, createBodyHash: await sessionCreateBodyHash((await request(runId)).body),
    receipt: { version: 1, provider: 'codex', observedAt: now.getTime(), providerExitedCleanly: true,
      foregroundDrained: true, backgroundDrained: true, writeProducersDrained: true } };
}

it('records a private owned exit after dispatch completion and reconciles a lost ACK without changing the manual chat', async () => {
  await register();
  await reportAutomationRun(client as never, 'owner', 'm1', report('automation-run:r1'), now);
  const app = await api(), payload = await exitRequest();
  const send = () => app.inject({ method: 'POST', url: '/v1/automation-runs/r1/execution-exit',
    headers: { authorization: `Bearer ${bearer}` }, payload });
  try {
    const first = await send(); expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ runId: 'r1', sessionId: 'automation-run:r1', receipt: payload.receipt });
    // Cleanup evidence remains reportable after a definition edit/revocation; it authorizes no new execution.
    await client.automation.update({ where: { id: 'a1' }, data: { generation: 2, revision: 2, paused: true, deletedAt: now, payloadVersion: 4 } });
    await client.automationRun.update({ where: { id: 'r1' }, data: { runLeaseExpiresAt: new Date(0) } });
    const replay = await send(); expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const feed = await app.inject({ method: 'GET', url: '/v1/sessions/manual/automation-runs', headers: { authorization: `Bearer ${bearer}` } });
    expect(feed.json().runs[0]).toMatchObject({ schedulerStatus: 'COMPLETED', executionExitReceipt: first.json().receipt });
    expect(await client.session.findUniqueOrThrow({ where: { id: 'manual' } })).toMatchObject({
      seq: 3, metadata: 'existing-manual-provider-and-title', agentState: 'existing-user-queue' });
  } finally { await app.close(); }
});

it.each([true, false])('retains authored result evidence and prunes internal detail only after a positive owned exit (%s)', async positive => {
  await register();
  const sessionId = 'automation-run:r1';
  const keep = ['automation-seed:r1', 'automation-evidence:r1:start', 'automation-evidence:r1:answer', 'automation-evidence:r1:end'];
  const { automationExecutionSeedLocalId } = await import('@slopus/happy-wire');
  keep[0] = automationExecutionSeedLocalId('r1');
  await client.sessionMessage.createMany({ data: [...keep, 'tool-call', null].map((localId, index) => ({
    sessionId, localId, seq: index + 1, content: { t: 'encrypted', c: `original-ciphertext-${index}` },
  })) });
  await client.session.update({ where: { id: sessionId }, data: { seq: 6 } });
  const before = await client.session.findUniqueOrThrow({ where: { id: sessionId } });
  const app = await api(), payload = await exitRequest();
  if (!positive) payload.receipt.writeProducersDrained = false;
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/automation-runs/r1/execution-exit',
      headers: { authorization: `Bearer ${bearer}` }, payload });
    expect(response.statusCode).toBe(positive ? 200 : 400);
    const messages = await client.sessionMessage.findMany({ where: { sessionId }, orderBy: { seq: 'asc' } });
    expect(messages.map(message => message.localId)).toEqual(positive ? keep : [...keep, 'tool-call', null]);
    expect(messages.map(message => message.content)).toEqual(messages.map((_, index) => ({ t: 'encrypted', c: `original-ciphertext-${index}` })));
    expect(await client.session.findUniqueOrThrow({ where: { id: sessionId } })).toEqual(before);
    expect(await client.sessionMessage.findMany({ where: { sessionId: 'manual' }, select: { localId: true } }))
      .toEqual([{ localId: 'manual-pending' }]);
  } finally { await app.close(); }
});

it('rejects conflicting owned exit evidence instead of overwriting the first receipt', async () => {
  await register(); const app = await api(), payload = await exitRequest();
  try {
    const send = (value: unknown) => app.inject({ method: 'POST', url: '/v1/automation-runs/r1/execution-exit',
      headers: { authorization: `Bearer ${bearer}` }, payload: value as any });
    expect((await send(payload)).statusCode).toBe(200);
    const conflict = await send({ ...payload, receipt: { ...payload.receipt, observedAt: payload.receipt.observedAt + 1 } });
    expect(conflict.statusCode).toBe(409);
    expect((await send(payload)).json().receipt).toMatchObject(payload.receipt);
  } finally { await app.close(); }
});

it.each(['claim', 'machine', 'body-hash', 'unregistered', 'partial', 'provider', 'extra', 'browser-principal', 'disabled'])(
  'refuses invalid owned exit admission: %s', async reason => {
    if (reason !== 'unregistered') await register();
    const payload: any = await exitRequest(), headers: Record<string, string> = { authorization: `Bearer ${bearer}` };
    const status: Record<string, number> = { claim: 403, machine: 403, 'body-hash': 409, unregistered: 409,
      partial: 400, provider: 400, extra: 400, 'browser-principal': 403, disabled: 404 };
    if (reason === 'claim') payload.claimToken = 'another-private-claim';
    if (reason === 'machine') payload.machineId = 'another-machine';
    if (reason === 'body-hash') payload.createBodyHash = '0'.repeat(64);
    if (reason === 'partial') payload.receipt.backgroundDrained = false;
    if (reason === 'provider') payload.receipt.provider = 'gemini';
    if (reason === 'extra') payload.receipt.assumeExited = true;
    if (reason === 'browser-principal') headers['x-test-principal'] = 'browser-sync';
    if (reason === 'disabled') vi.stubEnv('SAYCODE_AUTOMATION_ENABLED', 'false');
    const app = await api();
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/automation-runs/r1/execution-exit', headers, payload });
      expect(response.statusCode, response.body).toBe(status[reason]);
      expect((await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } })).executionExitReceipt).toBeNull();
    } finally { await app.close(); }
  });

it('keeps exit evidence scoped to the original machine account at the service boundary', async () => {
  await register();
  await expect(recordAutomationExecutionExit('other', { ...await exitRequest(), runId: 'r1' }))
    .rejects.toMatchObject({ statusCode: 403 });
  expect((await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } })).executionExitReceipt).toBeNull();
});

it('exposes corrupt stored exit evidence as unconfirmed with a reason instead of asserting a clean exit', async () => {
  await register();
  await client.automationRun.update({ where: { id: 'r1' }, data: { executionExitReceipt: { version: 1, provider: 'codex' } } });
  const app = await api();
  try {
    const feed = await app.inject({ method: 'GET', url: '/v1/sessions/manual/automation-runs', headers: { authorization: `Bearer ${bearer}` } });
    expect(feed.statusCode).toBe(200);
    expect(feed.json().runs[0]).toMatchObject({ executionExitReceipt: null, executionExitError: 'INVALID_EXECUTION_EXIT_RECEIPT' });
  } finally { await app.close(); }
});

it('accepts one concurrent owned exit and rejects a conflicting receipt atomically', async () => {
  await register(); const app = await api(), payload = await exitRequest();
  try {
    const send = (value: unknown) => app.inject({ method: 'POST', url: '/v1/automation-runs/r1/execution-exit',
      headers: { authorization: `Bearer ${bearer}` }, payload: value as any });
    const results = await Promise.all([send(payload), send({ ...payload, receipt: { ...payload.receipt, observedAt: payload.receipt.observedAt + 1 } })]);
    expect(results.map(row => row.statusCode).sort()).toEqual([200, 409]);
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } })).executionExitReceipt)
      .toEqual(results.find(row => row.statusCode === 200)!.json().receipt);
  } finally { await app.close(); }
});

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

it('binds display history and every evidence page to the requested project even for one shared Happy account', async () => {
  await register(); await run('r2'); await register('r2');
  await client.project.create({ data: { id: 'other-project', accountId: 'owner', name: 'Other' } });
  const original = await client.automation.findUniqueOrThrow({ where: { id: 'a1' } });
  await client.automation.create({ data: { ...original, id: 'a2', projectId: 'other-project', lastExecutionRunId: null } });
  await client.automationRun.update({ where: { id: 'r2' }, data: { automationId: 'a2' } });
  const app = await api();
  try {
    const get = (path: string) => app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${bearer}` } });
    const first = await get('/v1/sessions/manual/automation-runs?projectId=chat%3Ac1&limit=1');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ runs: [{ id: 'r1', projectId: 'chat:c1' }], nextCursor: null });
    expect(first.body).not.toContain('r2');
    const other = await get('/v1/sessions/manual/automation-runs?projectId=other-project');
    expect(other.statusCode, other.body).toBe(200);
    expect(other.json()).toMatchObject({ runs: [{ id: 'r2', projectId: 'other-project' }] });
    const evidence = await get('/v1/sessions/manual/automation-runs/r1/evidence?projectId=chat%3Ac1');
    expect(evidence.statusCode, evidence.body).toBe(200);
    expect(evidence.json()).toMatchObject({ runId: 'r1', projectId: 'chat:c1' });
    expect((await get('/v1/sessions/manual/automation-runs/r2/evidence?projectId=chat%3Ac1')).statusCode).toBe(404);
    expect((await get('/v1/sessions/manual/automation-runs/r1/evidence?projectId=other-project')).statusCode).toBe(404);
  } finally { await app.close(); }
});

it('projects persisted holds on the original display run without writing into its manual conversation', async () => {
  await register();
  const manual = await client.session.findUniqueOrThrow({ where: { id: 'manual' } }), messages = await client.sessionMessage.findMany();
  const app = await api(), input = { runId: 'r1', claimToken: 'claim-r1', holdCode: 'WORKSPACE_OWNER_UNCONFIRMED' };
  try {
    for (const holdCode of [input.holdCode, null]) {
      expect(await heartbeatAutomationRun(client, 'owner', 'm1', { ...input, holdCode }, now)).toMatchObject({ ok: true });
      const response = await app.inject({ method: 'GET', url: '/v1/sessions/manual/automation-runs', headers: { authorization: `Bearer ${bearer}` } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().runs[0]).toMatchObject({ id: 'r1', schedulerStatus: 'RUNNING', holdCode,
        displaySessionId: 'manual', executionSessionId: 'automation-run:r1' });
      expect(response.body).not.toContain('claim-r1'); expect(response.body).not.toContain('claimTokenHash');
    }
    expect(await client.session.findUniqueOrThrow({ where: { id: 'manual' } })).toEqual(manual);
    expect(await client.sessionMessage.findMany()).toEqual(messages);
  } finally { await app.close(); }
});

it.each(['archived', 'deleted'] as const)('clears waiting state when its owning Chat is %s and refuses later heartbeats', async state => {
  await register();
  const input = { runId: 'r1', claimToken: 'claim-r1', holdCode: 'WORKSPACE_BUSY' };
  expect(await heartbeatAutomationRun(client, 'owner', 'm1', input, now)).toMatchObject({ ok: true });
  await transitionChatAutomations(client, 'owner', 'chat:c1', state, now);
  expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } })).toMatchObject({
    status: 'CANCELLED', holdCode: null, failureCode: state === 'deleted' ? 'CHAT_DELETED' : 'CHAT_ARCHIVED',
  });
  expect(await heartbeatAutomationRun(client, 'owner', 'm1', input, now)).toEqual({ ok: false, error: 'run-not-running' });
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

it('persists only the original live claim hold and never restores it after a terminal report', async () => {
  const input = { runId: 'r1', claimToken: 'claim-r1', holdCode: 'WORKSPACE_BUSY' };
  expect(await heartbeatAutomationRun(client, 'owner', 'm1', input, now)).toMatchObject({ ok: true });
  expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } })).toHaveProperty('holdCode', 'WORKSPACE_BUSY');
  for (const [account, machine, claimToken] of [['other', 'm1', 'claim-r1'], ['owner', 'other', 'claim-r1'], ['owner', 'm1', 'wrong']]) {
    expect(await heartbeatAutomationRun(client, account, machine, { ...input, claimToken, holdCode: null }, now))
      .toEqual({ ok: false, error: 'run-not-running' });
  }
  expect(await heartbeatAutomationRun(client, 'owner', 'm1', { runId: 'r1', claimToken: 'claim-r1' }, now)).toMatchObject({ ok: true });
  expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } })).toHaveProperty('holdCode', 'WORKSPACE_BUSY');
  expect(await heartbeatAutomationRun(client, 'owner', 'm1', { ...input, holdCode: null }, now)).toMatchObject({ ok: true });
  expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } })).toHaveProperty('holdCode', null);
  await register();
  await heartbeatAutomationRun(client, 'owner', 'm1', input, now);
  expect(await reportAutomationRun(client, 'owner', 'm1', report('automation-run:r1', {
    status: 'FAILED', outcome: 'ERROR', failureCode: 'AUTOMATION_START_UNCONFIRMED',
  }), now)).toMatchObject({ ok: true });
  expect(await heartbeatAutomationRun(client, 'owner', 'm1', input, now)).toEqual({ ok: false, error: 'run-not-running' });
  expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } }))
    .toMatchObject({ status: 'FAILED', holdCode: null, failureCode: 'AUTOMATION_START_UNCONFIRMED' });
});

it('adds nullable hold state without rewriting legacy definitions, runs, or manual history', async () => {
  await client.automation.update({ where: { id: 'a1' }, data: { payloadVersion: 4 } });
  await client.automationRun.update({ where: { id: 'r1' }, data: { sessionId: 'manual', status: 'COMPLETED', outcome: 'WOKE' } });
  const definition = await client.automation.findUniqueOrThrow({ where: { id: 'a1' } });
  const legacy = await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } });
  const manual = await client.session.findUniqueOrThrow({ where: { id: 'manual' } }), messages = await client.sessionMessage.findMany();
  await db.exec('ALTER TABLE "AutomationRun" DROP COLUMN "holdCode";');
  await db.exec(await readFile('prisma/migrations/20261106010000_automation_execution_hold/migration.sql', 'utf8'));
  expect(await client.automation.findUniqueOrThrow({ where: { id: 'a1' } })).toEqual(definition);
  expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } })).toEqual({ ...legacy, holdCode: null });
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

async function reference(input: Record<string, string> = {}) {
  const app = await api();
  try {
    const query = new URLSearchParams({ machineId: 'm1', generation: '1', revision: '1', displaySessionId: 'manual', ...input });
    return await app.inject({ method: 'GET', url: `/v1/automations/a1/execution-reference?${query}`,
      headers: { authorization: `Bearer ${bearer}` } });
  } finally { await app.close(); }
}

it('proves an empty reference history before registration and never treats a dispatched run as a completed answer', async () => {
  const first = await reference();
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json()).toEqual({ status: 'NONE_ELIGIBLE', automationId: 'a1' });
  await register();
  await reportAutomationRun(client as never, 'owner', 'm1', report('automation-run:r1'), now);
  const pending = await reference();
  expect(pending.statusCode, pending.body).toBe(409);
  expect(pending.json()).toEqual({ error: 'AUTOMATION_REFERENCE_UNCONFIRMED' });
  expect((await reference({ beforeRunId: 'r1' })).json()).toEqual({ status: 'NONE_ELIGIBLE', automationId: 'a1' });
  await recordAutomationExecutionExit('owner', { ...await exitRequest(), runId: 'r1' });
  const confirmed = await reference();
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  expect(confirmed.json()).toMatchObject({ status: 'CANDIDATE', automationId: 'a1', runId: 'r1',
    generation: 1, displaySessionId: 'manual', executionSessionId: 'automation-run:r1', previousRunId: null });
  expect(confirmed.json()).not.toHaveProperty('answer');
});

it('keeps registration history stable on replay and exposes a deleted reference as unavailable', async () => {
  await register(); await run('r2'); await register('r2'); await register();
  expect(await client.automation.findUniqueOrThrow({ where: { id: 'a1' } })).toMatchObject({ lastExecutionRunId: 'r2' });
  expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r2' } })).toMatchObject({ previousExecutionRunId: 'r1' });
  await client.automationRun.delete({ where: { id: 'r2' } });
  const missing = await reference();
  expect(missing.statusCode, missing.body).toBe(409);
  expect(missing.json()).toEqual({ error: 'AUTOMATION_REFERENCE_UNAVAILABLE' });
});

it.each(['generation', 'revision', 'machine', 'paused', 'deleted', 'machine-key', 'viewer-key', 'owner', 'display'])(
  'denies reference selection before returning an empty history: %s', async reason => {
    const query: Record<string, string> = {};
    if (reason === 'generation') query.generation = '2';
    if (reason === 'revision') query.revision = '2';
    if (reason === 'machine') query.machineId = 'another-machine';
    if (reason === 'paused') await client.automation.update({ where: { id: 'a1' }, data: { paused: true } });
    if (reason === 'deleted') await client.automation.update({ where: { id: 'a1' }, data: { deletedAt: now } });
    if (reason === 'machine-key') await client.machine.update({ where: { accountId_id: { accountId: 'owner', id: 'm1' } }, data: { automationKeyVersion: 2 } });
    if (reason === 'viewer-key') await client.project.update({ where: { id: 'chat:c1' }, data: { automationViewerKeyVersion: 2 } });
    if (reason === 'owner') await client.automation.update({ where: { id: 'a1' }, data: { ownerAccountId: 'other' } });
    if (reason === 'display') query.displaySessionId = 'other-private-chat';
    expect((await reference(query)).statusCode).toBe(403);
  });

it('walks only registered history and fails closed when a retained link loses its source', async () => {
  await register(); await recordAutomationExecutionExit('owner', { ...await exitRequest(), runId: 'r1' });
  await run('r2'); await register('r2'); await recordAutomationExecutionExit('owner', { ...await exitRequest('r2'), runId: 'r2' });
  await run('r3'); // A claim without registration is not a provider result.
  expect((await reference()).json()).toMatchObject({ runId: 'r2', previousRunId: 'r1' });
  expect((await reference({ beforeRunId: 'r2' })).json()).toMatchObject({ runId: 'r1', previousRunId: null });
  expect((await reference({ beforeRunId: 'r1' })).json()).toEqual({ status: 'NONE_ELIGIBLE', automationId: 'a1' });
  expect((await reference({ beforeRunId: 'r3' })).statusCode).toBe(409);
  await client.session.delete({ where: { id: 'automation-run:r1' } });
  const missing = await reference({ beforeRunId: 'r2' });
  expect(missing.statusCode).toBe(409);
  expect(missing.json()).toEqual({ error: 'AUTOMATION_REFERENCE_UNAVAILABLE' });
});

it('backfills registered history additively while preserving manual data and corrupt source markers', async () => {
  await register(); await run('r2'); await register('r2');
  await run('r3'); // Legacy dispatch must not become a reference.
  await client.automationRun.update({ where: { id: 'r3' }, data: { sessionId: 'manual', status: 'COMPLETED', outcome: 'WOKE' } });
  const manual = await client.session.findUniqueOrThrow({ where: { id: 'manual' } });
  const messages = await client.sessionMessage.findMany();
  await db.exec('ALTER TABLE "Automation" DROP COLUMN "lastExecutionRunId"; ALTER TABLE "AutomationRun" DROP COLUMN "previousExecutionRunId";');
  await db.exec(await readFile('prisma/migrations/20261105013000_automation_execution_reference_history/migration.sql', 'utf8'));
  expect(await client.automation.findUniqueOrThrow({ where: { id: 'a1' } })).toMatchObject({ lastExecutionRunId: 'r2' });
  expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } })).toMatchObject({ previousExecutionRunId: null });
  expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r2' } })).toMatchObject({ previousExecutionRunId: 'r1' });
  expect(await client.automationRun.findUniqueOrThrow({ where: { id: 'r3' } })).toMatchObject({ previousExecutionRunId: null });
  expect(await client.session.findUniqueOrThrow({ where: { id: 'manual' } })).toEqual(manual);
  expect(await client.sessionMessage.findMany()).toEqual(messages);
});
