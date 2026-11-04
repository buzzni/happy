import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { automationExecutionSessionId, isAutomationExecutionSessionId,
  SessionExecutionCreateBodySchema, sessionCreateBodyHash } from '@slopus/happy-wire';
import { verifyAutomationExecutionTarget, type AutomationExecutionTarget } from '@slopus/happy-wire/automationExecutionToken';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createExecutionBoundSession } from '@/app/session/sessionExecutionBinding';

export const automationExecutionSessionRequestSchema = z.strictObject({
  runId: z.string().min(1).max(160), machineId: z.string().min(1).max(200),
  claimToken: z.string().min(1).max(256), displaySessionId: z.string().min(1).max(200),
  body: SessionExecutionCreateBodySchema,
  targetProof: z.string().min(1).max(8_192), executionBindingRequired: z.boolean(),
  executionProof: z.unknown().optional(),
});

export class AutomationExecutionSessionError extends Error {
  constructor(readonly statusCode: 400 | 403 | 409 | 503, message: string) { super(message); }
}
const refuse = () => { throw new AutomationExecutionSessionError(403, 'Invalid automation execution admission'); };
const conflict = () => { throw new AutomationExecutionSessionError(409, 'Automation execution identity conflict'); };

const ownedExitEvidenceSchema = z.strictObject({ version: z.literal(1), provider: z.enum(['claude', 'codex']),
  observedAt: z.number().int().min(0).max(8_640_000_000_000_000),
  providerExitedCleanly: z.literal(true), foregroundDrained: z.literal(true),
  backgroundDrained: z.literal(true), writeProducersDrained: z.literal(true) });
export const automationExecutionExitReceiptSchema = ownedExitEvidenceSchema.extend({ receivedAt: z.number().int().nonnegative() });
export const automationExecutionExitRequestSchema = z.strictObject({ runId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  machineId: z.string().min(1).max(200), claimToken: z.string().min(1).max(256),
  createBodyHash: z.string().regex(/^[a-f0-9]{64}$/), receipt: ownedExitEvidenceSchema });

/** A private claim proves the reporting machine's original run, even after dispatch/lease expiry.
 * This records cleanup only: it never renews authority, starts a provider or changes a manual session. */
export async function recordAutomationExecutionExit(accountId: string, raw: unknown) {
  const input = automationExecutionExitRequestSchema.parse(raw), sessionId = automationExecutionSessionId(input.runId);
  const where = { id: input.runId, machineAccountId: accountId, machineId: input.machineId,
    claimTokenHash: new Uint8Array(createHash('sha256').update(input.claimToken).digest()) };
  return inTx(async tx => {
    const run = await tx.automationRun.findFirst({ where });
    if (!run) return refuse();
    if (run.sessionId !== sessionId || !run.displaySessionId || run.executionCreateBodyHash !== input.createBodyHash) return conflict();
    const reconcile = (rawReceipt: unknown) => {
      const stored = automationExecutionExitReceiptSchema.safeParse(rawReceipt);
      if (!stored.success || (Object.keys(input.receipt) as Array<keyof typeof input.receipt>)
        .some(key => input.receipt[key] !== stored.data[key])) return conflict();
      return { runId: input.runId, sessionId, receipt: stored.data };
    };
    if (run.executionExitReceipt !== null) return reconcile(run.executionExitReceipt);
    const receipt = { ...input.receipt, receivedAt: Date.now() };
    const changed = await tx.automationRun.updateMany({ where: { ...where, sessionId,
      executionCreateBodyHash: input.createBodyHash, executionExitReceipt: { equals: Prisma.DbNull } }, data: { executionExitReceipt: receipt } });
    if (changed.count !== 1) {
      const stored = await tx.automationRun.findFirst({ where, select: { executionExitReceipt: true } });
      return reconcile(stored?.executionExitReceipt);
    }
    return { runId: input.runId, sessionId, receipt };
  });
}

