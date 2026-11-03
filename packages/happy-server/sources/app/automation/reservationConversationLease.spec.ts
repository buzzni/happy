import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { manageReservationCheckpoint } from './reservationCheckpoint';
import { reportAutomationRun } from './automationExecutionService';
import { manageReservationConversationLease, reservationMessageAccess } from './reservationConversationLease';
let sql: string, db: PGlite, client: PrismaClient;
const now = new Date('2026-11-03T00:00:00Z'), descriptorHash = 'a'.repeat(64);
const base = { wireVersion: 1 as const, runId: 'r1', claimToken: 'token-r1', sessionId: 's1' };
beforeAll(async () => {
  const require = createRequire(resolve('package.json'));
  sql = (await promisify(execFile)(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], { env: { ...process.env, DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused' }, maxBuffer: 1024 * 1024 })).stdout;
});
beforeEach(async () => {
  db = new PGlite(); await db.exec(sql); client = new PrismaClient({ adapter: new PrismaPGlite(db) });
  await client.account.create({ data: { id: 'owner', publicKey: 'owner' } });
  await client.project.create({ data: { id: 'p', accountId: 'owner', name: 'Project', config: { machineId: 'm' }, automationViewerKeyVersion: 1 } });
  await client.machine.create({ data: { id: 'm', accountId: 'owner', metadata: '', automationKeyVersion: 1, automationProtocolVersion: 7 } });
  await client.automation.create({ data: { id: 'a', projectId: 'p', ownerAccountId: 'owner', machineAccountId: 'owner', machineId: 'm', payloadVersion: 5, payloadCiphertext: new Uint8Array([1]), viewerKeyId: 'k', viewerKeyVersion: 1, viewerKeyEnvelope: new Uint8Array([1]), machineKeyVersion: 1, machineKeyEnvelope: new Uint8Array([1]) } });
  await client.session.create({ data: { id: 's1', accountId: 'owner', tag: 's1', metadata: '' } });
  await run('r1');
});
afterEach(async () => { await client?.$disconnect(); await db?.close(); });
async function run(id: string) { await client.automationRun.create({ data: { id, automationId: 'a', generation: 1, scheduledFor: new Date(now.getTime() + Number(id.slice(1)) * 1000), machineAccountId: 'owner', machineId: 'm', status: 'RUNNING', claimTokenHash: new Uint8Array(createHash('sha256').update(`token-${id}`).digest()), claimExpiresAt: new Date(now.getTime() + 600_000), runLeaseExpiresAt: new Date(now.getTime() + 600_000) } }); }
const manage = (input: Record<string, unknown>, at = now) => client.$transaction(tx => manageReservationConversationLease(tx, 'owner', 'm', { ...base, ...input } as never, at));
const acquire = (extra: Record<string, unknown> = {}, at = now) => manage({ operation: 'acquire', expectedSeq: 0, descriptorHash, ...extra }, at);
it('replays a lost acquire ACK but gives another run no access to the same conversation', async () => {
  const first = await acquire(); expect(first.ok).toBe(true);
  if (first.ok) { expect(first.value.messageAuthorization).toMatch(/^[a-f0-9-]+\.[A-Za-z0-9_-]{43}$/); expect(first.value.messageAuthorization).not.toContain('token-r1'); }
  expect(await acquire()).toEqual(first);
  await run('r2'); expect(await acquire({ runId: 'r2', claimToken: 'token-r2' })).toMatchObject({ ok: false, error: 'reservation-busy' });
  expect((await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } })).sessionId).toBe('s1');
  expect(await client.session.count()).toBe(1);
});
it('fences manual input in PREPARING and permits only the current runtime after activation', async () => {
  const admitted = await acquire(); if (!admitted.ok) throw new Error('admission failed');
  const epoch = admitted.value.epoch;
  expect(await client.$transaction(tx => reservationMessageAccess(tx, 'owner', 's1', undefined, now))).toMatchObject({ ok: false, error: 'reservation-busy' });
  const proof = admitted.value.messageAuthorization;
  expect(await client.$transaction(tx => reservationMessageAccess(tx, 'owner', 's1', proof, now))).toMatchObject({ ok: false });
  expect(await manage({ operation: 'activate', runtime: { launchId: 'launch', processGroupId: 1, processStartId: 'start' }, epoch, descriptorHash })).toMatchObject({ ok: true, value: { state: 'RUNNING' } });
  expect(await client.$transaction(tx => reservationMessageAccess(tx, 'owner', 's1', proof, now))).toMatchObject({ ok: true });
  expect(await client.$transaction(tx => reservationMessageAccess(tx, 'owner', 's1', `stale.${proof?.split('.')[1]}`, now))).toMatchObject({ ok: false });
});
it('never steals an expired lease without bound exit verification', async () => {
  const admitted = await acquire(); if (!admitted.ok) throw new Error('admission failed');
  const epoch = admitted.value.epoch, later = new Date(now.getTime() + 100_000);
  await run('r2'); expect(await acquire({ runId: 'r2', claimToken: 'token-r2' }, later)).toMatchObject({ ok: false, error: 'reservation-busy' });
  expect(await manage({ operation: 'settle', epoch }, later)).toMatchObject({ ok: true, value: { state: 'SETTLING' } });
  const proof = { status: 'exited', epoch, descriptorHash, launchId: 'launch', processGroupId: 1, processStartId: 'start', verifiedAt: later.getTime() };
  expect(await manage({ operation: 'release', epoch, proof: { ...proof, epoch: 'stale' } }, later)).toMatchObject({ ok: false });
  expect(await acquire({ runId: 'r2', claimToken: 'token-r2' }, later)).toMatchObject({ ok: false });
  expect(await manage({ operation: 'release', epoch, proof }, later)).toMatchObject({ ok: true });
  expect(await acquire({ runId: 'r2', claimToken: 'token-r2' }, later)).toMatchObject({ ok: true });
});
it('rejects a changed sequence, generation or paused definition without creating a lease', async () => {
  expect(await acquire({ expectedSeq: 1 })).toMatchObject({ ok: false, error: 'session-changed' });
  await client.automation.update({ where: { id: 'a' }, data: { paused: true } });
  expect(await acquire()).toMatchObject({ ok: false, error: 'claim-cancelled' });
  expect(await db.query('SELECT * FROM "ReservationConversationLease"')).toMatchObject({ rows: [] });
});
it('allows cleanup after cancellation but never another runtime write or a stale-epoch release', async () => {
  const admitted = await acquire(); if (!admitted.ok) throw new Error('admission failed'); const epoch = admitted.value.epoch;
  await manage({ operation: 'activate', runtime: { launchId: 'launch', processGroupId: 1, processStartId: 'start' }, epoch, descriptorHash });
  await client.automation.update({ where: { id: 'a' }, data: { paused: true, generation: 2 } });
  expect(await client.$transaction(tx => reservationMessageAccess(tx, 'owner', 's1', admitted.value.messageAuthorization, now))).toMatchObject({ ok: false });
  expect(await manage({ operation: 'settle', epoch })).toMatchObject({ ok: true });
  const proof = { status: 'exited', epoch, descriptorHash, launchId: 'launch', processGroupId: 1, processStartId: 'start', verifiedAt: now.getTime() };
  expect(await manage({ operation: 'release', epoch, proof: { status: 'not-started', epoch, descriptorHash, verifiedAt: now.getTime() } })).toMatchObject({ ok: false, error: 'reservation-exit-unconfirmed' });
  expect(await manage({ operation: 'release', epoch, proof: { ...proof, processStartId: 'reused-pid' } })).toMatchObject({ ok: false, error: 'reservation-exit-unconfirmed' });
  expect(await manage({ operation: 'release', epoch, proof })).toMatchObject({ ok: true });
  expect(await client.$transaction(tx => reservationMessageAccess(tx, 'owner', 's1', undefined, now))).toMatchObject({ ok: true });
});

