import { describe, expect, it, vi } from 'vitest';
import { invalidateSessionFollowups } from './sessionFollowupInvalidationService';

describe('invalidateSessionFollowups', () => {
    it('generation-fences active claims and writes metadata-only terminal history', async () => {
        const row = {
            id: 'followup-1', projectId: 'project-1', ownerAccountId: 'editor-1',
            machineAccountId: 'owner-1', machineId: 'machine-1', revision: 2,
            generation: 3, step: 4, currentRound: 2, lastObservedSeq: 12,
        };
        const updated = { ...row, revision: 3, generation: 4, step: 5, status: 'FAILED' };
        const tx = {
            sessionFollowup: {
                findMany: vi.fn(async () => [row]),
                updateMany: vi.fn(async () => ({ count: 1 })),
                findUnique: vi.fn(async () => updated),
            },
            sessionFollowupChange: { create: vi.fn(async () => ({})) },
            sessionFollowupHistory: { create: vi.fn(async () => ({})) },
        };
        const now = new Date(10);

        await expect(invalidateSessionFollowups(
            tx as never,
            { projectId: 'project-1', ownerAccountId: 'editor-1' },
            'PERMISSION_REVOKED',
            now,
        )).resolves.toEqual([updated]);
        expect(tx.sessionFollowup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ revision: 2, generation: 3, step: 4 }),
            data: expect.objectContaining({
                status: 'FAILED', terminalCode: 'PERMISSION_REVOKED',
                revision: { increment: 1 }, generation: { increment: 1 }, step: { increment: 1 },
                claimTokenHash: null, pendingLocalId: null,
            }),
        }));
        expect(tx.sessionFollowupHistory.create).toHaveBeenCalledWith({ data: {
            followupId: 'followup-1', generation: 4, step: 5, round: 2,
            kind: 'TERMINATED', terminalCode: 'PERMISSION_REVOKED', observedSeq: 12,
            detailCiphertext: null,
        } });
    });
});
