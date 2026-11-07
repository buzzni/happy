import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { automationExecutionQuestionRequestSchema, automationExecutionSessionId } from '@slopus/happy-wire';
import { projectAccess, chatAutomationsBlocked } from './automationService';
import { AutomationExecutionSessionError, automationExecutionExitReceiptSchema } from './automationExecutionSession';

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
