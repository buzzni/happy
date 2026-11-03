import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { reservationLeaseRequestSchema, type ReservationLeaseRequest, type ReservationLeaseView } from '@slopus/happy-wire';
type Tx = Prisma.TransactionClient;
type Lease = Omit<ReservationLeaseView, 'expiresAt' | 'leaseDurationMs'> & { accountId: string; machineId: string; automationId: string; generation: number; claimTokenHash: Uint8Array; messageCapabilityHash: Uint8Array; expiresAt: Date; createdAt: Date; activatedAt: Date | null; launchId: string | null; processGroupId: number | null; processStartId: string | null };
type Result = { ok: true; value: ReservationLeaseView } | { ok: false; error: string };
const denied = (error: string) => ({ ok: false as const, error });
const digest = (token: string) => new Uint8Array(createHash('sha256').update(token).digest());
const capability = (claimToken: string, row: Pick<Lease, 'epoch' | 'descriptorHash' | 'sessionId' | 'runId'>) => createHmac('sha256', claimToken).update(JSON.stringify(['happy-reservation-message-v1', row.epoch, row.descriptorHash, row.sessionId, row.runId])).digest('base64url');
const view = (row: Lease, claimToken?: string, now = new Date()): ReservationLeaseView => ({ sessionId: row.sessionId, runId: row.runId, epoch: row.epoch, state: row.state, descriptorHash: row.descriptorHash, expectedSeq: row.expectedSeq, expiresAt: row.expiresAt.getTime(), leaseDurationMs: Math.max(0, row.expiresAt.getTime() - now.getTime()), ...(claimToken ? { messageAuthorization: `${row.epoch}.${capability(claimToken, row)}` } : {}) });
export async function lockReservationSession(tx: Tx, accountId: string, sessionId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; seq: number }>>`SELECT "id", "seq" FROM "Session" WHERE "id" = ${sessionId} AND "accountId" = ${accountId} FOR UPDATE`;
  return rows[0] ?? null;
}
export async function readReservationLease(tx: Tx, sessionId: string): Promise<Lease | null> {
  const rows = await tx.$queryRaw<Lease[]>`SELECT * FROM "ReservationConversationLease" WHERE "sessionId" = ${sessionId}`;
  return rows[0] ?? null;
}
export async function authorizedReservationRun(tx: Tx, accountId: string, machineId: string, input: { runId: string; claimToken?: string; claimTokenHash?: Uint8Array }, now: Date) {
  const run = await tx.automationRun.findFirst({ where: { id: input.runId, machineAccountId: accountId, machineId, claimTokenHash: input.claimTokenHash ? new Uint8Array(input.claimTokenHash) : digest(input.claimToken!) }, include: { automation: { select: { id: true, projectId: true, ownerAccountId: true, machineAccountId: true, machineId: true, payloadVersion: true, paused: true, deletedAt: true, legacyMigrationPending: true, generation: true, revision: true, machineKeyVersion: true, viewerKeyVersion: true, project: { select: { accountId: true, config: true, automationViewerKeyVersion: true } }, targetMachine: { select: { automationKeyVersion: true } } } } } });
  if (!run) return null;
  const a = run.automation, config = a.project.config as { machineId?: string } | null;
  if (a.payloadVersion !== 5 || run.status !== 'RUNNING' || !run.runLeaseExpiresAt || run.runLeaseExpiresAt <= now || a.paused || a.deletedAt || a.legacyMigrationPending || a.generation !== run.generation || a.machineAccountId !== accountId || a.machineId !== machineId || a.project.accountId !== accountId || config?.machineId !== machineId || a.machineKeyVersion !== a.targetMachine?.automationKeyVersion || a.viewerKeyVersion !== a.project.automationViewerKeyVersion) return null;
  if (a.ownerAccountId !== accountId) {
    const member = await tx.projectMember.findUnique({ where: { projectId_accountId: { projectId: a.projectId, accountId: a.ownerAccountId } } });
    if (!member || member.status !== 'accepted' || !['owner', 'editor'].includes(member.role)) return null;
  }
  return run;
}
/** No expired lease is stolen. Cleanup remains possible after its definition or claim has been revoked. */
export async function manageReservationConversationLease(tx: Tx, accountId: string, machineId: string, raw: ReservationLeaseRequest, now = new Date()): Promise<Result> {
  const parsed = reservationLeaseRequestSchema.safeParse(raw);
  if (!parsed.success) return denied('invalid-input');
  const input = parsed.data;
  if (input.operation === 'recover' || input.operation === 'settle' || input.operation === 'release') {
    if (!await lockReservationSession(tx, accountId, input.sessionId)) return denied('target-mismatch');
    const lease = await readReservationLease(tx, input.sessionId);
    if (!lease) return input.operation === 'release' ? { ok: true, value: { sessionId: input.sessionId, runId: input.runId, epoch: input.epoch, state: 'RELEASED', descriptorHash: input.proof.descriptorHash, expectedSeq: 0, expiresAt: 0, leaseDurationMs: 0 } } : denied('reservation-not-found');
    if (lease.accountId !== accountId || lease.machineId !== machineId || lease.runId !== input.runId || (input.operation === 'recover' ? lease.descriptorHash !== input.descriptorHash : lease.epoch !== input.epoch) || !Buffer.from(lease.claimTokenHash).equals(Buffer.from(digest(input.claimToken)))) return denied('reservation-context-mismatch');
    if (input.operation === 'release') {
      const proof = input.proof;
      if ((lease.activatedAt && (proof.status !== 'exited' || proof.launchId !== lease.launchId || proof.processGroupId !== lease.processGroupId || proof.processStartId !== lease.processStartId)) || lease.state !== 'SETTLING' || proof.epoch !== lease.epoch || proof.descriptorHash !== lease.descriptorHash || proof.verifiedAt < lease.createdAt.getTime() || proof.verifiedAt > now.getTime() + 5000) return denied('reservation-exit-unconfirmed');
      await tx.$executeRaw`DELETE FROM "ReservationConversationLease" WHERE "sessionId" = ${lease.sessionId} AND "epoch" = ${lease.epoch}`;
      return { ok: true, value: { ...view(lease, undefined, now), state: 'RELEASED' } };
    }
    await tx.$executeRaw`UPDATE "ReservationConversationLease" SET "state" = 'SETTLING', "updatedAt" = ${now} WHERE "sessionId" = ${lease.sessionId} AND "epoch" = ${lease.epoch}`;
    return { ok: true, value: { ...view(lease, undefined, now), state: 'SETTLING' } };
  }
  const run = await authorizedReservationRun(tx, accountId, machineId, input, now);
  if (!run) return denied('claim-cancelled');
  const a = run.automation;
  // Same lock order as delivery and pause: definition before conversation.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Automation" WHERE "id" = ${a.id} AND "revision" = ${a.revision} AND "generation" = ${run.generation} AND "paused" = false AND "deletedAt" IS NULL FOR UPDATE`;
  if (!locked.length) return denied('claim-cancelled');
  const session = await lockReservationSession(tx, accountId, input.sessionId);
  if (!session || run.sessionId && run.sessionId !== session.id) return denied('target-mismatch');
  const lease = await readReservationLease(tx, input.sessionId);
  if (input.operation === 'acquire') {
    if (lease) return lease.runId === run.id && lease.machineId === machineId && lease.descriptorHash === input.descriptorHash && lease.expectedSeq === input.expectedSeq && lease.expiresAt > now && lease.state !== 'SETTLING' ? { ok: true, value: view(lease, input.claimToken, now) } : denied('reservation-busy');
    if (session.seq !== input.expectedSeq) return denied('session-changed');
    if ((await tx.automationRun.updateMany({ where: { id: run.id, status: 'RUNNING', runLeaseExpiresAt: { gt: now }, OR: [{ sessionId: null }, { sessionId: session.id }] }, data: { sessionId: session.id } })).count !== 1) return denied('claim-cancelled');
    const epoch = randomUUID(), messageCapability = capability(input.claimToken, { epoch, descriptorHash: input.descriptorHash, sessionId: session.id, runId: run.id }), expiresAt = new Date(Math.min(now.getTime() + 90_000, run.runLeaseExpiresAt!.getTime()));
    await tx.$executeRaw`INSERT INTO "ReservationConversationLease" ("sessionId", "runId", "automationId", "generation", "accountId", "machineId", "claimTokenHash", "epoch", "state", "descriptorHash", "messageCapabilityHash", "expectedSeq", "expiresAt", "createdAt", "updatedAt") VALUES (${session.id}, ${run.id}, ${a.id}, ${run.generation}, ${accountId}, ${machineId}, ${digest(input.claimToken)}, ${epoch}, 'PREPARING', ${input.descriptorHash}, ${digest(messageCapability)}, ${input.expectedSeq}, ${expiresAt}, ${now}, ${now})`;
    return { ok: true, value: { sessionId: session.id, runId: run.id, epoch, state: 'PREPARING', descriptorHash: input.descriptorHash, expectedSeq: input.expectedSeq, expiresAt: expiresAt.getTime(), leaseDurationMs: Math.max(0, expiresAt.getTime() - now.getTime()), messageAuthorization: `${epoch}.${messageCapability}` } };
  }
  if (!lease || lease.epoch !== input.epoch || lease.runId !== run.id || lease.machineId !== machineId || lease.expiresAt <= now || lease.state === 'SETTLING') return denied('reservation-context-mismatch');
  if (input.operation === 'activate' && (lease.descriptorHash !== input.descriptorHash || lease.state === 'PREPARING' && session.seq !== lease.expectedSeq)) return denied('session-changed');
  if (input.operation === 'activate') {
    const runtime = input.runtime;
    if (lease.activatedAt && (lease.launchId !== runtime.launchId || lease.processGroupId !== runtime.processGroupId || lease.processStartId !== runtime.processStartId)) return denied('reservation-context-mismatch');
    await tx.$executeRaw`UPDATE "ReservationConversationLease" SET "launchId" = ${runtime.launchId}, "processGroupId" = ${runtime.processGroupId}, "processStartId" = ${runtime.processStartId} WHERE "sessionId" = ${session.id} AND "epoch" = ${lease.epoch}`;
  }
  const state = input.operation === 'activate' ? 'RUNNING' : lease.state, expiresAt = new Date(Math.min(now.getTime() + 90_000, run.runLeaseExpiresAt!.getTime()));
  await tx.$executeRaw`UPDATE "ReservationConversationLease" SET "state" = ${state}::"ReservationConversationLeaseState", "activatedAt" = CASE WHEN ${input.operation} = 'activate' THEN COALESCE("activatedAt", ${now}) ELSE "activatedAt" END, "expiresAt" = ${expiresAt}, "updatedAt" = ${now} WHERE "sessionId" = ${session.id} AND "epoch" = ${lease.epoch}`;
  // Delivery requires an active chat. Confirm activation under the same owned lease lock, before its ACK.
  if (state === 'RUNNING') await tx.session.update({ where: { id: session.id }, data: { active: true, lastActiveAt: now } });
  return { ok: true, value: { ...view(lease, input.claimToken, now), state, expiresAt: expiresAt.getTime(), leaseDurationMs: Math.max(0, expiresAt.getTime() - now.getTime()) } };
}
/** Called inside the message transaction, before allocating seqs. Runtime output needs the same epoch too. */
export async function reservationMessageAccess(tx: Tx, accountId: string, sessionId: string, authorization?: unknown, now = new Date(), allowPreparing = false, lock = true) {
  if (lock && !await lockReservationSession(tx, accountId, sessionId)) return denied('target-mismatch');
  const lease = await readReservationLease(tx, sessionId);
  if (!lease) return authorization === undefined ? { ok: true as const } : denied('reservation-context-mismatch');
  if (typeof authorization !== 'string' || authorization.length > 300) return denied('reservation-busy');
  const [epoch, token, extra] = authorization.split('.');
  if (extra !== undefined || epoch !== lease.epoch || !/^[A-Za-z0-9_-]{43}$/.test(token ?? '') || !Buffer.from(lease.messageCapabilityHash).equals(Buffer.from(digest(token!))) || (lease.state !== 'RUNNING' && !(allowPreparing && lease.state === 'PREPARING')) || lease.expiresAt <= now) return denied('reservation-busy');
  const run = await authorizedReservationRun(tx, accountId, lease.machineId, { runId: lease.runId, claimTokenHash: lease.claimTokenHash }, now);
  return run && run.sessionId === sessionId ? { ok: true as const } : denied('claim-cancelled');
}

export class ReservationWriteDenied extends Error {
  constructor(readonly reason: string) { super(reason); }
}
export async function assertReservationWrite(tx: Tx, accountId: string, sessionId: string, authorization?: unknown, allowPreparing = false) {
  const access = await reservationMessageAccess(tx, accountId, sessionId, authorization, new Date(), allowPreparing);
  if (!access.ok) throw new ReservationWriteDenied(access.error);
}
