import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    allocateUserSeq: vi.fn(async () => 7),
    emitUpdate: vi.fn(),
    randomKeyNaked: vi.fn(() => 'update-id'),
    projectFindUnique: vi.fn(),
}));

vi.mock('@/storage/seq', () => ({ allocateUserSeq: mocks.allocateUserSeq }));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: mocks.randomKeyNaked }));
vi.mock('@/storage/db', () => ({
    db: { project: { findUnique: mocks.projectFindUnique } },
}));
vi.mock('@/app/events/eventRouter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/events/eventRouter')>();
    return { ...actual, eventRouter: { emitUpdate: mocks.emitUpdate } };
});

import { emitAutomationUpdate, emitProjectAutomationUpdate } from './automationUpdate';

describe('emitAutomationUpdate', () => {
    beforeEach(() => vi.clearAllMocks());

    it('emits metadata only to user-scoped clients with a user sequence', async () => {
        await emitAutomationUpdate('account-1', {
            projectId: 'project-1', automationId: 'automation-1', revision: 2,
            generation: 3, reason: 'upsert',
        });

        expect(mocks.emitUpdate).toHaveBeenCalledWith({
            userId: 'account-1',
            payload: expect.objectContaining({
                id: 'update-id',
                seq: 7,
                body: {
                    t: 'automation-updated', projectId: 'project-1', automationId: 'automation-1',
                    revision: 2, generation: 3, reason: 'upsert',
                },
            }),
            recipientFilter: { type: 'user-scoped-only' },
        });
    });

    it('fans project invalidations out to the owner and accepted members', async () => {
        mocks.projectFindUnique.mockResolvedValue({
            accountId: 'owner-1',
            members: [{ accountId: 'editor-1' }, { accountId: 'owner-1' }],
        });

        await emitProjectAutomationUpdate(
            'project-1',
            { projectId: 'project-1', reason: 'sync' },
            'editor-1',
        );

        expect(mocks.projectFindUnique).toHaveBeenCalledWith({
            where: { id: 'project-1' },
            select: {
                accountId: true,
                members: {
                    where: { status: 'accepted' },
                    select: { accountId: true },
                },
            },
        });
        expect(mocks.emitUpdate.mock.calls.map(([input]) => input.userId).sort())
            .toEqual(['editor-1', 'owner-1']);
    });
});
