import { logger } from '@/ui/logger';

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

export interface BashRpcDrainResult {
    /** Commands that were running when the drain began. */
    running: number;
    /** Commands still running when the drain gave up; they outlive the daemon. */
    remaining: number;
}

/**
 * Shutdown hooks of every scheduler in this process. Module state like the worktree queues in
 * daemon/worktreeOps: the daemon drains them without each handler set being plumbed to it.
 */
const liveSchedulers = new Set<(waitMs: number) => Promise<BashRpcDrainResult>>();

/**
 * Called before the daemon exits. Refuses new and queued commands with the retryable busy error (the
 * caller's retry reaches the next daemon) and waits a bounded time for running ones, so a Git writer
 * is neither started into a dying daemon nor cut off holding the shared repository lock. The bound
 * stays inside the 10 s `stopDaemon()` gives `/stop` before it SIGKILLs the daemon.
 */
export async function drainBashRpcs(options: { waitMs?: number } = {}): Promise<BashRpcDrainResult> {
    const results = await Promise.all([...liveSchedulers].map((shutdown) => shutdown(options.waitMs ?? 5_000)));
    const total = results.reduce((sum, result) => ({
        running: sum.running + result.running,
        remaining: sum.remaining + result.remaining,
    }), { running: 0, remaining: 0 });
    // An idle drain is the expected case; only commands caught by the shutdown are worth a line.
    if (total.running > 0) logger.debug(`[bash-rpc] shutdown drain: running=${total.running} stillRunning=${total.remaining}`);
    return total;
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
    let closed = false;
    const idleWaiters: Array<() => void> = [];

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
                if (running === 0) idleWaiters.splice(0).forEach((wake) => wake());
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

    const shutdown = async (waitMs: number): Promise<BashRpcDrainResult> => {
        closed = true;
        liveSchedulers.delete(shutdown);
        for (const item of [...foregroundQueue.splice(0), ...backgroundQueue.splice(0)]) {
            item.reject(new BashRpcBusyError('Daemon is shutting down'));
        }
        const atStart = running;
        if (running > 0) {
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([
                new Promise<void>((wake) => { idleWaiters.push(wake); }),
                new Promise<void>((wake) => { timer = setTimeout(wake, waitMs); }),
            ]);
            clearTimeout(timer);
        }
        notify();
        return { running: atStart, remaining: running };
    };
    liveSchedulers.add(shutdown);

    return {
        run<T>(executionClass: BashRpcExecutionClass, task: () => Promise<T> | T): Promise<T> {
            return new Promise<T>((resolve, reject) => {
                if (closed) {
                    reject(new BashRpcBusyError('Daemon is shutting down'));
                    return;
                }
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
