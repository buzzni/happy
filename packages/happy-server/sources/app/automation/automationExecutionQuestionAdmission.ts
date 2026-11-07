import type { Automation, AutomationExecutionQuestion, Machine, Project } from '@prisma/client';
import { automationExecutionQuestionRequestSchema } from '@slopus/happy-wire';
import { chatAutomationsBlocked } from './automationService';

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
