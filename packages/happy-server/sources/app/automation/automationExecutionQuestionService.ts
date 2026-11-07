import { createHash, timingSafeEqual } from 'node:crypto';
import type { Prisma, AutomationExecutionQuestion, AutomationRun } from '@prisma/client';
import { z } from 'zod';
import { automationExecutionQuestionRequestSchema, automationExecutionSessionId, automationExecutionQuestionBindingId, automationExecutionHoldCodeSchema } from '@slopus/happy-wire';
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
    if (existing.automationId !== automationId || existing.requestedByAccountId !== actorId || existing.requestHash !== requestHash) return reject(409, 'AUTOMATION_QUESTION_REQUEST_CONFLICT');
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
  const created = await tx.automationExecutionQuestion.createMany({ skipDuplicates: true, data: [{ id: input.requestId, requestedByAccountId: actorId, automationId,
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
  const access = await projectAccess(tx, question.requestedByAccountId, question.automation.projectId);
  if (!access?.canEdit) return reject(403, 'AUTOMATION_QUESTION_REQUESTER_REVOKED');
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
  const bound = await tx.automationExecutionQuestion.updateMany({ where: { id: requestId, runId: null, cancelledAt: null }, data: { runId: requestId, holdCode: null } });
  if (bound.count !== 1) return reject(409, 'AUTOMATION_QUESTION_CLAIM_CONFLICT');
  return { ...identity, runId: requestId, state: 'CLAIMED' as const, claimExpiresAt: claimExpiresAt.getTime(), runLeaseExpiresAt: null };
}

const questionCursorSchema = z.strictObject({ scope: z.string(), id: z.string().uuid(), createdAt: z.number().int().nonnegative().max(8_640_000_000_000_000) });
const questionRelations = { automation: { include: { project: true, targetMachine: true } } } as const;
type QuestionRun = Pick<AutomationRun, 'id' | 'automationId' | 'generation' | 'machineAccountId' | 'machineId' | 'status' | 'sessionId' | 'executionCreateBodyHash'>;
async function readQuestionRuns(tx: Tx, questions: AutomationExecutionQuestion[]) {
  const ids = questions.filter(row => row.runId === row.id).map(row => row.id);
  if (!ids.length) return new Map<string, QuestionRun>();
  const rows = await tx.automationRun.findMany({ where: { id: { in: ids }, kind: 'QUESTION' }, select: { id: true,
    automationId: true, generation: true, machineAccountId: true, machineId: true, status: true, sessionId: true, executionCreateBodyHash: true } });
  return new Map(rows.map(row => [row.id, row]));
}
function questionView(row: AutomationExecutionQuestion, projectId: string, run?: QuestionRun) {
  const bound = run && run.id === row.id && row.runId === row.id && run.automationId === row.automationId
    && run.generation === row.generation && run.machineAccountId === row.machineAccountId && run.machineId === row.machineId ? run : null;
  const hold = automationExecutionHoldCodeSchema.safeParse(row.holdCode);
  return { requestId: row.id, sourceRunId: row.sourceRunId, automationId: row.automationId, projectId,
    generation: row.generation, revision: row.revision, displaySessionId: row.displaySessionId,
    machineId: row.machineId, encrypted: row.encrypted, runId: row.runId, runState: bound?.status ?? null,
    executionRegistered: !!bound?.executionCreateBodyHash && bound.sessionId === automationExecutionSessionId(row.id),
    state: row.cancelledAt ? 'CANCEL_REQUESTED' as const : row.runId ? 'CLAIMED' as const : 'QUEUED' as const,
    holdCode: hold.success ? hold.data : row.holdCode ? 'AUTOMATION_HOLD_UNCONFIRMED' as const : null,
    createdAt: row.createdAt.getTime() };
}
async function pageQuestions(tx: Tx, where: Prisma.AutomationExecutionQuestionWhereInput, scope: string,
  input: { cursor?: string | null; limit?: number }, descending: boolean) {
  const limit = z.number().int().min(1).max(20).parse(input.limit ?? 20);
  let anchor: z.infer<typeof questionCursorSchema> | null = null;
  if (input.cursor) {
    try { anchor = questionCursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
    catch { return reject(400, 'AUTOMATION_QUESTION_PAGE_INVALID'); }
    if (anchor.scope !== scope) return reject(400, 'AUTOMATION_QUESTION_PAGE_INVALID');
  }
  const order = descending ? 'desc' as const : 'asc' as const;
  const boundary = anchor ? { OR: [{ createdAt: { [descending ? 'lt' : 'gt']: new Date(anchor.createdAt) } },
    { createdAt: new Date(anchor.createdAt), id: { [descending ? 'lt' : 'gt']: anchor.id } }] } : {};
  const rows = await tx.automationExecutionQuestion.findMany({ where: { AND: [where, boundary] }, include: questionRelations,
    orderBy: [{ createdAt: order }, { id: order }], take: limit + 1 });
  const selected = rows.slice(0, limit), last = selected.at(-1);
  const runs = await readQuestionRuns(tx, selected);
  return { questions: selected.map(row => questionView(row, row.automation.projectId, runs.get(row.id))),
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ scope, id: last.id, createdAt: last.createdAt.getTime() })).toString('base64url') : null };
}

export async function listMachineAutomationQuestions(tx: Tx, accountId: string, machineId: string, input: { cursor?: string | null; limit?: number }) {
  return pageQuestions(tx, { machineAccountId: accountId, machineId, runId: null, cancelledAt: null },
    JSON.stringify(['machine', accountId, machineId]), input, false);
}
export async function readMachineAutomationQuestion(tx: Tx, accountId: string, machineId: string, requestId: string) {
  const row = await tx.automationExecutionQuestion.findFirst({ where: { id: requestId, machineAccountId: accountId, machineId }, include: questionRelations });
  if (!row) return reject(404, 'AUTOMATION_QUESTION_NOT_FOUND');
  const access = await projectAccess(tx, row.requestedByAccountId, row.automation.projectId);
  const available = !!access?.canEdit && !!readCurrentAutomationQuestion(row, row.automation);
  return { ...questionView(row, row.automation.projectId, (await readQuestionRuns(tx, [row])).get(row.id)), available };
}
export async function holdMachineAutomationQuestion(tx: Tx, accountId: string, machineId: string, requestId: string, raw: unknown) {
  const holdCode = automationExecutionHoldCodeSchema.nullable().parse(raw);
  const result = await tx.automationExecutionQuestion.updateMany({ where: { id: requestId, machineAccountId: accountId, machineId,
    runId: null, cancelledAt: null }, data: { holdCode } });
  if (result.count !== 1) return reject(409, 'AUTOMATION_QUESTION_STATE_CHANGED');
  return { requestId, holdCode };
}
export async function listProjectAutomationQuestions(tx: Tx, actorId: string, projectId: string,
  input: { displaySessionId: string; cursor?: string | null; limit?: number }) {
  if (!await projectAccess(tx, actorId, projectId)) {
    // Ordinary Chats have no Happy automation mirror until their first explicit save. Absence is empty
    // only for an owned display; an existing scope whose membership was revoked must remain denied.
    if (await tx.project.findUnique({ where: { id: projectId }, select: { id: true } })
      || !await tx.session.findFirst({ where: { id: input.displaySessionId, accountId: actorId }, select: { id: true } })) {
      return reject(404, 'AUTOMATION_QUESTION_NOT_FOUND');
    }
    return { questions: [], nextCursor: null };
  }
  return pageQuestions(tx, { automation: { projectId }, displaySessionId: input.displaySessionId },
    JSON.stringify(['project', projectId, input.displaySessionId]), input, true);
}
export async function cancelAutomationExecutionQuestion(tx: Tx, actorId: string, projectId: string, requestId: string, displaySessionId: string) {
  const access = await projectAccess(tx, actorId, projectId);
  if (!access?.canEdit) return reject(404, 'AUTOMATION_QUESTION_NOT_FOUND');
  const row = await tx.automationExecutionQuestion.findFirst({ where: { id: requestId, displaySessionId, automation: { projectId } } });
  if (!row) return reject(404, 'AUTOMATION_QUESTION_NOT_FOUND');
  if (!row.cancelledAt) await tx.automationExecutionQuestion.updateMany({ where: { id: requestId, cancelledAt: null },
    data: { cancelledAt: new Date(), holdCode: null } });
  // A cancellation intent is not a positive native-exit receipt.
  return { ...questionView(row, projectId, (await readQuestionRuns(tx, [row])).get(row.id)), state: 'CANCEL_REQUESTED' as const, holdCode: null };
}
