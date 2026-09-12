import { describe, expect, it, vi } from 'vitest';
import {
    claimSessionFollowup,
    deliverSessionFollowupMessage,
    reportSessionFollowupEvaluation,
    syncSessionFollowups,
} from './sessionFollowupExecutionService';

const now = new Date('2026-09-01T00:00:00.000Z');
const encrypted = new Uint8Array([1, 2, 3]);

function followup(patch: Record<string, unknown> = {}) {
    return {
        id: 'followup-1', projectId: 'project-1', ownerAccountId: 'account-1',
        machineAccountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1',
        revision: 2, generation: 3, step: 5, status: 'WAITING', terminalCode: null,
        totalRounds: 4, currentRound: 1, responseBoundarySeq: 10, lastObservedSeq: 10,
        pendingExpectedSeq: null, pendingLocalId: null, deletedAt: null,
        payloadVersion: 1, payloadCiphertext: encrypted, machineKeyVersion: 7,
        machineKeyEnvelope: encrypted, viewerKeyVersion: 8,
        claimTokenHash: null, claimExpiresAt: null, claimedGeneration: null, claimedStep: null,
        project: {
            accountId: 'account-1',
            automationViewerKeyVersion: 8,
            config: { workspaceDir: '/workspace/project', machineId: 'machine-1' },
        },
        ...patch,
    };
}

function makeTx(row = followup()): any {
    return {
        sessionFollowupChange: {
            findMany: vi.fn(async () => [{
                seq: 12n, followupId: row.id, machineAccountId: 'account-1', machineId: 'machine-1',
                revision: row.revision, generation: row.generation, kind: 'UPSERT', createdAt: now,
            }]),
            create: vi.fn(async () => ({})),
        },
        sessionFollowup: {
            findMany: vi.fn(async () => []),
            findFirst: vi.fn(async () => row),
            findUnique: vi.fn(async () => row),
            updateMany: vi.fn(async () => ({ count: 1 })),
        },
        sessionFollowupHistory: { create: vi.fn(async () => ({})) },
        machine: { findUnique: vi.fn(async () => ({ automationKeyVersion: 7 })) },
        projectMember: { findUnique: vi.fn(async () => ({ role: 'editor', status: 'accepted' })) },
        session: {
            findFirst: vi.fn(async () => ({ id: 'session-1', accountId: 'account-1', seq: 20, active: true })),
            updateMany: vi.fn(async () => ({ count: 1 })),
        },
        sessionMessage: {
            findFirst: vi.fn(async () => null),
            create: vi.fn(async () => ({
                id: 'message-1', sessionId: 'session-1', seq: 21,
                localId: 'happy-followup:followup-1:3:2', content: { t: 'encrypted', c: 'ciphertext' },
                createdAt: now, updatedAt: now,
            })),
        },
    };
}

