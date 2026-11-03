import { reservationMonotonicNow } from './reservationMonotonicClock';
import type { PreparedReservationDelivery } from './reservationMonitorCheckpoint';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { reservationLeaseViewSchema } from '@slopus/happy-wire';
import type { AutomationConversationDeliverRequest, ReservationExitProof, ReservationLeaseRequest, ReservationLeaseView, ReservationRuntimeIdentity } from '@slopus/happy-wire';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const descriptorSchema = z.object({
  version: z.literal(1), automationId: id, generation: z.number().int().positive(), runId: id, sessionId: id,
  machineId: id, accountId: id, agent: z.enum(['claude', 'codex']),
  baseDirectory: z.string().min(1).max(4096), executionDirectory: z.string().min(1).max(4096),
  writeMode: z.enum(['read-only', 'worktree']), baseSha: sha.nullable(), headSha: sha.nullable(),
  connectorPolicy: z.enum(['none', 'optional', 'required']), requiredConnectors: z.array(id).max(100),
  // Opaque broker handles only. Secret values never enter the descriptor or checkpoint.
  credentialHandles: z.array(id).max(100),
}).strict();
export type ReservationTurnDescriptor = z.infer<typeof descriptorSchema>;
export type ReservationTurnCheckpoint = { runId: string; sessionId: string; descriptorHash: string; epoch?: string; state: 'ACQUIRING' | 'PREPARING' | 'RUNNING' | 'SETTLING' | 'RELEASED' };
export const reservationDescriptorHash = (descriptor: ReservationTurnDescriptor) => createHash('sha256').update(JSON.stringify(descriptorSchema.parse(descriptor))).digest('hex');
type Handle = ReservationRuntimeIdentity;
export type ReservationPreparationContext = { descriptorHash: string; epoch: string; expiresAt: number; deadlineMonotonicMs: number; signal: AbortSignal };
type Outcome = { outcome: 'WOKE' | 'SILENT' };
export type ReservationTurnDependencies = {
  now(): number;
  checkpoint(value: ReservationTurnCheckpoint): Promise<void>;
  /** Verifies canonical roots, pinned SHAs, provider lineage, capabilities and idle state; starts nothing. */
  prepare(descriptor: ReservationTurnDescriptor): Promise<{ expectedSeq: number }>;
  lease(request: ReservationLeaseRequest): Promise<{ ok: true; value: ReservationLeaseView } | { ok: false; error: string }>;
  heartbeatRun(): Promise<boolean>;
  prepareCommands?(input: ReservationPreparationContext & { recordIntent(engineId: string, directory: string): void }): Promise<void>;
  renewPreparation?(deadlineMonotonicMs: number): Promise<void>;
  finishPreparation?(): Promise<void>;
  /** Same session only. No prompt until activation; no daemon claim token is passed to this boundary. */
  start(input: { descriptor: ReservationTurnDescriptor; descriptorHash: string; epoch: string; messageAuthorization: string; expiresAt: number; deadlineMonotonicMs: number; signal: AbortSignal }): Promise<Handle>;
  renew(input: { handle: Handle; epoch: string; expiresAt: number; deadlineMonotonicMs: number }): Promise<void>;
  deliver(request: AutomationConversationDeliverRequest): Promise<{ ok: boolean; error?: string; value?: unknown }>;
  wait(input: { handle: Handle; runId: string; epoch: string; signal: AbortSignal }): Promise<Outcome>;
  /** Withdraw tool admission, drain durable output and verify the whole process tree, including unknown launches. */
  finish(input: { handle: Handle | null; descriptor: ReservationTurnDescriptor; descriptorHash: string; epoch: string }): Promise<{ stored: boolean; proof: ReservationExitProof | null }>;
};
type Result = { ok: true; sessionId: string; outcome: Outcome['outcome'] | 'NO_CHANGE' | 'SKIPPED_GATE' } | { ok: false; error: string };
const denied = (error: string): Result => ({ ok: false, error });