it('does not finalize a run while its conversation authority remains installed', async () => {
  const admitted = await acquire(); if (!admitted.ok) throw new Error('admission failed');
  await manage({ operation: 'activate', runtime: { launchId: 'launch', processGroupId: 1, processStartId: 'start' }, epoch: admitted.value.epoch, descriptorHash });
  const report = { runId: 'r1', claimToken: 'token-r1', reportId: 'report', status: 'COMPLETED' as const, outcome: 'WOKE' as const, sessionId: 's1', detailCiphertext: null, failureCode: null };
  expect(await client.$transaction(tx => reportAutomationRun(tx, 'owner', 'm', report, now))).toMatchObject({ ok: false, error: 'reservation-unsettled' });
  expect((await client.automationRun.findUniqueOrThrow({ where: { id: 'r1' } })).status).toBe('RUNNING');
});

it('CAS-writes opaque checkpoints only for the current run and preserves state across turns', async () => {
  const admitted = await acquire(); if (!admitted.ok) throw new Error('admission failed');
  const epoch = admitted.value.epoch;
  const checkpoint = (patch: Record<string, unknown>) => client.$transaction(tx => manageReservationCheckpoint(tx, 'owner', 'm', { ...base, epoch, ...patch } as never, now));
  expect(await checkpoint({ operation: 'read-checkpoint' })).toEqual({ ok: true, value: { revision: 0, ciphertext: null } });
  const ciphertext = Buffer.from('opaque cipher, not plaintext monitor output').toString('base64');
  expect(await checkpoint({ operation: 'write-checkpoint', expectedRevision: 0, ciphertext })).toEqual({ ok: true, value: { revision: 1, ciphertext } });
  expect(await checkpoint({ operation: 'write-checkpoint', expectedRevision: 0, ciphertext: 'bmV3' })).toMatchObject({ ok: false, error: 'checkpoint-conflict' });
  expect(await checkpoint({ operation: 'read-checkpoint', epoch: 'stale' })).toMatchObject({ ok: false });
  expect(await checkpoint({ operation: 'read-checkpoint' })).toEqual({ ok: true, value: { revision: 1, ciphertext } });
  await manage({ operation: 'settle', epoch });
  expect(await checkpoint({ operation: 'write-checkpoint', expectedRevision: 1, ciphertext })).toMatchObject({ ok: false });
});

