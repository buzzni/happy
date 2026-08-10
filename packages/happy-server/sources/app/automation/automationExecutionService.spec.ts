import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
    claimAutomationRun,
    heartbeatAutomationRun,
    registerAutomationMachineKey,
    reportAutomationRun,
    startAutomationRun,
    syncAutomations,
} from './automationExecutionService';

const now = new Date('2026-08-10T08:00:00.000Z');

function automation(patch: Record<string, unknown> = {}) {
    return {
        id: 'automation-1', projectId: 'project-1', machineAccountId: 'account-1', machineId: 'machine-1',
        revision: 2, generation: 3, paused: false, deletedAt: null, enabledAt: new Date(0),
        payloadVersion: 1, payloadCiphertext: new Uint8Array([1]), machineKeyVersion: 4,
        machineKeyEnvelope: new Uint8Array([2]), viewerKeyVersion: 5,
        project: { automationViewerKeyVersion: 5 },
        targetMachine: { automationKeyVersion: 4 },
        ...patch,
    };
}

function makeTx() {
    const row = automation();
    return {
        machine: {
            updateMany: vi.fn(async () => ({ count: 1 })),
            findFirst: vi.fn(),
        },
        automationChange: { findMany: vi.fn(async () => [{
            seq: 9n, automationId: 'automation-1', revision: 2, generation: 3, kind: 'UPSERT',
            machineAccountId: 'account-1', machineId: 'machine-1', createdAt: now,
        }]) },
        automation: {
            findFirst: vi.fn(async () => row),
            findMany: vi.fn(async () => [row]),
            updateMany: vi.fn(async () => ({ count: 1 })),
        },
        automationRun: {
            updateMany: vi.fn(async () => ({ count: 1 })),
            create: vi.fn(async ({ data }: { data: object }) => ({ id: 'run-1', ...data })),
            findFirst: vi.fn(),
            findUnique: vi.fn(),
        },
        session: { findFirst: vi.fn(async () => null) },
    };
}