/** Registration does not start a provider. The caller must reconcile its durable launch receipt. */
export async function createAutomationExecutionSession(accountId: string, bearer: string, raw: unknown,
  options: { secret?: string; now?: Date } = {}) {
  const parsed = automationExecutionSessionRequestSchema.safeParse(raw);
  if (!parsed.success) throw new AutomationExecutionSessionError(400, 'Invalid automation execution session request');
  const input = parsed.data;
  const secret = options.secret ?? process.env.SCRIPT_AUTOMATION_ADMISSION_SECRET ?? '';
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new AutomationExecutionSessionError(503, 'Automation execution admission trust is not configured');
  }
  const clock = () => options.now ?? new Date();
  const sessionId = automationExecutionSessionId(input.runId);
  if (input.body.tag !== sessionId || isAutomationExecutionSessionId(input.displaySessionId)) refuse();
  const bodyHash = await sessionCreateBodyHash(input.body);
  const claimTokenHash = new Uint8Array(createHash('sha256').update(input.claimToken).digest());
  function checkTarget(target: AutomationExecutionTarget) {
    if (!verifyAutomationExecutionTarget({ token: input.targetProof, expected: target, bearer, secret, now: clock().getTime() })) refuse();
  }

  async function authorize(tx: Pick<Prisma.TransactionClient, 'automationRun' | 'projectMember' | 'session'>) {
    const run = await tx.automationRun.findFirst({
      where: { id: input.runId, machineAccountId: accountId, machineId: input.machineId, claimTokenHash },
      include: { automation: { include: { project: true, targetMachine: true } } },
    });
    if (!run) return refuse();
    const a = run.automation, now = clock();
    const config = a.project.config as { machineId?: unknown } | null;
    if (run.status !== 'RUNNING' || !run.runLeaseExpiresAt || run.runLeaseExpiresAt < now
      || a.payloadVersion !== 6 || a.generation !== run.generation || a.paused || a.deletedAt || a.legacyMigrationPending
      || a.machineAccountId !== accountId || a.machineId !== input.machineId
      || a.project.accountId !== accountId || config?.machineId !== input.machineId
      || a.machineKeyVersion !== a.targetMachine?.automationKeyVersion
      || a.viewerKeyVersion !== a.project.automationViewerKeyVersion) return refuse();
    const target: AutomationExecutionTarget = {
      automationId: a.id, projectId: a.projectId, runId: run.id, generation: run.generation,
      revision: a.revision, machineId: input.machineId, machineAccountId: accountId,
      displaySessionId: input.displaySessionId, createBodyHash: bodyHash,
      executionBindingRequired: input.executionBindingRequired,
    };
    checkTarget(target);
    if (a.ownerAccountId !== accountId) {
      const member = await tx.projectMember.findUnique({ where: { projectId_accountId: { projectId: a.projectId, accountId: a.ownerAccountId } } });
      if (!member || member.status !== 'accepted' || !['owner', 'editor'].includes(member.role)) return refuse();
    }
    const display = await tx.session.findFirst({ where: { id: input.displaySessionId, accountId }, select: { id: true } });
    if (!display) return refuse();
    if ((run.sessionId && run.sessionId !== sessionId)
      || (run.displaySessionId && run.displaySessionId !== input.displaySessionId)
      || (run.executionCreateBodyHash && run.executionCreateBodyHash !== bodyHash)
      || (run.executionSeedMetadata && run.executionSeedMetadata !== input.body.metadata)) return conflict();
    return { run, target };
  }

  async function bind(tx: Prisma.TransactionClient, registeredSessionId: string) {
    const { run } = await authorize(tx);
    if (registeredSessionId !== sessionId) return conflict();
    const a = run.automation;
    // Same definition -> run order as pause/delete/conversation delivery.
    const definition = await tx.automation.updateMany({ where: {
      id: a.id, revision: a.revision, generation: run.generation, paused: false, deletedAt: null,
      targetMachine: { is: { automationKeyVersion: a.machineKeyVersion } },
      project: { is: { automationViewerKeyVersion: a.viewerKeyVersion } },
    }, data: { revision: a.revision } });
    if (definition.count !== 1) return refuse();
    const changed = await tx.automationRun.updateMany({ where: {
      id: run.id, claimTokenHash, status: 'RUNNING', runLeaseExpiresAt: { gte: clock() },
      AND: [{ OR: [{ sessionId: null }, { sessionId }] },
        { OR: [{ displaySessionId: null }, { displaySessionId: input.displaySessionId }] },
        { OR: [{ executionCreateBodyHash: null }, { executionCreateBodyHash: bodyHash }] },
        { OR: [{ executionSeedMetadata: null }, { executionSeedMetadata: input.body.metadata }] }],
    }, data: { sessionId, displaySessionId: input.displaySessionId, executionCreateBodyHash: bodyHash,
      executionSeedMetadata: input.body.metadata } });
    if (changed.count !== 1) return conflict();
    return run;
  }

  const admission = await authorize(db);
  if (input.executionBindingRequired && !input.executionProof) return refuse();
  if (input.executionProof !== undefined) {
    let created = false;
    const session = await createExecutionBoundSession(accountId, input.body, input.executionProof,
      async (tx, row, isNew) => {
        const previous = await bind(tx, row.id);
        if (!isNew && previous.executionCreateBodyHash !== bodyHash) conflict();
        created = isNew;
      }, () => checkTarget(admission.target), input.runId);
    return { created, session };
  }
  return inTx(async tx => {
    const previous = await bind(tx, sessionId);
    const existing = await tx.session.findUnique({ where: { id: sessionId } });
    const dataEncryptionKey = input.body.dataEncryptionKey
      ? new Uint8Array(Buffer.from(input.body.dataEncryptionKey, 'base64')) : null;
    if (existing) {
      if (previous.executionCreateBodyHash !== bodyHash || existing.accountId !== accountId || existing.tag !== input.body.tag) return conflict();
      checkTarget(admission.target);
      return { created: false, session: existing };
    }
    const session = await tx.session.create({ data: { id: sessionId, accountId, tag: input.body.tag,
      metadata: input.body.metadata, agentState: input.body.agentState, dataEncryptionKey } });
    checkTarget(admission.target);
    return { created: true, session };
  });
}
