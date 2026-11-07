import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { claimAutomationExecutionQuestion, queueAutomationExecutionQuestion } from './automationExecutionQuestionService';

function fixture() {
  const one = (size: number) => Buffer.concat([Buffer.from([1]), Buffer.alloc(size - 1)]).toString('base64');
  const input = { requestId: '9cc41d26-562e-4b48-8e2f-a38dc2c85a78', sourceRunId: 'source', expectedRevision: 2, generation: 3, displaySessionId: 'manual',
    encrypted: { payloadVersion: 6 as const, payloadCiphertext: one(41), viewerKeyId: 'k', viewerKeyVersion: 1,
      viewerKeyEnvelope: one(105), machineKeyVersion: 1, machineKeyEnvelope: one(105) } };
  const definition = { id: 'a1', projectId: 'p1', payloadVersion: 6, revision: 2, generation: 3, machineId: 'm1', machineAccountId: 'owner',
    paused: true, deletedAt: null, legacyMigrationPending: false, machineKeyVersion: 1, viewerKeyVersion: 1,
    targetMachine: { automationKeyVersion: 1, automationContextIsolationVersion: 1 } };
  const source = { id: 'source', automationId: 'a1', machineAccountId: 'owner', machineId: 'm1', displaySessionId: 'manual',
    sessionId: 'automation-run:source', executionCreateBodyHash: 'hash', executionSeedMetadata: 'encrypted',
    executionExitReceipt: { version: 1, provider: 'codex', observedAt: 1, receivedAt: 2, providerExitedCleanly: true,
      foregroundDrained: true, backgroundDrained: true, writeProducersDrained: true } };
  const tx = { project: { findUnique: vi.fn(async () => ({ id: 'p1', accountId: 'owner', config: { machineId: 'm1' }, automationViewerKeyVersion: 1 })) },
    projectMember: { findUnique: vi.fn() }, automation: { findFirst: vi.fn(async () => definition), update: vi.fn(), updateMany: vi.fn() },
    automationRun: { findFirst: vi.fn(async () => source), createMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) }, session: { findFirst: vi.fn(async () => ({ id: 'manual' })) },
    automationExecutionQuestion: { findUnique: vi.fn(async (): Promise<any> => null), createMany: vi.fn(async () => ({ count: 1 })) } };
  return { tx, input, definition, source };
}
it('queues a manual followup even while the schedule is paused without touching the definition or claiming a scheduled slot', async () => {
  const f = fixture();
  expect(await queueAutomationExecutionQuestion(f.tx as never, 'owner', 'p1', 'a1', f.input)).toMatchObject({ requestId: f.input.requestId, state: 'QUEUED' });
  expect(f.tx.automation.update).not.toHaveBeenCalled(); expect(f.tx.automation.updateMany).not.toHaveBeenCalled();
  expect(f.tx.automationRun.createMany).not.toHaveBeenCalled();
  expect(f.tx.automationExecutionQuestion.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true,
    data: [expect.objectContaining({ id: f.input.requestId, requestedByAccountId: 'owner', automationId: 'a1', sourceRunId: 'source', generation: 3, revision: 2, displaySessionId: 'manual', encrypted: f.input.encrypted })] }));
});
it.each(['foreign-display', 'unconfirmed-exit', 'readiness', 'revision', 'generation', 'viewer-key', 'machine-key', 'deleted', 'archived'])('refuses unsafe question source or current execution state (%s)', async reason => {
  const f = fixture();
  if (reason === 'foreign-display') f.source.displaySessionId = 'other';
  if (reason === 'unconfirmed-exit') f.source.executionExitReceipt = null as never;
  if (reason === 'readiness') f.definition.targetMachine.automationContextIsolationVersion = 0;
  if (reason === 'revision') f.input.expectedRevision++;
  if (reason === 'generation') f.input.generation++;
  if (reason === 'viewer-key') f.input.encrypted.viewerKeyVersion++;
  if (reason === 'machine-key') f.input.encrypted.machineKeyVersion++;
  if (reason === 'deleted') f.definition.deletedAt = new Date() as never;
  if (reason === 'archived') f.tx.project.findUnique.mockResolvedValue({ id: 'chat:p1', accountId: 'owner', config: { machineId: 'm1', chatAutomationState: 'archived' }, automationViewerKeyVersion: 1 } as never);
  if (reason === 'archived') { f.definition.projectId = 'chat:p1'; }
  await expect(queueAutomationExecutionQuestion(f.tx as never, 'owner', reason === 'archived' ? 'chat:p1' : 'p1', 'a1', f.input)).rejects.toThrow();
  expect(f.tx.automationExecutionQuestion.createMany).not.toHaveBeenCalled();
});
it('refuses a viewer before reading the source or storing a request', async () => {
  const f = fixture(); f.tx.projectMember.findUnique.mockResolvedValue({ status: 'accepted', role: 'viewer' });
  await expect(queueAutomationExecutionQuestion(f.tx as never, 'viewer', 'p1', 'a1', f.input)).rejects.toThrow();
  expect(f.tx.automationRun.findFirst).not.toHaveBeenCalled(); expect(f.tx.automationExecutionQuestion.createMany).not.toHaveBeenCalled();
});

