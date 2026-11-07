import { describe, expect, it, vi } from 'vitest';
import {
    BashRpcBusyError,
    createBashRpcScheduler,
    drainBashRpcs,
} from './bashRpcScheduler';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('bash RPC scheduler', () => {
    it('limits total execution to eight and background execution to four', async () => {
        const scheduler = createBashRpcScheduler();
        const gates = Array.from({ length: 16 }, () => deferred());
        let running = 0;
        let maxRunning = 0;
        let backgroundRunning = 0;
        let maxBackgroundRunning = 0;
        const tasks = gates.map((gate, index) => scheduler.run(
            index < 12 ? 'background' : 'foreground',
            async () => {
                running += 1;
                maxRunning = Math.max(maxRunning, running);
                if (index < 12) {
                    backgroundRunning += 1;
                    maxBackgroundRunning = Math.max(maxBackgroundRunning, backgroundRunning);
                }
                await gate.promise;
                running -= 1;
                if (index < 12) backgroundRunning -= 1;
            },
        ));

        await vi.waitFor(() => expect(scheduler.snapshot().running).toBe(8));
        expect(maxRunning).toBe(8);
        expect(maxBackgroundRunning).toBe(4);
        gates.forEach((gate) => gate.resolve());
        await Promise.all(tasks);
    });

    it('starts queued foreground work before queued background work', async () => {
        const scheduler = createBashRpcScheduler({
            maxConcurrent: 1,
            maxBackground: 1,
            maxQueued: 4,
        });
        const firstGate = deferred();
        const order: string[] = [];
        const first = scheduler.run('background', async () => {
            order.push('background-running');
            await firstGate.promise;
        });
        const queuedBackground = scheduler.run('background', async () => { order.push('background-queued'); });
        const queuedForeground = scheduler.run('foreground', async () => { order.push('foreground-queued'); });

        await vi.waitFor(() => expect(order).toEqual(['background-running']));
        firstGate.resolve();
        await Promise.all([first, queuedBackground, queuedForeground]);

        expect(order).toEqual([
            'background-running',
            'foreground-queued',
            'background-queued',
        ]);
    });

    it('caps the queue and admits foreground by evicting queued background work', async () => {
        const scheduler = createBashRpcScheduler({
            maxConcurrent: 1,
            maxBackground: 1,
            maxQueued: 2,
        });
        const firstGate = deferred();
        const first = scheduler.run('background', () => firstGate.promise);
        const evicted = scheduler.run('background', async () => undefined);
        const retained = scheduler.run('background', async () => undefined);
        const foreground = scheduler.run('foreground', async () => 'foreground');
        const overflow = scheduler.run('background', async () => undefined);

        await expect(evicted).rejects.toBeInstanceOf(BashRpcBusyError);
        await expect(overflow).rejects.toBeInstanceOf(BashRpcBusyError);
        expect(scheduler.snapshot()).toMatchObject({ running: 1, queued: 2 });
        firstGate.resolve();
        await expect(foreground).resolves.toBe('foreground');
        await Promise.all([first, retained]);
    });

    describe('at daemon shutdown', () => {
        it('refuses new work so a Git writer cannot start just before the daemon exits', async () => {
            const scheduler = createBashRpcScheduler();
            const task = vi.fn(async () => 'ran');
            await drainBashRpcs({ waitMs: 10 });

            await expect(scheduler.run('foreground', task)).rejects.toMatchObject({ errorCode: 'DAEMON_BUSY' });
            expect(task).not.toHaveBeenCalled();
        });

        it('refuses queued work that never started and waits for running work to finish', async () => {
            const scheduler = createBashRpcScheduler({ maxConcurrent: 1 });
            const gate = deferred();
            const running = scheduler.run('foreground', () => gate.promise);
            const queuedTask = vi.fn(async () => undefined);
            const queued = scheduler.run('foreground', queuedTask);
            await vi.waitFor(() => expect(scheduler.snapshot().running).toBe(1));

            const drained = drainBashRpcs({ waitMs: 5_000 });
            await expect(queued).rejects.toBeInstanceOf(BashRpcBusyError);
            gate.resolve();

            await expect(drained).resolves.toEqual({ running: 1, remaining: 0 });
            await running;
            expect(queuedTask).not.toHaveBeenCalled();
        });

        it('closes admission the moment shutdown is requested, before anything is awaited', async () => {
            const scheduler = createBashRpcScheduler();
            const task = vi.fn(async () => 'ran');
            const drained = drainBashRpcs({ waitMs: 10 });
            const late = scheduler.run('foreground', task);

            await expect(late).rejects.toMatchObject({ errorCode: 'DAEMON_BUSY' });
            await drained;
            expect(task).not.toHaveBeenCalled();
        });

        it('makes every concurrent shutdown path wait for the same running work', async () => {
            const scheduler = createBashRpcScheduler();
            const gate = deferred();
            const running = scheduler.run('foreground', () => gate.promise);
            await vi.waitFor(() => expect(scheduler.snapshot().running).toBe(1));

            const first = drainBashRpcs({ waitMs: 5_000 });
            const second = drainBashRpcs({ waitMs: 5_000 });
            const early = await Promise.race([second.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 20))]);
            gate.resolve();

            expect(early).toBe('waiting');
            await expect(Promise.all([first, second])).resolves.toEqual([{ running: 1, remaining: 0 }, { running: 1, remaining: 0 }]);
            await running;
        });

        it('stops waiting after the bound and reports the work still running', async () => {
            const scheduler = createBashRpcScheduler();
            const gate = deferred();
            const running = scheduler.run('foreground', () => gate.promise);
            await vi.waitFor(() => expect(scheduler.snapshot().running).toBe(1));

            await expect(drainBashRpcs({ waitMs: 20 })).resolves.toEqual({ running: 1, remaining: 1 });
            gate.resolve();
            await running;
        });
    });
});
