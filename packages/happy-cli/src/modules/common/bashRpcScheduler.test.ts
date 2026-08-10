import { describe, expect, it, vi } from 'vitest';
import {
    BashRpcBusyError,
    createBashRpcScheduler,
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
});
