import { randomUUID } from 'node:crypto';
import { hashScriptInput, type ScriptServiceOperation } from '@slopus/happy-wire/scriptServiceToken';
import Ajv from 'ajv';
import type { Prisma } from '@prisma/client';
import { encryptScriptValue, nextScriptScheduledAt, planScriptSchedule, scriptAdmissionSchema,
  scriptInvocationRequestSchema, SCRIPT_AUTOMATION_PROTOCOL_VERSION } from '@slopus/happy-wire';
import { getAutomationTarget, projectAccess } from './automationService';
import { createScriptInvocationService, type ScriptEnqueueInput } from './scriptInvocationService';

export function scriptQueueInTransaction(tx: Prisma.TransactionClient) {
  return createScriptInvocationService({ transaction: (action) => action({
    query: <T>(sql: string, values: unknown[] = []) => tx.$queryRawUnsafe<T[]>(sql, ...values),
  }) });
}

/** Only local JSON Schema references; no coercion, defaults, removal or network loading. */
export function compileScriptInputSchema(schema: Record<string, unknown>) {
  if (Buffer.byteLength(JSON.stringify(schema)) > 65536) throw new Error('INPUT_SCHEMA_INVALID');
  try { return new Ajv({ strict: true, allErrors: false, ownProperties: true }).compile(schema); }
  catch { throw new Error('INPUT_SCHEMA_INVALID'); }
}

export async function validateScriptTarget(tx: Prisma.TransactionClient, id: string, accountId?: string, machineId?: string) {
  await tx.$queryRaw`SELECT id FROM "Automation" WHERE id=${id} FOR UPDATE`;
  const row = await tx.automation.findUnique({ where: { id } });
  if (!row || row.deletedAt || row.payloadVersion !== 3) throw new Error('NOT_FOUND');
  if (accountId !== undefined && (row.machineAccountId !== accountId || row.machineId !== machineId)) throw new Error('MACHINE_DENIED');
  const access = await projectAccess(tx, row.ownerAccountId, row.projectId);
  if (!access?.canEdit) throw new Error('PROJECT_WRITE_DENIED');
  const target = await getAutomationTarget(tx, row.ownerAccountId, row.projectId);
  if (!target.ok || target.value.automationProtocolVersion < SCRIPT_AUTOMATION_PROTOCOL_VERSION) throw new Error('SCRIPT_RUNNER_UNSUPPORTED');
  const keys = target.value;
  if (keys.machineAccountId !== row.machineAccountId || keys.machineId !== row.machineId) throw new Error('MACHINE_DENIED');
  if (!keys.viewerPublicKey || keys.machineKeyVersion !== row.machineKeyVersion || keys.viewerKeyVersion !== row.viewerKeyVersion) throw new Error('KEY_VERSION_CONFLICT');
  return { row, keys: { ...keys, viewerPublicKey: keys.viewerPublicKey } };
}

/** The authenticated target calls this only after decrypting and verifying code/config admission. */
export async function markScriptReady(tx: Prisma.TransactionClient, accountId: string, machineId: string, id: string, revision: number, now: number) {
  const { row } = await validateScriptTarget(tx, id, accountId, machineId);
  if (row.revision !== revision) throw new Error('REVISION_CONFLICT');
  const current = await tx.scriptAutomationRevision.findUniqueOrThrow({ where: { automationId_revision: { automationId: id, revision } } });
  if (current.ready) return;
  const admission = scriptAdmissionSchema.parse(current.admission);
  compileScriptInputSchema(admission.inputSchema);
  // A one-shot timestamp already due is still consumed once after an offline registration.
  const schedule = admission.schedule && { ...admission.schedule, enabled: true };
  const nextRunAt = current.scheduleInitialized ? current.nextRunAt
    : schedule?.kind === 'at' ? schedule.at : nextScriptScheduledAt(schedule, now);
  await tx.scriptAutomationRevision.update({ where: { automationId_revision: { automationId: id, revision } }, data: { ready: true, nextRunAt, scheduleInitialized: true, validationFailure: null } });
}

async function admit(tx: Prisma.TransactionClient, target: Awaited<ReturnType<typeof validateScriptTarget>>,
  input: Record<string, unknown>, request: Pick<ScriptEnqueueInput, 'trigger' | 'requestedBy' | 'idempotencyKey' | 'scheduledFor' | 'missedCount' | 'keyId' | 'keyEpoch'>, now: number) {
  const { row, keys } = target;
  const revision = await tx.scriptAutomationRevision.findUniqueOrThrow({ where: { automationId_revision: { automationId: row.id, revision: row.revision } } });
  if (!revision.ready) throw new Error('REVISION_NOT_READY');
  const admission = scriptAdmissionSchema.parse(revision.admission);
  if (Buffer.byteLength(JSON.stringify(input)) > 65536) throw new Error('INPUT_TOO_LARGE');
  if (!compileScriptInputSchema(admission.inputSchema)(input)) throw new Error('INPUT_SCHEMA_INVALID');
  const id = randomUUID();
  const encrypted = encryptScriptValue({ value: input, context: { projectId: row.projectId, resourceId: id, purpose: 'input' },
    viewerPublicKey: new Uint8Array(keys.viewerPublicKey), machinePublicKey: new Uint8Array(keys.machinePublicKey) });
  return scriptQueueInTransaction(tx).enqueue({ ...request, id, automationId: row.id, projectId: row.projectId,
    revision: row.revision, generation: row.generation, bodyHash: hashScriptInput(input),
    inputCiphertext: JSON.stringify(encrypted) }, now);
}

