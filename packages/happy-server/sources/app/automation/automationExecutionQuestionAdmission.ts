import type { Automation, AutomationExecutionQuestion, AutomationRun, Machine, Prisma, Project } from '@prisma/client';
import { automationExecutionQuestionRequestSchema } from '@slopus/happy-wire';
import { chatAutomationsBlocked, projectAccess } from './automationService';

export function readCurrentAutomationQuestion(question: AutomationExecutionQuestion,
  definition: Automation & { project: Project; targetMachine: Machine | null }) {
  const parsed = automationExecutionQuestionRequestSchema.safeParse({ requestId: question.id, sourceRunId: question.sourceRunId,
    expectedRevision: question.revision, generation: question.generation, displaySessionId: question.displaySessionId, encrypted: question.encrypted });
  if (!parsed.success || question.cancelledAt || definition.id !== question.automationId || definition.deletedAt || definition.legacyMigrationPending
    || definition.payloadVersion !== 6 || definition.revision !== question.revision || definition.generation !== question.generation
    || definition.machineAccountId !== question.machineAccountId || definition.machineId !== question.machineId
    || definition.project.accountId !== question.machineAccountId || (definition.project.config as { machineId?: unknown } | null)?.machineId !== question.machineId
    || chatAutomationsBlocked(definition.project) || definition.targetMachine?.automationContextIsolationVersion !== 1
    || definition.machineKeyVersion !== definition.targetMachine.automationKeyVersion || definition.machineKeyVersion !== parsed.data.encrypted.machineKeyVersion
    || definition.viewerKeyVersion !== definition.project.automationViewerKeyVersion || definition.viewerKeyVersion !== parsed.data.encrypted.viewerKeyVersion) return null;
  return parsed.data;
}

/** Undefined is an ordinary run; null is a question whose immutable request can no longer authorize execution. */
export async function readAutomationExecutionQuestionForRun(tx: Prisma.TransactionClient,
  run: Pick<AutomationRun, 'id' | 'kind' | 'automationId' | 'generation' | 'machineAccountId' | 'machineId' | 'previousExecutionRunId'>) {
  if (run.kind !== 'QUESTION') return undefined;
  const question = await tx.automationExecutionQuestion.findUnique({ where: { runId: run.id }, include: {
    automation: { include: { project: true, targetMachine: true } },
  } });
  if (!question || question.runId !== run.id || question.id !== run.id || question.automationId !== run.automationId
    || question.generation !== run.generation || question.machineAccountId !== run.machineAccountId || question.machineId !== run.machineId
    || question.sourceRunId !== run.previousExecutionRunId || !readCurrentAutomationQuestion(question, question.automation)) return null;
  const access = await projectAccess(tx, question.requestedByAccountId, question.automation.projectId);
  if (!access?.canEdit) return null;
  return question;
}
