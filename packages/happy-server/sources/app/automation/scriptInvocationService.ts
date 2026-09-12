import { createHash, randomBytes, randomUUID } from 'node:crypto';

// Bound SQL parameters only; both Prisma and the integration database implement
// this transaction boundary. Every mutation locks Automation before run/key rows.
export type ScriptQueueTransaction = { query<T>(sql: string, values?: unknown[]): Promise<T[]> };
export type ScriptQueueDatabase = { transaction<T>(action: (tx: ScriptQueueTransaction) => Promise<T>): Promise<T> };
type Automation = {
  id: string; projectId: string; revision: number; generation: number; paused: boolean;
  deletedAt: Date | null; machineAccountId: string | null; machineId: string | null;
  scriptRegistrationKey: string | null;
};
type Revision = {
  artifactId: string; digest: string; payloadCiphertext: string;
  admission: { externalEnabled: boolean }; ready: boolean;
};
export type ScriptInvocation = {
  id: string; automationId: string; revision: number; generation: number;
  trigger: 'API' | 'MANUAL' | 'SCHEDULE'; requestedBy: string;
  keyId: string | null; keyEpoch: number | null; idempotencyKey: string;
  bodyHash: string; inputCiphertext: string; snapshot: Revision;
  status: 'QUEUED' | 'CLAIMED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'UNKNOWN';
  claimHash: string | null; leaseExpiresAt: number | null; createdAt: number;
  cancelRequestedAt: number | null;
  exitCode: number | null; failureCode: string | null; logCiphertext: string | null;
  scheduledFor: number | null; missedCount: number;
};
export type ScriptEnqueueInput = Pick<ScriptInvocation,
  'automationId' | 'revision' | 'generation' | 'trigger' | 'requestedBy' | 'idempotencyKey' | 'bodyHash' | 'inputCiphertext'
> & { projectId: string; keyId?: string; keyEpoch?: number; id?: string; scheduledFor?: number; missedCount?: number };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(code: string): never { throw new Error(code); }

async function lockAutomation(tx: ScriptQueueTransaction, id: string): Promise<Automation> {
  const [row] = await tx.query<Automation>('SELECT * FROM "Automation" WHERE id=$1 FOR UPDATE', [id]);
  return row ?? fail('NOT_FOUND');
}

async function keyValid(tx: ScriptQueueTransaction, id: string, keyId: string | null | undefined, epoch: number | null | undefined, now: number) {
  if (!keyId || epoch === null || epoch === undefined) return false;
  const rows = await tx.query('SELECT id FROM "ScriptAutomationKeyEpoch" WHERE id=$1 AND "automationId"=$2 AND epoch=$3 AND NOT revoked AND "expiresAt">$4', [keyId, id, epoch, now]);
  return rows.length === 1;
}

async function lockRunWithToken(tx: ScriptQueueTransaction, id: string, token: string) {
  const [reference] = await tx.query<{ automationId: string }>('SELECT "automationId" FROM "ScriptInvocation" WHERE id=$1', [id]);
  if (!reference) return null;
  const automation = await lockAutomation(tx, reference.automationId);
  const [run] = await tx.query<ScriptInvocation>('SELECT * FROM "ScriptInvocation" WHERE id=$1 FOR UPDATE', [id]);
  return run && run.claimHash === hash(token) ? { automation, run } : null;
}

/** Retain immutable snapshots while a run references them, then reclaim their encrypted artifacts. */
export async function removeUnusedScriptRevisions(tx: ScriptQueueTransaction, automationId: string, currentRevision: number) {
  const removed = await tx.query<{ artifactId: string }>(`DELETE FROM "ScriptAutomationRevision" r WHERE "automationId"=$1 AND revision<$2
    AND NOT EXISTS (SELECT 1 FROM "ScriptInvocation" i WHERE i."automationId"=r."automationId" AND i.revision=r.revision)
    RETURNING "artifactId"`, [automationId, currentRevision]);
  for (const artifactId of new Set(removed.map((row) => row.artifactId))) {
    await tx.query(`DELETE FROM "ScriptArtifact" a WHERE id=$1
      AND NOT EXISTS (SELECT 1 FROM "ScriptAutomationRevision" r WHERE r."artifactId"=a.id)`, [artifactId]);
  }
}

