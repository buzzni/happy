import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
    createSessionFollowup,
    deleteSessionFollowup,
    pauseSessionFollowup,
    resumeSessionFollowup,
    stopSessionFollowup,
} from './sessionFollowupService';

const bytes = new Uint8Array([1, 2, 3]);

function followup(patch: Record<string, unknown> = {}) {
    return {
        id: 'followup-1', projectId: 'project-1', ownerAccountId: 'editor-1',
        machineAccountId: 'owner-1', machineId: 'machine-1', sessionId: 'session-1',
        revision: 1, generation: 1, step: 1, payloadVersion: 1,
        payloadCiphertext: bytes, viewerKeyId: 'viewer', viewerKeyVersion: 2,
        viewerKeyEnvelope: bytes, machineKeyVersion: 3, machineKeyEnvelope: bytes,
        status: 'WAITING', terminalCode: null, totalRounds: 4, currentRound: 1,
        responseBoundarySeq: 10, lastObservedSeq: 10, pendingExpectedSeq: null,
        pendingLocalId: null, claimTokenHash: null, claimExpiresAt: null,
        claimedGeneration: null, claimedStep: null, deletedAt: null, completedAt: null,
        createdAt: new Date(0), updatedAt: new Date(0),
        ...patch,
    };
}

function makeTx(options: {
    actorRole?: string;
    actorStatus?: string;
    sessionAccountId?: string;
    sessionActive?: boolean;
    protocolVersion?: number;
    current?: ReturnType<typeof followup> | null;
    activeCount?: number;
} = {}) {
    const current = options.current === undefined ? followup() : options.current;
    const created = followup();
    const tx = {
        project: { findUnique: vi.fn(async () => ({
            id: 'project-1', accountId: 'owner-1', config: {
                machineId: 'machine-1', workspaceDir: '/workspace/project',
            },
            automationViewerKeyVersion: 2,
        })) },
        projectMember: { findUnique: vi.fn(async () => ({
            role: options.actorRole ?? 'editor', status: options.actorStatus ?? 'accepted',
        })) },
        machine: { findUnique: vi.fn(async () => ({
            id: 'machine-1', accountId: 'owner-1', automationKeyVersion: 3,
            automationProtocolVersion: options.protocolVersion ?? 4,
        })) },
        session: { findFirst: vi.fn(async () => options.sessionActive === false ? null : ({
            id: 'session-1', accountId: options.sessionAccountId ?? 'owner-1', seq: 12, active: true,
        })) },
        sessionFollowup: {
            count: vi.fn(async () => options.activeCount ?? 0),
            create: vi.fn(async () => created),
            findFirst: vi.fn(async () => current),
            updateMany: vi.fn(async () => ({ count: 1 })),
            findUnique: vi.fn(async () => followup({ revision: 2, generation: 2 })),
        },
        sessionFollowupChange: { create: vi.fn(async () => ({})) },
        sessionFollowupHistory: { create: vi.fn(async () => ({})) },
    };
    return { tx, created };
}

const createInput = {
    sessionId: 'session-1', totalRounds: 4, currentRound: 1, responseBoundarySeq: 10,
    payloadVersion: 1 as const, payloadCiphertext: bytes, viewerKeyId: 'viewer',
    viewerKeyVersion: 2, viewerKeyEnvelope: bytes, machineKeyVersion: 3,
    machineKeyEnvelope: bytes,
};

