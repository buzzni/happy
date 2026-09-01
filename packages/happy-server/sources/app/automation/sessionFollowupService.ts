import { Prisma } from '@prisma/client';
import { AUTOMATION_SESSION_FOLLOWUP_PROTOCOL_VERSION } from '@slopus/happy-wire';

type Binary = Uint8Array<ArrayBuffer>;
type Tx = any;

export type SessionFollowupServiceError =
    | 'not-found'
    | 'forbidden'
    | 'revision-conflict'
    | 'invalid-rounds'
    | 'invalid-boundary'
    | 'automation-target-unavailable'
    | 'session-followup-unsupported'
    | 'session-target-mismatch'
    | 'viewer-key-version-conflict'
    | 'machine-key-version-conflict'
    | 'active-followup-exists'
    | 'invalid-state';

type Result<T> = { ok: true; value: T } | { ok: false; error: SessionFollowupServiceError; latest?: any };

export interface SessionFollowupCreateInput {
    sessionId: string;
    totalRounds: number;
    currentRound: number;
    responseBoundarySeq: number;
    payloadVersion: 1;
    payloadCiphertext: Binary;
    viewerKeyId: string;
    viewerKeyVersion: number;
    viewerKeyEnvelope: Binary;
    machineKeyVersion: number;
    machineKeyEnvelope: Binary;
}

async function access(tx: Tx, actorId: string, projectId: string) {
    const project = await tx.project.findUnique({
        where: { id: projectId },
        select: {
            id: true, accountId: true, config: true,
            automationViewerKeyVersion: true,
        },
    });
    if (!project) return null;
    if (project.accountId === actorId) return { project, canEdit: true };
    const member = await tx.projectMember.findUnique({
        where: { projectId_accountId: { projectId, accountId: actorId } },
        select: { role: true, status: true },
    });
    if (!member || member.status !== 'accepted') return null;
    return { project, canEdit: member.role === 'owner' || member.role === 'editor' };
}

async function target(tx: Tx, project: any) {
    const machineId = project.config && typeof project.config === 'object'
        && typeof project.config.machineId === 'string'
        ? project.config.machineId
        : null;
    if (!machineId) return null;
    return tx.machine.findUnique({
        where: { accountId_id: { accountId: project.accountId, id: machineId } },
        select: {
            id: true, accountId: true, automationKeyVersion: true,
            automationProtocolVersion: true,
        },
    });
}

async function writeChange(tx: Tx, row: any, kind: 'UPSERT' | 'TOMBSTONE') {
    await tx.sessionFollowupChange.create({ data: {
        followupId: row.id,
        machineAccountId: row.machineAccountId,
        machineId: row.machineId,
        revision: row.revision,
        generation: row.generation,
        kind,
    } });
}

async function writeHistory(
    tx: Tx,
    row: any,
    kind: 'STARTED' | 'PAUSED' | 'RESUMED' | 'STOPPED' | 'DELETED',
) {
    await tx.sessionFollowupHistory.create({ data: {
        followupId: row.id,
        generation: row.generation,
        step: row.step,
        round: row.currentRound,
        kind,
        terminalCode: kind === 'STOPPED'
            ? 'STOPPED'
            : kind === 'DELETED'
                ? row.terminalCode ?? 'STOPPED'
                : null,
        observedSeq: row.lastObservedSeq,
        detailCiphertext: null,
    } });
}

