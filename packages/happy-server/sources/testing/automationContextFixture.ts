/** Disposable native integration fixture only; never imported by the production server entry. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolve } from 'node:path';

if (!process.send || process.argv[2] !== 'serve' || process.env.HOST !== '127.0.0.1' || process.env.DB_PROVIDER !== 'pglite'
  || !process.env.PGLITE_DIR?.includes('.scope-server-integration-')) throw new Error('Disposable context fixture required');
process.env.SAYCODE_AUTOMATION_ENABLED = 'true';
const seedSchema = z.discriminatedUnion('action', [z.strictObject({ id: z.string().uuid(), action: z.literal('seed-context'),
  accountId: z.string().min(1), displaySessionId: z.string().min(1), runId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  claimToken: z.string().min(1), directory: z.string().min(1), secret: z.string().min(32) }),
  z.strictObject({ id: z.string().uuid(), action: z.literal('complete-context'), accountId: z.string().min(1),
    machineId: z.string().min(1), runId: z.string().min(1), claimToken: z.string().min(1), reportId: z.string().uuid(), sessionId: z.string().min(1) })]);

process.on('message', async raw => {
  const parsed = seedSchema.safeParse(raw);
  if (!parsed.success) return;
  const input = parsed.data;
  try {
    const { db } = await import('@/storage/db');
    if (input.action === 'complete-context') {
      const { reportAutomationRun } = await import('@/app/automation/automationExecutionService');
      const result = await db.$transaction(tx => reportAutomationRun(tx, input.accountId, input.machineId, {
        runId: input.runId, claimToken: input.claimToken, reportId: input.reportId, sessionId: input.sessionId,
        status: 'COMPLETED', outcome: 'WOKE', detailCiphertext: null, failureCode: null,
      }));
      process.send!({ id: input.id, ok: result.ok }); return;
    }
    if (input.directory !== resolve(process.env.PGLITE_DIR!, '../../project')) throw new Error('Fixture root mismatch');
    const machine = await db.machine.findFirst({ where: { accountId: input.accountId, automationKeyVersion: { gt: 0 } } });
    if (!machine) { process.send!({ id: input.id, retry: true }); return; }
    if (!await db.session.findFirst({ where: { id: input.displaySessionId, accountId: input.accountId } })) throw new Error('Fixture display missing');
    process.env.SCRIPT_AUTOMATION_ADMISSION_SECRET = input.secret;
    const projectId = `context-fixture:${input.accountId}`, automationId = `context-fixture-${input.accountId}`;
    await db.project.upsert({ where: { id: projectId }, update: {}, create: { id: projectId, accountId: input.accountId,
      name: 'Disposable context fixture', config: { machineId: machine.id }, automationViewerKeyVersion: 1 } });
    const automation = await db.automation.upsert({ where: { id: automationId }, update: {}, create: { id: automationId, projectId,
      ownerAccountId: input.accountId, machineAccountId: input.accountId, machineId: machine.id,
      payloadVersion: 6, payloadCiphertext: new Uint8Array([1]), viewerKeyId: 'fixture', viewerKeyVersion: 1,
      viewerKeyEnvelope: new Uint8Array([1]), machineKeyVersion: machine.automationKeyVersion, machineKeyEnvelope: new Uint8Array([1]) } });
    const now = new Date();
    await db.automationRun.create({ data: { id: input.runId, automationId, generation: automation.generation, scheduledFor: now,
      machineAccountId: input.accountId, machineId: machine.id, status: 'RUNNING', startedAt: now,
      claimTokenHash: new Uint8Array(createHash('sha256').update(input.claimToken).digest()),
      claimExpiresAt: new Date(now.getTime() + 180_000), runLeaseExpiresAt: new Date(now.getTime() + 180_000) } });
    process.send!({ id: input.id, ok: true, machineId: machine.id, projectId, automationId, generation: automation.generation, revision: automation.revision });
  } catch { process.send!({ id: input.id, ok: false }); }
});
process.channel?.unref();
// Keep the normal standalone startup, real JWT authentication, storage and API routes.
void import('../standalone').then(({ serve }) => serve());