describe('sessionFollowupService', () => {
    beforeEach(() => vi.clearAllMocks());

    it('derives the target from the project and starts against a same-tenant active session', async () => {
        const { tx, created } = makeTx();
        await expect(createSessionFollowup(tx as never, 'editor-1', 'project-1', createInput))
            .resolves.toEqual({ ok: true, value: created });
        expect(tx.session.findFirst).toHaveBeenCalledWith({
            where: { id: 'session-1', accountId: 'owner-1', active: true },
            select: { id: true, accountId: true, seq: true, active: true },
        });
        expect(tx.sessionFollowup.count).toHaveBeenCalledWith({ where: {
            sessionId: 'session-1', deletedAt: null,
            status: { in: ['WAITING', 'DELIVERY_PENDING', 'PAUSED'] },
        } });
        expect(tx.sessionFollowup.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            ownerAccountId: 'editor-1', machineAccountId: 'owner-1', machineId: 'machine-1',
            currentRound: 1, totalRounds: 4, responseBoundarySeq: 10, lastObservedSeq: 10,
        }) });
        expect(tx.sessionFollowupHistory.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            kind: 'STARTED', round: 1, detailCiphertext: null,
        }) });
    });

    it('starts against a project that has a target machine but no explicit workspaceDir', async () => {
        // A follow-up binds to an existing session, whose directory is already
        // inside the encrypted payload. Projects without an explicit workspace
        // directory (Desktop resolves one per project) are the common case.
        const { tx, created } = makeTx();
        tx.project.findUnique.mockResolvedValue({
            id: 'project-1', accountId: 'owner-1', config: { machineId: 'machine-1' },
            automationViewerKeyVersion: 2,
        } as never);
        await expect(createSessionFollowup(tx as never, 'editor-1', 'project-1', createInput))
            .resolves.toEqual({ ok: true, value: created });
    });

    it('refuses cross-tenant, missing, inactive, and protocol-incompatible targets', async () => {
        const crossTenant = makeTx({ sessionAccountId: 'foreign' });
        crossTenant.tx.session.findFirst.mockResolvedValue(null);
        await expect(createSessionFollowup(crossTenant.tx as never, 'editor-1', 'project-1', createInput))
            .resolves.toEqual({ ok: false, error: 'session-target-mismatch' });

        const oldDaemon = makeTx({ protocolVersion: 3 });
        await expect(createSessionFollowup(oldDaemon.tx as never, 'editor-1', 'project-1', createInput))
            .resolves.toEqual({ ok: false, error: 'session-followup-unsupported' });
        expect(oldDaemon.tx.sessionFollowup.create).not.toHaveBeenCalled();
    });

    it('rejects a second live loop for the same session', async () => {
        const { tx } = makeTx({ activeCount: 1 });
        await expect(createSessionFollowup(tx as never, 'editor-1', 'project-1', createInput))
            .resolves.toEqual({ ok: false, error: 'active-followup-exists' });
    });

    it('maps a concurrent active-loop uniqueness race to the domain conflict', async () => {
        const { tx } = makeTx();
        tx.sessionFollowup.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
            'duplicate active session follow-up',
            { code: 'P2002', clientVersion: 'test' },
        ));
        await expect(createSessionFollowup(tx as never, 'editor-1', 'project-1', createInput))
            .resolves.toEqual({ ok: false, error: 'active-followup-exists' });
        expect(tx.sessionFollowupChange.create).not.toHaveBeenCalled();
        expect(tx.sessionFollowupHistory.create).not.toHaveBeenCalled();
    });

    it('generation-fences pause, resume, and stop while preserving safe history only', async () => {
        const paused = makeTx();
        await expect(pauseSessionFollowup(paused.tx as never, 'editor-1', 'project-1', 'followup-1', 1))
            .resolves.toEqual({ ok: true, value: followup({ revision: 2, generation: 2 }) });
        expect(paused.tx.sessionFollowup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ revision: 1, status: { in: ['WAITING', 'DELIVERY_PENDING'] } }),
            data: expect.objectContaining({ status: 'PAUSED', revision: { increment: 1 }, generation: { increment: 1 } }),
        }));

        const resumed = makeTx({ current: followup({ status: 'PAUSED', pendingLocalId: 'pending' }) });
        await resumeSessionFollowup(resumed.tx as never, 'editor-1', 'project-1', 'followup-1', 1);
        expect(resumed.tx.sessionFollowup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                status: 'DELIVERY_PENDING',
                generation: { increment: 1 },
                pendingLocalId: 'happy-followup:followup-1:2:2',
            }),
        }));

        const stopped = makeTx();
        await stopSessionFollowup(stopped.tx as never, 'editor-1', 'project-1', 'followup-1', 1);
        expect(stopped.tx.sessionFollowup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'CANCELLED', terminalCode: 'STOPPED', generation: { increment: 1 } }),
        }));
        expect(stopped.tx.sessionFollowupHistory.create).toHaveBeenCalledWith({ data: expect.not.objectContaining({
            reviewBody: expect.anything(),
        }) });
    });

    it('writes a durable tombstone on delete', async () => {
        const { tx } = makeTx();
        await deleteSessionFollowup(tx as never, 'editor-1', 'project-1', 'followup-1', 1);
        expect(tx.sessionFollowupChange.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            followupId: 'followup-1', revision: 2, generation: 2, kind: 'TOMBSTONE',
        }) });
    });

    it('deletes a terminal loop without rewriting its outcome', async () => {
        const terminal = followup({
            revision: 5,
            generation: 3,
            step: 7,
            status: 'COMPLETED',
            terminalCode: 'CLEAN',
            completedAt: new Date(10),
        });
        const deleted = followup({
            ...terminal,
            revision: 6,
            generation: 4,
            deletedAt: new Date(20),
        });
        const { tx } = makeTx({ current: terminal });
        tx.sessionFollowup.findUnique.mockResolvedValue(deleted);

        await expect(deleteSessionFollowup(
            tx as never,
            'editor-1',
            'project-1',
            'followup-1',
            5,
            new Date(20),
        )).resolves.toEqual({ ok: true, value: deleted });
        const update = (tx.sessionFollowup.updateMany as any).mock.calls[0]![0];
        expect(update.where).not.toHaveProperty('status');
        expect(update.data).not.toHaveProperty('status');
        expect(update.data).not.toHaveProperty('terminalCode');
        expect(update.data).toEqual(expect.objectContaining({
            revision: { increment: 1 },
            generation: { increment: 1 },
            deletedAt: new Date(20),
        }));
        expect(tx.sessionFollowupHistory.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            kind: 'DELETED',
            terminalCode: 'CLEAN',
        }) });
    });
});