export async function createSessionFollowup(
    tx: Tx,
    actorId: string,
    projectId: string,
    input: SessionFollowupCreateInput,
): Promise<Result<any>> {
    if (!Number.isInteger(input.totalRounds) || input.totalRounds < 2 || input.totalRounds > 7
        || !Number.isInteger(input.currentRound) || input.currentRound < 1 || input.currentRound > input.totalRounds) {
        return { ok: false, error: 'invalid-rounds' };
    }
    if (!Number.isInteger(input.responseBoundarySeq) || input.responseBoundarySeq < 0) {
        return { ok: false, error: 'invalid-boundary' };
    }
    const projectAccess = await access(tx, actorId, projectId);
    if (!projectAccess) return { ok: false, error: 'not-found' };
    if (!projectAccess.canEdit) return { ok: false, error: 'forbidden' };
    if (!projectAccess.project.config || typeof projectAccess.project.config !== 'object'
        || typeof projectAccess.project.config.workspaceDir !== 'string'
        || projectAccess.project.config.workspaceDir.length === 0) {
        return { ok: false, error: 'automation-target-unavailable' };
    }
    const machine = await target(tx, projectAccess.project);
    if (!machine) return { ok: false, error: 'automation-target-unavailable' };
    if (machine.automationProtocolVersion < AUTOMATION_SESSION_FOLLOWUP_PROTOCOL_VERSION) {
        return { ok: false, error: 'session-followup-unsupported' };
    }
    if (input.viewerKeyVersion !== projectAccess.project.automationViewerKeyVersion) {
        return { ok: false, error: 'viewer-key-version-conflict' };
    }
    if (input.machineKeyVersion !== machine.automationKeyVersion) {
        return { ok: false, error: 'machine-key-version-conflict' };
    }
    const session = await tx.session.findFirst({
        where: { id: input.sessionId, accountId: machine.accountId, active: true },
        select: { id: true, accountId: true, seq: true, active: true },
    });
    if (!session || input.responseBoundarySeq > session.seq) {
        return { ok: false, error: 'session-target-mismatch' };
    }
    const activeCount = await tx.sessionFollowup.count({
        where: {
            sessionId: input.sessionId,
            deletedAt: null,
            status: { in: ['WAITING', 'DELIVERY_PENDING', 'PAUSED'] },
        },
    });
    if (activeCount > 0) return { ok: false, error: 'active-followup-exists' };

    let row;
    try {
        row = await tx.sessionFollowup.create({ data: {
            projectId,
            ownerAccountId: actorId,
            machineAccountId: machine.accountId,
            machineId: machine.id,
            sessionId: input.sessionId,
            payloadVersion: input.payloadVersion,
            payloadCiphertext: input.payloadCiphertext,
            viewerKeyId: input.viewerKeyId,
            viewerKeyVersion: input.viewerKeyVersion,
            viewerKeyEnvelope: input.viewerKeyEnvelope,
            machineKeyVersion: input.machineKeyVersion,
            machineKeyEnvelope: input.machineKeyEnvelope,
            totalRounds: input.totalRounds,
            currentRound: input.currentRound,
            responseBoundarySeq: input.responseBoundarySeq,
            lastObservedSeq: input.responseBoundarySeq,
        } });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return { ok: false, error: 'active-followup-exists' };
        }
        throw error;
    }
    await writeChange(tx, row, 'UPSERT');
    await writeHistory(tx, row, 'STARTED');
    return { ok: true, value: row };
}

async function findEditable(tx: Tx, actorId: string, projectId: string, followupId: string) {
    const projectAccess = await access(tx, actorId, projectId);
    if (!projectAccess) return { error: 'not-found' as const };
    if (!projectAccess.canEdit) return { error: 'forbidden' as const };
    const row = await tx.sessionFollowup.findFirst({
        where: { id: followupId, projectId, deletedAt: null },
    });
    return row ? { row } : { error: 'not-found' as const };
}

