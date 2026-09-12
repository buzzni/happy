import { buildAutomationUpdate, eventRouter } from '@/app/events/eventRouter';
import { allocateUserSeq } from '@/storage/seq';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import { log } from '@/utils/log';
import { db } from '@/storage/db';

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

export async function emitProjectAutomationUpdate(
    projectId: string,
    data: AutomationUpdateData,
    fallbackUserId: string,
): Promise<void> {
    const userIds = new Set([fallbackUserId]);
    try {
        const project = await db.project.findUnique({
            where: { id: projectId },
            select: {
                accountId: true,
                members: {
                    where: { status: 'accepted' },
                    select: { accountId: true },
                },
            },
        });
        if (project) {
            userIds.add(project.accountId);
            for (const member of project.members) userIds.add(member.accountId);
        }
    } catch (error) {
        log({ module: 'automation', projectId, error }, 'Failed to resolve project automation update recipients');
    }
    await Promise.all([...userIds].map((userId) => emitAutomationUpdate(userId, data)));
}
