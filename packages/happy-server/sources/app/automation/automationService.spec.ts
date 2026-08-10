import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createAutomation,
    deleteAutomation,
    getAutomationTarget,
    listAutomationRuns,
    listAutomations,
    setAutomationViewerKey,
    updateAutomation,
} from './automationService';

const payload = new Uint8Array([1, 2, 3]);
const envelope = new Uint8Array([4, 5, 6]);

function automationRecord(patch: Record<string, unknown> = {}) {
    return {
        id: 'automation-1',
        projectId: 'project-1',
        ownerAccountId: 'editor-1',
        machineAccountId: 'owner-1',
        machineId: 'machine-1',
        revision: 1,
        generation: 1,
        payloadVersion: 1,
        payloadCiphertext: payload,
        viewerKeyId: 'viewer-key',
        viewerKeyVersion: 2,
        viewerKeyEnvelope: envelope,
        machineKeyVersion: 3,
        machineKeyEnvelope: envelope,
        paused: false,
        enabledAt: new Date(0),
        deletedAt: null,
        appliedRevision: 0,
        appliedAt: null,
        legacyMachineId: null,
        legacyAutomationId: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...patch,
    };
}

function makeTx(options: {
    actorId?: string;
    actorRole?: string;
    actorStatus?: string;
    automation?: ReturnType<typeof automationRecord> | null;
    machineAccountId?: string;
} = {}) {
    const actorId = options.actorId ?? 'editor-1';
    const project = {
        id: 'project-1',
        accountId: 'owner-1',
        config: { machineId: 'machine-1' },
        automationViewerPublicKey: new Uint8Array(32),
        automationViewerKeyVersion: 2,
    };
    const current = options.automation === undefined ? automationRecord() : options.automation;
    const created = automationRecord();
    const updated = automationRecord({ revision: 2, generation: 2 });
    const tx = {
        project: {
            findUnique: vi.fn(async () => project),
            updateMany: vi.fn(async () => ({ count: 1 })),
        },
        projectMember: {
            findUnique: vi.fn(async () => actorId === 'owner-1' ? null : {
                accountId: actorId,
                role: options.actorRole ?? 'editor',
                status: options.actorStatus ?? 'accepted',
            }),
        },
        machine: {
            findUnique: vi.fn(async () => options.machineAccountId === 'foreign-owner' ? null : ({
                id: 'machine-1',
                accountId: 'owner-1',
                automationPublicKey: new Uint8Array(32),
                automationKeyVersion: 3,
            })),
        },
        automation: {
            findMany: vi.fn(async () => current ? [current] : []),
            findFirst: vi.fn(async ({ where }: { where: { projectId?: string } }) => (
                current && (!where.projectId || current.projectId === where.projectId) ? current : null
            )),
            create: vi.fn(async () => created),
            updateMany: vi.fn(async () => ({ count: 1 })),
            findUnique: vi.fn()
                .mockResolvedValueOnce(updated)
                .mockResolvedValue(updated),
        },
        automationChange: {
            create: vi.fn(async () => ({})),
        },
        automationRun: {
            findMany: vi.fn(async () => [{ id: 'run-1', automationId: 'automation-1' }]),
        },
    };
    return { tx, project, created, updated };
}

const createInput = {
    payloadVersion: 1,
    payloadCiphertext: payload,
    viewerKeyId: 'viewer-key',
    viewerKeyVersion: 2,
    viewerKeyEnvelope: envelope,
    machineKeyVersion: 3,
    machineKeyEnvelope: envelope,
    paused: false,
};

