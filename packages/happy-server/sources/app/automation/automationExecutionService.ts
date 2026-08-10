import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type AutomationRunOutcome, type Prisma as PrismaTypes } from '@prisma/client';

type Tx = PrismaTypes.TransactionClient;
type Binary = Uint8Array<ArrayBuffer>;

export type AutomationExecutionError =
    | 'key-version-conflict'
    | 'sync-failed'
    | 'claim-denied'
    | 'already-claimed'
    | 'claim-not-found'
    | 'claim-cancelled'
    | 'claim-expired'
    | 'run-not-running'
    | 'report-conflict';

type Result<T> = { ok: true; value: T } | { ok: false; error: AutomationExecutionError };

function tokenHash(token: string): Binary {
    return new Uint8Array(createHash('sha256').update(token).digest());
}

export async function registerAutomationMachineKey(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: { expectedKeyVersion: number; publicKey: Binary },
): Promise<Result<{ keyVersion: number }>> {
    const changed = await tx.machine.updateMany({
        where: { id: machineId, accountId, automationKeyVersion: input.expectedKeyVersion },
        data: { automationPublicKey: input.publicKey, automationKeyVersion: { increment: 1 } },
    });
    if (changed.count === 0) return { ok: false, error: 'key-version-conflict' };
    return { ok: true, value: { keyVersion: input.expectedKeyVersion + 1 } };
}

export async function syncAutomations(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: { afterSeq: bigint; limit: number },
    now: Date = new Date(),
): Promise<Result<{ serverTime: Date; nextSeq: bigint; changes: Array<Record<string, unknown>> }>> {
    const rows = await tx.automationChange.findMany({
        where: { machineAccountId: accountId, machineId, seq: { gt: input.afterSeq } },
        orderBy: { seq: 'asc' },
        take: input.limit,
    });
    const changes: Array<Record<string, unknown>> = [];
    for (const change of rows) {
        if (change.kind === 'TOMBSTONE') {
            changes.push({ seq: change.seq, automationId: change.automationId, revision: change.revision, generation: change.generation, kind: 'TOMBSTONE' });
            continue;
        }
        const automation = await tx.automation.findFirst({
            where: {
                id: change.automationId,
                machineAccountId: accountId,
                machineId,
                deletedAt: null,
                revision: { gte: change.revision },
            },
        });
        if (!automation) {
            changes.push({ seq: change.seq, automationId: change.automationId, revision: change.revision, generation: change.generation, kind: 'TOMBSTONE' });
            continue;
        }
        changes.push({
            seq: change.seq,
            automationId: automation.id,
            revision: automation.revision,
            generation: automation.generation,
            kind: 'UPSERT',
            payloadVersion: automation.payloadVersion,
            payloadCiphertext: automation.payloadCiphertext,
            machineKeyVersion: automation.machineKeyVersion,
            machineKeyEnvelope: automation.machineKeyEnvelope,
            paused: automation.paused,
            enabledAt: automation.enabledAt,
        });
    }
    return {
        ok: true,
        value: {
            serverTime: now,
            nextSeq: rows.length > 0 ? rows[rows.length - 1]!.seq : input.afterSeq,
            changes,
        },
    };
}

export async function ackAutomationSync(
    tx: Tx,
    accountId: string,
    machineId: string,
    items: Array<{ automationId: string; revision: number }>,
    now: Date = new Date(),
): Promise<Result<{ acknowledged: number }>> {
    let acknowledged = 0;
    for (const item of items) {
        const changed = await tx.automation.updateMany({
            where: {
                id: item.automationId,
                machineAccountId: accountId,
                machineId,
                revision: item.revision,
                appliedRevision: { lt: item.revision },
            },
            data: { appliedRevision: item.revision, appliedAt: now },
        });
        acknowledged += changed.count;
    }
    return { ok: true, value: { acknowledged } };
}

function executable(automation: any, accountId: string, machineId: string, generation: number): boolean {
    return automation
        && automation.machineAccountId === accountId
        && automation.machineId === machineId
        && automation.generation === generation
        && !automation.paused
        && !automation.deletedAt
        && automation.machineKeyVersion === automation.targetMachine?.automationKeyVersion
        && automation.viewerKeyVersion === automation.project?.automationViewerKeyVersion;
}

export async function claimAutomationRun(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: { automationId: string; generation: number; scheduledFor: Date },
    now: Date = new Date(),
): Promise<Result<{ runId: string; claimToken: string; claimExpiresAt: Date; serverTime: Date }>> {
    if (input.scheduledFor.getTime() < now.getTime() - 90_000 || input.scheduledFor.getTime() > now.getTime() + 15_000) {
        return { ok: false, error: 'claim-denied' };
    }
    const automation = await tx.automation.findFirst({
        where: { id: input.automationId, machineAccountId: accountId, machineId, deletedAt: null },
        include: {
            project: { select: { automationViewerKeyVersion: true } },
            targetMachine: { select: { automationKeyVersion: true } },
        },
    });
    if (!automation || !executable(automation, accountId, machineId, input.generation)
        || input.scheduledFor < automation.enabledAt) {
        return { ok: false, error: 'claim-denied' };
    }

    await tx.automationRun.updateMany({
        where: { automationId: input.automationId, status: 'CLAIMED', claimExpiresAt: { lt: now } },
        data: { status: 'EXPIRED', completedAt: now },
    });
    await tx.automationRun.updateMany({
        where: { automationId: input.automationId, status: 'RUNNING', runLeaseExpiresAt: { lt: now } },
        data: { status: 'ABANDONED', completedAt: now },
    });

    const claimToken = randomBytes(32).toString('base64url');
    const claimExpiresAt = new Date(now.getTime() + 2 * 60_000);
    try {
        const run = await tx.automationRun.create({
            data: {
                automationId: automation.id,
                generation: input.generation,
                scheduledFor: input.scheduledFor,
                machineAccountId: accountId,
                machineId,
                status: 'CLAIMED',
                claimTokenHash: tokenHash(claimToken),
                claimExpiresAt,
            },
        });
        return { ok: true, value: { runId: run.id, claimToken, claimExpiresAt, serverTime: now } };
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return { ok: false, error: 'already-claimed' };
        }
        throw error;
    }
}

