type Tx = any;

export type SessionFollowupInvalidationCode =
    | 'PERMISSION_REVOKED'
    | 'TARGET_MISMATCH'
    | 'DECRYPT_FAILED';

export async function invalidateSessionFollowups(
    tx: Tx,
    filter: {
        followupId?: string;
        projectId?: string;
        ownerAccountId?: string;
        machineAccountId?: string;
        machineId?: string;
    },
    terminalCode: SessionFollowupInvalidationCode,
    now = new Date(),
): Promise<any[]> {
    if (Object.values(filter).every((value) => value === undefined)) {
        throw new Error('session-followup-invalidation-filter-required');
    }
    const rows = await tx.sessionFollowup.findMany({
        where: {
            ...filter,
            deletedAt: null,
            status: { in: ['WAITING', 'DELIVERY_PENDING', 'PAUSED'] },
        },
    });
    const invalidated: any[] = [];
    for (const row of rows) {
        const changed = await tx.sessionFollowup.updateMany({
            where: {
                id: row.id,
                revision: row.revision,
                generation: row.generation,
                step: row.step,
                deletedAt: null,
                status: { in: ['WAITING', 'DELIVERY_PENDING', 'PAUSED'] },
            },
            data: {
                status: 'FAILED',
                terminalCode,
                completedAt: now,
                revision: { increment: 1 },
                generation: { increment: 1 },
                step: { increment: 1 },
                pendingExpectedSeq: null,
                pendingLocalId: null,
                claimTokenHash: null,
                claimExpiresAt: null,
                claimedGeneration: null,
                claimedStep: null,
            },
        });
        if (changed.count !== 1) continue;
        const updated = await tx.sessionFollowup.findUnique({
            where: { id: row.id },
            include: { project: { select: { config: true } } },
        });
        if (!updated) continue;
        await tx.sessionFollowupChange.create({ data: {
            followupId: updated.id,
            machineAccountId: updated.machineAccountId,
            machineId: updated.machineId,
            revision: updated.revision,
            generation: updated.generation,
            kind: 'UPSERT',
        } });
        await tx.sessionFollowupHistory.create({ data: {
            followupId: updated.id,
            generation: updated.generation,
            step: updated.step,
            round: updated.currentRound,
            kind: 'TERMINATED',
            terminalCode,
            observedSeq: updated.lastObservedSeq,
            detailCiphertext: null,
        } });
        invalidated.push(updated);
    }
    return invalidated;
}
