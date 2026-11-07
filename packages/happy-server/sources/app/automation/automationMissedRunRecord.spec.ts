import { describe, expect, it, vi } from 'vitest';
import { recordMissedAutomationRuns, syncAutomations } from './automationExecutionService';

// aplus-dev-studio specs/scheduled-missed-run-policy R4~R9 — a daemon that slept through
// scheduled slots reports the whole gap as one EXPIRED row with a missedCount.

const now = new Date('2026-11-07T09:00:00.000Z');
const firstMissedAt = new Date('2026-11-07T01:00:00.000Z');

function automation(patch: Record<string, unknown> = {}) {
    return {
        id: 'automation-1', projectId: 'project-1', ownerAccountId: 'owner-1', machineAccountId: 'account-1', machineId: 'machine-1',
        revision: 2, generation: 3, paused: false, deletedAt: null, enabledAt: new Date(0),
        runRequestedAt: null, legacyMigrationPending: false, payloadVersion: 1, machineKeyVersion: 4, viewerKeyVersion: 5,
        project: { automationViewerKeyVersion: 5 },
        targetMachine: { automationKeyVersion: 4 },
        ...patch,
    };
}

function makeTx() {
    return {
        automation: { findFirst: vi.fn(async (): Promise<unknown> => automation()) },
        automationChange: { findMany: vi.fn(async () => []) },
        automationRun: {
            createMany: vi.fn(async (_input: { data: any[]; skipDuplicates: boolean }) => ({ count: 1 })),
            findFirst: vi.fn(async (): Promise<unknown> => null),
            updateMany: vi.fn(async () => ({ count: 1 })),
        },
    };
}

function record(tx: ReturnType<typeof makeTx>, patch: Record<string, unknown> = {}, accountId = 'account-1', machineId = 'machine-1') {
    return recordMissedAutomationRuns(tx as never, accountId, machineId, {
        automationId: 'automation-1', generation: 3, firstMissedAt, missedCount: 8, failureCode: 'MISSED_OFFLINE',
        ...patch,
    } as never, now);
}

