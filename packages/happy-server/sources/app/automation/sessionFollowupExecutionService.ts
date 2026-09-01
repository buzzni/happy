import { createHash, randomBytes } from 'node:crypto';
import {
    invalidateSessionFollowups,
    type SessionFollowupInvalidationCode,
} from './sessionFollowupInvalidationService';

type Tx = any;
type Binary = Uint8Array<ArrayBuffer>;

export type SessionFollowupExecutionError =
    | 'claim-denied'
    | 'already-claimed'
    | 'claim-not-found'
    | 'report-conflict'
    | 'rounds-exhausted';

type Result<T> = { ok: true; value: T } | { ok: false; error: SessionFollowupExecutionError };

const daemonProjectInclude = {
    project: { select: { config: true } },
} as const;

function tokenHash(token: string): Binary {
    return new Uint8Array(createHash('sha256').update(token).digest());
}

function executable(row: any, accountId: string, machineId: string, generation: number, step: number): boolean {
    return row
        && row.machineAccountId === accountId
        && row.machineId === machineId
        && row.generation === generation
        && row.step === step
        && ['WAITING', 'DELIVERY_PENDING'].includes(row.status)
        && !row.deletedAt;
}

async function authorityDenial(tx: Tx, row: any): Promise<SessionFollowupInvalidationCode | null> {
    const configuredMachineId = row?.project?.config && typeof row.project.config === 'object'
        && typeof row.project.config.machineId === 'string'
        ? row.project.config.machineId
        : null;
    const targetMachine = await tx.machine.findUnique({
        where: { accountId_id: { accountId: row.machineAccountId, id: row.machineId } },
        select: { automationKeyVersion: true },
    });
    if (row.project?.accountId !== row.machineAccountId
        || configuredMachineId !== row.machineId
        || row.machineKeyVersion !== targetMachine?.automationKeyVersion
        || row.viewerKeyVersion !== row.project?.automationViewerKeyVersion) {
        return 'TARGET_MISMATCH';
    }
    if (row.ownerAccountId === row.project.accountId) return null;
    const member = await tx.projectMember.findUnique({
        where: { projectId_accountId: { projectId: row.projectId, accountId: row.ownerAccountId } },
        select: { role: true, status: true },
    });
    return member?.status === 'accepted' && (member.role === 'owner' || member.role === 'editor')
        ? null
        : 'PERMISSION_REVOKED';
}

async function invalidateDenied(tx: Tx, row: any, code: SessionFollowupInvalidationCode, now: Date) {
    const [updated] = await invalidateSessionFollowups(tx, { followupId: row.id }, code, now);
    return updated ?? row;
}

function daemonView(row: any) {
    const projectWorkspaceDir = row.project?.config && typeof row.project.config === 'object'
        && typeof row.project.config.workspaceDir === 'string'
        ? row.project.config.workspaceDir
        : null;
    return {
        id: row.id,
        projectId: row.projectId,
        projectWorkspaceDir,
        sessionId: row.sessionId,
        machineAccountId: row.machineAccountId,
        machineId: row.machineId,
        revision: row.revision,
        generation: row.generation,
        step: row.step,
        status: row.status,
        totalRounds: row.totalRounds,
        currentRound: row.currentRound,
        responseBoundarySeq: row.responseBoundarySeq,
        lastObservedSeq: row.lastObservedSeq,
        pendingExpectedSeq: row.pendingExpectedSeq,
        pendingLocalId: row.pendingLocalId,
        payloadVersion: row.payloadVersion,
        payloadCiphertext: row.payloadCiphertext,
        machineKeyVersion: row.machineKeyVersion,
        machineKeyEnvelope: row.machineKeyEnvelope,
    };
}

