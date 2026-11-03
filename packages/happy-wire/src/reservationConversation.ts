import { z } from 'zod';
const id = z.string().min(1).max(200), hash = z.string().regex(/^[a-f0-9]{64}$/);
const base = { wireVersion: z.literal(1), runId: id, claimToken: z.string().min(1).max(512), sessionId: id };
const proof = { epoch: id, descriptorHash: hash, verifiedAt: z.number().int().nonnegative() };
export const reservationExitProofSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...proof, status: z.literal('exited'), launchId: id, processGroupId: z.number().int().positive(), processStartId: id }),
  z.strictObject({ ...proof, status: z.literal('not-started') }),
]);
export const reservationRuntimeIdentitySchema = z.strictObject({ launchId: id, processGroupId: z.number().int().positive().max(2147483647), processStartId: id });
export type ReservationRuntimeIdentity = z.infer<typeof reservationRuntimeIdentitySchema>;
export const reservationLeaseRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...base, operation: z.literal('recover'), descriptorHash: hash }),
  z.strictObject({ ...base, operation: z.literal('acquire'), expectedSeq: z.number().int().nonnegative(), descriptorHash: hash }),
  z.strictObject({ ...base, operation: z.literal('activate'), epoch: id, descriptorHash: hash, runtime: reservationRuntimeIdentitySchema }),
  z.strictObject({ ...base, operation: z.literal('heartbeat'), epoch: id }),
  z.strictObject({ ...base, operation: z.literal('settle'), epoch: id }),
  z.strictObject({ ...base, operation: z.literal('release'), epoch: id, proof: reservationExitProofSchema }),
]);
export type ReservationLeaseRequest = z.infer<typeof reservationLeaseRequestSchema>;
export type ReservationExitProof = z.infer<typeof reservationExitProofSchema>;
export const reservationLeaseViewSchema = z.strictObject({ sessionId: id, runId: id, epoch: id,
  state: z.enum(['PREPARING', 'RUNNING', 'SETTLING', 'RELEASED']), descriptorHash: hash,
  expectedSeq: z.number().int().min(0).max(2147483647), expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  leaseDurationMs: z.number().int().min(0).max(90000),
  messageAuthorization: z.string().max(256).regex(/^[A-Za-z0-9_-]{1,200}\.[A-Za-z0-9_-]{43}$/).optional(),
}).superRefine((value, context) => {
  if ((value.state === 'PREPARING' || value.state === 'RUNNING') && (value.leaseDurationMs <= 0 || !value.messageAuthorization)) context.addIssue({ code: 'custom', path: ['leaseDurationMs'], message: 'active reservation grant required' });
  if (value.messageAuthorization && value.messageAuthorization.split('.')[0] !== value.epoch) context.addIssue({ code: 'custom', path: ['messageAuthorization'], message: 'reservation epoch mismatch' });
});
export type ReservationLeaseView = z.infer<typeof reservationLeaseViewSchema>;

/** The server stores only the opaque checkpoint; output, hashes and notepad stay E2EE. */
export const reservationCheckpointRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...base, operation: z.literal('read-checkpoint'), epoch: id }),
  z.strictObject({ ...base, operation: z.literal('delivery-proof'), epoch: id, pendingRunId: id }),
  z.strictObject({ ...base, operation: z.literal('write-checkpoint'), epoch: id,
    expectedRevision: z.number().int().min(0).max(2147483646),
    ciphertext: z.string().min(1).max(768 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
]);
export type ReservationCheckpointRequest = z.infer<typeof reservationCheckpointRequestSchema>;
export type ReservationCheckpointView = { revision: number; ciphertext: string | null };

export type ReservationDeliveryProof = { status: 'delivered'; runId: string; sessionId: string; localId: string; seq: number } | { status: 'not-delivered' | 'unconfirmed' };