describe('automationService', () => {
    beforeEach(() => vi.clearAllMocks());

    it('lists only for an accepted project member', async () => {
        const accepted = makeTx();
        const pending = makeTx({ actorStatus: 'pending' });

        await expect(listAutomations(accepted.tx as never, 'editor-1', 'project-1'))
            .resolves.toEqual({ ok: true, value: [automationRecord()] });
        await expect(listAutomations(pending.tx as never, 'editor-1', 'project-1'))
            .resolves.toEqual({ ok: false, error: 'not-found' });
    });

    it('lists shared run history through the same project access boundary', async () => {
        const { tx } = makeTx({ actorRole: 'viewer' });
        await expect(listAutomationRuns(tx as never, 'editor-1', 'project-1', {
            automationId: 'automation-1', limit: 20,
        })).resolves.toEqual({ ok: true, value: [{ id: 'run-1', automationId: 'automation-1' }] });
        expect(tx.automationRun.findMany).toHaveBeenCalledWith({
            where: { automation: { projectId: 'project-1' }, automationId: 'automation-1' },
            orderBy: { claimedAt: 'desc' },
            take: 20,
        });
    });

    it('derives owner and target machine instead of trusting client identity', async () => {
        const { tx, created } = makeTx();

        const result = await createAutomation(tx as never, 'editor-1', 'project-1', createInput);

        expect(result).toEqual({ ok: true, value: created });
        expect(tx.automation.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            projectId: 'project-1',
            ownerAccountId: 'editor-1',
            machineAccountId: 'owner-1',
            machineId: 'machine-1',
        }) });
        expect(tx.automationChange.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            automationId: 'automation-1',
            kind: 'UPSERT',
        }) });
    });

    it('rejects a project configured with another account\'s machine id', async () => {
        const { tx } = makeTx({ machineAccountId: 'foreign-owner' });

        await expect(getAutomationTarget(tx as never, 'editor-1', 'project-1'))
            .resolves.toEqual({ ok: false, error: 'automation-target-unavailable' });
        expect(tx.machine.findUnique).toHaveBeenCalledWith({
            where: { accountId_id: { accountId: 'owner-1', id: 'machine-1' } },
            select: expect.any(Object),
        });
    });

    it('returns public target keys to viewers but lets only the project owner rotate the viewer key', async () => {
        const viewer = makeTx({ actorRole: 'viewer' });
        const owner = makeTx({ actorId: 'owner-1' });

        await expect(getAutomationTarget(viewer.tx as never, 'editor-1', 'project-1'))
            .resolves.toEqual({ ok: true, value: expect.objectContaining({
                machineId: 'machine-1',
                machineKeyVersion: 3,
                viewerKeyVersion: 2,
            }) });
        await expect(setAutomationViewerKey(viewer.tx as never, 'editor-1', 'project-1', {
            expectedKeyVersion: 2,
            publicKey: new Uint8Array(32),
        })).resolves.toEqual({ ok: false, error: 'forbidden' });
        await expect(setAutomationViewerKey(owner.tx as never, 'owner-1', 'project-1', {
            expectedKeyVersion: 2,
            publicKey: new Uint8Array(32),
        })).resolves.toEqual({ ok: true, value: { keyVersion: 3 } });
    });

    it('rejects a viewer mutation and a stale machine envelope', async () => {
        const viewer = makeTx({ actorRole: 'viewer' });
        const stale = makeTx();

        await expect(createAutomation(viewer.tx as never, 'editor-1', 'project-1', createInput))
            .resolves.toEqual({ ok: false, error: 'forbidden' });
        await expect(createAutomation(stale.tx as never, 'editor-1', 'project-1', {
            ...createInput,
            machineKeyVersion: 2,
        })).resolves.toEqual({ ok: false, error: 'machine-key-version-conflict' });
        expect(viewer.tx.automation.create).not.toHaveBeenCalled();
        expect(stale.tx.automation.create).not.toHaveBeenCalled();
    });

    it('updates by expected revision, increments the execution fence, and appends a change', async () => {
        const { tx, updated } = makeTx();

        const result = await updateAutomation(tx as never, 'editor-1', 'project-1', 'automation-1', {
            expectedRevision: 1,
            paused: true,
        });

        expect(result).toEqual({ ok: true, value: updated });
        expect(tx.automation.updateMany).toHaveBeenCalledWith({
            where: { id: 'automation-1', projectId: 'project-1', revision: 1, deletedAt: null },
            data: expect.objectContaining({ revision: { increment: 1 }, generation: { increment: 1 }, paused: true }),
        });
        expect(tx.automationChange.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            revision: 2,
            generation: 2,
            kind: 'UPSERT',
        }) });
    });

    it('returns the latest row on a stale revision without appending a change', async () => {
        const { tx } = makeTx();
        tx.automation.updateMany.mockResolvedValue({ count: 0 });

        const result = await updateAutomation(tx as never, 'editor-1', 'project-1', 'automation-1', {
            expectedRevision: 0,
            paused: true,
        });

        expect(result).toEqual({ ok: false, error: 'revision-conflict', latest: automationRecord() });
        expect(tx.automationChange.create).not.toHaveBeenCalled();
    });

    it('rejects a no-op update without consuming a revision', async () => {
        const { tx } = makeTx();

        await expect(updateAutomation(tx as never, 'editor-1', 'project-1', 'automation-1', {
            expectedRevision: 1,
        })).resolves.toEqual({ ok: false, error: 'invalid-payload-update' });
        expect(tx.automation.updateMany).not.toHaveBeenCalled();
    });

    it('soft-deletes with a tombstone and hides cross-project automation ids', async () => {
        const allowed = makeTx();
        const foreign = makeTx({ automation: automationRecord({ projectId: 'project-other' }) });

        await expect(deleteAutomation(allowed.tx as never, 'editor-1', 'project-1', 'automation-1', 1))
            .resolves.toEqual({ ok: true, value: allowed.updated });
        expect(allowed.tx.automationChange.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'TOMBSTONE' }) });
        await expect(deleteAutomation(foreign.tx as never, 'editor-1', 'project-1', 'automation-1', 1))
            .resolves.toEqual({ ok: false, error: 'not-found' });
    });
});
