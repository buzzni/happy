import { expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { listAutomationPage } from './automationPageService';
it('bounds the SQL read, restricts accepted project access and continues by timestamp/id after deletion', async () => {
    const rows = [{ id: 'b', createdAt: new Date(100) }, { id: 'a', createdAt: new Date(100) }, { id: 'z', createdAt: new Date(99) }];
    const findMany = vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([rows[2]]);
    const tx = { automation: { findMany } } as unknown as Prisma.TransactionClient;
    const first = await listAutomationPage(tx, 'actor', { projectIds: ['chat:c'], limit: 2, cursor: null });
    expect(first.automations.map(row => row.id)).toEqual(['b', 'a']);
    expect(findMany.mock.calls[0][0]).toMatchObject({ take: 3, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], where: {
        deletedAt: null, payloadVersion: { not: 3 }, projectId: { in: ['chat:c'] },
        project: { OR: [{ accountId: 'actor' }, { members: { some: { accountId: 'actor', status: 'accepted' } } }] },
    } });
    const last = await listAutomationPage(tx, 'actor', { projectIds: ['chat:c'], limit: 2, cursor: first.nextCursor });
    expect(findMany.mock.calls[1][0].where.OR).toEqual([{ createdAt: { lt: new Date(100) } }, { createdAt: new Date(100), id: { lt: 'a' } }]);
    expect(last.nextCursor).toBeNull(); expect(last.automations).toHaveLength(1);
});
it('rejects malformed cursors before reading storage', async () => {
    const findMany = vi.fn();
    await expect(listAutomationPage({ automation: { findMany } } as unknown as Prisma.TransactionClient, 'actor', { projectIds: ['chat:c'], limit: 20, cursor: 'invalid' })).rejects.toThrow('invalid-automation-cursor');
    expect(findMany).not.toHaveBeenCalled();
});