async function claimedRun(tx: Tx, accountId: string, machineId: string, runId: string, claimToken: string) {
    return tx.automationRun.findFirst({
        where: { id: runId, machineAccountId: accountId, machineId, claimTokenHash: tokenHash(claimToken) },
        include: {
            automation: {
                include: {
                    project: { select: { automationViewerKeyVersion: true } },
                    targetMachine: { select: { automationKeyVersion: true } },
                },
            },
        },
    });
}

export async function startAutomationRun(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: { runId: string; claimToken: string },
    now: Date = new Date(),
): Promise<Result<{ runLeaseExpiresAt: Date }>> {
    const run = await claimedRun(tx, accountId, machineId, input.runId, input.claimToken);
    if (!run) return { ok: false, error: 'claim-not-found' };
    if (run.status !== 'CLAIMED') return { ok: false, error: 'claim-cancelled' };
    if (run.claimExpiresAt < now) {
        await tx.automationRun.updateMany({ where: { id: run.id, status: 'CLAIMED' }, data: { status: 'EXPIRED', completedAt: now } });
        return { ok: false, error: 'claim-expired' };
    }
    if (!executable(run.automation, accountId, machineId, run.generation)) {
        await tx.automationRun.updateMany({ where: { id: run.id, status: 'CLAIMED' }, data: { status: 'CANCELLED', completedAt: now } });
        return { ok: false, error: 'claim-cancelled' };
    }
    const runLeaseExpiresAt = new Date(now.getTime() + 5 * 60_000);
    const changed = await tx.automationRun.updateMany({
        where: { id: run.id, status: 'CLAIMED' },
        data: { status: 'RUNNING', startedAt: now, runLeaseExpiresAt },
    });
    return changed.count === 1
        ? { ok: true, value: { runLeaseExpiresAt } }
        : { ok: false, error: 'claim-cancelled' };
}

export async function heartbeatAutomationRun(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: { runId: string; claimToken: string },
    now: Date = new Date(),
): Promise<Result<{ runLeaseExpiresAt: Date }>> {
    const runLeaseExpiresAt = new Date(now.getTime() + 5 * 60_000);
    const changed = await tx.automationRun.updateMany({
        where: {
            id: input.runId,
            machineAccountId: accountId,
            machineId,
            claimTokenHash: tokenHash(input.claimToken),
            status: 'RUNNING',
            runLeaseExpiresAt: { gte: now },
        },
        data: { runLeaseExpiresAt },
    });
    return changed.count === 1
        ? { ok: true, value: { runLeaseExpiresAt } }
        : { ok: false, error: 'run-not-running' };
}

export async function reportAutomationRun(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: {
        runId: string;
        claimToken: string;
        reportId: string;
        status: 'COMPLETED' | 'FAILED';
        outcome: AutomationRunOutcome;
        sessionId: string | null;
        detailCiphertext: Binary | null;
    },
    now: Date = new Date(),
): Promise<Result<{ idempotent: boolean; status: string; outcome: AutomationRunOutcome | null }>> {
    const run = await claimedRun(tx, accountId, machineId, input.runId, input.claimToken);
    if (!run) return { ok: false, error: 'claim-not-found' };
    if (run.reportId) {
        return run.reportId === input.reportId
            ? { ok: true, value: { idempotent: true, status: run.status, outcome: run.outcome } }
            : { ok: false, error: 'report-conflict' };
    }
    if (run.status !== 'RUNNING' && run.status !== 'ABANDONED') {
        return { ok: false, error: 'run-not-running' };
    }
    if ((input.status === 'FAILED') !== (input.outcome === 'ERROR')) {
        return { ok: false, error: 'report-conflict' };
    }
    if (input.sessionId) {
        const session = await tx.session.findFirst({
            where: { id: input.sessionId, accountId },
            select: { id: true },
        });
        if (!session) return { ok: false, error: 'report-conflict' };
    }
    let changed;
    try {
        changed = await tx.automationRun.updateMany({
            where: { id: run.id, reportId: null, status: { in: ['RUNNING', 'ABANDONED'] } },
            data: {
                reportId: input.reportId,
                status: input.status,
                outcome: input.outcome,
                sessionId: input.sessionId,
                detailCiphertext: input.detailCiphertext,
                completedAt: now,
                lateReport: run.status === 'ABANDONED'
                    || (run.runLeaseExpiresAt !== null && run.runLeaseExpiresAt < now),
            },
        });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return { ok: false, error: 'report-conflict' };
        }
        throw error;
    }
    return changed.count === 1
        ? { ok: true, value: { idempotent: false, status: input.status, outcome: input.outcome } }
        : { ok: false, error: 'report-conflict' };
}
