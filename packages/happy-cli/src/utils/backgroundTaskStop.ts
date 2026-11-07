/**
 * `background-task-stop`: the session RPC that stops one background task this runtime lists in its metadata
 * (aplus-dev-studio-desktop specs/agent-background-work-panel R2). Claude stops a `claudeBackgroundTasks` task
 * through the SDK, Codex a `codexBackgroundTasks` terminal through the app-server.
 *
 * `requested` only means the provider accepted the stop. Whether the task ended is read from the list, which
 * drops it once the provider reports it gone; the client waits for that.
 */
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { ApiSessionClient } from '@/api/apiSession';
import { logger } from '@/ui/logger';

export type BackgroundTaskStopStatus = 'requested' | 'not_found' | 'unavailable' | 'unsupported' | 'failed';
export type BackgroundTaskStopResult = { status: BackgroundTaskStopStatus };

const MAX_TASK_ID_LENGTH = 512;

/** Publishes `runtimeCapabilities.backgroundTaskStop` on a session whose handler is registered. */
export function advertiseBackgroundTaskStop(session: Pick<ApiSessionClient, 'updateMetadata'>): void {
    session.updateMetadata(current => ({ ...current, runtimeCapabilities: { ...current.runtimeCapabilities, backgroundTaskStop: 1 } }));
}

export function registerBackgroundTaskStopHandler(
    rpcHandlerManager: Pick<RpcHandlerManager, 'registerHandler'>,
    stop: (taskId: string) => Promise<BackgroundTaskStopStatus>,
): void {
    rpcHandlerManager.registerHandler<unknown, BackgroundTaskStopResult>('background-task-stop', async (params) => {
        const taskId = (params as { taskId?: unknown } | null)?.taskId;
        if (typeof taskId !== 'string' || !taskId || taskId.length > MAX_TASK_ID_LENGTH) return { status: 'failed' };
        try {
            return { status: await stop(taskId) };
        } catch (error) {
            logger.debug('[background-task-stop] Stop failed', { error: String(error) });
            return { status: 'failed' };
        }
    });
}
