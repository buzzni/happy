import { createHash, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { automationExecutionQuestionRequestSchema, automationExecutionSessionId, automationExecutionQuestionBindingId } from '@slopus/happy-wire';
import { projectAccess, chatAutomationsBlocked } from './automationService';
import { AutomationExecutionSessionError, automationExecutionExitReceiptSchema } from './automationExecutionSession';
import { readCurrentAutomationQuestion } from './automationExecutionQuestionAdmission';

type Tx = Prisma.TransactionClient;
const reject = (code: AutomationExecutionSessionError['statusCode'], message: string): never => { throw new AutomationExecutionSessionError(code, message); };
function publicQuestion(row: { id: string; sourceRunId: string; runId: string | null; cancelledAt: Date | null }) {
  return { requestId: row.id, sourceRunId: row.sourceRunId, runId: row.runId,
    state: row.cancelledAt ? 'CANCELLED' as const : row.runId ? 'CLAIMED' as const : 'QUEUED' as const };
}

/** Call inside a serializable transaction. Stored inputs never replace the saved automation. */
export async function queueAutomationExecutionQuestion(tx: Tx, actorId: string, projectId: string, automationId: string, raw: unknown) {
  const input = automationExecutionQuestionRequestSchema.parse(raw), access = await projectAccess(tx, actorId, projectId);
  if (!access || access.project.id !== projectId || !access.canEdit) return reject(404, 'AUTOMATION_QUESTION_NOT_FOUND');
  const requestHash = createHash('sha256').update(JSON.stringify({ projectId, automationId, ...input })).digest('hex');
  const replay = async () => {
    const existing = await tx.automationExecutionQuestion.findUnique({ where: { id: input.requestId } });
    if (!existing) return null;
    if (existing.automationId !== automationId || existing.requestHash !== requestHash) return reject(409, 'AUTOMATION_QUESTION_REQUEST_CONFLICT');
    return publicQuestion(existing);
  };
  const existing = await replay();
  if (existing) return existing;
  if (chatAutomationsBlocked(access.project)) return reject(409, 'AUTOMATION_QUESTION_TARGET_UNAVAILABLE');
  const definition = await tx.automation.findFirst({ where: { id: automationId, projectId }, include: { targetMachine: true } });
  if (!definition || definition.deletedAt || definition.legacyMigrationPending || definition.payloadVersion !== 6
    || definition.revision !== input.expectedRevision || definition.generation !== input.generation
    || !definition.machineId || definition.machineAccountId !== access.project.accountId
    || (access.project.config as { machineId?: unknown } | null)?.machineId !== definition.machineId
    || definition.targetMachine?.automationContextIsolationVersion !== 1
    || definition.machineKeyVersion !== definition.targetMachine.automationKeyVersion
    || definition.machineKeyVersion !== input.encrypted.machineKeyVersion
    || definition.viewerKeyVersion !== access.project.automationViewerKeyVersion
    || definition.viewerKeyVersion !== input.encrypted.viewerKeyVersion) return reject(409, 'AUTOMATION_QUESTION_TARGET_UNAVAILABLE');
  const source = await tx.automationRun.findFirst({ where: { id: input.sourceRunId, automationId,
    machineAccountId: definition.machineAccountId, machineId: definition.machineId } });
  if (!source || source.displaySessionId !== input.displaySessionId || source.sessionId !== automationExecutionSessionId(input.sourceRunId)
    || !source.executionCreateBodyHash || !source.executionSeedMetadata) return reject(404, 'AUTOMATION_QUESTION_SOURCE_UNAVAILABLE');
  if (!automationExecutionExitReceiptSchema.safeParse(source.executionExitReceipt).success) return reject(409, 'AUTOMATION_QUESTION_SOURCE_UNCONFIRMED');
  for (const sessionId of [input.displaySessionId, source.sessionId]) {
    if (!await tx.session.findFirst({ where: { id: sessionId, accountId: definition.machineAccountId }, select: { id: true } })) {
      return reject(404, 'AUTOMATION_QUESTION_SOURCE_UNAVAILABLE');
    }
  }
  const created = await tx.automationExecutionQuestion.createMany({ skipDuplicates: true, data: [{ id: input.requestId, automationId,
    sourceRunId: input.sourceRunId, generation: input.generation, revision: input.expectedRevision, displaySessionId: input.displaySessionId,
    machineAccountId: definition.machineAccountId, machineId: definition.machineId, encrypted: input.encrypted, requestHash }] });
  if (created.count !== 1) return await replay() ?? reject(503, 'AUTOMATION_QUESTION_STORAGE_UNCONFIRMED');
  return publicQuestion({ id: input.requestId, sourceRunId: input.sourceRunId, runId: null, cancelledAt: null });
}

/** The daemon persists this caller-generated token before sending the claim. An ACK replay reuses the same run. */
export async function claimAutomationExecutionQuestion(tx: Tx, accountId: string, machineId: string, requestId: string, claimToken: string, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(claimToken)) return reject(400, 'INVALID_AUTOMATION_QUESTION_CLAIM');
  const question = await tx.automationExecutionQuestion.findUnique({ where: { id: requestId }, include: {
    automation: { include: { project: true, targetMachine: true } },
  } });
  if (!question || question.machineAccountId !== accountId || question.machineId !== machineId) return reject(404, 'AUTOMATION_QUESTION_NOT_FOUND');
  const snapshot = readCurrentAutomationQuestion(question, question.automation);
  if (!snapshot) return reject(409, 'AUTOMATION_QUESTION_TARGET_UNAVAILABLE');
  const identity = { requestId, sourceRunId: question.sourceRunId, automationId: question.automationId,
    projectId: question.automation.projectId, generation: question.generation, revision: question.revision,
    displaySessionId: question.displaySessionId, executionBindingId: automationExecutionQuestionBindingId(requestId), encrypted: snapshot.encrypted };
  const claimTokenHash = new Uint8Array(createHash('sha256').update(claimToken).digest());
  if (question.runId) {
    const run = await tx.automationRun.findUnique({ where: { id: question.runId } });
    if (!run || run.id !== requestId || run.kind !== 'QUESTION' || run.automationId !== question.automationId || run.generation !== question.generation
      || run.machineAccountId !== accountId || run.machineId !== machineId || run.previousExecutionRunId !== question.sourceRunId
      || run.claimTokenHash.length !== claimTokenHash.length || !timingSafeEqual(run.claimTokenHash, claimTokenHash)) return reject(409, 'AUTOMATION_QUESTION_CLAIM_CONFLICT');
    if (run.status === 'CLAIMED' && run.claimExpiresAt < now
      || run.status === 'RUNNING' && (!run.runLeaseExpiresAt || run.runLeaseExpiresAt < now)) {
      const state = run.status === 'CLAIMED' ? 'EXPIRED' as const : 'ABANDONED' as const;
      const expired = await tx.automationRun.updateMany({ where: { id: run.id, status: run.status,
        ...(run.status === 'CLAIMED' ? { claimExpiresAt: { lt: now } } : { OR: [{ runLeaseExpiresAt: null }, { runLeaseExpiresAt: { lt: now } }] }) },
        data: { status: state, completedAt: now, holdCode: null } });
      if (expired.count !== 1) return reject(503, 'AUTOMATION_QUESTION_CLAIM_STATE_CHANGED');
      // Return the terminal state so the transaction commits; throwing here would keep the active slot occupied.
      return { ...identity, runId: run.id, state, claimExpiresAt: run.claimExpiresAt.getTime(), runLeaseExpiresAt: run.runLeaseExpiresAt?.getTime() ?? null };
    }
    return { ...identity, runId: run.id, state: run.status, claimExpiresAt: run.claimExpiresAt.getTime(), runLeaseExpiresAt: run.runLeaseExpiresAt?.getTime() ?? null };
  }
  const source = await tx.automationRun.findFirst({ where: { id: question.sourceRunId, automationId: question.automationId,
    machineAccountId: accountId, machineId } });
  if (!source || source.sessionId !== automationExecutionSessionId(question.sourceRunId) || source.displaySessionId !== question.displaySessionId
    || !source.executionCreateBodyHash || !source.executionSeedMetadata) return reject(404, 'AUTOMATION_QUESTION_SOURCE_UNAVAILABLE');
  if (!automationExecutionExitReceiptSchema.safeParse(source.executionExitReceipt).success) return reject(409, 'AUTOMATION_QUESTION_SOURCE_UNCONFIRMED');
  await tx.automationRun.updateMany({ where: { automationId: question.automationId, status: 'CLAIMED', claimExpiresAt: { lt: now } },
    data: { status: 'EXPIRED', completedAt: now, holdCode: null } });
  await tx.automationRun.updateMany({ where: { automationId: question.automationId, status: 'RUNNING',
    OR: [{ runLeaseExpiresAt: null }, { runLeaseExpiresAt: { lt: now } }] }, data: { status: 'ABANDONED', completedAt: now, holdCode: null } });
  const claimExpiresAt = new Date(now.getTime() + 120_000);
  const created = await tx.automationRun.createMany({ skipDuplicates: true, data: [{ id: requestId, kind: 'QUESTION', automationId: question.automationId,
    generation: question.generation, scheduledFor: question.createdAt, machineAccountId: accountId, machineId, status: 'CLAIMED',
    claimTokenHash, claimExpiresAt, previousExecutionRunId: question.sourceRunId }] });
  if (created.count !== 1) {
    const collision = await tx.automationRun.findUnique({ where: { id: requestId }, select: { id: true } });
    return reject(409, collision ? 'AUTOMATION_QUESTION_CLAIM_CONFLICT' : 'AUTOMATION_QUESTION_BUSY');
  }
  const bound = await tx.automationExecutionQuestion.updateMany({ where: { id: requestId, runId: null, cancelledAt: null }, data: { runId: requestId } });
  if (bound.count !== 1) return reject(409, 'AUTOMATION_QUESTION_CLAIM_CONFLICT');
  return { ...identity, runId: requestId, state: 'CLAIMED' as const, claimExpiresAt: claimExpiresAt.getTime(), runLeaseExpiresAt: null };
}
