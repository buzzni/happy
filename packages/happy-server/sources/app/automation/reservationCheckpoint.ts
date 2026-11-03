import type { Prisma } from '@prisma/client';
import { reservationCheckpointRequestSchema, type ReservationCheckpointRequest, type ReservationCheckpointView, type ReservationDeliveryProof } from '@slopus/happy-wire';
import { authorizedReservationRun, lockReservationSession, readReservationLease } from './reservationConversationLease';
type Tx = Prisma.TransactionClient;
const denied = (error: string) => ({ ok: false as const, error });
/** Never decrypts monitor output, hashes, prompts or notepad. The v5 payload owns its state key. */
export async function manageReservationCheckpoint(tx: Tx, accountId: string, machineId: string, raw: ReservationCheckpointRequest, now = new Date()): Promise<{ ok: true; value: ReservationCheckpointView | ReservationDeliveryProof } | { ok: false; error: string }> {
  const parsed = reservationCheckpointRequestSchema.safeParse(raw);
  if (!parsed.success) return denied('invalid-input');
  const input = parsed.data;
  const run = await authorizedReservationRun(tx, accountId, machineId, input, now);
  if (!run || run.sessionId !== input.sessionId) return denied('claim-cancelled');
  // Match the lease/delivery lock order and fence pause/delete/generation changes.
  const definition = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Automation" WHERE "id" = ${run.automationId} AND "revision" = ${run.automation.revision} AND "generation" = ${run.generation} AND "paused" = false AND "deletedAt" IS NULL FOR UPDATE`;
  if (!definition.length || !await lockReservationSession(tx, accountId, input.sessionId)) return denied('claim-cancelled');
  const lease = await readReservationLease(tx, input.sessionId);
  if (!lease || lease.accountId !== accountId || lease.machineId !== machineId || lease.runId !== run.id || lease.epoch !== input.epoch || lease.state === 'SETTLING' || lease.expiresAt <= now) return denied('reservation-context-mismatch');
  if (input.operation === 'delivery-proof') {
    const previous = await tx.automationRun.findFirst({ where: { id: input.pendingRunId, automationId: run.automationId, sessionId: input.sessionId }, select: { id: true, status: true } });
    if (!previous) return { ok: true, value: { status: 'unconfirmed' } };
    const localId = `happy-automation:${previous.id}`;
    const message = await tx.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId: input.sessionId, localId } }, select: { seq: true } });
    if (message) return { ok: true, value: { status: 'delivered', runId: previous.id, sessionId: input.sessionId, localId, seq: message.seq } };
    // A still-running/claimable run could append after this query: absence is
    // evidence only after the old run can never append again.
    return { ok: true, value: { status: ['CLAIMED', 'RUNNING'].includes(previous.status) ? 'unconfirmed' : 'not-delivered' } };
  }
  const [row] = await tx.$queryRaw<Array<{ revision: number; ciphertext: Uint8Array }>>`SELECT "revision", "ciphertext" FROM "ReservationCheckpoint" WHERE "automationId" = ${run.automationId}`;
  const current: ReservationCheckpointView = { revision: row?.revision ?? 0, ciphertext: row ? Buffer.from(row.ciphertext).toString('base64') : null };
  if (input.operation === 'read-checkpoint') return { ok: true, value: current };
  // Retrying the exact encrypted write after a lost ACK is mutation-free.
  if (current.revision === input.expectedRevision + 1 && current.ciphertext === input.ciphertext) return { ok: true, value: current };
  if (current.revision !== input.expectedRevision || current.revision >= 2147483647) return denied('checkpoint-conflict');
  const ciphertext = new Uint8Array(Buffer.from(input.ciphertext, 'base64'));
  if (ciphertext.byteLength > 512 * 1024) return denied('invalid-input');
  const next = current.revision + 1;
  if (row) await tx.$executeRaw`UPDATE "ReservationCheckpoint" SET "revision" = ${next}, "ciphertext" = ${ciphertext}, "updatedAt" = ${now} WHERE "automationId" = ${run.automationId} AND "revision" = ${current.revision}`;
  else await tx.$executeRaw`INSERT INTO "ReservationCheckpoint" ("automationId", "revision", "ciphertext", "updatedAt") VALUES (${run.automationId}, ${next}, ${ciphertext}, ${now})`;
  return { ok: true, value: { revision: next, ciphertext: input.ciphertext } };
}