it('claims a separate question run with the durable caller token and the selected source without consuming the schedule', async () => {
  const f = fixture(), token = 'a'.repeat(43), now = new Date(10_000);
  f.tx.automationExecutionQuestion.findUnique.mockResolvedValue({ id: f.input.requestId, requestedByAccountId: 'owner', automationId: 'a1', sourceRunId: 'source', generation: 3,
    revision: 2, displaySessionId: 'manual', machineAccountId: 'owner', machineId: 'm1', encrypted: f.input.encrypted, runId: null, cancelledAt: null,
    createdAt: new Date(1), automation: { ...f.definition, project: { id: 'p1', accountId: 'owner', config: { machineId: 'm1' }, automationViewerKeyVersion: 1 } } });
  Object.assign(f.tx.automationExecutionQuestion, { updateMany: vi.fn(async () => ({ count: 1 })) });
  f.tx.automationRun.createMany.mockResolvedValue({ count: 1 } as never);
  const result = await claimAutomationExecutionQuestion(f.tx as never, 'owner', 'm1', f.input.requestId, token, now);
  expect(result).toMatchObject({ requestId: f.input.requestId, runId: f.input.requestId, state: 'CLAIMED', automationId: 'a1',
    sourceRunId: 'source', generation: 3, revision: 2, encrypted: f.input.encrypted });
  expect(f.tx.automationRun.createMany).toHaveBeenCalledWith({ skipDuplicates: true, data: [expect.objectContaining({
    id: f.input.requestId, kind: 'QUESTION', automationId: 'a1', generation: 3, previousExecutionRunId: 'source', scheduledFor: new Date(1), status: 'CLAIMED',
  })] });
  expect(f.tx.automation.update).not.toHaveBeenCalled(); expect(f.tx.automation.updateMany).not.toHaveBeenCalled();
});

it.each(['expired-claim', 'expired-running', 'missing-running-lease'])('never reuses an expired question execution admission (%s)', async state => {
  const f = fixture(), token = 'a'.repeat(43), now = new Date(10_000);
  f.tx.automationExecutionQuestion.findUnique.mockResolvedValue({ id: f.input.requestId, requestedByAccountId: 'owner', automationId: 'a1', sourceRunId: 'source', generation: 3,
    revision: 2, displaySessionId: 'manual', machineAccountId: 'owner', machineId: 'm1', encrypted: f.input.encrypted, runId: f.input.requestId, cancelledAt: null,
    createdAt: new Date(1), automation: { ...f.definition, project: { id: 'p1', accountId: 'owner', config: { machineId: 'm1' }, automationViewerKeyVersion: 1 } } });
  Object.assign(f.tx.automationRun, { findUnique: vi.fn(async () => ({ id: f.input.requestId, kind: 'QUESTION', automationId: 'a1', generation: 3,
    machineAccountId: 'owner', machineId: 'm1', previousExecutionRunId: 'source', claimTokenHash: createHash('sha256').update(token).digest(),
    status: state === 'expired-claim' ? 'CLAIMED' : 'RUNNING', claimExpiresAt: new Date(1), runLeaseExpiresAt: state === 'missing-running-lease' ? null : new Date(1) })) });
  await expect(claimAutomationExecutionQuestion(f.tx as never, 'owner', 'm1', f.input.requestId, token, now)).resolves.toMatchObject({
    runId: f.input.requestId, state: state === 'expired-claim' ? 'EXPIRED' : 'ABANDONED',
  });
  expect(f.tx.automationRun.updateMany).toHaveBeenCalled();
  expect(f.tx.automationRun.createMany).not.toHaveBeenCalled();
});