export async function syncSessionFollowups(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: { afterSeq: bigint; limit: number },
    now = new Date(),
): Promise<Result<{ serverTime: Date; nextSeq: bigint; hasMore: boolean; changes: any[] }>> {
    const fetched = await tx.sessionFollowupChange.findMany({
        where: { machineAccountId: accountId, machineId, seq: { gt: input.afterSeq } },
        orderBy: { seq: 'asc' },
        take: input.limit + 1,
    });
    const hasMore = fetched.length > input.limit;
    const rows = hasMore ? fetched.slice(0, input.limit) : fetched;
    const changes: any[] = [];
    for (const change of rows) {
        if (change.kind === 'TOMBSTONE') {
            changes.push({
                seq: change.seq, followupId: change.followupId, revision: change.revision,
                generation: change.generation, kind: 'TOMBSTONE',
            });
            continue;
        }
        const row = await tx.sessionFollowup.findFirst({
            where: {
                id: change.followupId, machineAccountId: accountId, machineId,
                deletedAt: null, revision: { gte: change.revision },
            },
            include: daemonProjectInclude,
        });
        if (!row || !['WAITING', 'DELIVERY_PENDING'].includes(row.status)) {
            changes.push({
                seq: change.seq,
                followupId: change.followupId,
                revision: row?.revision ?? change.revision,
                generation: row?.generation ?? change.generation,
                kind: 'TOMBSTONE',
            });
            continue;
        }
        changes.push({ seq: change.seq, followupId: row.id, kind: 'UPSERT', ...daemonView(row) });
    }
    return {
        ok: true,
        value: {
            serverTime: now,
            nextSeq: rows.length > 0 ? rows[rows.length - 1]!.seq : input.afterSeq,
            hasMore,
            changes,
        },
    };
}

export async function claimSessionFollowup(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: { followupId: string; generation: number; step: number },
    now = new Date(),
): Promise<Result<{ claimToken: string; claimExpiresAt: Date; followup: ReturnType<typeof daemonView> }>> {
    const row = await tx.sessionFollowup.findFirst({
        where: { id: input.followupId, machineAccountId: accountId, machineId, deletedAt: null },
        include: {
            project: { select: { accountId: true, automationViewerKeyVersion: true, config: true } },
        },
    });
    if (!executable(row, accountId, machineId, input.generation, input.step)) {
        return { ok: false, error: 'claim-denied' };
    }
    const denial = await authorityDenial(tx, row);
    if (denial) {
        await invalidateDenied(tx, row, denial, now);
        return { ok: false, error: 'claim-denied' };
    }
    const claimToken = randomBytes(32).toString('base64url');
    const claimExpiresAt = new Date(now.getTime() + 90_000);
    const changed = await tx.sessionFollowup.updateMany({
        where: {
            id: input.followupId,
            machineAccountId: accountId,
            machineId,
            generation: input.generation,
            step: input.step,
            status: { in: ['WAITING', 'DELIVERY_PENDING'] },
            deletedAt: null,
            OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: now } }],
        },
        data: {
            claimTokenHash: tokenHash(claimToken),
            claimExpiresAt,
            claimedGeneration: input.generation,
            claimedStep: input.step,
        },
    });
    if (changed.count !== 1) return { ok: false, error: 'already-claimed' };
    return { ok: true, value: { claimToken, claimExpiresAt, followup: daemonView(row) } };
}

async function claimed(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: { followupId: string; generation: number; step: number; claimToken: string },
    now: Date,
) {
    return tx.sessionFollowup.findFirst({
        where: {
            id: input.followupId,
            machineAccountId: accountId,
            machineId,
            generation: input.generation,
            step: input.step,
            claimTokenHash: tokenHash(input.claimToken),
            claimExpiresAt: { gte: now },
            claimedGeneration: input.generation,
            claimedStep: input.step,
            deletedAt: null,
        },
        include: {
            project: { select: { accountId: true, automationViewerKeyVersion: true, config: true } },
        },
    });
}

async function writeChange(tx: Tx, row: any) {
    await tx.sessionFollowupChange.create({ data: {
        followupId: row.id,
        machineAccountId: row.machineAccountId,
        machineId: row.machineId,
        revision: row.revision,
        generation: row.generation,
        kind: 'UPSERT',
    } });
}

