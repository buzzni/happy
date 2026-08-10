import { buildAutomationUpdate, eventRouter } from '@/app/events/eventRouter';
import { allocateUserSeq } from '@/storage/seq';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import { log } from '@/utils/log';

export interface AutomationUpdateData {
    projectId: string | null;
    automationId?: string;
    runId?: string;
    revision?: number;
    generation?: number;
    reason: 'viewer-key' | 'machine-key' | 'upsert' | 'delete' | 'sync' | 'run';
}

export async function emitAutomationUpdate(userId: string, data: AutomationUpdateData): Promise<void> {
    try {
        const seq = await allocateUserSeq(userId);
        eventRouter.emitUpdate({
            userId,
            payload: buildAutomationUpdate(data, seq, randomKeyNaked(12)),
            recipientFilter: { type: 'user-scoped-only' },
        });
    } catch (error) {
        log({ module: 'automation', userId, error }, 'Failed to emit automation update');
    }
}
