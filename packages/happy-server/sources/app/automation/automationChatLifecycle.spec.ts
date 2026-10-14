import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readChatAutomationImpact, transitionChatAutomations } from './automationChatLifecycle';
import { createAutomation, updateAutomation, requestAutomationRun } from './automationService';
import { syncAutomations } from './automationExecutionService';
import { saveScriptAutomation } from './scriptRegistrationService';
import { scriptAutomationRoutes } from '../api/routes/scriptAutomationRoutes';
import { encryptScriptValue } from '@slopus/happy-wire';
import nacl from 'tweetnacl';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
let sql: string, db: PGlite, client: PrismaClient;
const now = new Date('2026-10-14T00:00:00Z');
beforeAll(async () => {
  const require = createRequire(resolve('package.json'));
  sql = (await promisify(execFile)(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
    { env: { ...process.env, DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused' }, maxBuffer: 1024 * 1024 })).stdout;
});
beforeEach(async () => {
  db = new PGlite(); await db.exec(sql); client = new PrismaClient({ adapter: new PrismaPGlite(db) });
  await client.account.createMany({ data: [{ id: 'owner', publicKey: 'owner' }, { id: 'other', publicKey: 'other' }] });
  await client.project.create({ data: { id: 'chat:c', accountId: 'owner', name: 'Chat', config: { machineId: 'm' }, automationViewerPublicKey: new Uint8Array(32), automationViewerKeyVersion: 1 } });
  await client.machine.create({ data: { id: 'm', accountId: 'owner', metadata: '', automationKeyVersion: 1, automationPublicKey: new Uint8Array(32), automationProtocolVersion: 4 } });
  for (const [id, paused] of [['a', false], ['b', true]] as const) await client.automation.create({ data: { id, projectId: 'chat:c', ownerAccountId: 'owner', machineAccountId: 'owner', machineId: 'm', payloadVersion: 4, payloadCiphertext: new Uint8Array([1]), viewerKeyId: 'k', viewerKeyVersion: 1, viewerKeyEnvelope: new Uint8Array([1]), machineKeyVersion: 1, machineKeyEnvelope: new Uint8Array([1]), paused } });
  await client.automationRun.create({ data: { id: 'r', automationId: 'a', generation: 1, scheduledFor: now, machineAccountId: 'owner', machineId: 'm', status: 'CLAIMED', claimTokenHash: new Uint8Array([1]), claimExpiresAt: now } });
});
afterEach(async () => { await client?.$disconnect(); await db?.close(); });
const transition = (state: 'active' | 'archived' | 'deleted', owner = 'owner') => client.$transaction(tx => transitionChatAutomations(tx, owner, 'chat:c', state, now), { isolationLevel: 'Serializable' });
it('reports live schedule impact without preparing keys or changing the Chat', async () => {
  expect(await client.$transaction(tx => readChatAutomationImpact(tx, 'owner', 'chat:c'))).toEqual({ total: 2, paused: 1, running: 1 });
  expect(await client.automationChange.count()).toBe(0);
});
it('archives all schedules, cancels claims and restores without automatically resuming', async () => {
  await transition('archived');
  expect((await client.automation.findMany()).every(a => a.paused)).toBe(true);
  expect((await client.automationRun.findUniqueOrThrow({ where: { id: 'r' } })).status).toBe('CANCELLED');
  await transition('active');
  expect((await client.automation.findMany()).every(a => a.paused)).toBe(true);
  expect(await client.automation.count()).toBe(2);
});
it('deletes schedules idempotently and preserves encrypted definitions and run history', async () => {
  await transition('deleted'); const count = await client.automationChange.count(); await transition('deleted');
  expect(await client.automationChange.count()).toBe(count);
  expect(await client.automation.count({ where: { deletedAt: { not: null } } })).toBe(2);
  expect(await client.automationRun.count()).toBe(1);
  expect((await client.automation.findUniqueOrThrow({ where: { id: 'a' } })).payloadCiphertext).toEqual(new Uint8Array([1]));
  await expect(transition('active')).rejects.toThrow('CHAT_AUTOMATIONS_DELETED');
});
it('refuses another owner and does not touch any definitions', async () => {
  await expect(transition('deleted', 'other')).rejects.toThrow('CHAT_AUTOMATIONS_FORBIDDEN');
  expect(await client.automation.count({ where: { deletedAt: null } })).toBe(2);
});
it('blocks a late create, unpause and run request after the lifecycle fence', async () => {
  await transition('archived');
  const row = await client.automation.findUniqueOrThrow({ where: { id: 'a' } });
  expect(await client.$transaction(tx => updateAutomation(tx, 'owner', 'chat:c', 'a', { expectedRevision: row.revision, paused: false }))).toMatchObject({ ok: false });
  expect(await client.$transaction(tx => requestAutomationRun(tx, 'owner', 'chat:c', 'a', row.revision))).toMatchObject({ ok: false });
  expect(await client.$transaction(tx => createAutomation(tx, 'owner', 'chat:c', { ...row, paused: false }))).toMatchObject({ ok: false });
});
it('delivers sealed cancellation targets after reconnect, while old clients receive ordinary tombstones', async () => {
  await transition('deleted');
  const sync = await client.$transaction(tx => syncAutomations(tx, 'owner', 'm', { afterSeq: 0n, limit: 500, payloadVersions: [1, 4] }));
  expect(sync).toMatchObject({ ok: true });
  if (!sync.ok) throw new Error('sync failed');
  expect(sync.value.changes).toHaveLength(2);
  expect(sync.value.changes.every(row => row.kind === 'TOMBSTONE' && row.chatDeleted === true && row.payloadVersion === 4)).toBe(true);
  const old = await client.$transaction(tx => syncAutomations(tx, 'owner', 'm', { afterSeq: 0n, limit: 500 }));
  if (!old.ok) throw new Error('old sync failed');
  expect(old.value.changes.every(row => row.kind === 'TOMBSTONE' && row.chatDeleted === undefined)).toBe(true);
});
it.each(['QUEUED', 'RUNNING'])('cancels a %s script without erasing its history', async status => {
  const row = await client.automation.findUniqueOrThrow({ where: { id: 'a' } });
  await client.automation.create({ data: { ...row, id: 'script', payloadVersion: 3 } });
  await client.scriptArtifact.create({ data: { id: 'artifact', projectId: 'chat:c', digest: 'digest', encrypted: {} } });
  await client.scriptAutomationRevision.create({ data: { automationId: 'script', revision: 1, artifactId: 'artifact', digest: 'digest', payloadCiphertext: 'encrypted', admission: {} } });
  await client.scriptInvocation.create({ data: { id: 'script-run', automationId: 'script', revision: 1, generation: 1,
    trigger: 'SCHEDULE', requestedBy: 'owner', idempotencyKey: 'scheduled', bodyHash: 'hash', inputCiphertext: 'encrypted', snapshot: {}, status, createdAt: now.getTime() } });
  expect(await client.$transaction(tx => readChatAutomationImpact(tx, 'owner', 'chat:c'))).toMatchObject({ total: 3, running: 2 });
  await transition('deleted');
  const run = await client.scriptInvocation.findUniqueOrThrow({ where: { id: 'script-run' } });
  expect(run.status).toBe(status === 'QUEUED' ? 'CANCELLED' : 'RUNNING');
  if (status === 'RUNNING') expect(run.cancelRequestedAt).toBe(now.getTime());
});

it('lists and explicitly resumes a script after archive and restore without losing its definition or schedule cursor', async () => {
  const keys = nacl.box.keyPair();
  await client.project.update({ where: { id: 'chat:c' }, data: { automationViewerPublicKey: new Uint8Array(keys.publicKey) } });
  await client.machine.update({ where: { id: 'm' }, data: { automationPublicKey: new Uint8Array(keys.publicKey), automationProtocolVersion: 5 } });
  const encrypted = encryptScriptValue({ value: {}, context: { projectId: 'chat:c', resourceId: 'script', purpose: 'configuration' }, viewerPublicKey: keys.publicKey, machinePublicKey: keys.publicKey });
  const registration = {
    registrationKey: 'script', expectedRevision: 0, paused: false, viewerKeyVersion: 1, machineKeyVersion: 1,
    encrypted, artifact: encrypted,
    admission: { artifactId: 'artifact', digest: 'a'.repeat(64), schedule: { kind: 'interval' as const, minutes: 15, enabled: true }, externalEnabled: false, inputSchema: {} },
  };
  const row = await client.$transaction(tx => saveScriptAutomation(tx, 'owner', 'chat:c', registration));
  await client.scriptAutomationRevision.update({ where: { automationId_revision: { automationId: row.id, revision: 1 } }, data: { ready: true, scheduleInitialized: true, nextRunAt: 123456 } });
  await transition('archived');
  await transition('active');

  const app = fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'owner'; });
  scriptAutomationRoutes(app, { transaction: action => client.$transaction(action), enabled: () => true });
  try {
    const listed = await app.inject({ method: 'GET', url: '/v1/projects/chat:c/script-automations' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().automations).toEqual([expect.objectContaining({ id: row.id, revision: 1, generation: 2, paused: true, encrypted, admission: registration.admission, nextRunAt: null })]);
    const resumed = await app.inject({ method: 'POST', url: '/v1/projects/chat:c/script-automations', payload: { ...registration, expectedRevision: 1 } });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().automation).toMatchObject({ revision: 2, paused: false, encrypted, admission: registration.admission });
    expect(await client.scriptAutomationRevision.findUniqueOrThrow({ where: { automationId_revision: { automationId: row.id, revision: 2 } } })).toMatchObject({ scheduleInitialized: true, nextRunAt: 123456 });
  } finally { await app.close(); }
});