async function history(tx: Tx, row: any, input: {
    kind: 'CONTINUATION_RESERVED' | 'CONTINUATION_DELIVERED' | 'TERMINATED';
    round: number;
    terminalCode?: string | null;
    observedSeq: number;
}) {
    await tx.sessionFollowupHistory.create({ data: {
        followupId: row.id,
        generation: row.generation,
        step: row.step,
        round: input.round,
        kind: input.kind,
        terminalCode: input.terminalCode ?? null,
        observedSeq: input.observedSeq,
        detailCiphertext: null,
    } });
}

export async function reportSessionFollowupEvaluation(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: {
        followupId: string;
        generation: number;
        step: number;
        claimToken: string;
        decision: 'WAIT' | 'CONTINUE' | 'TERMINATE';
        observedSeq: number;
        terminalCode?: 'CLEAN' | 'LOW_OR_NIT_ONLY' | 'UNSTRUCTURED' | 'ROUNDS_EXHAUSTED' | 'USER_INTERVENTION' | 'SESSION_UNAVAILABLE' | 'TARGET_MISMATCH' | 'DECRYPT_FAILED' | 'PERMISSION_REVOKED';
    },
    now = new Date(),
): Promise<Result<any>> {
    const row = await claimed(tx, accountId, machineId, input, now);
    if (!row) return { ok: false, error: 'claim-not-found' };
    const denial = await authorityDenial(tx, row);
    if (denial) {
        const updated = await invalidateDenied(tx, row, denial, now);
        return { ok: true, value: daemonView(updated) };
    }
    if (!['WAITING', 'DELIVERY_PENDING'].includes(row.status)
        || (row.status === 'DELIVERY_PENDING' && input.decision !== 'TERMINATE')) {
        return { ok: false, error: 'report-conflict' };
    }
    if (input.decision === 'CONTINUE' && row.currentRound >= row.totalRounds) {
        return { ok: false, error: 'rounds-exhausted' };
    }
    if (input.decision === 'TERMINATE' && !input.terminalCode) {
        return { ok: false, error: 'report-conflict' };
    }
    const clearClaim = {
        claimTokenHash: null,
        claimExpiresAt: null,
        claimedGeneration: null,
        claimedStep: null,
    };
    if (input.decision === 'WAIT') {
        const changed = await tx.sessionFollowup.updateMany({
            where: {
                id: row.id, generation: input.generation, step: input.step,
                claimTokenHash: tokenHash(input.claimToken), status: 'WAITING', deletedAt: null,
            },
            data: { lastObservedSeq: input.observedSeq, ...clearClaim },
        });
        return changed.count === 1
            ? { ok: true, value: daemonView({
                ...row, lastObservedSeq: input.observedSeq, ...clearClaim,
            }) }
            : { ok: false, error: 'report-conflict' };
    }
    if (input.decision === 'CONTINUE') {
        const pendingLocalId = `happy-followup:${row.id}:${row.generation}:${row.currentRound + 1}`;
        const changed = await tx.sessionFollowup.updateMany({
            where: {
                id: row.id, generation: input.generation, step: input.step,
                claimTokenHash: tokenHash(input.claimToken), status: 'WAITING', deletedAt: null,
            },
            data: {
                status: 'DELIVERY_PENDING',
                pendingExpectedSeq: input.observedSeq,
                pendingLocalId,
                lastObservedSeq: input.observedSeq,
                revision: { increment: 1 },
                step: { increment: 1 },
                ...clearClaim,
            },
        });
        if (changed.count !== 1) return { ok: false, error: 'report-conflict' };
        const updated = await tx.sessionFollowup.findUnique({
            where: { id: row.id }, include: daemonProjectInclude,
        });
        await writeChange(tx, updated);
        await history(tx, updated, {
            kind: 'CONTINUATION_RESERVED', round: row.currentRound, observedSeq: input.observedSeq,
        });
        return { ok: true, value: daemonView(updated) };
    }

    const failed = ['UNSTRUCTURED', 'SESSION_UNAVAILABLE', 'TARGET_MISMATCH', 'DECRYPT_FAILED', 'PERMISSION_REVOKED']
        .includes(input.terminalCode!);
    const changed = await tx.sessionFollowup.updateMany({
        where: {
            id: row.id, generation: input.generation, step: input.step,
            claimTokenHash: tokenHash(input.claimToken), status: row.status, deletedAt: null,
        },
        data: {
            status: failed ? 'FAILED' : 'COMPLETED',
            terminalCode: input.terminalCode,
            lastObservedSeq: input.observedSeq,
            completedAt: now,
            pendingExpectedSeq: null,
            pendingLocalId: null,
            revision: { increment: 1 },
            step: { increment: 1 },
            ...clearClaim,
        },
    });
    if (changed.count !== 1) return { ok: false, error: 'report-conflict' };
    const updated = await tx.sessionFollowup.findUnique({
        where: { id: row.id }, include: daemonProjectInclude,
    });
    await writeChange(tx, updated);
    await history(tx, updated, {
        kind: 'TERMINATED', round: row.currentRound,
        terminalCode: input.terminalCode, observedSeq: input.observedSeq,
    });
    return { ok: true, value: daemonView(updated) };
}