async function mutate(
    tx: Tx,
    actorId: string,
    projectId: string,
    followupId: string,
    expectedRevision: number,
    operation: 'pause' | 'resume' | 'stop' | 'delete',
    now: Date,
): Promise<Result<any>> {
    const found = await findEditable(tx, actorId, projectId, followupId);
    if ('error' in found) return { ok: false, error: found.error ?? 'not-found' };
    const row = found.row;
    if (row.revision !== expectedRevision) {
        return { ok: false, error: 'revision-conflict', latest: row };
    }
    const activeStatuses = ['WAITING', 'DELIVERY_PENDING', 'PAUSED'];
    const active = activeStatuses.includes(row.status);
    const allowed = operation === 'pause'
        ? ['WAITING', 'DELIVERY_PENDING'].includes(row.status)
        : operation === 'resume'
            ? row.status === 'PAUSED'
            : operation === 'delete'
                ? true
                : active;
    if (!allowed) return { ok: false, error: 'invalid-state', latest: row };
    const nextStatus = operation === 'pause'
        ? 'PAUSED'
        : operation === 'resume'
            ? row.pendingLocalId ? 'DELIVERY_PENDING' : 'WAITING'
            : 'CANCELLED';
    const data: Record<string, unknown> = {
        revision: { increment: 1 },
        generation: { increment: 1 },
        claimTokenHash: null,
        claimExpiresAt: null,
        claimedGeneration: null,
        claimedStep: null,
    };
    if (operation === 'resume' && row.pendingLocalId) {
        // Pause/resume increments generation. Re-key the durable delivery ID
        // to that generation so an ACK-loss retry satisfies the same
        // idempotency invariant as an uninterrupted delivery.
        data.pendingLocalId = `happy-followup:${row.id}:${row.generation + 1}:${row.currentRound + 1}`;
    }
    if (operation !== 'delete' || active) data.status = nextStatus;
    if (operation === 'stop' || (operation === 'delete' && active)) {
        data.terminalCode = 'STOPPED';
        data.completedAt = now;
    }
    if (operation === 'stop' || operation === 'delete') {
        data.pendingExpectedSeq = null;
        data.pendingLocalId = null;
    }
    if (operation === 'delete') data.deletedAt = now;
    const changed = await tx.sessionFollowup.updateMany({
        where: {
            id: followupId,
            projectId,
            revision: expectedRevision,
            ...(operation === 'pause'
                ? { status: { in: ['WAITING', 'DELIVERY_PENDING'] } }
                : operation === 'resume'
                    ? { status: 'PAUSED' }
                    : operation === 'stop'
                        ? { status: { in: activeStatuses } }
                        : {}),
            deletedAt: null,
        },
        data,
    });
    if (changed.count !== 1) {
        const latest = await tx.sessionFollowup.findFirst({ where: { id: followupId, projectId } });
        return { ok: false, error: 'revision-conflict', ...(latest ? { latest } : {}) };
    }
    const updated = await tx.sessionFollowup.findUnique({ where: { id: followupId } });
    await writeChange(tx, updated, operation === 'delete' ? 'TOMBSTONE' : 'UPSERT');
    await writeHistory(tx, updated, operation === 'pause' ? 'PAUSED' : operation === 'resume' ? 'RESUMED' : operation === 'stop' ? 'STOPPED' : 'DELETED');
    return { ok: true, value: updated };
}

export const pauseSessionFollowup = (
    tx: Tx, actorId: string, projectId: string, followupId: string, expectedRevision: number, now = new Date(),
) => mutate(tx, actorId, projectId, followupId, expectedRevision, 'pause', now);

export const resumeSessionFollowup = (
    tx: Tx, actorId: string, projectId: string, followupId: string, expectedRevision: number, now = new Date(),
) => mutate(tx, actorId, projectId, followupId, expectedRevision, 'resume', now);

export const stopSessionFollowup = (
    tx: Tx, actorId: string, projectId: string, followupId: string, expectedRevision: number, now = new Date(),
) => mutate(tx, actorId, projectId, followupId, expectedRevision, 'stop', now);

export const deleteSessionFollowup = (
    tx: Tx, actorId: string, projectId: string, followupId: string, expectedRevision: number, now = new Date(),
) => mutate(tx, actorId, projectId, followupId, expectedRevision, 'delete', now);

export async function getSessionFollowup(tx: Tx, actorId: string, projectId: string, followupId: string): Promise<Result<any>> {
    const projectAccess = await access(tx, actorId, projectId);
    if (!projectAccess) return { ok: false, error: 'not-found' };
    const row = await tx.sessionFollowup.findFirst({ where: { id: followupId, projectId, deletedAt: null } });
    return row ? { ok: true, value: row } : { ok: false, error: 'not-found' };
}

export async function listSessionFollowups(
    tx: Tx,
    actorId: string,
    projectId: string,
    input: { sessionId?: string; limit: number },
): Promise<Result<any[]>> {
    const projectAccess = await access(tx, actorId, projectId);
    if (!projectAccess) return { ok: false, error: 'not-found' };
    return { ok: true, value: await tx.sessionFollowup.findMany({
        where: { projectId, deletedAt: null, ...(input.sessionId ? { sessionId: input.sessionId } : {}) },
        orderBy: { updatedAt: 'desc' },
        take: input.limit,
    }) };
}

export async function listSessionFollowupHistory(
    tx: Tx,
    actorId: string,
    projectId: string,
    followupId: string,
    limit: number,
): Promise<Result<any[]>> {
    const projectAccess = await access(tx, actorId, projectId);
    if (!projectAccess) return { ok: false, error: 'not-found' };
    const row = await tx.sessionFollowup.findFirst({ where: { id: followupId, projectId }, select: { id: true } });
    if (!row) return { ok: false, error: 'not-found' };
    return { ok: true, value: await tx.sessionFollowupHistory.findMany({
        where: { followupId }, orderBy: { createdAt: 'desc' }, take: limit,
    }) };
}
