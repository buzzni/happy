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

/** The signal aborts once a daemon shutdown stops waiting for this command. */
type BashRpcTask<T> = (signal: AbortSignal) => Promise<T> | T;

interface QueuedTask<T> {
    executionClass: BashRpcExecutionClass;
    task: BashRpcTask<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
}

export interface BashRpcScheduler {
    run<T>(executionClass: BashRpcExecutionClass, task: BashRpcTask<T>): Promise<T>;
    snapshot(): BashRpcSchedulerSnapshot;
}

export interface BashRpcDrainResult {
    /** Commands that were running when the drain began. */
    running: number;
    /** Commands still running at the bound, sent SIGTERM so their own cleanup traps run. */
    terminated: number;
    /** Commands still running after termination; they outlive the daemon. */
    remaining: number;
}

type DrainOptions = { waitMs: number; termGraceMs: number };

/**
 * Shutdown hooks of every scheduler in this process. Module state like the worktree queues in
 * daemon/worktreeOps: the daemon drains them without each handler set being plumbed to it.
 */
const liveSchedulers = new Set<(options: DrainOptions) => Promise<BashRpcDrainResult>>();

/**
 * Called on every daemon exit path. The first call closes admission synchronously: new and queued commands
 * get the busy error (the caller may retry against the next daemon), so a Git writer is never started into a
 * dying daemon. Running commands get `waitMs`, counted from that first call so the wait overlaps the rest of
 * the teardown; then SIGTERM, so a writer's trap releases the shared repository lock instead of the shell dying
 * of SIGPIPE after the daemon exits (a signal-killed shell skips its EXIT trap). The shell defers the trap until
 * its foreground command returns, so a write is never cut off. Both bounds stay inside the 10 s `stopDaemon()`
 * gives `/stop` before it SIGKILLs the daemon. Concurrent callers share the same wait.
 */
export async function drainBashRpcs(options: Partial<DrainOptions> = {}): Promise<BashRpcDrainResult> {
    const resolved = { waitMs: options.waitMs ?? 5_000, termGraceMs: options.termGraceMs ?? 1_000 };
    const results = await Promise.all([...liveSchedulers].map((shutdown) => shutdown(resolved)));
    const total = results.reduce((sum, result) => ({
        running: sum.running + result.running,
        terminated: sum.terminated + result.terminated,
        remaining: sum.remaining + result.remaining,
    }), { running: 0, terminated: 0, remaining: 0 });
    // An idle drain is the expected case; only commands caught by the shutdown are worth a line.
    if (total.running > 0) {
        logger.debug(`[bash-rpc] shutdown drain: running=${total.running} terminated=${total.terminated} stillRunning=${total.remaining}`
            + (total.terminated > 0 ? ' (a terminated Git writer releases its repository lock from its own trap)' : ''));
    }
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
    let shuttingDown: Promise<BashRpcDrainResult> | null = null;
    const idleWaiters: Array<() => void> = [];
    const termination = new AbortController();

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
            .then(() => item.task(termination.signal))
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

    /** Resolves true once nothing runs, false when the bound passes first. */
    const idleWithin = async (ms: number): Promise<boolean> => {
        if (running === 0) return true;
        let timer: NodeJS.Timeout | undefined;
        const idle = await Promise.race([
            new Promise<boolean>((wake) => { idleWaiters.push(() => wake(true)); }),
            new Promise<boolean>((wake) => { timer = setTimeout(() => wake(false), ms); }),
        ]);
        clearTimeout(timer);
        return idle;
    };

    // Memoized: a second shutdown path (e.g. a signal during bundle handoff) waits on the same commands
    // instead of finding nothing to wait for. The close below runs before the first await.
    const shutdown = (drainOptions: DrainOptions): Promise<BashRpcDrainResult> => shuttingDown ??= (async () => {
        closed = true;
        for (const item of [...foregroundQueue.splice(0), ...backgroundQueue.splice(0)]) {
            item.reject(new BashRpcBusyError('Daemon is shutting down'));
        }
        notify();
        const atStart = running;
        if (await idleWithin(drainOptions.waitMs)) return { running: atStart, terminated: 0, remaining: 0 };
        const terminated = running;
        termination.abort();
        await idleWithin(drainOptions.termGraceMs);
        return { running: atStart, terminated, remaining: running };
    })().finally(() => liveSchedulers.delete(shutdown));
    liveSchedulers.add(shutdown);

    return {
        run<T>(executionClass: BashRpcExecutionClass, task: BashRpcTask<T>): Promise<T> {
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
