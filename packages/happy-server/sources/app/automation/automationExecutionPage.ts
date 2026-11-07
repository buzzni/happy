import type { Prisma } from '@prisma/client';
import { automationExecutionSeedLocalId, automationExecutionSessionId, isAutomationExecutionSessionId } from '@slopus/happy-wire';
import { automationExecutionExitReceiptSchema, AutomationExecutionSessionError } from './automationExecutionSession';

/** Display projection only. Reading it never appends messages to the manual provider input. */
export async function listAutomationExecutionPage(tx: Prisma.TransactionClient, accountId: string,
  displaySessionId: string, input: { limit: number; cursor: string | null }) {
  if (isAutomationExecutionSessionId(displaySessionId)
    || !await tx.session.findFirst({ where: { id: displaySessionId, accountId }, select: { id: true } })) return null;
  let after: { createdAt: Date; id: string } | null = null;
  if (input.cursor !== null) {
    try {
      const row = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] < 0
        || !Number.isFinite(new Date(row[0]).getTime()) || typeof row[1] !== 'string' || !row[1] || row[1].length > 160) throw new Error();
      after = { createdAt: new Date(row[0]), id: row[1] };
    } catch { throw new Error('invalid-automation-execution-cursor'); }
  }
  const rows = await tx.automationRun.findMany({
    where: { displaySessionId, machineAccountId: accountId, executionCreateBodyHash: { not: null },
      automation: { project: { OR: [{ accountId }, { members: { some: { accountId, status: 'accepted' } } }] } },
      ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
    },
    select: { id: true, automationId: true, generation: true, displaySessionId: true, sessionId: true,
      createdAt: true, scheduledFor: true, status: true, outcome: true, failureCode: true, holdCode: true, startedAt: true, completedAt: true, executionExitReceipt: true,
      automation: { select: { projectId: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: input.limit + 1,
  });
  const page = rows.slice(0, input.limit), last = page.at(-1);
  return { runs: page.map(row => {
    const exit = automationExecutionExitReceiptSchema.safeParse(row.executionExitReceipt);
    return { id: row.id, automationId: row.automationId, projectId: row.automation.projectId,
    generation: row.generation, displaySessionId: row.displaySessionId, executionSessionId: row.sessionId,
    // COMPLETED/WOKE means dispatch accepted, not proof that the native model finished its answer.
    schedulerStatus: row.status, outcome: row.outcome, failureCode: row.failureCode, holdCode: row.holdCode,
    executionExitReceipt: exit.success ? exit.data : null,
    executionExitError: row.executionExitReceipt !== null && !exit.success ? 'INVALID_EXECUTION_EXIT_RECEIPT' : null,
    scheduledFor: row.scheduledFor.getTime(), dispatchedAt: row.startedAt?.getTime() ?? null,
    dispatchReportedAt: row.completedAt?.getTime() ?? null,
  }; }), nextCursor: rows.length > input.limit && last
    ? Buffer.from(JSON.stringify([last.createdAt.getTime(), last.id])).toString('base64url') : null };
}

/** The server selects opaque boundary receipts, never decrypting or inferring a model answer. */
export async function readAutomationExecutionEvidencePage(tx: Prisma.TransactionClient, accountId: string,
  displaySessionId: string, runId: string, input: { limit: number; after_seq: number; through_seq?: number }) {
  if (isAutomationExecutionSessionId(displaySessionId)
    || !await tx.session.findFirst({ where: { id: displaySessionId, accountId }, select: { id: true } })) return null;
  const run = await tx.automationRun.findFirst({
    where: { id: runId, displaySessionId, machineAccountId: accountId, executionCreateBodyHash: { not: null },
      executionSeedMetadata: { not: null },
      automation: { project: { OR: [{ accountId }, { members: { some: { accountId, status: 'accepted' } } }] } } },
    select: { id: true, automationId: true, generation: true, sessionId: true, executionSeedMetadata: true },
  });
  if (!run || run.sessionId !== automationExecutionSessionId(runId)) return null;
  const session = await tx.session.findFirst({ where: { id: run.sessionId, accountId },
    select: { seq: true, dataEncryptionKey: true } });
  if (!session) return null;
  const throughSeq = input.through_seq ?? session.seq;
  if (throughSeq > session.seq || input.after_seq > throughSeq) throw new Error('invalid-automation-evidence-cursor');
  const rows = await tx.sessionMessage.findMany({ where: { sessionId: run.sessionId,
    seq: { gt: input.after_seq, lte: throughSeq }, localId: { startsWith: `automation-evidence:${runId}:` } },
    orderBy: { seq: 'asc' }, take: input.limit + 1,
    select: { id: true, seq: true, localId: true, content: true, createdAt: true } });
  const messages = rows.slice(0, input.limit);
  const seedMessage = input.after_seq === 0 ? await tx.sessionMessage.findFirst({
    where: { sessionId: run.sessionId, localId: automationExecutionSeedLocalId(runId), seq: { lte: throughSeq } },
    select: { id: true, seq: true, localId: true, content: true, createdAt: true },
  }) : null;
  return { runId, automationId: run.automationId, generation: run.generation, displaySessionId, executionSessionId: run.sessionId,
    seedManifestCiphertext: run.executionSeedMetadata,
    seedMessage: seedMessage ? { ...seedMessage, createdAt: seedMessage.createdAt.getTime() } : null,
    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
    throughSeq, messages: messages.map(row => ({ ...row, createdAt: row.createdAt.getTime() })),
    nextAfterSeq: rows.length > input.limit ? messages.at(-1)!.seq : null };
}

/** A history link survives source pruning. Only the client can verify an E2EE final answer. */
export async function readAutomationExecutionReference(tx: Prisma.TransactionClient, accountId: string,
  automationId: string, input: { machineId: string; generation: number; revision: number;
    displaySessionId: string; beforeRunId?: string }) {
  const denied = () => { throw new AutomationExecutionSessionError(403, 'Invalid automation reference admission'); };
  const unavailable = () => { throw new AutomationExecutionSessionError(409, 'AUTOMATION_REFERENCE_UNAVAILABLE'); };
  const definition = await tx.automation.findFirst({ where: { id: automationId, machineAccountId: accountId,
    machineId: input.machineId, payloadVersion: 6, generation: input.generation, revision: input.revision,
    paused: false, deletedAt: null, legacyMigrationPending: false }, include: { project: true, targetMachine: true } });
  if (!definition || definition.project.accountId !== accountId
    || (definition.project.config as { machineId?: unknown } | null)?.machineId !== input.machineId
    || definition.machineKeyVersion !== definition.targetMachine?.automationKeyVersion
    || definition.viewerKeyVersion !== definition.project.automationViewerKeyVersion
    || isAutomationExecutionSessionId(input.displaySessionId)
    || !await tx.session.findFirst({ where: { id: input.displaySessionId, accountId }, select: { id: true } })) return denied();
  if (definition.ownerAccountId !== accountId) {
    const member = await tx.projectMember.findUnique({ where: {
      projectId_accountId: { projectId: definition.projectId, accountId: definition.ownerAccountId } } });
    if (!member || member.status !== 'accepted' || !['owner', 'editor'].includes(member.role)) return denied();
  }
  async function candidate(runId: string, requireExit = true) {
    const run = await tx.automationRun.findFirst({ where: { id: runId, automationId,
      machineAccountId: accountId, machineId: input.machineId } });
    if (!run || run.sessionId !== automationExecutionSessionId(runId) || run.displaySessionId !== input.displaySessionId
      || !run.executionCreateBodyHash || !run.executionSeedMetadata || run.previousExecutionRunId === run.id) return unavailable();
    const exit = automationExecutionExitReceiptSchema.safeParse(run.executionExitReceipt);
    if (requireExit && !exit.success) throw new AutomationExecutionSessionError(409, 'AUTOMATION_REFERENCE_UNCONFIRMED');
    if (!await tx.session.findFirst({ where: { id: run.sessionId, accountId }, select: { id: true } })) return unavailable();
    return { status: 'CANDIDATE' as const, automationId, runId, generation: run.generation,
      displaySessionId: run.displaySessionId, executionSessionId: run.sessionId,
      createBodyHash: run.executionCreateBodyHash, executionExitReceipt: exit.success ? exit.data : null,
      previousRunId: run.previousExecutionRunId };
  }
  const runId = input.beforeRunId ? (await candidate(input.beforeRunId, false)).previousRunId : definition.lastExecutionRunId;
  if (!runId) return { status: 'NONE_ELIGIBLE' as const, automationId };
  return candidate(runId);
}
