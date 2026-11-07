import { describe, expect, it, vi } from 'vitest';
import { registerBackgroundTaskStopHandler } from './backgroundTaskStop';

function registered(stop: (taskId: string) => Promise<never | 'requested' | 'not_found'>) {
    const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
    registerBackgroundTaskStopHandler({ registerHandler: (name: string, handler: (params: unknown) => Promise<unknown>) => { handlers.set(name, handler); } } as never, stop);
    return handlers.get('background-task-stop')!;
}

describe('background-task-stop RPC (specs/agent-background-work-panel R2)', () => {
    it('passes a task id to the runtime and answers its status', async () => {
        const stop = vi.fn(async () => 'requested' as const);
        await expect(registered(stop)({ taskId: 'shell-1' })).resolves.toEqual({ status: 'requested' });
        expect(stop).toHaveBeenCalledWith('shell-1');
    });

    it.each([[{}], [{ taskId: '' }], [{ taskId: 7 }], [{ taskId: 'x'.repeat(513) }], [null]])('refuses a malformed request %j without calling the runtime', async (params) => {
        const stop = vi.fn(async () => 'requested' as const);
        await expect(registered(stop)(params)).resolves.toEqual({ status: 'failed' });
        expect(stop).not.toHaveBeenCalled();
    });

    it('answers failed when the provider rejects the stop', async () => {
        await expect(registered(async () => { throw new Error('closed'); })({ taskId: 'a' })).resolves.toEqual({ status: 'failed' });
    });
});