describe('sessionFollowupExecutionService', () => {
    it('syncs only machine-targeted opaque payloads and tombstones', async () => {
        const tx = makeTx();
        const result = await syncSessionFollowups(tx as never, 'account-1', 'machine-1', { afterSeq: 0n, limit: 100 }, now);
        expect(result).toEqual({ ok: true, value: expect.objectContaining({
            nextSeq: 12n,
            hasMore: false,
            changes: [expect.objectContaining({ payloadCiphertext: encrypted, machineKeyEnvelope: encrypted })],
        }) });
        expect(tx.sessionFollowupChange.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 101 }));
        expect(tx.sessionFollowup.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            include: { project: { select: { config: true } } },
        }));
        expect((result as any).value.changes[0].projectWorkspaceDir).toBe('/workspace/project');
        expect((result as any).value.changes[0].viewerKeyEnvelope).toBeUndefined();
        expect((result as any).value.changes[0].reviewBody).toBeUndefined();
    });

    it('returns the daemon projection rather than the raw Prisma row for WAIT', async () => {
        const claimed = followup({
            viewerKeyId: 'viewer-key-id', viewerKeyEnvelope: encrypted,
            claimTokenHash: encrypted, claimExpiresAt: new Date(now.getTime() + 30_000),
        });
        const tx = makeTx(claimed);

        const result = await reportSessionFollowupEvaluation(tx as never, 'account-1', 'machine-1', {
            followupId: 'followup-1', generation: 3, step: 5, claimToken: 'claim',
            decision: 'WAIT', observedSeq: 14,
        }, now);

        expect(result).toEqual({ ok: true, value: expect.objectContaining({
            id: 'followup-1', lastObservedSeq: 14,
            projectWorkspaceDir: '/workspace/project',
        }) });
        expect((result as any).value).not.toHaveProperty('project');
        expect((result as any).value).not.toHaveProperty('ownerAccountId');
        expect((result as any).value).not.toHaveProperty('viewerKeyId');
        expect((result as any).value).not.toHaveProperty('viewerKeyEnvelope');
        expect((result as any).value).not.toHaveProperty('claimTokenHash');
        expect((result as any).value).not.toHaveProperty('terminalCode');
    });

    it('marks a truncated machine change page without exposing the next change', async () => {
        const tx = makeTx();
        tx.sessionFollowupChange.findMany.mockResolvedValue([
            { seq: 12n, followupId: 'followup-1', revision: 2, generation: 3, kind: 'UPSERT' },
            { seq: 13n, followupId: 'followup-2', revision: 1, generation: 1, kind: 'TOMBSTONE' },
        ]);
        await expect(syncSessionFollowups(
            tx as never, 'account-1', 'machine-1', { afterSeq: 0n, limit: 1 }, now,
        )).resolves.toEqual({ ok: true, value: expect.objectContaining({
            nextSeq: 12n,
            hasMore: true,
            changes: [expect.objectContaining({ followupId: 'followup-1' })],
        }) });
    });

    it('tombstones non-executable rows without poisoning other active changes', async () => {
        const tx = makeTx();
        tx.sessionFollowupChange.findMany.mockResolvedValue([
            { seq: 12n, followupId: 'paused-1', revision: 2, generation: 1, kind: 'UPSERT' },
            { seq: 13n, followupId: 'followup-1', revision: 2, generation: 3, kind: 'UPSERT' },
        ]);
        tx.sessionFollowup.findFirst
            .mockResolvedValueOnce(followup({
                id: 'paused-1', status: 'PAUSED', revision: 3, generation: 2,
            }))
            .mockResolvedValueOnce(followup());
        await expect(syncSessionFollowups(
            tx as never, 'account-1', 'machine-1', { afterSeq: 0n, limit: 100 }, now,
        )).resolves.toEqual({ ok: true, value: expect.objectContaining({
            hasMore: false,
            changes: [
                { seq: 12n, followupId: 'paused-1', revision: 3, generation: 2, kind: 'TOMBSTONE' },
                expect.objectContaining({ followupId: 'followup-1', kind: 'UPSERT', status: 'WAITING' }),
            ],
        }) });
    });

    it('claims one current generation/step with a hash-only token fence', async () => {
        const tx = makeTx();
        const result = await claimSessionFollowup(tx as never, 'account-1', 'machine-1', {
            followupId: 'followup-1', generation: 3, step: 5,
        }, now);
        expect(result).toEqual({ ok: true, value: expect.objectContaining({
            claimToken: expect.any(String), followup: expect.objectContaining({ id: 'followup-1' }),
        }) });
        const update = tx.sessionFollowup.updateMany.mock.calls[0]![0];
        expect(update.where).toEqual(expect.objectContaining({
            id: 'followup-1', generation: 3, step: 5,
            OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: now } }],
        }));
        expect(update.data.claimTokenHash).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(update.data.claimTokenHash).toString('base64url')).not.toBe((result as any).value.claimToken);

        tx.sessionFollowup.updateMany.mockResolvedValueOnce({ count: 0 });
        await expect(claimSessionFollowup(tx as never, 'account-1', 'machine-1', {
            followupId: 'followup-1', generation: 3, step: 5,
        }, now)).resolves.toEqual({ ok: false, error: 'already-claimed' });
    });

    it('invalidates a loop when its initiating editor no longer has execution permission', async () => {
        const revoked = followup({ ownerAccountId: 'editor-1' });
        const terminal = followup({
            ownerAccountId: 'editor-1', revision: 3, generation: 4, step: 6,
            status: 'FAILED', terminalCode: 'PERMISSION_REVOKED',
        });
        const tx = makeTx(revoked);
        tx.projectMember.findUnique.mockResolvedValue(null);
        tx.sessionFollowup.findMany.mockResolvedValue([revoked]);
        tx.sessionFollowup.findUnique.mockResolvedValue(terminal);

        await expect(claimSessionFollowup(tx as never, 'account-1', 'machine-1', {
            followupId: 'followup-1', generation: 3, step: 5,
        }, now)).resolves.toEqual({ ok: false, error: 'claim-denied' });
        expect(tx.sessionFollowup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                status: 'FAILED', terminalCode: 'PERMISSION_REVOKED', generation: { increment: 1 },
            }),
        }));
    });

    it('invalidates a loop when its target machine was deleted', async () => {
        const active = followup();
        const terminal = followup({
            revision: 3, generation: 4, step: 6,
            status: 'FAILED', terminalCode: 'TARGET_MISMATCH',
        });
        const tx = makeTx(active);
        tx.machine.findUnique.mockResolvedValue(null);
        tx.sessionFollowup.findMany.mockResolvedValue([active]);
        tx.sessionFollowup.findUnique.mockResolvedValue(terminal);

        await expect(claimSessionFollowup(tx as never, 'account-1', 'machine-1', {
            followupId: 'followup-1', generation: 3, step: 5,
        }, now)).resolves.toEqual({ ok: false, error: 'claim-denied' });
        expect(tx.sessionFollowup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                status: 'FAILED', terminalCode: 'TARGET_MISMATCH', generation: { increment: 1 },
            }),
        }));
    });

    it('reserves exactly one continuation without storing the review body', async () => {
        const reserved = followup({
            revision: 3, step: 6, status: 'DELIVERY_PENDING', pendingExpectedSeq: 20,
            pendingLocalId: 'happy-followup:followup-1:3:2',
        });
        const tx = makeTx();
        tx.sessionFollowup.findFirst.mockResolvedValue(followup({
            claimTokenHash: expect.anything(), claimExpiresAt: new Date(now.getTime() + 30_000),
        }) as any);
        tx.sessionFollowup.findUnique.mockResolvedValue(reserved);

        const result = await reportSessionFollowupEvaluation(tx as never, 'account-1', 'machine-1', {
            followupId: 'followup-1', generation: 3, step: 5, claimToken: 'claim',
            decision: 'CONTINUE', observedSeq: 20,
        }, now);
        expect(result).toEqual({ ok: true, value: expect.objectContaining({
            id: 'followup-1', status: 'DELIVERY_PENDING', pendingExpectedSeq: 20,
            pendingLocalId: 'happy-followup:followup-1:3:2',
        }) });
        expect(tx.sessionFollowup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                status: 'DELIVERY_PENDING', pendingExpectedSeq: 20,
                pendingLocalId: 'happy-followup:followup-1:3:2', step: { increment: 1 },
            }),
        }));
        expect(tx.sessionFollowupHistory.create).toHaveBeenCalledWith({ data: {
            followupId: 'followup-1', generation: 3, step: 6, round: 1,
            kind: 'CONTINUATION_RESERVED', terminalCode: null, observedSeq: 20,
            detailCiphertext: null,
        } });
    });

    it('rejects continue when rounds are exhausted', async () => {
        const tx = makeTx(followup({ currentRound: 4, totalRounds: 4 }));
        tx.sessionFollowup.findFirst.mockResolvedValue(followup({
            currentRound: 4, totalRounds: 4, claimExpiresAt: new Date(now.getTime() + 30_000),
        }));
        await expect(reportSessionFollowupEvaluation(tx as never, 'account-1', 'machine-1', {
            followupId: 'followup-1', generation: 3, step: 5, claimToken: 'claim',
            decision: 'CONTINUE', observedSeq: 20,
        }, now)).resolves.toEqual({ ok: false, error: 'rounds-exhausted' });
        expect(tx.sessionFollowup.updateMany).not.toHaveBeenCalled();
    });

    it('terminates a reserved delivery when the target session cannot resume', async () => {
        const pending = followup({
            revision: 3, step: 6, status: 'DELIVERY_PENDING', pendingExpectedSeq: 20,
            pendingLocalId: 'happy-followup:followup-1:3:2',
            claimExpiresAt: new Date(now.getTime() + 30_000),
        });
        const terminal = followup({
            revision: 4, step: 7, status: 'FAILED', terminalCode: 'SESSION_UNAVAILABLE',
            pendingExpectedSeq: null, pendingLocalId: null,
        });
        const tx = makeTx(pending);
        tx.sessionFollowup.findUnique.mockResolvedValue(terminal);

        await expect(reportSessionFollowupEvaluation(tx as never, 'account-1', 'machine-1', {
            followupId: 'followup-1', generation: 3, step: 6, claimToken: 'claim',
            decision: 'TERMINATE', observedSeq: 20, terminalCode: 'SESSION_UNAVAILABLE',
        }, now)).resolves.toEqual({ ok: true, value: expect.objectContaining({
            status: 'FAILED', pendingExpectedSeq: null, pendingLocalId: null,
        }) });
        expect(tx.sessionFollowup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ status: 'DELIVERY_PENDING', step: 6 }),
            data: expect.objectContaining({
                status: 'FAILED', terminalCode: 'SESSION_UNAVAILABLE',
                pendingExpectedSeq: null, pendingLocalId: null,
            }),
        }));
        expect(tx.sessionFollowupHistory.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            kind: 'TERMINATED', terminalCode: 'SESSION_UNAVAILABLE', observedSeq: 20,
        }) });
    });

    it('inserts the continuation and advances the round atomically once', async () => {
        const pending = followup({
            status: 'DELIVERY_PENDING', step: 6, pendingExpectedSeq: 20,
            pendingLocalId: 'happy-followup:followup-1:3:2',
            claimExpiresAt: new Date(now.getTime() + 30_000),
        });
        const advanced = followup({
            revision: 4, step: 7, currentRound: 2, status: 'WAITING',
            responseBoundarySeq: 21, lastObservedSeq: 21,
        });
        const tx = makeTx(pending);
        tx.sessionFollowup.findUnique.mockResolvedValue(advanced);
        const result = await deliverSessionFollowupMessage(tx as never, 'account-1', 'machine-1', {
            followupId: 'followup-1', generation: 3, step: 6, claimToken: 'claim',
            expectedSeq: 20, localId: 'happy-followup:followup-1:3:2', contentCiphertext: 'ciphertext',
        }, now);
        expect(result).toEqual({ ok: true, value: expect.objectContaining({ idempotent: false, messageSeq: 21 }) });
        expect(tx.session.updateMany).toHaveBeenCalledWith({
            where: { id: 'session-1', accountId: 'account-1', active: true, seq: 20 },
            data: { seq: { increment: 1 }, lastActiveAt: now },
        });
        expect(tx.sessionMessage.create).toHaveBeenCalledTimes(1);
        expect(tx.sessionFollowup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                status: 'WAITING', currentRound: { increment: 1 }, responseBoundarySeq: 21,
                pendingExpectedSeq: null, pendingLocalId: null,
            }),
        }));

        tx.sessionMessage.findFirst.mockResolvedValue({
            id: 'message-1', sessionId: 'session-1', seq: 21,
            localId: 'happy-followup:followup-1:3:2',
        });
        await expect(deliverSessionFollowupMessage(tx as never, 'account-1', 'machine-1', {
            followupId: 'followup-1', generation: 3, step: 6, claimToken: 'claim',
            expectedSeq: 20, localId: 'happy-followup:followup-1:3:2', contentCiphertext: 'ciphertext',
        }, now)).resolves.toEqual({ ok: true, value: {
            idempotent: true,
            messageSeq: 21,
            deliveredMessage: null,
            followup: expect.objectContaining({ id: 'followup-1', currentRound: 2, status: 'WAITING' }),
        } });
        expect(tx.sessionMessage.create).toHaveBeenCalledTimes(1);

        await expect(deliverSessionFollowupMessage(tx as never, 'account-1', 'machine-1', {
            followupId: 'followup-1', generation: 4, step: 6, claimToken: 'stale',
            expectedSeq: 20, localId: 'happy-followup:followup-1:3:2', contentCiphertext: 'ciphertext',
        }, now)).resolves.toEqual({ ok: false, error: 'claim-not-found' });
    });

    it('fails closed when a user message wins the sequence race', async () => {
        const pending = followup({
            status: 'DELIVERY_PENDING', step: 6, pendingExpectedSeq: 20,
            pendingLocalId: 'happy-followup:followup-1:3:2',
            claimExpiresAt: new Date(now.getTime() + 30_000),
        });
        const tx = makeTx(pending);
        tx.session.updateMany.mockResolvedValue({ count: 0 });
        tx.sessionFollowup.findUnique.mockResolvedValue(followup({
            status: 'COMPLETED', terminalCode: 'USER_INTERVENTION', step: 7,
            pendingExpectedSeq: null, pendingLocalId: null,
        }));
        await expect(deliverSessionFollowupMessage(tx as never, 'account-1', 'machine-1', {
            followupId: 'followup-1', generation: 3, step: 6, claimToken: 'claim',
            expectedSeq: 20, localId: 'happy-followup:followup-1:3:2', contentCiphertext: 'ciphertext',
        }, now)).resolves.toEqual({ ok: true, value: {
            idempotent: false,
            messageSeq: null,
            deliveredMessage: null,
            followup: expect.objectContaining({ status: 'COMPLETED' }),
        } });
        expect(tx.sessionMessage.create).not.toHaveBeenCalled();
        expect(tx.sessionFollowup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'COMPLETED', terminalCode: 'USER_INTERVENTION' }),
        }));
        expect(tx.sessionFollowupChange.create).toHaveBeenCalledTimes(1);
        expect(tx.sessionFollowupHistory.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            kind: 'TERMINATED', terminalCode: 'USER_INTERVENTION', observedSeq: 20,
        }) });
    });

    it('does not touch the session when a pause, stop, or delete wins the generation race', async () => {
        const pending = followup({
            status: 'DELIVERY_PENDING', step: 6, pendingExpectedSeq: 20,
            pendingLocalId: 'happy-followup:followup-1:3:2',
            claimExpiresAt: new Date(now.getTime() + 30_000),
        });
        const tx = makeTx(pending);
        // Models a concurrent control mutation clearing the claim/generation
        // immediately before delivery obtains the row lock.
        tx.sessionFollowup.updateMany.mockResolvedValueOnce({ count: 0 });

        await expect(deliverSessionFollowupMessage(tx as never, 'account-1', 'machine-1', {
            followupId: 'followup-1', generation: 3, step: 6, claimToken: 'stale-claim',
            expectedSeq: 20, localId: 'happy-followup:followup-1:3:2', contentCiphertext: 'ciphertext',
        }, now)).resolves.toEqual({ ok: false, error: 'claim-not-found' });

        expect(tx.sessionFollowup.updateMany).toHaveBeenCalledWith({
            where: expect.objectContaining({
                id: 'followup-1', generation: 3, step: 6,
                status: 'DELIVERY_PENDING', pendingExpectedSeq: 20,
                pendingLocalId: 'happy-followup:followup-1:3:2',
            }),
            data: { claimExpiresAt: pending.claimExpiresAt },
        });
        expect(tx.session.updateMany).not.toHaveBeenCalled();
        expect(tx.sessionMessage.create).not.toHaveBeenCalled();
    });

    it('rechecks project targeting after claim and before inserting a message', async () => {
        const pending = followup({
            status: 'DELIVERY_PENDING', step: 6, pendingExpectedSeq: 20,
            pendingLocalId: 'happy-followup:followup-1:3:2',
            claimExpiresAt: new Date(now.getTime() + 30_000),
            project: {
                accountId: 'account-1', automationViewerKeyVersion: 8,
                config: { workspaceDir: '/workspace/project', machineId: 'replacement-machine' },
            },
        });
        const terminal = followup({
            revision: 3, generation: 4, step: 7, status: 'FAILED', terminalCode: 'TARGET_MISMATCH',
        });
        const tx = makeTx(pending);
        tx.sessionFollowup.findMany.mockResolvedValue([pending]);
        tx.sessionFollowup.findUnique.mockResolvedValue(terminal);

        await expect(deliverSessionFollowupMessage(tx as never, 'account-1', 'machine-1', {
            followupId: 'followup-1', generation: 3, step: 6, claimToken: 'claim',
            expectedSeq: 20, localId: 'happy-followup:followup-1:3:2', contentCiphertext: 'ciphertext',
        }, now)).resolves.toEqual({ ok: true, value: expect.objectContaining({
            messageSeq: null,
            followup: expect.objectContaining({ status: 'FAILED' }),
        }) });
        expect(tx.session.updateMany).not.toHaveBeenCalled();
        expect(tx.sessionMessage.create).not.toHaveBeenCalled();
    });

    it('refuses another tenant or machine before touching the session', async () => {
        const tx = makeTx();
        tx.sessionFollowup.findFirst.mockResolvedValue(null);
        await expect(deliverSessionFollowupMessage(tx as never, 'foreign-account', 'machine-2', {
            followupId: 'followup-1', generation: 3, step: 6, claimToken: 'claim',
            expectedSeq: 20, localId: 'local', contentCiphertext: 'ciphertext',
        }, now)).resolves.toEqual({ ok: false, error: 'claim-not-found' });
        expect(tx.session.updateMany).not.toHaveBeenCalled();
    });
});
