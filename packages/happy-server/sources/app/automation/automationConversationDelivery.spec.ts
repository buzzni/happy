import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { deliverAutomationConversationMessage } from './automationConversationDelivery';
let sql: string, db: PGlite, client: PrismaClient;
const now = new Date('2026-10-14T00:00:00Z');
const request = { wireVersion: 1 as const, runId: 'r1', claimToken: 'token-r1', sessionId: 's1', expectedSeq: 0, contentCiphertext: 'ZW5jcnlwdGVk' };
beforeAll(async () => {
  const require = createRequire(resolve('package.json'));
  sql = (await promisify(execFile)(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
    { env: { ...process.env, DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused' }, maxBuffer: 1024 * 1024 })).stdout;
});

beforeEach(async () => {
  db = new PGlite(); await db.exec(sql); client = new PrismaClient({ adapter: new PrismaPGlite(db) });
  await client.account.createMany({ data: [{ id: 'owner', publicKey: 'owner' }, { id: 'other', publicKey: 'other' }] });
  await client.project.create({ data: { id: 'chat:c1', accountId: 'owner', name: 'Chat', config: { machineId: 'm1' }, automationViewerKeyVersion: 1 } });
  await client.machine.create({ data: { id: 'm1', accountId: 'owner', metadata: '', automationKeyVersion: 1, automationProtocolVersion: 7 } });
  await client.automation.create({ data: { id: 'a1', projectId: 'chat:c1', ownerAccountId: 'owner', machineAccountId: 'owner', machineId: 'm1', payloadVersion: 4, payloadCiphertext: new Uint8Array([1]), viewerKeyId: 'k', viewerKeyVersion: 1, viewerKeyEnvelope: new Uint8Array([1]), machineKeyVersion: 1, machineKeyEnvelope: new Uint8Array([1]) } });
  await client.session.create({ data: { id: 's1', accountId: 'owner', tag: 's1', metadata: '' } });
  await run('r1');
});
afterEach(async () => { await client?.$disconnect(); await db?.close(); });
async function run(id: string) { await client.automationRun.create({ data: { id, automationId: 'a1', generation: 1, scheduledFor: new Date(now.getTime() + Number(id.slice(1)) * 1000), machineAccountId: 'owner', machineId: 'm1', status: 'RUNNING', claimTokenHash: new Uint8Array(createHash('sha256').update(`token-${id}`).digest()), claimExpiresAt: new Date(now.getTime() + 60000), runLeaseExpiresAt: new Date(now.getTime() + 60000) } }); }
const deliver = (patch: Partial<typeof request> = {}) => client.$transaction(tx => deliverAutomationConversationMessage(tx, 'owner', 'm1', { ...request, ...patch }, now));
it('stores two scheduled questions, a manual follow-up and a third schedule in the ordinary session', async () => {
  expect(await deliver()).toMatchObject({ ok: true, value: { message: { seq: 1, sessionId: 's1' } } });
  await run('r2'); expect(await deliver({ runId: 'r2', claimToken: 'token-r2', expectedSeq: 1 })).toMatchObject({ ok: true });
  await client.sessionMessage.create({ data: { sessionId: 's1', seq: 3, localId: 'manual', content: { t: 'encrypted', c: 'manual' } } });
  await client.session.update({ where: { id: 's1' }, data: { seq: 3 } });
  await run('r3'); expect(await deliver({ runId: 'r3', claimToken: 'token-r3', expectedSeq: 3 })).toMatchObject({ ok: true });
  expect((await client.sessionMessage.findMany({ where: { sessionId: 's1' }, orderBy: { seq: 'asc' } })).map(m => m.localId)).toEqual(['happy-automation:r1', 'happy-automation:r2', 'manual', 'happy-automation:r3']);
  expect(await client.session.count()).toBe(1);
});
it('replays a delivered run without adding a second question and rejects redirecting the replay', async () => {
  await deliver(); expect(await deliver()).toMatchObject({ ok: true, value: { idempotent: true } });
  expect(await client.sessionMessage.count()).toBe(1);
  expect(await deliver({ sessionId: 'another' })).toMatchObject({ ok: false });
});
it.each(['paused', 'deleted', 'generation', 'key', 'revoked', 'expired'])('does not deliver after %s changes', async reason => {
  if (reason === 'paused') await client.automation.update({ where: { id: 'a1' }, data: { paused: true } });
  if (reason === 'deleted') await client.automation.update({ where: { id: 'a1' }, data: { deletedAt: now } });
  if (reason === 'generation') await client.automation.update({ where: { id: 'a1' }, data: { generation: 2 } });
  if (reason === 'key') await client.machine.update({ where: { accountId_id: { accountId: 'owner', id: 'm1' } }, data: { automationKeyVersion: 2 } });
  if (reason === 'revoked') await client.session.update({ where: { id: 's1' }, data: { accountId: 'other' } });
  if (reason === 'expired') await client.automationRun.update({ where: { id: 'r1' }, data: { runLeaseExpiresAt: new Date(0) } });
  expect(await deliver()).toMatchObject({ ok: false }); expect(await client.sessionMessage.count()).toBe(0);
});
it('rejects a stale sequence without consuming the prompt and permits a rechecked sequence', async () => {
  await client.session.update({ where: { id: 's1' }, data: { seq: 2 } });
  expect(await deliver()).toMatchObject({ ok: false, error: 'session-changed' });
  expect(await client.sessionMessage.count()).toBe(0);
  expect(await deliver({ expectedSeq: 2 })).toMatchObject({ ok: true });
});
it('reports an inactive resumed target separately and delivers after its heartbeat activates it', async () => {
  await client.session.update({ where: { id: 's1' }, data: { active: false } });
  expect(await deliver()).toMatchObject({ ok: false, error: 'session-inactive' });
  expect(await client.sessionMessage.count()).toBe(0);
  expect((await client.session.findUniqueOrThrow({ where: { id: 's1' } })).seq).toBe(0);
  await client.session.update({ where: { id: 's1' }, data: { active: true } });
  expect(await deliver()).toMatchObject({ ok: true, value: { message: { seq: 1 } } });
  expect(await client.sessionMessage.count()).toBe(1);
});
