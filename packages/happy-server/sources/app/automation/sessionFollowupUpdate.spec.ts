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

import { emitSessionFollowupMessageUpdate } from './sessionFollowupUpdate';

describe('emitSessionFollowupMessageUpdate', () => {
    it('announces the inserted ciphertext through the normal session message channel', async () => {
        await emitSessionFollowupMessageUpdate({
            userId: 'account-1', sessionId: 'session-1', id: 'message-1', seq: 12,
            localId: 'happy-followup:followup-1:2:2', contentCiphertext: 'AQ==',
            createdAt: new Date(10), updatedAt: new Date(11),
        });

        expect(mocks.emitUpdate).toHaveBeenCalledWith({
            userId: 'account-1',
            payload: expect.objectContaining({
                id: 'update-id',
                seq: 7,
                body: expect.objectContaining({
                    t: 'new-message',
                    sid: 'session-1',
                    message: expect.objectContaining({
                        id: 'message-1', seq: 12,
                        content: { t: 'encrypted', c: 'AQ==' },
                    }),
                }),
            }),
            recipientFilter: { type: 'all-interested-in-session', sessionId: 'session-1' },
        });
    });
});
