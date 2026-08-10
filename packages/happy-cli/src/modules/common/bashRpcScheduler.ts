export type BashRpcExecutionClass = 'foreground' | 'background';

export interface BashRpcSchedulerSnapshot {
    running: number;
    runningBackground: number;
    queued: number;
    queuedForeground: number;
    queuedBackground: number;
}

export class BashRpcBusyError extends Error {
    readonly errorCode = 'DAEMON_BUSY';
    readonly retryAfterMs = 1_000;

    constructor(message = 'Daemon is busy') {
        super(message);
        this.name = 'BashRpcBusyError';
    }
}

interface QueuedTask<T> {
    executionClass: BashRpcExecutionClass;
    task: () => Promise<T> | T;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
}

export interface BashRpcScheduler {
    run<T>(executionClass: BashRpcExecutionClass, task: () => Promise<T> | T): Promise<T>;
    snapshot(): BashRpcSchedulerSnapshot;
}

export function createBashRpcScheduler(options: {
    maxConcurrent?: number;
    maxBackground?: number;
    maxQueued?: number;
    onStateChange?: (snapshot: BashRpcSchedulerSnapshot) => void;
} = {}): BashRpcScheduler {
    const maxConcurrent = options.maxConcurrent ?? 8;
    const maxBackground = options.maxBackground ?? 4;
    const maxQueued = options.maxQueued ?? 128;
    const foregroundQueue: Array<QueuedTask<unknown>> = [];
    const backgroundQueue: Array<QueuedTask<unknown>> = [];
    let running = 0;
    let runningBackground = 0;

    const snapshot = (): BashRpcSchedulerSnapshot => ({
        running,
        runningBackground,
        queued: foregroundQueue.length + backgroundQueue.length,
        queuedForeground: foregroundQueue.length,
        queuedBackground: backgroundQueue.length,
    });
    const notify = () => options.onStateChange?.(snapshot());

    const start = (item: QueuedTask<unknown>) => {
        running += 1;
        if (item.executionClass === 'background') runningBackground += 1;
        notify();
        Promise.resolve()
            .then(item.task)
            .then(item.resolve, item.reject)
            .finally(() => {
                running -= 1;
                if (item.executionClass === 'background') runningBackground -= 1;
                drain();
            });
    };

    const drain = () => {
        while (running < maxConcurrent) {
            const foreground = foregroundQueue.shift();
            if (foreground) {
                start(foreground);
                continue;
            }
            if (runningBackground >= maxBackground) break;
            const background = backgroundQueue.shift();
            if (!background) break;
            start(background);
        }
        notify();
    };

    return {
        run<T>(executionClass: BashRpcExecutionClass, task: () => Promise<T> | T): Promise<T> {
            return new Promise<T>((resolve, reject) => {
                if (foregroundQueue.length + backgroundQueue.length >= maxQueued) {
                    if (executionClass === 'foreground' && backgroundQueue.length > 0) {
                        const evicted = backgroundQueue.shift();
                        evicted?.reject(new BashRpcBusyError());
                    } else {
                        reject(new BashRpcBusyError());
                        return;
                    }
                }
                const item: QueuedTask<T> = { executionClass, task, resolve, reject };
                if (executionClass === 'foreground') {
                    foregroundQueue.push(item as QueuedTask<unknown>);
                } else {
                    backgroundQueue.push(item as QueuedTask<unknown>);
                }
                drain();
            });
        },
        snapshot,
    };
}
