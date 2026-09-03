import { logger } from '@/ui/logger';

type CheckpointOperationSummary = {
    snapshot: { created: boolean };
    plan: { files: number; restore: number; delete: number; skip: number; conflict: number };
    restore: {
        status: 'cancelled' | 'stale-plan' | 'completed' | 'partial';
        files: number;
        failed: number;
    };
    gc: { prunedCheckpoints: number; retainedActive: number; storeBytes: number };
};

type CheckpointOperation = keyof CheckpointOperationSummary;

export type CheckpointOperationObservation = {
    schemaVersion: 1;
    operation: CheckpointOperation;
    outcome: 'success' | 'failure';
    durationMs: number;
    created?: boolean;
    files?: number;
    restore?: number;
    delete?: number;
    skip?: number;
    conflict?: number;
    status?: 'cancelled' | 'stale-plan' | 'completed' | 'partial';
    failed?: number;
    prunedCheckpoints?: number;
    retainedActive?: number;
    storeBytes?: number;
};

export type CheckpointOperationObserver = (event: CheckpointOperationObservation) => void;

type CheckpointOperationObservationOptions = {
    observer?: CheckpointOperationObserver;
    now?: () => number;
};

const defaultObserver: CheckpointOperationObserver = (event) => {
    logger.debug('[checkpoint-operation]', event);
};

export async function observeCheckpointOperation<Operation extends CheckpointOperation, Result>(
    operation: Operation,
    action: () => Promise<Result>,
    summarize: (result: Result) => CheckpointOperationSummary[Operation],
    options: CheckpointOperationObservationOptions = {},
): Promise<Result> {
    const now = options.now ?? Date.now;
    const observer = options.observer ?? defaultObserver;
    const startedAt = now();
    try {
        const result = await action();
        emit(observer, {
            schemaVersion: 1,
            operation,
            outcome: 'success',
            durationMs: elapsedMs(startedAt, now()),
            ...summarize(result),
        });
        return result;
    } catch (error) {
        emit(observer, {
            schemaVersion: 1,
            operation,
            outcome: 'failure',
            durationMs: elapsedMs(startedAt, now()),
        });
        throw error;
    }
}

function emit(observer: CheckpointOperationObserver, event: CheckpointOperationObservation): void {
    try {
        observer(event);
    } catch {
        // Observability must not change checkpoint safety or operation results.
    }
}

function elapsedMs(startedAt: number, endedAt: number): number {
    const elapsed = endedAt - startedAt;
    return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0;
}
