import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./log', () => ({ log: vi.fn() }));
afterEach(() => vi.resetModules());
describe('controlled standalone shutdown', () => {
    it('keeps signal handling through final database close and propagates close failure', async () => {
        const { awaitShutdown, onShutdown } = await import('./shutdown');
        const order: string[] = [];
        const before = process.listenerCount('SIGTERM');
        onShutdown('db', async () => { order.push('disconnect'); });
        const finalListenerCounts: number[] = [];
        await expect(awaitShutdown({
            requested: Promise.resolve(),
            finalize: async () => {
                order.push('close');
                finalListenerCounts.push(process.listenerCount('SIGTERM'));
                process.emit('SIGTERM');
                throw new Error('close failed');
            },
        })).rejects.toThrow('close failed');
        expect(order).toEqual(['disconnect', 'close']);
        expect(finalListenerCounts).toEqual([before + 1]);
        expect(process.listenerCount('SIGTERM')).toBe(before);
    });
    it('keeps repeated termination signals handled while draining', async () => {
        const { awaitShutdown, onShutdown } = await import('./shutdown');
        let release!: () => void;
        const before = process.listenerCount('SIGTERM');
        onShutdown('api', () => new Promise<void>(resolve => { release = resolve; }));
        const stopped = awaitShutdown();
        process.emit('SIGTERM');
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        const during = process.listenerCount('SIGTERM');
        process.emit('SIGTERM');
        release();
        await stopped;
        expect(during).toBe(before + 1);
        expect(process.listenerCount('SIGTERM')).toBe(before);
    });
    it('drains other handlers before disconnecting the database', async () => {
        const { awaitShutdown, onShutdown } = await import('./shutdown');
        const order: string[] = [];
        let release!: () => void;
        onShutdown('db', async () => { order.push('db'); });
        onShutdown('api', async () => { await new Promise<void>(r => { release = r; }); order.push('api'); });
        const stopped = awaitShutdown({ requested: Promise.resolve() });
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        expect(order).toEqual([]);
        release();
        await stopped;
        expect(order).toEqual(['api', 'db']);
    });
    it('reports a synchronous or asynchronous handler failure instead of successful drain', async () => {
        const { awaitShutdown, onShutdown } = await import('./shutdown');
        const disconnect = vi.fn(async () => {});
        onShutdown('db', disconnect);
        onShutdown('api', () => { throw new Error('drain failed'); });
        await expect(awaitShutdown({ requested: Promise.resolve() })).rejects.toThrow('Standalone shutdown failed');
        expect(disconnect).toHaveBeenCalledOnce();
    });
    it('retains SIGTERM shutdown and removes only its own listeners', async () => {
        const { awaitShutdown, onShutdown } = await import('./shutdown');
        const handler = vi.fn(async () => {});
        onShutdown('api', handler);
        const before = process.listenerCount('SIGTERM');
        const stopped = awaitShutdown();
        process.emit('SIGTERM');
        await stopped;
        expect(handler).toHaveBeenCalledOnce();
        expect(process.listenerCount('SIGTERM')).toBe(before);
    });
});
