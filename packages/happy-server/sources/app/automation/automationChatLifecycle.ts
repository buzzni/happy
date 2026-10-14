import type { Prisma } from '@prisma/client';
import { appendChange } from './automationService';
type Tx = Prisma.TransactionClient;
type State = 'active' | 'archived' | 'deleted';
const configObject = (config: unknown) => config && typeof config === 'object' && !Array.isArray(config) ? config as Record<string, Prisma.InputJsonValue> : {};
async function ownedProject(tx: Tx, accountId: string, projectId: string) {
  if (!projectId.startsWith('chat:') || projectId.length <= 5) throw new Error('CHAT_AUTOMATIONS_FORBIDDEN');
  const project = await tx.project.findUnique({ where: { id: projectId } });
  if (project && project.accountId !== accountId) throw new Error('CHAT_AUTOMATIONS_FORBIDDEN');
  return project;
}
export async function readChatAutomationImpact(tx: Tx, accountId: string, projectId: string) {
  if (!await ownedProject(tx, accountId, projectId)) return { total: 0, paused: 0, running: 0 };
  const where = { projectId, deletedAt: null };
  const [total, paused, promptRunning, scriptRunning] = await Promise.all([
    tx.automation.count({ where }), tx.automation.count({ where: { ...where, paused: true } }),
    tx.automationRun.count({ where: { automation: where, status: { in: ['CLAIMED', 'RUNNING'] } } }),
    tx.scriptInvocation.count({ where: { automation: where, status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] } } }),
  ]);
  return { total, paused, running: promptRunning + scriptRunning };
}
export async function transitionChatAutomations(tx: Tx, accountId: string, projectId: string, state: State, now = new Date()) {
  let project = await ownedProject(tx, accountId, projectId);
  if (!project) project = await tx.project.create({ data: { id: projectId, accountId, name: projectId } });
  const config = configObject(project.config);
  if (config.chatAutomationState === 'deleted' && state !== 'deleted') throw new Error('CHAT_AUTOMATIONS_DELETED');
  // A persistent fence also rejects a create/unpause whose request arrived late.
  await tx.project.update({ where: { id: projectId }, data: { config: { ...config, chatAutomationState: state } } });
  if (state === 'active') return readChatAutomationImpact(tx, accountId, projectId);
  const rows = await tx.automation.findMany({ where: { projectId, deletedAt: null }, orderBy: { id: 'asc' } });
  for (const row of rows) {
    if (state === 'archived' && row.paused && !row.runRequestedAt) continue;
    // Script revisions identify stored code/admission, so a lifecycle pause
    // preserves that revision. Generation still fences cancelled executions.
    const updated = await tx.automation.update({ where: { id: row.id }, data: {
      paused: true, runRequestedAt: null, ...(row.payloadVersion === 3 ? {} : { revision: { increment: 1 } }), generation: { increment: 1 },
      ...(state === 'deleted' ? { deletedAt: now } : {}),
    } });
    if (row.payloadVersion !== 3 && row.machineAccountId && row.machineId) await appendChange(tx, updated, { machineAccountId: row.machineAccountId, machineId: row.machineId }, state === 'deleted' ? 'TOMBSTONE' : 'UPSERT');
  }
  const ids = rows.map(row => row.id);
  await tx.automationRun.updateMany({ where: { automationId: { in: ids }, status: { in: ['CLAIMED', 'RUNNING'] } }, data: { status: 'CANCELLED', completedAt: now, failureCode: state === 'deleted' ? 'CHAT_DELETED' : 'CHAT_ARCHIVED' } });
  await tx.scriptInvocation.updateMany({ where: { automationId: { in: ids }, status: { in: ['QUEUED', 'CLAIMED'] } }, data: { status: 'CANCELLED', completedAt: now.getTime() } });
  if (state === 'deleted') await tx.scriptInvocation.updateMany({ where: { automationId: { in: ids }, status: 'RUNNING' }, data: { cancelRequestedAt: now.getTime() } });
  return readChatAutomationImpact(tx, accountId, projectId);
}
