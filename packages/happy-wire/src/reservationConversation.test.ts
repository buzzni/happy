import { expect, it } from 'vitest';
import { reservationLeaseRequestSchema, reservationExitProofSchema, reservationLeaseViewSchema } from './reservationConversation';
const base = { wireVersion: 1, runId: 'run', claimToken: 'claim', sessionId: 'session' };
it('requires an exact run, session, sequence and descriptor for admission', () => {
  expect(reservationLeaseRequestSchema.parse({ ...base, operation: 'acquire', expectedSeq: 0, descriptorHash: 'a'.repeat(64) })).toMatchObject({ operation: 'acquire' });
  expect(reservationLeaseRequestSchema.safeParse({ ...base, operation: 'acquire', expectedSeq: -1, descriptorHash: 'a'.repeat(64) }).success).toBe(false);
  expect(reservationLeaseRequestSchema.safeParse({ ...base, operation: 'acquire', expectedSeq: 0, descriptorHash: 'a'.repeat(64), force: true }).success).toBe(false);
});
it('requires a bound process-exit receipt, never a cleanup boolean', () => {
  expect(reservationLeaseRequestSchema.safeParse({ ...base, operation: 'release', epoch: 'e', exited: true }).success).toBe(false);
  expect(reservationExitProofSchema.safeParse({ status: 'exited', epoch: 'e', descriptorHash: 'a'.repeat(64), launchId: 'l', processGroupId: 12, processStartId: 'start', verifiedAt: 100 }).success).toBe(true);
  expect(reservationExitProofSchema.safeParse({ status: 'exited', epoch: 'e', descriptorHash: 'a'.repeat(64), launchId: 'l', processGroupId: 0, processStartId: 'start', verifiedAt: 100 }).success).toBe(false);
});

it('rejects an overlong or cross-epoch active grant before any native process can start', () => {
  const grant = { sessionId: 's', runId: 'r', epoch: 'e', state: 'PREPARING', descriptorHash: 'a'.repeat(64), expectedSeq: 0, expiresAt: 100000, leaseDurationMs: 90000, messageAuthorization: 'e.' + 'a'.repeat(43) };
  expect(reservationLeaseViewSchema.safeParse(grant).success).toBe(true);
  expect(reservationLeaseViewSchema.safeParse({ ...grant, leaseDurationMs: 90001 }).success).toBe(false);
  expect(reservationLeaseViewSchema.safeParse({ ...grant, leaseDurationMs: 0 }).success).toBe(false);
  expect(reservationLeaseViewSchema.safeParse({ ...grant, messageAuthorization: 'foreign.' + 'a'.repeat(43) }).success).toBe(false);
});
