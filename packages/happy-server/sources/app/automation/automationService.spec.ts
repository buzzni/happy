import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    activateAutomationAdoption,
    adoptAutomation,
    createAutomation,
    deleteAutomation,
    getAutomationTarget,
    listAutomationRuns,
    listAutomations,
    replaceAutomationViewerKeyIfUnused,
    requestAutomationRun,
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
        targetMachine: { automationProtocolVersion: 2, automationKeyVersion: 3 },
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
        runRequestedAt: null,
        enabledAt: new Date(0),
        deletedAt: null,
        appliedRevision: 0,
        appliedAt: null,
        legacyMachineId: null,
        legacyAutomationId: null,
        legacyMigrationPending: false,
        legacyDesiredPaused: null,
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
    automationProtocolVersion?: number;
    activeAutomationCount?: number;
    followupCount?: number;
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
                automationProtocolVersion: options.automationProtocolVersion ?? 2,
            })),
        },
        automation: {
            count: vi.fn(async () => options.activeAutomationCount ?? (current ? 1 : 0)),
            findMany: vi.fn(async () => current ? [current] : []),
            findFirst: vi.fn(async ({ where }: { where: { projectId?: string } }) => (
                current && (!where.projectId || current.projectId === where.projectId) ? current : null
            )),
            create: vi.fn(async () => created),
            createMany: vi.fn(async () => ({ count: 1 })),
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
        sessionFollowup: {
            count: vi.fn(async () => options.followupCount ?? 0),
            findMany: vi.fn(async () => []),
        },
        sessionFollowupChange: { create: vi.fn(async () => ({})) },
        sessionFollowupHistory: { create: vi.fn(async () => ({})) },
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

    it('advertises session follow-ups only at the shared protocol threshold', async () => {
        const oldDaemon = makeTx({ automationProtocolVersion: 3 });
        const currentDaemon = makeTx({ automationProtocolVersion: 4 });

        await expect(getAutomationTarget(oldDaemon.tx as never, 'editor-1', 'project-1'))
            .resolves.toEqual({ ok: true, value: expect.objectContaining({
                sessionFollowupSupported: false,
            }) });
        await expect(getAutomationTarget(currentDaemon.tx as never, 'editor-1', 'project-1'))
            .resolves.toEqual({ ok: true, value: expect.objectContaining({
                sessionFollowupSupported: true,
            }) });
    });

    it('lists shared run history through the same project access boundary', async () => {
        const { tx } = makeTx({ actorRole: 'viewer' });
        await expect(listAutomationRuns(tx as never, 'editor-1', 'project-1', {
            automationId: 'automation-1', limit: 20,
        })).resolves.toEqual({ ok: true, value: [{ id: 'run-1', automationId: 'automation-1' }] });
        expect(tx.automationRun.findMany).toHaveBeenCalledWith({
            where: { automation: { projectId: 'project-1' }, automationId: 'automation-1' },
            orderBy: [{ claimedAt: 'desc' }, { scheduledFor: 'desc' }],
            take: 20,
        });
    });

    it('records one revision-safe immediate run request without resetting the generation', async () => {
        const requestedAt = new Date('2026-08-18T10:00:00.000Z');
        const requested = automationRecord({ revision: 2, generation: 1, runRequestedAt: requestedAt });
        const { tx } = makeTx();
        tx.automation.findUnique = vi.fn(async () => requested);

        await expect(requestAutomationRun(
            tx as never,
            'editor-1',
            'project-1',
            'automation-1',
            1,
            requestedAt,
        )).resolves.toEqual({ ok: true, value: requested });

        expect(tx.automation.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'automation-1', projectId: 'project-1', revision: 1,
                paused: false, legacyMigrationPending: false, deletedAt: null,
            },
            data: { revision: { increment: 1 }, runRequestedAt: requestedAt },
        });
        expect(tx.automationChange.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ revision: 2, generation: 1, kind: 'UPSERT' }),
        });
    });

    it('rejects immediate execution for a paused automation', async () => {
        const { tx } = makeTx({ automation: automationRecord({ paused: true }) });

        await expect(requestAutomationRun(
            tx as never, 'editor-1', 'project-1', 'automation-1', 1,
        )).resolves.toEqual({ ok: false, error: 'automation-paused' });
        expect(tx.automation.updateMany).not.toHaveBeenCalled();
    });

    it('returns the latest row when a stale run request observes a newly paused automation', async () => {
        const latest = automationRecord({ revision: 2, paused: true });
        const { tx } = makeTx({ automation: latest });

        await expect(requestAutomationRun(
            tx as never, 'editor-1', 'project-1', 'automation-1', 1,
        )).resolves.toEqual({ ok: false, error: 'revision-conflict', latest });
        expect(tx.automation.updateMany).not.toHaveBeenCalled();
    });

    it('does not persist an immediate request when the execution target is unavailable', async () => {
        const { tx } = makeTx({ automation: automationRecord({ machineAccountId: null, machineId: null }) });

        await expect(requestAutomationRun(
            tx as never, 'editor-1', 'project-1', 'automation-1', 1,
        )).resolves.toEqual({ ok: false, error: 'automation-target-unavailable' });
        expect(tx.automation.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an immediate request when the target daemon does not support run-now', async () => {
        const { tx } = makeTx({
            automation: automationRecord({ targetMachine: { automationProtocolVersion: 1 } }),
        });

        await expect(requestAutomationRun(
            tx as never, 'editor-1', 'project-1', 'automation-1', 1,
        )).resolves.toEqual({ ok: false, error: 'automation-run-unsupported' });
        expect(tx.automation.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an immediate request when the target machine key has rotated', async () => {
        const { tx } = makeTx({
            automation: automationRecord({
                machineKeyVersion: 3,
                targetMachine: { automationProtocolVersion: 2, automationKeyVersion: 4 },
            }),
        });

        await expect(requestAutomationRun(
            tx as never, 'editor-1', 'project-1', 'automation-1', 1,
        )).resolves.toEqual({ ok: false, error: 'machine-key-version-conflict' });
        expect(tx.automation.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an immediate request when the project viewer key has rotated', async () => {
        const { tx } = makeTx({ automation: automationRecord({ viewerKeyVersion: 1 }) });

        await expect(requestAutomationRun(
            tx as never, 'editor-1', 'project-1', 'automation-1', 1,
        )).resolves.toEqual({ ok: false, error: 'viewer-key-version-conflict' });
        expect(tx.automation.updateMany).not.toHaveBeenCalled();
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

    it('stages one idempotent legacy adoption under the target machine owner', async () => {
        const { tx } = makeTx({ actorId: 'owner-1' });
        const staged = automationRecord({
            ownerAccountId: 'owner-1', paused: true, legacyMachineId: 'machine-1',
            legacyAutomationId: 'legacy-1', legacyMigrationPending: true, legacyDesiredPaused: false,
            appliedRevision: 1,
        });
        tx.automation.createMany = vi.fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });
        tx.automation.findUnique = vi.fn(async () => staged);
        const input = {
            ...createInput,
            legacyMachineId: 'machine-1', legacyAutomationId: 'legacy-1',
            ownershipConfirmed: true as const, desiredPaused: false,
        };

        await expect(adoptAutomation(tx as never, 'owner-1', 'project-1', input))
            .resolves.toEqual({ ok: true, value: staged });
        await expect(adoptAutomation(tx as never, 'owner-1', 'project-1', input))
            .resolves.toEqual({ ok: true, value: staged });
        expect(tx.automation.createMany).toHaveBeenNthCalledWith(1, {
            data: [expect.objectContaining({
                ownerAccountId: 'owner-1', machineId: 'machine-1', paused: true,
                legacyMachineId: 'machine-1', legacyAutomationId: 'legacy-1',
                legacyMigrationPending: true, legacyDesiredPaused: false,
            })],
            skipDuplicates: true,
        });
        expect(tx.automationChange.create).toHaveBeenCalledTimes(1);
    });

    it('rejects adoption by a member who does not own the target machine', async () => {
        const { tx } = makeTx();
        await expect(adoptAutomation(tx as never, 'editor-1', 'project-1', {
            ...createInput,
            legacyMachineId: 'machine-1', legacyAutomationId: 'legacy-1',
            ownershipConfirmed: true, desiredPaused: false,
        })).resolves.toEqual({ ok: false, error: 'forbidden' });
        expect(tx.automation.create).not.toHaveBeenCalled();
    });

    it('activates a staged adoption with the persisted desired pause state', async () => {
        const staged = automationRecord({
            ownerAccountId: 'owner-1', paused: true, legacyMachineId: 'machine-1',
            legacyAutomationId: 'legacy-1', legacyMigrationPending: true, legacyDesiredPaused: false,
            appliedRevision: 1,
        });
        const active = automationRecord({ ...staged, revision: 2, generation: 2, paused: false, legacyMigrationPending: false });
        const { tx } = makeTx({ actorId: 'owner-1', automation: staged });
        tx.automation.findUnique = vi.fn(async () => active);

        await expect(activateAutomationAdoption(tx as never, 'owner-1', 'project-1', 'automation-1', 1))
            .resolves.toEqual({ ok: true, value: active });
        expect(tx.automation.updateMany).toHaveBeenCalledWith({
            where: { id: 'automation-1', projectId: 'project-1', revision: 1, legacyMigrationPending: true, deletedAt: null },
            data: expect.objectContaining({
                revision: { increment: 1 }, generation: { increment: 1 },
                paused: false, legacyMigrationPending: false,
            }),
        });
        expect(tx.automationChange.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'UPSERT' }) });
    });

    it('does not activate before the daemon acknowledges the staged revision', async () => {
        const staged = automationRecord({
            ownerAccountId: 'owner-1', paused: true, legacyMachineId: 'machine-1',
            legacyAutomationId: 'legacy-1', legacyMigrationPending: true, legacyDesiredPaused: false,
            appliedRevision: 0,
        });
        const { tx } = makeTx({ actorId: 'owner-1', automation: staged });

        await expect(activateAutomationAdoption(tx as never, 'owner-1', 'project-1', 'automation-1', 1))
            .resolves.toEqual({ ok: false, error: 'migration-not-applied' });
        expect(tx.automation.updateMany).not.toHaveBeenCalled();
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
                automationProtocolVersion: 2,
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
        expect(owner.tx.sessionFollowup.findMany).toHaveBeenCalledWith({ where: expect.objectContaining({
            projectId: 'project-1',
        }) });
    });

    it('replaces a mismatched viewer key only when no automation or follow-up uses it', async () => {
        const empty = makeTx({ actorId: 'owner-1', automation: null });
        const inUse = makeTx({ actorId: 'owner-1', activeAutomationCount: 1 });
        const followupInUse = makeTx({
            actorId: 'owner-1', automation: null, followupCount: 1,
        });
        const publicKey = new Uint8Array(32).fill(7);

        await expect(replaceAutomationViewerKeyIfUnused(empty.tx as never, 'owner-1', 'project-1', {
            expectedKeyVersion: 2,
            publicKey,
        })).resolves.toEqual({ ok: true, value: { keyVersion: 3 } });
        expect(empty.tx.automation.count).toHaveBeenCalledWith({
            where: { projectId: 'project-1', deletedAt: null },
        });
        expect(empty.tx.sessionFollowup.count).toHaveBeenCalledWith({
            where: { projectId: 'project-1', deletedAt: null },
        });
        expect(empty.tx.project.updateMany).toHaveBeenCalledWith({
            where: { id: 'project-1', automationViewerKeyVersion: 2 },
            data: { automationViewerPublicKey: publicKey, automationViewerKeyVersion: { increment: 1 } },
        });

        await expect(replaceAutomationViewerKeyIfUnused(inUse.tx as never, 'owner-1', 'project-1', {
            expectedKeyVersion: 2,
            publicKey,
        })).resolves.toEqual({ ok: false, error: 'viewer-key-in-use' });
        expect(inUse.tx.project.updateMany).not.toHaveBeenCalled();

        await expect(replaceAutomationViewerKeyIfUnused(
            followupInUse.tx as never,
            'owner-1',
            'project-1',
            { expectedKeyVersion: 2, publicKey },
        )).resolves.toEqual({ ok: false, error: 'viewer-key-in-use' });
        expect(followupInUse.tx.project.updateMany).not.toHaveBeenCalled();
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
