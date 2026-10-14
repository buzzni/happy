import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { AutomationConversationDeliverRequest } from '@slopus/happy-wire';
export async function deliverAutomationConversationMessage(tx: Prisma.TransactionClient, accountId: string, machineId: string, input: AutomationConversationDeliverRequest, now = new Date()) {
    const denied = (error: string) => ({ ok: false as const, error });
    const claimTokenHash = new Uint8Array(createHash('sha256').update(input.claimToken).digest());
    const run = await tx.automationRun.findFirst({
        where: { id: input.runId, machineAccountId: accountId, machineId, claimTokenHash },
        include: { automation: { include: { project: true, targetMachine: true } } },
    });
    if (!run || run.automation.payloadVersion !== 4) return denied('claim-not-found');
    const localId = `happy-automation:${run.id}`;
    // The run owns one target, even after its report or the transport ACK is lost.
    if (run.sessionId && run.sessionId !== input.sessionId) return denied('target-mismatch');
    const session = await tx.session.findFirst({ where: { id: input.sessionId, accountId } });
    if (!session) return denied('target-mismatch');
    const existing = await tx.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId: input.sessionId, localId } } });
    if (existing) return { ok: true as const, value: { idempotent: true, message: existing } };
    const a = run.automation;
    if (run.status !== 'RUNNING' || !run.runLeaseExpiresAt || run.runLeaseExpiresAt < now
        || a.generation !== run.generation || a.paused || a.deletedAt || a.legacyMigrationPending
        || a.machineAccountId !== accountId || a.machineId !== machineId
        || a.machineKeyVersion !== a.targetMachine?.automationKeyVersion
        || a.viewerKeyVersion !== a.project.automationViewerKeyVersion) return denied('claim-cancelled');
    const config = a.project.config as { machineId?: unknown } | null;
    if (a.project.accountId !== accountId || config?.machineId !== machineId) return denied('target-mismatch');
    if (a.ownerAccountId !== accountId) {
        const member = await tx.projectMember.findUnique({ where: { projectId_accountId: { projectId: a.projectId, accountId: a.ownerAccountId } } });
        if (!member || member.status !== 'accepted' || !['owner', 'editor'].includes(member.role)) return denied('permission-revoked');
    }
    // Lock the definition before the run/session: pause/delete use the same order.
    const definition = await tx.automation.updateMany({ where: { id: a.id, revision: a.revision, generation: run.generation, paused: false, deletedAt: null }, data: { revision: a.revision } });
    if (definition.count !== 1) return denied('claim-cancelled');
    const fenced = await tx.automationRun.updateMany({ where: { id: run.id, claimTokenHash, status: 'RUNNING', runLeaseExpiresAt: { gte: now }, OR: [{ sessionId: null }, { sessionId: input.sessionId }] }, data: { sessionId: input.sessionId } });
    if (fenced.count !== 1) return denied('claim-cancelled');
    // A concurrent replay may have waited on either lock above.
    const replay = await tx.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId: input.sessionId, localId } } });
    if (replay) return { ok: true as const, value: { idempotent: true, message: replay } };
    const updated = await tx.session.updateMany({ where: { id: input.sessionId, accountId, active: true, seq: input.expectedSeq }, data: { seq: { increment: 1 }, lastActiveAt: now } });
    if (updated.count !== 1) return denied('session-changed');
    const message = await tx.sessionMessage.create({ data: { sessionId: input.sessionId, localId, seq: input.expectedSeq + 1, content: { t: 'encrypted', c: input.contentCiphertext } } });
    return { ok: true as const, value: { idempotent: false, message } };
}
