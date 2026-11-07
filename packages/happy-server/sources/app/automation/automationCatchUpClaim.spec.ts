import { describe, expect, it, vi } from 'vitest';
import { claimAutomationRun, syncAutomations } from './automationExecutionService';

// aplus-dev-studio specs/scheduled-missed-run-policy R11·R13 — an automation the user opted into
// "run once when back" may claim its latest missed slot up to eight days late. Everything else
// about the claim (generation, enabledAt, pause, key versions, the slot fence) is unchanged.

const now = new Date('2026-11-07T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60_000;

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
            updateMany: vi.fn(async () => ({ count: 0 })),
        },
    };
}

function claim(tx: ReturnType<typeof makeTx>, scheduledFor: Date, patch: Record<string, unknown> = {}) {
    return claimAutomationRun(tx as never, 'account-1', 'machine-1', {
        automationId: 'automation-1', generation: 3, scheduledFor, ...patch,
    } as never, now);
}

describe('claimAutomationRun catch-up', () => {
    it('claims a slot hours late only when the daemon asks for a catch-up', async () => {
        const slot = new Date(now.getTime() - 5 * 60 * 60_000);

        const plain = makeTx();
        await expect(claim(plain, slot)).resolves.toEqual({ ok: false, error: 'claim-denied' });
        expect(plain.automationRun.createMany).not.toHaveBeenCalled();

        const catchUp = makeTx();
        await expect(claim(catchUp, slot, { catchUp: true })).resolves.toMatchObject({ ok: true, value: { runId: expect.any(String) } });
        // The real slot is stored, not a synthetic "now": the slot fence keeps it from running twice.
        expect(catchUp.automationRun.createMany.mock.calls[0]![0].data[0]).toMatchObject({ scheduledFor: slot, status: 'CLAIMED' });
    });

    it('accepts slots up to eight days old and refuses older ones', async () => {
        const edge = makeTx();
        await expect(claim(edge, new Date(now.getTime() - 8 * DAY_MS), { catchUp: true })).resolves.toMatchObject({ ok: true });

        const tooOld = makeTx();
        await expect(claim(tooOld, new Date(now.getTime() - 8 * DAY_MS - 1), { catchUp: true })).resolves.toEqual({ ok: false, error: 'claim-denied' });
        expect(tooOld.automationRun.createMany).not.toHaveBeenCalled();
    });

    it('keeps the future edge at fifteen seconds', async () => {
        const future = makeTx();
        await expect(claim(future, new Date(now.getTime() + 15_001), { catchUp: true })).resolves.toEqual({ ok: false, error: 'claim-denied' });
        expect(future.automationRun.createMany).not.toHaveBeenCalled();
    });

    it('still refuses a late slot before enabledAt, from a stale generation or while paused', async () => {
        const slot = new Date(now.getTime() - DAY_MS);

        const beforeEnable = makeTx();
        beforeEnable.automation.findFirst.mockResolvedValue(automation({ enabledAt: new Date(slot.getTime() + 1) }));
        await expect(claim(beforeEnable, slot, { catchUp: true })).resolves.toEqual({ ok: false, error: 'claim-denied' });

        const staleGeneration = makeTx();
        await expect(claim(staleGeneration, slot, { catchUp: true, generation: 2 })).resolves.toEqual({ ok: false, error: 'claim-denied' });

        const paused = makeTx();
        paused.automation.findFirst.mockResolvedValue(automation({ paused: true }));
        await expect(claim(paused, slot, { catchUp: true })).resolves.toEqual({ ok: false, error: 'claim-denied' });

        for (const tx of [beforeEnable, staleGeneration, paused]) expect(tx.automationRun.createMany).not.toHaveBeenCalled();
    });

    it('answers already-claimed when the same late slot is claimed again', async () => {
        // A daemon restart after a catch-up claim reaches the server must not run the slot a second time.
        const tx = makeTx();
        tx.automationRun.createMany.mockResolvedValue({ count: 0 });
        tx.automationRun.findFirst.mockResolvedValue({ id: 'run-earlier' });
        const slot = new Date(now.getTime() - 3 * 60 * 60_000);

        await expect(claim(tx, slot, { catchUp: true })).resolves.toEqual({ ok: false, error: 'already-claimed' });
        expect(tx.automationRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { automationId: 'automation-1', generation: 3, scheduledFor: slot, kind: 'SCHEDULED' },
        }));
    });

    it('advertises the catch-up claim on sync so a daemon only offers the policy where it works', async () => {
        const tx = makeTx();
        await expect(syncAutomations(tx as never, 'account-1', 'machine-1', { afterSeq: 0n, limit: 10 }, now))
            .resolves.toMatchObject({ ok: true, value: { missedRunRecord: 1, catchUpClaim: 1 } });
    });
});