describe('automationExecutionService', () => {
    it('registers a persistent public key with account, machine, and version CAS', async () => {
        const tx = makeTx();
        await expect(registerAutomationMachineKey(tx as never, 'account-1', 'machine-1', {
            expectedKeyVersion: 3,
            publicKey: new Uint8Array(32),
        })).resolves.toEqual({ ok: true, value: { keyVersion: 4 } });
        expect(tx.machine.updateMany).toHaveBeenCalledWith({
            where: { id: 'machine-1', accountId: 'account-1', automationKeyVersion: 3 },
            data: { automationPublicKey: new Uint8Array(32), automationKeyVersion: { increment: 1 } },
        });
    });

    it('recovers idempotently when the server committed the same key before the daemon saved its version', async () => {
        const tx = makeTx();
        const publicKey = new Uint8Array(32);
        tx.machine.updateMany.mockResolvedValue({ count: 0 });
        tx.machine.findFirst.mockResolvedValue({ automationPublicKey: publicKey, automationKeyVersion: 4 });

        await expect(registerAutomationMachineKey(tx as never, 'account-1', 'machine-1', {
            expectedKeyVersion: 3,
            publicKey,
        })).resolves.toEqual({ ok: true, value: { keyVersion: 4 } });
    });

    it('returns only machine-targeted deltas without the viewer envelope', async () => {
        const tx = makeTx();
        const result = await syncAutomations(tx as never, 'account-1', 'machine-1', { afterSeq: 0n, limit: 100 }, now);
        expect(tx.automationChange.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { machineAccountId: 'account-1', machineId: 'machine-1', seq: { gt: 0n } },
        }));
        expect(result).toEqual({ ok: true, value: expect.objectContaining({
            nextSeq: 9n,
            changes: [expect.objectContaining({ kind: 'UPSERT', payloadCiphertext: new Uint8Array([1]) })],
        }) });
        expect((result as any).value.changes[0].viewerKeyEnvelope).toBeUndefined();
    });

    it('claims only the current generation inside the due window and stores only a token hash', async () => {
        const tx = makeTx();
        const result = await claimAutomationRun(tx as never, 'account-1', 'machine-1', {
            automationId: 'automation-1', generation: 3, scheduledFor: new Date(now.getTime() - 30_000),
        }, now);
        expect(result).toEqual({ ok: true, value: expect.objectContaining({ runId: 'run-1', claimToken: expect.any(String) }) });
        const data = tx.automationRun.create.mock.calls[0]![0].data as any;
        expect(data.claimTokenHash).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(data.claimTokenHash).toString('base64url')).not.toBe((result as any).value.claimToken);

        await expect(claimAutomationRun(tx as never, 'account-1', 'machine-1', {
            automationId: 'automation-1', generation: 2, scheduledFor: now,
        }, now)).resolves.toEqual({ ok: false, error: 'claim-denied' });
    });

    it('maps the database uniqueness fence to an already-claimed result', async () => {
        const tx = makeTx();
        tx.automationRun.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate run', {
            code: 'P2002',
            clientVersion: 'test',
        }));

        await expect(claimAutomationRun(tx as never, 'account-1', 'machine-1', {
            automationId: 'automation-1', generation: 3, scheduledFor: now,
        }, now)).resolves.toEqual({ ok: false, error: 'already-claimed' });
    });

    it('cancels a claimed run when pause wins before start', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', status: 'CLAIMED', claimExpiresAt: new Date(now.getTime() + 60_000),
            automation: automation({ paused: true }),
        });
        await expect(startAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token',
        }, now)).resolves.toEqual({ ok: false, error: 'claim-cancelled' });
        expect(tx.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'CANCELLED', completedAt: now } }));
    });

    it('does not resurrect a run after its heartbeat lease expires', async () => {
        const tx = makeTx();
        tx.automationRun.updateMany.mockResolvedValue({ count: 0 });

        await expect(heartbeatAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token',
        }, now)).resolves.toEqual({ ok: false, error: 'run-not-running' });
        expect(tx.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ runLeaseExpiresAt: { gte: now } }),
        }));
    });

    it('returns an existing terminal result for the same report id', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', status: 'COMPLETED', reportId: 'report-1', outcome: 'WOKE', sessionId: 'session-1',
        });
        await expect(reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status: 'COMPLETED',
            outcome: 'WOKE', sessionId: 'session-1', detailCiphertext: null,
        }, now)).resolves.toEqual({ ok: true, value: expect.objectContaining({ idempotent: true }) });
        expect(tx.automationRun.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a first completion report linked to a foreign session', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'RUNNING', reportId: null });
        await expect(reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status: 'COMPLETED',
            outcome: 'WOKE', sessionId: 'foreign-session', detailCiphertext: null,
        }, now)).resolves.toEqual({ ok: false, error: 'report-conflict' });
        expect(tx.session.findFirst).toHaveBeenCalledWith({
            where: { id: 'foreign-session', accountId: 'account-1' }, select: { id: true },
        });
        expect(tx.automationRun.updateMany).not.toHaveBeenCalled();
    });

    it('maps a cross-run report id uniqueness conflict to report-conflict', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'RUNNING', reportId: null });
        tx.automationRun.updateMany.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate report', {
            code: 'P2002',
            clientVersion: 'test',
        }));

        await expect(reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-used-by-another-run', status: 'COMPLETED',
            outcome: 'WOKE', sessionId: null, detailCiphertext: null,
        }, now)).resolves.toEqual({ ok: false, error: 'report-conflict' });
    });

    it('marks a report after the run lease deadline as late', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', status: 'RUNNING', reportId: null,
            runLeaseExpiresAt: new Date(now.getTime() - 1),
        });

        await reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status: 'COMPLETED',
            outcome: 'WOKE', sessionId: null, detailCiphertext: null,
        }, now);
        expect(tx.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ lateReport: true }),
        }));
    });

    it.each([
        { status: 'COMPLETED', outcome: 'ERROR' },
        { status: 'FAILED', outcome: 'WOKE' },
    ] as const)('rejects an invalid $status and $outcome report pair', async ({ status, outcome }) => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'RUNNING', reportId: null });
        await expect(reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status,
            outcome, sessionId: null, detailCiphertext: null,
        }, now)).resolves.toEqual({ ok: false, error: 'report-conflict' });
        expect(tx.automationRun.updateMany).not.toHaveBeenCalled();
    });
});
