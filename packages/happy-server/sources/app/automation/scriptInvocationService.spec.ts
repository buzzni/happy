import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createScriptInvocationService, type ScriptQueueDatabase } from './scriptInvocationService';

let db: PGlite;
let service: ReturnType<typeof createScriptInvocationService>;
const request = {
  automationId: 'a1', projectId: 'p1', revision: 1, generation: 1,
  trigger: 'API' as const, requestedBy: 'caller', keyId: 'k1', keyEpoch: 1,
  idempotencyKey: 'i1', bodyHash: 'hash', inputCiphertext: 'encrypted-input',
};

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE "Project" (id TEXT PRIMARY KEY); INSERT INTO "Project" VALUES ('p1');
  CREATE TABLE "Automation" (
    id TEXT PRIMARY KEY, "projectId" TEXT NOT NULL, revision INTEGER NOT NULL,
    generation INTEGER NOT NULL, paused BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMPTZ, "machineAccountId" TEXT, "machineId" TEXT
  ); INSERT INTO "Automation" VALUES ('a1','p1',1,1,false,NULL,'owner','machine');`);
  await db.exec(await readFile('prisma/migrations/20260908233000_script_invocations/migration.sql', 'utf8'));
  await db.query(`INSERT INTO "ScriptArtifact" VALUES ('artifact','p1','digest','{}')`);
  await db.query(`INSERT INTO "ScriptAutomationRevision" ("automationId",revision,"artifactId",digest,"payloadCiphertext","admission",ready) VALUES ('a1',1,'artifact','digest','encrypted-code','{"externalEnabled":true}',true)`);
  await db.query(`INSERT INTO "ScriptAutomationKeyEpoch" (id,"automationId",epoch,"expiresAt") VALUES ('k1','a1',1,999999999)`);
  const database: ScriptQueueDatabase = {
    transaction: (action) => db.transaction((tx) => action({
      query: async <T>(sql: string, values: unknown[] = []) => (await tx.query<T>(sql, values)).rows,
    })),
  };
  service = createScriptInvocationService(database);
});
afterEach(async () => { await db?.close(); });

describe('durable script invocation queue', () => {
  it('never resurrects a revoked key epoch and cancels an already claimed invocation', async () => {
    await service.enqueue(request, 1000);
    const claim = (await service.claim('a1', 'owner', 'machine', 2000))!;
    const key = { projectId: 'p1', automationId: 'a1', keyId: 'k1', epoch: 2, revoked: true, expiresAt: 999999999 };
    await service.syncKey(key, 2001);
    await service.syncKey(key, 2002);
    await expect(service.syncKey({ ...key, epoch: 1, revoked: false }, 2003)).rejects.toThrow('KEY_EPOCH_CONFLICT');
    await expect(service.syncKey({ ...key, epoch: 3, revoked: false }, 2003)).rejects.toThrow('KEY_EPOCH_CONFLICT');
    await expect(service.start(claim.run.id, claim.token, 2004)).rejects.toThrow('CLAIM_INVALID');
    expect((await db.query('SELECT epoch,revoked FROM "ScriptAutomationKeyEpoch"')).rows[0]).toEqual({ epoch: 2, revoked: true });
  });
  it('limits new API admissions per key without charging duplicate requests twice', async () => {
    const first = await service.enqueue(request, 1000);
    for (let index = 1; index < 60; index++) await service.enqueue({ ...request, idempotencyKey: `rate-${index}` }, 1000);
    expect((await service.enqueue(request, 1001)).id).toBe(first.id);
    await expect(service.enqueue({ ...request, idempotencyKey: 'over-limit' }, 1002)).rejects.toThrow('RATE_LIMITED');
    const next = await service.enqueue({ ...request, idempotencyKey: 'next-window' }, 61000);
    expect(next.status).toBe('QUEUED');
    expect((await db.query('SELECT "rateCount" FROM "ScriptAutomationKeyEpoch"')).rows[0]).toEqual({ rateCount: 1 });
  });
  it('expires offline queued work, removes terminal inputs after a day, and retains idempotency for thirty days', async () => {
    const first = await service.enqueue(request, 1000);
    const claim = (await service.claim('a1', 'owner', 'machine', 2000))!;
    await service.start(first.id, claim.token, 2001);
    await service.complete(first.id, claim.token, { exitCode: 0, logCiphertext: 'logs' }, 3000);
    const queued = await service.enqueue({ ...request, idempotencyKey: 'offline' }, 4000);
    await service.sweep('a1', 86404000);
    expect((await db.query('SELECT status,"inputCiphertext" FROM "ScriptInvocation" WHERE id=$1', [first.id])).rows[0]).toEqual({ status: 'COMPLETED', inputCiphertext: '' });
    expect((await db.query('SELECT status FROM "ScriptInvocation" WHERE id=$1', [queued.id])).rows[0]).toEqual({ status: 'EXPIRED' });
    expect((await service.enqueue(request, 86404001)).id).toBe(first.id);
    await service.sweep('a1', 32 * 86400000);
    expect((await db.query('SELECT id FROM "ScriptInvocation"')).rows).toHaveLength(0);
    expect((await db.query('SELECT revision FROM "ScriptAutomationRevision"')).rows).toHaveLength(1);
    expect((await db.query('SELECT id FROM "ScriptArtifact"')).rows).toHaveLength(1);
  });
  it('accepts an identical terminal report retry but rejects changed results and tokens', async () => {
    await service.enqueue(request, 1000);
    const claim = (await service.claim('a1', 'owner', 'machine', 2000))!;
    await service.start(claim.run.id, claim.token, 2001);
    const result = { exitCode: 0, logCiphertext: 'logs' };
    await service.complete(claim.run.id, claim.token, result, 2002);
    await service.complete(claim.run.id, claim.token, result, 900000);
    await expect(service.complete(claim.run.id, claim.token, { ...result, exitCode: 2 }, 900001)).rejects.toThrow('REPORT_CONFLICT');
    await expect(service.complete(claim.run.id, 'wrong', result, 900002)).rejects.toThrow('CLAIM_INVALID');
    expect((await db.query<{ completedAt: number }>('SELECT "completedAt" FROM "ScriptInvocation"')).rows[0].completedAt).toBe(2002);
  });
  it('records preparation failure without claiming the script ran', async () => {
    await service.enqueue(request, 1000);
    const claim = (await service.claim('a1', 'owner', 'machine', 2000))!;
    await service.failClaim(claim.run.id, claim.token, 'ARTIFACT_DIGEST_MISMATCH', 2001);
    await service.failClaim(claim.run.id, claim.token, 'ARTIFACT_DIGEST_MISMATCH', 900000);
    await expect(service.failClaim(claim.run.id, claim.token, 'OTHER_FAILURE', 900001)).rejects.toThrow('REPORT_CONFLICT');
    expect((await db.query('SELECT status,"startedAt","failureCode" FROM "ScriptInvocation"')).rows[0]).toEqual({
      status: 'FAILED', startedAt: null, failureCode: 'ARTIFACT_DIGEST_MISMATCH',
    });
  });
  it('acknowledges preparation reports for cancelled claims without overwriting the cancellation', async () => {
    await service.enqueue(request, 1000);
    const claim = (await service.claim('a1', 'owner', 'machine', 2000))!;
    await service.revokeKey('a1', 'k1', 1, 2001);
    await service.failClaim(claim.run.id, claim.token, 'SCRIPT_PREPARATION_FAILED', 2002);
    expect((await db.query('SELECT status,"failureCode" FROM "ScriptInvocation"')).rows[0]).toEqual({ status: 'CANCELLED', failureCode: null });
  });
  it('acknowledges an expired preparation report before maintenance without replaying', async () => {
    await service.enqueue(request, 1000);
    const claim = (await service.claim('a1', 'owner', 'machine', 2000))!;
    await service.failClaim(claim.run.id, claim.token, 'WORKER_RESTARTED_BEFORE_START', 400000);
    expect((await db.query('SELECT status,"failureCode" FROM "ScriptInvocation"')).rows[0]).toEqual({ status: 'EXPIRED', failureCode: 'CLAIM_EXPIRED' });
    expect(await service.claim('a1', 'owner', 'machine', 400001)).toBeNull();
  });
  it('records UNKNOWN after verified worker cleanup and makes restart recovery idempotent', async () => {
    await service.enqueue(request, 1000);
    const claim = (await service.claim('a1', 'owner', 'machine', 2000))!;
    await service.start(claim.run.id, claim.token, 2001);
    await expect(service.abandon(claim.run.id, 'wrong', 2002)).rejects.toThrow('CLAIM_INVALID');
    await service.abandon(claim.run.id, claim.token, 2003);
    await service.abandon(claim.run.id, claim.token, 2004);
    expect((await db.query('SELECT status,"failureCode","completedAt" FROM "ScriptInvocation"')).rows[0]).toEqual({ status: 'UNKNOWN', failureCode: 'WORKER_LOST', completedAt: 2003 });
    expect(await service.claim('a1', 'owner', 'machine', 2005)).toBeNull();
  });
  it('scopes cancellation to the project and fences a running worker heartbeat', async () => {
    await service.enqueue(request, 1000);
    const claim = (await service.claim('a1', 'owner', 'machine', 2000))!;
    await service.start(claim.run.id, claim.token, 2001);
    await expect(service.cancel('other', 'a1', claim.run.id, 2002)).rejects.toThrow('NOT_FOUND');
    await service.heartbeat(claim.run.id, claim.token, 2003);
    await service.cancel('p1', 'a1', claim.run.id, 2004);
    await service.cancel('p1', 'a1', claim.run.id, 2005);
    await expect(service.heartbeat(claim.run.id, claim.token, 2006)).rejects.toThrow('CLAIM_INVALID');
    expect((await db.query('SELECT status,"cancelRequestedAt" FROM "ScriptInvocation"')).rows[0]).toEqual({ status: 'RUNNING', cancelRequestedAt: 2004 });
    await service.enqueue({ ...request, idempotencyKey: 'next' }, 2007);
    expect(await service.claim('a1', 'owner', 'machine', 2008)).toBeNull();
    await service.complete(claim.run.id, claim.token, { exitCode: 137, logCiphertext: '', failureCode: 'SCRIPT_CANCELLED' }, 2009);
    expect((await db.query('SELECT status FROM "ScriptInvocation" WHERE id=$1', [claim.run.id])).rows[0]).toEqual({ status: 'CANCELLED' });
    expect(await service.claim('a1', 'owner', 'machine', 2010)).not.toBeNull();
  });
  it('returns the persisted run for duplicate requests and rejects a changed body', async () => {
    const run = await service.enqueue(request, 1000);
    expect(run.status).toBe('QUEUED');
    expect((await service.enqueue(request, 1001)).id).toBe(run.id);
    await expect(service.enqueue({ ...request, bodyHash: 'different' }, 1002)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect((await db.query('SELECT * FROM "ScriptInvocation"')).rows).toHaveLength(1);
  });
  it('claims FIFO once and fences completion using the claim token', async () => {
    const first = await service.enqueue(request, 1000);
    await service.enqueue({ ...request, idempotencyKey: 'i2' }, 1001);
    const claim = await service.claim('a1', 'owner', 'machine', 2000);
    expect(claim?.run.id).toBe(first.id);
    expect(await service.claim('a1', 'owner', 'machine', 2001)).toBeNull();
    await expect(service.start(first.id, 'invalid', 2002)).rejects.toThrow('CLAIM_INVALID');
    await service.start(first.id, claim!.token, 2002);
    await service.complete(first.id, claim!.token, { exitCode: 0, logCiphertext: 'logs' }, 2003);
    expect((await service.claim('a1', 'owner', 'machine', 2004))?.run.id).not.toBe(first.id);
  });
  it('keeps the accepted revision snapshot after a code update', async () => {
    await service.enqueue(request, 1000);
    await db.query('UPDATE "Automation" SET revision=2');
    const claim = await service.claim('a1', 'owner', 'machine', 2000);
    expect(claim?.run.revision).toBe(1);
    expect(claim?.run.snapshot).toMatchObject({ artifactId: 'artifact', digest: 'digest' });
  });
  it('rejects other projects and machines and cancels pending work after pause', async () => {
    await expect(service.enqueue({ ...request, projectId: 'other' }, 1000)).rejects.toThrow('NOT_FOUND');
    await service.enqueue(request, 1000);
    await expect(service.claim('a1', 'owner', 'other', 2000)).rejects.toThrow('MACHINE_DENIED');
    await db.query('UPDATE "Automation" SET paused=true');
    expect(await service.claim('a1', 'owner', 'machine', 2001)).toBeNull();
    expect((await db.query<{ status: string }>('SELECT status FROM "ScriptInvocation"')).rows[0].status).toBe('CANCELLED');
  });
  it('revokes a key and prevents an already claimed run from starting', async () => {
    await service.enqueue(request, 1000);
    const claim = await service.claim('a1', 'owner', 'machine', 2000);
    await service.revokeKey('a1', 'k1', 1, 2001);
    await expect(service.start(claim!.run.id, claim!.token, 2002)).rejects.toThrow('CLAIM_INVALID');
    await expect(service.enqueue({ ...request, idempotencyKey: 'i2' }, 2003)).rejects.toThrow('KEY_REVOKED');
  });
  it('records unknown side effects after a running lease is lost and never replays the run', async () => {
    await service.enqueue(request, 1000);
    const claim = await service.claim('a1', 'owner', 'machine', 2000);
    await service.start(claim!.run.id, claim!.token, 2001);
    expect(await service.claim('a1', 'owner', 'machine', 400000)).toBeNull();
    expect((await db.query<{ status: string }>('SELECT status FROM "ScriptInvocation"')).rows[0].status).toBe('UNKNOWN');
    expect(await service.complete(claim!.run.id, claim!.token, { exitCode: 0, logCiphertext: '' }, 400001)).toEqual({ recorded: false, status: 'UNKNOWN' });
    expect((await db.query('SELECT status,"logCiphertext" FROM "ScriptInvocation"')).rows[0]).toEqual({ status: 'UNKNOWN', logCiphertext: null });
  });
  it('fences an expired report even before a maintenance sweep observes the lease', async () => {
    await service.enqueue(request, 1000);
    const claim = (await service.claim('a1', 'owner', 'machine', 2000))!;
    await service.start(claim.run.id, claim.token, 2001);
    expect(await service.complete(claim.run.id, claim.token, { exitCode: 0, logCiphertext: 'late' }, 400000)).toEqual({ recorded: false, status: 'UNKNOWN' });
    expect((await db.query('SELECT status,"logCiphertext" FROM "ScriptInvocation"')).rows[0]).toEqual({ status: 'UNKNOWN', logCiphertext: null });
  });
  it('expires work that was not started for 24 hours', async () => {
    await service.enqueue(request, 1000);
    expect(await service.claim('a1', 'owner', 'machine', 86401001)).toBeNull();
    expect((await db.query<{ status: string }>('SELECT status FROM "ScriptInvocation"')).rows[0].status).toBe('EXPIRED');
  });
  it('serializes simultaneous duplicate admission and competing claims', async () => {
    const runs = await Promise.all(Array.from({ length: 5 }, () => service.enqueue(request, 1000)));
    expect(new Set(runs.map((run) => run.id)).size).toBe(1);
    const claims = await Promise.all(Array.from({ length: 5 }, () => service.claim('a1', 'owner', 'machine', 2000)));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it('persists cancellation when pause wins between claim and start', async () => {
    await service.enqueue(request, 1000);
    const claim = await service.claim('a1', 'owner', 'machine', 2000);
    await db.query('UPDATE "Automation" SET paused=true');
    await expect(service.start(claim!.run.id, claim!.token, 2001)).rejects.toThrow('CLAIM_INVALID');
    expect((await db.query<{ status: string }>('SELECT status FROM "ScriptInvocation"')).rows[0].status).toBe('CANCELLED');
  });
  it('expires unstarted claims without replaying and accepts failed exits as failures', async () => {
    await service.enqueue(request, 1000);
    const first = await service.claim('a1', 'owner', 'machine', 2000);
    expect(await service.claim('a1', 'owner', 'machine', 122000)).toBeNull();
    await expect(service.start(first!.run.id, first!.token, 122001)).rejects.toThrow('CLAIM_INVALID');
    await service.enqueue({ ...request, idempotencyKey: 'second' }, 123000);
    const second = await service.claim('a1', 'owner', 'machine', 124000);
    await service.start(second!.run.id, second!.token, 124001);
    await service.complete(second!.run.id, second!.token, { exitCode: 2, logCiphertext: 'encrypted-error' }, 124002);
    const rows = (await db.query<{ status: string }>('SELECT status FROM "ScriptInvocation" ORDER BY "createdAt"')).rows;
    expect(rows.map((row) => row.status)).toEqual(['EXPIRED', 'FAILED']);
  });
});