export async function enqueueScriptApiInput(tx: Prisma.TransactionClient, actorId: string,
  claims: Extract<ScriptServiceOperation, { operation: 'enqueue' }>, raw: unknown, now: number) {
  if (!(await projectAccess(tx, actorId, claims.projectId))?.canEdit) throw new Error('PROJECT_WRITE_DENIED');
  const { input } = scriptInvocationRequestSchema.parse(raw);
  const bodyHash = hashScriptInput(input);
  if (bodyHash !== claims.inputHash) throw new Error('SCRIPT_SERVICE_PROOF_INVALID');
  await tx.$queryRaw`SELECT id FROM "Automation" WHERE id=${claims.automationId} FOR UPDATE`;
  const request = { trigger: 'API' as const, requestedBy: `key:${claims.keyId}`, keyId: claims.keyId,
    keyEpoch: claims.epoch, idempotencyKey: claims.idempotencyKey };
  const existing = await tx.scriptInvocation.findUnique({ where: { automationId_requestedBy_idempotencyKey: {
    automationId: claims.automationId, requestedBy: request.requestedBy, idempotencyKey: claims.idempotencyKey,
  } } });
  // Historical retries remain valid after a schema/code edit. The queue still
  // rechecks the key epoch and scope before returning the accepted run.
  if (existing) return scriptQueueInTransaction(tx).enqueue({ ...request, projectId: claims.projectId, automationId: claims.automationId,
    revision: claims.revision, generation: claims.generation, bodyHash, inputCiphertext: existing.inputCiphertext }, now);
  const target = await validateScriptTarget(tx, claims.automationId);
  if (target.row.projectId !== claims.projectId) throw new Error('NOT_FOUND');
  if (target.row.revision !== claims.revision || target.row.generation !== claims.generation) throw new Error('REVISION_CONFLICT');
  return admit(tx, target, input, request, now);
}

export async function enqueueScriptInput(tx: Prisma.TransactionClient, actorId: string, projectId: string, id: string,
  raw: unknown, idempotencyKey: string, now: number) {
  if (!(await projectAccess(tx, actorId, projectId))?.canEdit) throw new Error('PROJECT_WRITE_DENIED');
  const target = await validateScriptTarget(tx, id);
  if (target.row.projectId !== projectId) throw new Error('NOT_FOUND');
  const { input } = scriptInvocationRequestSchema.parse(raw);
  const request = { trigger: 'MANUAL' as const, requestedBy: actorId, idempotencyKey };
  const existing = await tx.scriptInvocation.findUnique({ where: { automationId_requestedBy_idempotencyKey: {
    automationId: id, requestedBy: actorId, idempotencyKey,
  } } });
  if (existing) return scriptQueueInTransaction(tx).enqueue({ ...request, automationId: id, projectId,
    revision: target.row.revision, generation: target.row.generation, bodyHash: hashScriptInput(input),
    inputCiphertext: existing.inputCiphertext }, now);
  return admit(tx, target, input, request, now);
}

export async function enqueueDueScript(tx: Prisma.TransactionClient, accountId: string, machineId: string, id: string, now: number) {
  const target = await validateScriptTarget(tx, id, accountId, machineId);
  if (target.row.paused) return null;
  const revision = await tx.scriptAutomationRevision.findUniqueOrThrow({ where: { automationId_revision: { automationId: id, revision: target.row.revision } } });
  if (!revision.ready) return null;
  const admission = scriptAdmissionSchema.parse(revision.admission);
  const plan = planScriptSchedule({ schedule: admission.schedule, nextRunAt: revision.nextRunAt, now });
  if (!plan) return null;
  const run = await admit(tx, target, {}, { trigger: 'SCHEDULE', requestedBy: `schedule:${id}`,
    idempotencyKey: `${revision.revision}:${plan.scheduledFor}`, scheduledFor: plan.scheduledFor, missedCount: plan.missedCount }, now);
  await tx.scriptAutomationRevision.update({ where: { automationId_revision: { automationId: id, revision: revision.revision } }, data: { nextRunAt: plan.nextRunAt } });
  return run;
}

export async function markScriptValidationFailed(tx: Prisma.TransactionClient, accountId: string, machineId: string, id: string, revision: number) {
  const { row } = await validateScriptTarget(tx, id, accountId, machineId);
  if (row.revision !== revision) throw new Error('REVISION_CONFLICT');
  await tx.scriptAutomationRevision.updateMany({ where: { automationId: id, revision, ready: false }, data: { validationFailure: 'SCRIPT_REVISION_INVALID' } });
}
