import type { Prisma } from '@prisma/client';

export async function listAutomationPage(tx: Prisma.TransactionClient, actorId: string,
    input: { projectIds: string[]; limit: number; cursor: string | null; reservationExtensions?: boolean }) {
    let after: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
        try {
            const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
            if (!Array.isArray(value) || value.length !== 2 || !Number.isSafeInteger(value[0]) || value[0] < 0
                || typeof value[1] !== 'string' || !value[1] || !Number.isFinite(new Date(value[0]).getTime())) throw new Error();
            after = { createdAt: new Date(value[0]), id: value[1] };
        } catch { throw new Error('invalid-automation-cursor'); }
    }
    const rows = await tx.automation.findMany({
        where: {
            projectId: { in: input.projectIds }, deletedAt: null,
            // Retired native v5 rows stay hidden on both paths.
            ...(input.reservationExtensions ? { payloadVersion: { not: 5 }, AND: [{ OR: [{ projectId: { not: { startsWith: 'chat:' } } }, { payloadVersion: 3 }] }] } : { payloadVersion: { notIn: [3, 5] } }),
            project: { OR: [{ accountId: actorId }, { members: { some: { accountId: actorId, status: 'accepted' } } }] },
            ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: input.limit + 1,
        include: { scriptRevisions: { orderBy: { revision: 'desc' as const }, take: 1 }, targetMachine: true, project: true, runs: { orderBy: [{ claimedAt: 'desc' }, { scheduledFor: 'desc' }], take: 20 } },
    });
    const automations = rows.slice(0, input.limit), last = automations.at(-1);
    return { automations, nextCursor: rows.length > input.limit && last
        ? Buffer.from(JSON.stringify([last.createdAt.getTime(), last.id])).toString('base64url') : null };
}