export async function deliverSessionFollowupMessage(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: {
        followupId: string;
        generation: number;
        step: number;
        claimToken: string;
        expectedSeq: number;
        localId: string;
        contentCiphertext: string;
    },
    now = new Date(),
): Promise<Result<{
    idempotent: boolean;
    messageSeq: number | null;
    deliveredMessage: {
        id: string;
        localId: string | null;
        createdAt: Date;
        updatedAt: Date;
    } | null;
    followup: any;
}>> {
    const target = await tx.sessionFollowup.findFirst({
        where: {
            id: input.followupId,
            machineAccountId: accountId,
            machineId,
            deletedAt: null,
        },
    });
    if (!target) return { ok: false, error: 'claim-not-found' };
    const existing = await tx.sessionMessage.findFirst({
        where: { sessionId: target.sessionId, localId: input.localId },
        select: { id: true, sessionId: true, seq: true, localId: true },
    });
    if (existing) {
        const row = await tx.sessionFollowup.findUnique({
            where: { id: input.followupId }, include: daemonProjectInclude,
        });
        const expectedLocalId = row
            ? `happy-followup:${row.id}:${input.generation}:${row.currentRound}`
            : null;
        if (!row
            || existing.sessionId !== row.sessionId
            || row.machineAccountId !== accountId
            || row.machineId !== machineId
            || row.generation !== input.generation
            || row.step !== input.step + 1
            || input.localId !== expectedLocalId
            || existing.seq !== row.responseBoundarySeq
            || existing.seq !== input.expectedSeq + 1) {
            return { ok: false, error: 'claim-not-found' };
        }
        return {
            ok: true,
            value: {
                idempotent: true,
                messageSeq: existing.seq,
                deliveredMessage: null,
                followup: daemonView(row),
            },
        };
    }
    const row = await claimed(tx, accountId, machineId, input, now);
    if (!row
        || row.status !== 'DELIVERY_PENDING'
        || row.pendingExpectedSeq !== input.expectedSeq
        || row.pendingLocalId !== input.localId
        || row.currentRound >= row.totalRounds) {
        return { ok: false, error: 'claim-not-found' };
    }
    const denial = await authorityDenial(tx, row);
    if (denial) {
        const updated = await invalidateDenied(tx, row, denial, now);
        return {
            ok: true,
            value: {
                idempotent: false,
                messageSeq: null,
                deliveredMessage: null,
                followup: daemonView(updated),
            },
        };
    }
    // Acquire the follow-up row lock with the full claim/generation fence
    // before incrementing Session.seq or inserting the prompt. Returning a
    // conflict after those writes would otherwise commit them when a
    // concurrent pause/stop/delete had already won the follow-up CAS.
    const deliveryFence = await tx.sessionFollowup.updateMany({
        where: {
            id: row.id,
            generation: input.generation,
            step: input.step,
            claimTokenHash: tokenHash(input.claimToken),
            status: 'DELIVERY_PENDING',
            pendingExpectedSeq: input.expectedSeq,
            pendingLocalId: input.localId,
            deletedAt: null,
        },
        // A no-op update still obtains the database row lock. Keep all
        // externally visible state unchanged until the Session.seq fence wins.
        data: { claimExpiresAt: row.claimExpiresAt },
    });
    if (deliveryFence.count !== 1) return { ok: false, error: 'claim-not-found' };
    const sessionChanged = await tx.session.updateMany({
        where: {
            id: row.sessionId,
            accountId,
            active: true,
            seq: input.expectedSeq,
        },
        data: { seq: { increment: 1 }, lastActiveAt: now },
    });
    if (sessionChanged.count !== 1) {
        const terminal = await tx.sessionFollowup.updateMany({
            where: {
                id: row.id, generation: input.generation, step: input.step,
                claimTokenHash: tokenHash(input.claimToken), status: 'DELIVERY_PENDING', deletedAt: null,
            },
            data: {
                status: 'COMPLETED', terminalCode: 'USER_INTERVENTION', completedAt: now,
                revision: { increment: 1 }, step: { increment: 1 },
                claimTokenHash: null, claimExpiresAt: null, claimedGeneration: null, claimedStep: null,
                pendingExpectedSeq: null, pendingLocalId: null,
            },
        });
        if (terminal.count !== 1) return { ok: false, error: 'report-conflict' };
        const updated = await tx.sessionFollowup.findUnique({
            where: { id: row.id }, include: daemonProjectInclude,
        });
        await writeChange(tx, updated);
        await history(tx, updated, {
            kind: 'TERMINATED', round: row.currentRound,
            terminalCode: 'USER_INTERVENTION', observedSeq: input.expectedSeq,
        });
        return {
            ok: true,
            value: {
                idempotent: false,
                messageSeq: null,
                deliveredMessage: null,
                followup: daemonView(updated),
            },
        };
    }
    const messageSeq = input.expectedSeq + 1;
    const deliveredMessage = await tx.sessionMessage.create({ data: {
        sessionId: row.sessionId,
        seq: messageSeq,
        content: { t: 'encrypted', c: input.contentCiphertext },
        localId: input.localId,
    }, select: {
        id: true,
        localId: true,
        createdAt: true,
        updatedAt: true,
    } });
    const changed = await tx.sessionFollowup.updateMany({
        where: {
            id: row.id, generation: input.generation, step: input.step,
            claimTokenHash: tokenHash(input.claimToken), status: 'DELIVERY_PENDING', deletedAt: null,
        },
        data: {
            status: 'WAITING',
            currentRound: { increment: 1 },
            responseBoundarySeq: messageSeq,
            lastObservedSeq: messageSeq,
            pendingExpectedSeq: null,
            pendingLocalId: null,
            revision: { increment: 1 },
            step: { increment: 1 },
            claimTokenHash: null,
            claimExpiresAt: null,
            claimedGeneration: null,
            claimedStep: null,
        },
    });
    if (changed.count !== 1) return { ok: false, error: 'report-conflict' };
    const updated = await tx.sessionFollowup.findUnique({
        where: { id: row.id }, include: daemonProjectInclude,
    });
    await writeChange(tx, updated);
    await history(tx, updated, {
        kind: 'CONTINUATION_DELIVERED', round: row.currentRound + 1, observedSeq: messageSeq,
    });
    return {
        ok: true,
        value: {
            idempotent: false,
            messageSeq,
            deliveredMessage,
            followup: daemonView(updated),
        },
    };
}