export function createScriptInvocationService(database: ScriptQueueDatabase) {
  async function mutateClaim(id: string, token: string, now: number, status: 'CLAIMED' | 'RUNNING', action: (tx: ScriptQueueTransaction, run: ScriptInvocation) => Promise<void>) {
    const valid = await database.transaction(async (tx) => {
      const locked = await lockRunWithToken(tx, id, token);
      if (!locked) return false;
      const { automation, run } = locked;
      if (run.status !== status || (run.leaseExpiresAt ?? 0) <= now) return false;
      // Pause/revocation stops unstarted work. Running work requires explicit
      // cancellation; a report must still be accepted after its key is revoked.
      if (status === 'CLAIMED' && (automation.paused || automation.deletedAt || automation.generation !== run.generation
        || (run.trigger === 'API' && !await keyValid(tx, automation.id, run.keyId, run.keyEpoch, now)))) {
        await tx.query('UPDATE "ScriptInvocation" SET status=\'CANCELLED\', "completedAt"=$2 WHERE id=$1', [id, now]);
        return false;
      }
      await action(tx, run);
      return true;
    });
    if (!valid) fail('CLAIM_INVALID');
  }

  return {
    apiStatus(input: { projectId: string; automationId: string; keyId: string; epoch: number; runId: string }, now: number) {
      return database.transaction(async (tx) => {
        const automation = await lockAutomation(tx, input.automationId);
        if (automation.projectId !== input.projectId || automation.deletedAt) fail('NOT_FOUND');
        if (!await keyValid(tx, input.automationId, input.keyId, input.epoch, now)) fail('KEY_REVOKED');
        const [run] = await tx.query<Record<string, unknown>>(`SELECT id AS "runId",status,revision,"createdAt","startedAt","completedAt","exitCode","failureCode"
          FROM "ScriptInvocation" WHERE id=$1 AND "automationId"=$2 AND "keyId"=$3 AND trigger='API'`, [input.runId, input.automationId, input.keyId]);
        return run ?? fail('NOT_FOUND');
      });
    },
    syncKey(input: { projectId: string; automationId: string; keyId: string; epoch: number; revoked: boolean; expiresAt: number }, now: number) {
      return database.transaction(async (tx) => {
        const automation = await lockAutomation(tx, input.automationId);
        if (automation.projectId !== input.projectId || (automation.deletedAt && !input.revoked)) fail('NOT_FOUND');
        const [existing] = await tx.query<{ automationId: string; epoch: number; revoked: boolean; expiresAt: number }>('SELECT * FROM "ScriptAutomationKeyEpoch" WHERE id=$1 FOR UPDATE', [input.keyId]);
        if (existing && (existing.automationId !== input.automationId || existing.epoch > input.epoch
          || (existing.revoked && !input.revoked) || existing.expiresAt !== input.expiresAt)) fail('KEY_EPOCH_CONFLICT');
        await tx.query(`INSERT INTO "ScriptAutomationKeyEpoch" (id,"automationId",epoch,revoked,"expiresAt") VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (id) DO UPDATE SET epoch=EXCLUDED.epoch,revoked=EXCLUDED.revoked`,
          [input.keyId, input.automationId, input.epoch, input.revoked, input.expiresAt]);
        if (input.revoked) await tx.query('UPDATE "ScriptInvocation" SET status=\'CANCELLED\',"completedAt"=$3 WHERE "automationId"=$1 AND "keyId"=$2 AND status IN (\'QUEUED\',\'CLAIMED\')', [input.automationId, input.keyId, now]);
      });
    },
    sweep(automationId: string, now: number) {
      return database.transaction(async (tx) => {
        const automation = await lockAutomation(tx, automationId);
        await tx.query(`UPDATE "ScriptInvocation" SET status=CASE WHEN status='RUNNING' THEN 'UNKNOWN' ELSE 'EXPIRED' END,
          "failureCode"=CASE WHEN status='RUNNING' THEN 'WORKER_LOST' ELSE 'QUEUE_EXPIRED' END,"completedAt"=$2
          WHERE "automationId"=$1 AND ((status IN ('RUNNING','CLAIMED') AND "leaseExpiresAt"<=$2)
          OR (status='QUEUED' AND "createdAt"<=$2-86400000))`, [automationId, now]);
        await tx.query(`UPDATE "ScriptInvocation" SET "inputCiphertext"='' WHERE "automationId"=$1
          AND status NOT IN ('QUEUED','CLAIMED','RUNNING') AND "completedAt"<=$2::double precision-86400000 AND "inputCiphertext"<>''`, [automationId, now]);
        await tx.query(`DELETE FROM "ScriptInvocation" WHERE "automationId"=$1
          AND status NOT IN ('QUEUED','CLAIMED','RUNNING') AND "completedAt"<=$2::double precision-2592000000`, [automationId, now]);
        await removeUnusedScriptRevisions(tx, automationId, automation.revision);
      });
    },
    async enqueue(input: ScriptEnqueueInput, now: number): Promise<ScriptInvocation> {
      return database.transaction(async (tx) => {
        const automation = await lockAutomation(tx, input.automationId);
        if (automation.projectId !== input.projectId || automation.deletedAt) fail('NOT_FOUND');
        if (input.trigger === 'API' && !await keyValid(tx, automation.id, input.keyId, input.keyEpoch, now)) fail('KEY_REVOKED');
        const [existing] = await tx.query<ScriptInvocation>('SELECT * FROM "ScriptInvocation" WHERE "automationId"=$1 AND "requestedBy"=$2 AND "idempotencyKey"=$3', [automation.id, input.requestedBy, input.idempotencyKey]);
        if (existing) {
          if (existing.bodyHash !== input.bodyHash || existing.keyId !== (input.keyId ?? null)) fail('IDEMPOTENCY_CONFLICT');
          return existing;
        }
        if (automation.paused) fail('AUTOMATION_PAUSED');
        if (automation.revision !== input.revision || automation.generation !== input.generation) fail('REVISION_CONFLICT');
        const [revision] = await tx.query<Revision>('SELECT * FROM "ScriptAutomationRevision" WHERE "automationId"=$1 AND revision=$2', [automation.id, input.revision]);
        if (!revision?.ready) fail('REVISION_NOT_READY');
        if (input.trigger === 'API' && !revision.admission.externalEnabled) fail('EXTERNAL_DISABLED');
        const pending = await tx.query('SELECT id FROM "ScriptInvocation" WHERE "automationId"=$1 AND status=\'QUEUED\' LIMIT 100', [automation.id]);
        if (pending.length >= 100) fail('QUEUE_FULL');
        if (input.trigger === 'API') {
          const window = Math.floor(now / 60000) * 60000;
          const accepted = await tx.query(`UPDATE "ScriptAutomationKeyEpoch" SET
            "rateCount"=CASE WHEN "rateWindow"=$2 THEN "rateCount"+1 ELSE 1 END,"rateWindow"=$2
            WHERE id=$1 AND ("rateWindow"<>$2 OR "rateCount"<60) RETURNING id`, [input.keyId, window]);
          if (!accepted.length) fail('RATE_LIMITED');
        }
        const [run] = await tx.query<ScriptInvocation>(`INSERT INTO "ScriptInvocation"
          (id,"automationId",revision,generation,trigger,"requestedBy","keyId","keyEpoch","idempotencyKey","bodyHash",snapshot,"inputCiphertext","createdAt","scheduledFor","missedCount")
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15) RETURNING *`,
          [input.id ?? randomUUID(), automation.id, input.revision, input.generation, input.trigger, input.requestedBy,
            input.keyId ?? null, input.keyEpoch ?? null, input.idempotencyKey, input.bodyHash,
            JSON.stringify({ ...revision, machineAccountId: automation.machineAccountId, machineId: automation.machineId,
              projectId: automation.projectId, registrationKey: automation.scriptRegistrationKey }), input.inputCiphertext, now,
            input.scheduledFor ?? null, input.missedCount ?? 0]);
        return run;
      });
    },
    async claim(automationId: string, accountId: string, machineId: string, now: number): Promise<{ run: ScriptInvocation; token: string } | null> {
      return database.transaction(async (tx) => {
        const automation = await lockAutomation(tx, automationId);
        if (automation.machineAccountId !== accountId || automation.machineId !== machineId) fail('MACHINE_DENIED');
        await tx.query(`UPDATE "ScriptInvocation" SET status=CASE WHEN status='RUNNING' THEN 'UNKNOWN' ELSE 'EXPIRED' END,
          "completedAt"=$2 WHERE "automationId"=$1 AND ((status IN ('RUNNING','CLAIMED') AND "leaseExpiresAt"<=$2)
          OR (status='QUEUED' AND "createdAt"<=$2-86400000))`, [automation.id, now]);
        if (automation.paused || automation.deletedAt) {
          await tx.query('UPDATE "ScriptInvocation" SET status=\'CANCELLED\', "completedAt"=$2 WHERE "automationId"=$1 AND status IN (\'QUEUED\',\'CLAIMED\')', [automation.id, now]);
          return null;
        }
        await tx.query(`UPDATE "ScriptInvocation" r SET status='CANCELLED', "completedAt"=$2 WHERE "automationId"=$1 AND status='QUEUED'
          AND (generation<>$3 OR (trigger='API' AND NOT EXISTS (SELECT 1 FROM "ScriptAutomationKeyEpoch" k
            WHERE k.id=r."keyId" AND k."automationId"=$1 AND k.epoch=r."keyEpoch" AND NOT k.revoked AND k."expiresAt">$2)))`, [automation.id, now, automation.generation]);
        if ((await tx.query('SELECT id FROM "ScriptInvocation" WHERE "automationId"=$1 AND status IN (\'CLAIMED\',\'RUNNING\')', [automation.id])).length) return null;
        const token = randomBytes(32).toString('base64url');
        const [run] = await tx.query<ScriptInvocation>(`UPDATE "ScriptInvocation" SET status='CLAIMED', "claimHash"=$2,"leaseExpiresAt"=$3
          WHERE id=(SELECT id FROM "ScriptInvocation" WHERE "automationId"=$1 AND status='QUEUED' ORDER BY "createdAt",id LIMIT 1) RETURNING *`, [automation.id, hash(token), now + 120000]);
        return run ? { run, token } : null;
      });
    },
    async context(id: string, token: string, now: number) {
      let context: { automationId: string; generation: number; leaseExpiresAt: number | null } | undefined;
      await mutateClaim(id, token, now, 'CLAIMED', async (_tx, run) => {
        context = { automationId: run.automationId, generation: run.generation, leaseExpiresAt: run.leaseExpiresAt };
      });
      return context!;
    },
    start(id: string, token: string, now: number) {
      return mutateClaim(id, token, now, 'CLAIMED', async (tx) => {
        await tx.query('UPDATE "ScriptInvocation" SET status=\'RUNNING\', "startedAt"=$2,"leaseExpiresAt"=$3 WHERE id=$1', [id, now, now + 300000]);
      });
    },
    heartbeat(id: string, token: string, now: number) {
      return mutateClaim(id, token, now, 'RUNNING', async (tx, run) => {
        if (run.cancelRequestedAt !== null) fail('CLAIM_INVALID');
        await tx.query('UPDATE "ScriptInvocation" SET "leaseExpiresAt"=$2 WHERE id=$1', [id, now + 300000]);
      });
    },
    complete(id: string, token: string, result: { exitCode: number | null; logCiphertext: string; failureCode?: string }, now: number) {
      return database.transaction(async (tx) => {
        const locked = await lockRunWithToken(tx, id, token);
        if (!locked) fail('CLAIM_INVALID');
        const { run } = locked;
        if (run.status === 'RUNNING' && (run.leaseExpiresAt ?? 0) <= now) {
          await tx.query('UPDATE "ScriptInvocation" SET status=\'UNKNOWN\',"failureCode"=\'WORKER_LOST\',"completedAt"=$2 WHERE id=$1', [id, now]);
          return { recorded: false, status: 'UNKNOWN' };
        }
        if (run.status === 'UNKNOWN' || run.status === 'EXPIRED') return { recorded: false, status: run.status };
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
          if (run.exitCode !== result.exitCode || run.logCiphertext !== result.logCiphertext || run.failureCode !== (result.failureCode ?? null)) fail('REPORT_CONFLICT');
          return { recorded: true, status: run.status };
        }
        if (run.status !== 'RUNNING' || (run.leaseExpiresAt ?? 0) <= now) fail('CLAIM_INVALID');
        const status = run.cancelRequestedAt !== null ? 'CANCELLED' : result.exitCode === 0 && !result.failureCode ? 'COMPLETED' : 'FAILED';
        await tx.query('UPDATE "ScriptInvocation" SET status=$2,"exitCode"=$3,"logCiphertext"=$4,"failureCode"=$5,"completedAt"=$6 WHERE id=$1',
          [id, status, result.exitCode, result.logCiphertext, result.failureCode ?? null, now]);
        return { recorded: true, status };
      });
    },
    failClaim(id: string, token: string, failureCode: string, now: number) {
      return database.transaction(async (tx) => {
        const locked = await lockRunWithToken(tx, id, token);
        if (!locked) fail('CLAIM_INVALID');
        const { run } = locked;
        if (['CANCELLED', 'EXPIRED', 'UNKNOWN'].includes(run.status)) return;
        if (run.status === 'CLAIMED' && (run.leaseExpiresAt ?? 0) <= now) {
          await tx.query('UPDATE "ScriptInvocation" SET status=\'EXPIRED\',"failureCode"=\'CLAIM_EXPIRED\',"completedAt"=$2 WHERE id=$1', [id, now]);
          return;
        }
        if (run.status === 'FAILED') {
          if (run.failureCode !== failureCode) fail('REPORT_CONFLICT');
          return;
        }
        if (run.status !== 'CLAIMED' || (run.leaseExpiresAt ?? 0) <= now) fail('CLAIM_INVALID');
        await tx.query('UPDATE "ScriptInvocation" SET status=\'FAILED\',"failureCode"=$2,"completedAt"=$3 WHERE id=$1', [id, failureCode, now]);
      });
    },
    abandon(id: string, token: string, now: number) {
      return database.transaction(async (tx) => {
        const locked = await lockRunWithToken(tx, id, token);
        if (!locked) fail('CLAIM_INVALID');
        const { run } = locked;
        if (!['CLAIMED', 'RUNNING'].includes(run.status)) return;
        await tx.query('UPDATE "ScriptInvocation" SET status=$2,"failureCode"=\'WORKER_LOST\',"completedAt"=$3 WHERE id=$1',
          [id, run.status === 'RUNNING' ? 'UNKNOWN' : 'FAILED', now]);
      });
    },
    cancel(projectId: string, automationId: string, id: string, now: number) {
      return database.transaction(async (tx) => {
        const automation = await lockAutomation(tx, automationId);
        if (automation.projectId !== projectId || automation.deletedAt) fail('NOT_FOUND');
        const [run] = await tx.query<ScriptInvocation>('SELECT * FROM "ScriptInvocation" WHERE id=$1 AND "automationId"=$2 FOR UPDATE', [id, automationId]);
        if (!run) fail('NOT_FOUND');
        if (run.status === 'RUNNING') {
          await tx.query('UPDATE "ScriptInvocation" SET "cancelRequestedAt"=COALESCE("cancelRequestedAt",$2) WHERE id=$1', [id, now]);
        } else if (run.status === 'QUEUED' || run.status === 'CLAIMED') {
          await tx.query('UPDATE "ScriptInvocation" SET status=\'CANCELLED\',"completedAt"=$2 WHERE id=$1', [id, now]);
        }
      });
    },
    revokeKey(automationId: string, keyId: string, epoch: number, now: number) {
      return database.transaction(async (tx) => {
        await lockAutomation(tx, automationId);
        await tx.query('UPDATE "ScriptAutomationKeyEpoch" SET revoked=true WHERE id=$1 AND "automationId"=$2 AND epoch<=$3', [keyId, automationId, epoch]);
        await tx.query('UPDATE "ScriptInvocation" SET status=\'CANCELLED\',"completedAt"=$3 WHERE "automationId"=$1 AND "keyId"=$2 AND status IN (\'QUEUED\',\'CLAIMED\')', [automationId, keyId, now]);
      });
    },
  };
}
