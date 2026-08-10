import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    allocateUserSeq: vi.fn(async () => 7),
    emitUpdate: vi.fn(),
    randomKeyNaked: vi.fn(() => 'update-id'),
}));

vi.mock('@/storage/seq', () => ({ allocateUserSeq: mocks.allocateUserSeq }));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: mocks.randomKeyNaked }));
vi.mock('@/app/events/eventRouter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/events/eventRouter')>();
    return { ...actual, eventRouter: { emitUpdate: mocks.emitUpdate } };
});

import { emitAutomationUpdate } from './automationUpdate';

describe('emitAutomationUpdate', () => {
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
});
