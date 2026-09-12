import { createHash } from 'node:crypto';
import { scriptAutomationId } from '@slopus/happy-wire/scriptServiceToken';
import { isDeepStrictEqual } from 'node:util';
import type { Automation, Prisma } from '@prisma/client';
import { SCRIPT_AUTOMATION_PROTOCOL_VERSION, scriptAdmissionSchema, scriptRegistrationRequestSchema, type ScriptRegistrationRequest } from '@slopus/happy-wire';
import { getAutomationTarget, projectAccess } from './automationService';
import { createScriptArtifactService } from './scriptArtifactService';
import { removeUnusedScriptRevisions, type ScriptQueueDatabase, type ScriptQueueTransaction } from './scriptInvocationService';
import { compileScriptInputSchema } from './scriptExecutionService';

/** Caller supplies the enclosing transaction: artifact/config/revision commit together. */
export async function saveScriptAutomation(tx: Prisma.TransactionClient, actorId: string, projectId: string, raw: ScriptRegistrationRequest): Promise<Automation> {
  const input = scriptRegistrationRequestSchema.parse(raw);
  const validateInput = compileScriptInputSchema(input.admission.inputSchema);
  if (input.admission.schedule?.enabled && !validateInput({})) throw new Error('INPUT_SCHEMA_INVALID');
  const access = await projectAccess(tx, actorId, projectId);
  if (!access?.canEdit) throw new Error('PROJECT_WRITE_DENIED');
  const target = await getAutomationTarget(tx, actorId, projectId);
  if (!target.ok || target.value.automationProtocolVersion < SCRIPT_AUTOMATION_PROTOCOL_VERSION) throw new Error('SCRIPT_RUNNER_UNSUPPORTED');
  if (!target.value.viewerPublicKey || target.value.viewerKeyVersion !== input.viewerKeyVersion || target.value.machineKeyVersion !== input.machineKeyVersion) throw new Error('KEY_VERSION_CONFLICT');
  // Serialize creation by registrationKey, including the case where no row exists.
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
  const current = await tx.automation.findFirst({ where: { projectId, scriptRegistrationKey: input.registrationKey, deletedAt: null } });
  if (current) {
    await tx.$queryRaw`SELECT id FROM "Automation" WHERE id=${current.id} FOR UPDATE`;
    if (input.expectedRevision === 0 && current.revision === 1
      && Buffer.from(current.payloadCiphertext).toString('base64') === input.encrypted.ciphertext
      && current.paused === input.paused) {
      const revision = await tx.scriptAutomationRevision.findUnique({ where: { automationId_revision: { automationId: current.id, revision: current.revision } } });
      const artifact = input.artifact ? await tx.scriptArtifact.findUnique({ where: { id: input.admission.artifactId } }) : null;
      if (revision && isDeepStrictEqual(revision.admission, input.admission)
        && isDeepStrictEqual(JSON.parse(revision.payloadCiphertext), input.encrypted)
        && (!input.artifact || (artifact && isDeepStrictEqual(artifact.encrypted, input.artifact)))) return current;
    }
    if (input.expectedRevision !== current.revision) throw new Error('REVISION_CONFLICT');
  } else if (input.expectedRevision !== 0) throw new Error('REVISION_CONFLICT');

  const queueTransaction: ScriptQueueTransaction = {
    query: <T>(sql: string, values: unknown[] = []) => tx.$queryRawUnsafe<T[]>(sql, ...values),
  };
  const database: ScriptQueueDatabase = { transaction: (action) => action(queueTransaction) };
  const artifacts = createScriptArtifactService(database);
  if (input.artifact) await artifacts.put({ id: input.admission.artifactId, projectId, digest: input.admission.digest, encrypted: input.artifact });
  const artifact = await artifacts.get(projectId, input.admission.artifactId);
  if (artifact.digest !== input.admission.digest) throw new Error('ARTIFACT_DIGEST_MISMATCH');
  const fields = {
    payloadVersion: 3, payloadCiphertext: new Uint8Array(Buffer.from(input.encrypted.ciphertext, 'base64')),
    viewerKeyId: createHash('sha256').update(target.value.viewerPublicKey).digest('base64url'),
    viewerKeyVersion: input.viewerKeyVersion, viewerKeyEnvelope: new Uint8Array(Buffer.from(input.encrypted.viewerKeyEnvelope, 'base64')),
    machineKeyVersion: input.machineKeyVersion, machineKeyEnvelope: new Uint8Array(Buffer.from(input.encrypted.machineKeyEnvelope, 'base64')),
    machineId: target.value.machineId, machineAccountId: target.value.machineAccountId, paused: input.paused,
  };
  const targetChanged = current && (current.machineId !== fields.machineId || current.machineAccountId !== fields.machineAccountId
    || current.machineKeyVersion !== fields.machineKeyVersion || current.viewerKeyVersion !== fields.viewerKeyVersion);
  const row = current
    ? await tx.automation.update({ where: { id: current.id }, data: { ...fields, revision: { increment: 1 }, ...(targetChanged ? { generation: { increment: 1 } } : {}) } })
    : await tx.automation.create({ data: { id: scriptAutomationId(projectId, input.registrationKey), ...fields, projectId, ownerAccountId: actorId, scriptRegistrationKey: input.registrationKey } });
  await artifacts.attachRevision({ automationId: row.id, projectId, revision: row.revision,
    artifactId: input.admission.artifactId, digest: input.admission.digest,
    payloadCiphertext: JSON.stringify(input.encrypted), admission: input.admission });
  if (current) {
    const previous = await tx.scriptAutomationRevision.findUniqueOrThrow({ where: { automationId_revision: { automationId: row.id, revision: current.revision } } });
    const oldSchedule = scriptAdmissionSchema.parse(previous.admission).schedule;
    const newSchedule = input.admission.schedule;
    // Pausing changes admission, not the identity or consumption of a schedule.
    if (isDeepStrictEqual(oldSchedule && { ...oldSchedule, enabled: true }, newSchedule && { ...newSchedule, enabled: true })) {
      await tx.scriptAutomationRevision.update({ where: { automationId_revision: { automationId: row.id, revision: row.revision } },
        data: { nextRunAt: previous.nextRunAt, scheduleInitialized: previous.scheduleInitialized } });
    }
  }
  if (row.paused || targetChanged) await tx.scriptInvocation.updateMany({
    where: { automationId: row.id, status: { in: ['QUEUED', 'CLAIMED'] } }, data: { status: 'CANCELLED', completedAt: Date.now() },
  });
  await removeUnusedScriptRevisions(queueTransaction, row.id, row.revision);
  // Script v3 has its own machine poll contract; publishing it into the legacy
  // change stream would make older daemons reject their whole sync batch.
  return row;
}