it('distinguishes stored prompt proof from an uncertain absence and refuses foreign history', async () => {
  const admitted = await acquire(); if (!admitted.ok) throw new Error('admission failed');
  const proof = (pendingRunId: string) => client.$transaction(tx => manageReservationCheckpoint(tx, 'owner', 'm', { ...base, operation: 'delivery-proof', epoch: admitted.value.epoch, pendingRunId }, now));
  expect(await proof('r1')).toMatchObject({ ok: true, value: { status: 'unconfirmed' } });
  expect(await proof('foreign')).toMatchObject({ ok: true, value: { status: 'unconfirmed' } });
  await client.sessionMessage.create({ data: { sessionId: 's1', seq: 1, localId: 'happy-automation:r1', content: { t: 'encrypted', c: 'opaque' } } });
  expect(await proof('r1')).toEqual({ ok: true, value: { status: 'delivered', runId: 'r1', sessionId: 's1', localId: 'happy-automation:r1', seq: 1 } });
});

it('recovers an unknown acquire ACK after pause without returning a message capability or restarting authority', async () => {
  const admitted = await acquire(); if (!admitted.ok) throw new Error('admission failed');
  await client.automation.update({ where: { id: 'a' }, data: { paused: true, generation: 2 } });
  expect(await manage({ operation: 'recover', descriptorHash: 'b'.repeat(64) })).toMatchObject({ ok: false, error: 'reservation-context-mismatch' });
  expect(await manage({ operation: 'recover', descriptorHash, claimToken: 'foreign' })).toMatchObject({ ok: false, error: 'reservation-context-mismatch' });
  const recovered = await manage({ operation: 'recover', descriptorHash });
  expect(recovered).toMatchObject({ ok: true, value: { epoch: admitted.value.epoch, state: 'SETTLING', descriptorHash } });
  if (recovered.ok) expect(recovered.value).not.toHaveProperty('messageAuthorization');
  expect(await manage({ operation: 'heartbeat', epoch: admitted.value.epoch })).toMatchObject({ ok: false });
  expect(await client.session.count()).toBe(1);
});