/** One fixed conversation, with no worker/session-creation fallback at any stage. */
export async function runReservationConversationTurn(input: { descriptor: ReservationTurnDescriptor; claimToken: string; contentCiphertext: string; afterDelivery?: () => Promise<void>; prepareDelivery?: (context: { epoch: string; signal: AbortSignal }) => Promise<PreparedReservationDelivery> }, deps: ReservationTurnDependencies): Promise<Result> {
  const parsed = descriptorSchema.safeParse(input.descriptor);
  if (!parsed.success) return denied('RESERVATION_DESCRIPTOR_INVALID');
  const descriptor = parsed.data;
  if (descriptor.connectorPolicy === 'none' && descriptor.requiredConnectors.length) return denied('RESERVATION_DESCRIPTOR_INVALID');
  const descriptorHash = reservationDescriptorHash(descriptor);
  const base = { wireVersion: 1 as const, runId: descriptor.runId, claimToken: input.claimToken, sessionId: descriptor.sessionId };
  const checkpoint = (state: ReservationTurnCheckpoint['state'], epoch?: string) => deps.checkpoint({ runId: descriptor.runId, sessionId: descriptor.sessionId, descriptorHash, ...(epoch ? { epoch } : {}), state });
  let preparation: { expectedSeq: number };
  let lease: ReservationLeaseView, localDeadline = 0;
  const grantDeadline = (value: ReservationLeaseView, requestedAt: number) => Math.floor(reservationMonotonicNow() + Math.max(0, Math.min(90000, value.leaseDurationMs) - (reservationMonotonicNow() - requestedAt) - 5000));
  try {
    preparation = await deps.prepare(descriptor);
    if (!Number.isSafeInteger(preparation.expectedSeq) || preparation.expectedSeq < 0) return denied('RESERVATION_SEQUENCE_UNAVAILABLE');
    await checkpoint('ACQUIRING');
    const requestedAt = reservationMonotonicNow();
    const acquired = await deps.lease({ ...base, operation: 'acquire', descriptorHash, expectedSeq: preparation.expectedSeq });
    if (!acquired.ok) return denied(acquired.error);
    lease = reservationLeaseViewSchema.parse(acquired.value); localDeadline = grantDeadline(lease, requestedAt);
  } catch { return denied('RESERVATION_ADMISSION_UNCONFIRMED'); }
  // Fail closed even if a mixed-version endpoint accidentally answers another target.
  if (lease.sessionId !== descriptor.sessionId || lease.runId !== descriptor.runId || lease.descriptorHash !== descriptorHash || !lease.messageAuthorization || lease.expectedSeq !== preparation.expectedSeq || lease.state !== 'PREPARING') return denied('RESERVATION_CONTEXT_MISMATCH');
  const epoch = lease.epoch, controller = new AbortController();
  let handle: Handle | null = null, outcome: { outcome: Outcome['outcome'] | 'NO_CHANGE' | 'SKIPPED_GATE' } | null = null, failure = 'RESERVATION_TURN_FAILED', renewal: Promise<void> | null = null;
  const deadline = setTimeout(() => controller.abort(), 2 * 60 * 60_000); deadline.unref?.();
  const heartbeat = setInterval(() => {
    if (renewal || controller.signal.aborted) return;
    renewal = (async () => {
      if (!await deps.heartbeatRun()) throw new Error();
      const requestedAt = reservationMonotonicNow();
      const renewed = await deps.lease({ ...base, operation: 'heartbeat', epoch });
      if (!renewed.ok || renewed.value.epoch !== epoch || renewed.value.sessionId !== descriptor.sessionId || renewed.value.descriptorHash !== descriptorHash || renewed.value.state === 'SETTLING' || renewed.value.state === 'RELEASED' || renewed.value.expiresAt <= deps.now()) throw new Error();
      lease = reservationLeaseViewSchema.parse(renewed.value); localDeadline = grantDeadline(lease, requestedAt);
      if (handle) await deps.renew({ handle, epoch, expiresAt: lease.expiresAt, deadlineMonotonicMs: localDeadline });
      else await deps.renewPreparation?.(localDeadline);
    })().catch(() => { failure = 'RESERVATION_AUTHORITY_LOST'; controller.abort(); }).finally(() => { renewal = null; });
  }, 20_000); heartbeat.unref?.();
  try {
    await checkpoint('PREPARING', epoch);
    if (lease.expiresAt <= deps.now() || localDeadline <= reservationMonotonicNow()) throw new Error();
    if (input.prepareDelivery) await deps.prepareCommands?.({ descriptorHash, epoch, expiresAt: lease.expiresAt, deadlineMonotonicMs: localDeadline, signal: controller.signal, recordIntent: () => { throw new Error('RESERVATION_JOURNAL_REQUIRED'); } });
    const prepared = await input.prepareDelivery?.({ epoch, signal: controller.signal });
    await deps.finishPreparation?.();
    if (controller.signal.aborted) throw new Error();
    if (prepared?.kind === 'skip') outcome = { outcome: prepared.outcome };
    else {
    handle = await deps.start({ descriptor, descriptorHash, epoch, messageAuthorization: lease.messageAuthorization!, expiresAt: lease.expiresAt, deadlineMonotonicMs: localDeadline, signal: controller.signal });
    if (controller.signal.aborted) throw new Error();
    const requestedAt = reservationMonotonicNow();
    const activated = await deps.lease({ ...base, operation: 'activate', epoch, descriptorHash, runtime: { launchId: handle.launchId, processGroupId: handle.processGroupId, processStartId: handle.processStartId } });
    if (!activated.ok || activated.value.state !== 'RUNNING' || activated.value.epoch !== epoch || activated.value.descriptorHash !== descriptorHash || activated.value.sessionId !== descriptor.sessionId) throw new Error();
    lease = reservationLeaseViewSchema.parse(activated.value); localDeadline = grantDeadline(lease, requestedAt);
    await deps.renew({ handle, epoch, expiresAt: lease.expiresAt, deadlineMonotonicMs: localDeadline });
    await checkpoint('RUNNING', epoch);
    let delivered = false;
    for (let attempt = 0; attempt < 3 && !controller.signal.aborted; attempt++) {
      let ack: Awaited<ReturnType<ReservationTurnDependencies['deliver']>>;
      try { ack = await deps.deliver({ ...base, reservationEpoch: epoch, expectedSeq: preparation.expectedSeq, contentCiphertext: prepared?.kind === 'deliver' ? prepared.contentCiphertext : input.contentCiphertext }); }
      catch { failure = 'RESERVATION_DELIVERY_UNCONFIRMED'; continue; }
      if (!ack.ok) { failure = 'RESERVATION_DELIVERY_REJECTED'; break; }
      if (prepared?.kind === 'deliver') {
        try { await prepared.confirm(ack.value); }
        catch { failure = 'RESERVATION_CHECKPOINT_UNCONFIRMED'; break; }
      }
      delivered = true; break;
    }
    if (!delivered || controller.signal.aborted) throw new Error();
    await input.afterDelivery?.();
    outcome = await deps.wait({ handle, runId: descriptor.runId, epoch, signal: controller.signal });
    if (controller.signal.aborted) { outcome = null; throw new Error(); }
    }
  } catch { /* The adapter owns native cancellation. Cleanup below is mandatory even for an unknown start ACK. */ }
  const cleanupLease = async (request: Extract<ReservationLeaseRequest, { operation: 'settle' | 'release' }>) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await deps.lease(request);
        if (result.ok || result.error !== 'ack-timeout') return result;
      } catch { /* Replay only this cleanup operation and its original receipt. */ }
    }
    return { ok: false as const, error: 'ack-timeout' };
  };
  // Stop renewals and revoke local admission before collecting an exit receipt.
  clearInterval(heartbeat); clearTimeout(deadline); controller.abort();
  await renewal;
  let exit: Awaited<ReturnType<ReservationTurnDependencies['finish']>> = { stored: false, proof: null };
  try { exit = await deps.finish({ handle, descriptor, descriptorHash, epoch }); } catch { /* No guessed exit receipt. */ }
  try {
    await checkpoint('SETTLING', epoch);
    const settling = await cleanupLease({ ...base, operation: 'settle', epoch });
    if (!settling.ok || settling.value.epoch !== epoch || settling.value.state !== 'SETTLING') return denied('RESERVATION_CLEANUP_UNCONFIRMED');
    const proof = exit.proof;
    if (!exit.stored || !proof || proof.epoch !== epoch || proof.descriptorHash !== descriptorHash || proof.verifiedAt > deps.now() + 5000 || (proof.status === 'exited' && handle && (proof.launchId !== handle.launchId || proof.processGroupId !== handle.processGroupId || proof.processStartId !== handle.processStartId))) return denied('RESERVATION_CLEANUP_UNCONFIRMED');
    const released = await cleanupLease({ ...base, operation: 'release', epoch, proof });
    if (!released.ok || released.value.state !== 'RELEASED' || released.value.epoch !== epoch) return denied('RESERVATION_CLEANUP_UNCONFIRMED');
    await checkpoint('RELEASED', epoch);
  } catch { return denied('RESERVATION_CLEANUP_UNCONFIRMED'); }
  return outcome ? { ok: true, sessionId: descriptor.sessionId, ...outcome } : denied(failure);
}