describe('recordMissedAutomationRuns', () => {
    it('stores the whole gap as a single EXPIRED row keyed by its first missed slot', async () => {
        const tx = makeTx();
        await expect(record(tx)).resolves.toEqual({
            ok: true, value: { runId: expect.any(String), idempotent: false, projectId: 'project-1' },
        });
        expect(tx.automationRun.createMany).toHaveBeenCalledTimes(1);
        const { data, skipDuplicates } = tx.automationRun.createMany.mock.calls[0]![0];
        expect(skipDuplicates).toBe(true);
        expect(data).toHaveLength(1);
        expect(data[0]).toMatchObject({
            automationId: 'automation-1', generation: 3, scheduledFor: firstMissedAt,
            machineAccountId: 'account-1', machineId: 'machine-1',
            status: 'EXPIRED', failureCode: 'MISSED_OFFLINE', missedCount: 8,
            completedAt: now, claimExpiresAt: now,
        });
        // The claim fence is never usable: nobody holds the token behind this hash.
        expect(data[0].claimTokenHash).toBeInstanceOf(Uint8Array);
        expect(data[0].claimTokenHash.byteLength).toBe(32);
        expect(data[0]).not.toHaveProperty('startedAt');
        expect(data[0]).not.toHaveProperty('sessionId');
    });

    it('absorbs a re-reported gap without adding a row', async () => {
        const tx = makeTx();
        tx.automationRun.createMany.mockResolvedValue({ count: 0 });
        tx.automationRun.findFirst.mockResolvedValue({ id: 'run-existing', failureCode: 'MISSED_OFFLINE', missedCount: 8 });

        await expect(record(tx)).resolves.toEqual({
            ok: true, value: { runId: 'run-existing', idempotent: true, projectId: 'project-1' },
        });
        expect(tx.automationRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { automationId: 'automation-1', generation: 3, scheduledFor: firstMissedAt },
        }));
        expect(tx.automationRun.updateMany).not.toHaveBeenCalled();
    });

    it('grows the stored count when the same gap comes back longer, never shrinks it', async () => {
        const tx = makeTx();
        tx.automationRun.createMany.mockResolvedValue({ count: 0 });
        tx.automationRun.findFirst.mockResolvedValue({ id: 'run-existing', failureCode: 'MISSED_OFFLINE', missedCount: 8 });

        await expect(record(tx, { missedCount: 12 })).resolves.toMatchObject({ ok: true, value: { idempotent: true } });
        expect(tx.automationRun.updateMany).toHaveBeenCalledWith({
            where: { id: 'run-existing', failureCode: { in: ['MISSED_OFFLINE', 'MISSED_COLLAPSED'] }, missedCount: { lt: 12 } },
            data: { missedCount: 12 },
        });

        tx.automationRun.updateMany.mockClear();
        await record(tx, { missedCount: 3 });
        expect(tx.automationRun.updateMany).not.toHaveBeenCalled();
    });

    it('leaves a real run on the same slot untouched and reports it as already recorded', async () => {
        const tx = makeTx();
        tx.automationRun.createMany.mockResolvedValue({ count: 0 });
        tx.automationRun.findFirst.mockResolvedValue({ id: 'run-real', failureCode: null, missedCount: null });

        await expect(record(tx, { missedCount: 12 })).resolves.toMatchObject({ ok: true, value: { runId: 'run-real', idempotent: true } });
        expect(tx.automationRun.updateMany).not.toHaveBeenCalled();
    });

    it('refuses another machine, a stale generation, a paused or deleted automation', async () => {
        const otherMachine = makeTx();
        otherMachine.automation.findFirst.mockResolvedValue(null);
        await expect(record(otherMachine, {}, 'account-2', 'machine-2')).resolves.toEqual({ ok: false, error: 'claim-denied' });
        expect(otherMachine.automation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'automation-1', machineAccountId: 'account-2', machineId: 'machine-2', deletedAt: null },
        }));

        const staleGeneration = makeTx();
        await expect(record(staleGeneration, { generation: 2 })).resolves.toEqual({ ok: false, error: 'claim-denied' });

        const paused = makeTx();
        paused.automation.findFirst.mockResolvedValue(automation({ paused: true }));
        await expect(record(paused)).resolves.toEqual({ ok: false, error: 'claim-denied' });

        for (const tx of [otherMachine, staleGeneration, paused]) {
            expect(tx.automationRun.createMany).not.toHaveBeenCalled();
        }
    });

    it('refuses slots before enabledAt and slots still inside the claim window', async () => {
        const beforeEnable = makeTx();
        beforeEnable.automation.findFirst.mockResolvedValue(automation({ enabledAt: new Date(firstMissedAt.getTime() + 1) }));
        await expect(record(beforeEnable)).resolves.toEqual({ ok: false, error: 'claim-denied' });

        // Still claimable: the daemon must claim it, not write it off.
        const claimable = makeTx();
        await expect(record(claimable, { firstMissedAt: new Date(now.getTime() - 90_000) })).resolves.toEqual({ ok: false, error: 'claim-denied' });
        await expect(record(claimable, { firstMissedAt: new Date(now.getTime() + 60_000) })).resolves.toEqual({ ok: false, error: 'claim-denied' });

        for (const tx of [beforeEnable, claimable]) expect(tx.automationRun.createMany).not.toHaveBeenCalled();
    });

    it.each([0, 1001, 1.5, -1])('rejects a missed count of %s', async (missedCount) => {
        const tx = makeTx();
        await expect(record(tx, { missedCount })).resolves.toEqual({ ok: false, error: 'claim-denied' });
        expect(tx.automationRun.createMany).not.toHaveBeenCalled();
    });

    it('accepts the cap of 1000 slots', async () => {
        const tx = makeTx();
        await expect(record(tx, { missedCount: 1000 })).resolves.toMatchObject({ ok: true });
        expect(tx.automationRun.createMany.mock.calls[0]![0].data[0].missedCount).toBe(1000);
    });

    it('advertises the missed-run record capability on sync so old servers can be told apart', async () => {
        const tx = makeTx();
        const result = await syncAutomations(tx as never, 'account-1', 'machine-1', { afterSeq: 0n, limit: 10 }, now);
        expect(result).toMatchObject({ ok: true, value: { missedRunRecord: 1 } });
    });
});
