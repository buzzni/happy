import { buildNewMessageUpdate, eventRouter } from '@/app/events/eventRouter';
import { allocateUserSeq } from '@/storage/seq';
import { log } from '@/utils/log';
import { randomKeyNaked } from '@/utils/randomKeyNaked';

export async function emitSessionFollowupMessageUpdate(input: {
    userId: string;
    sessionId: string;
    id: string;
    seq: number;
    localId: string | null;
    contentCiphertext: string;
    createdAt: Date;
    updatedAt: Date;
}): Promise<void> {
    try {
        const updateSeq = await allocateUserSeq(input.userId);
        eventRouter.emitUpdate({
            userId: input.userId,
            payload: buildNewMessageUpdate({
                id: input.id,
                seq: input.seq,
                localId: input.localId,
                content: { t: 'encrypted', c: input.contentCiphertext },
                createdAt: input.createdAt,
                updatedAt: input.updatedAt,
            }, input.sessionId, updateSeq, randomKeyNaked(12)),
            recipientFilter: { type: 'all-interested-in-session', sessionId: input.sessionId },
        });
    } catch (error) {
        log({ module: 'session-followup', userId: input.userId, error }, 'Failed to emit session follow-up message update');
    }
}
