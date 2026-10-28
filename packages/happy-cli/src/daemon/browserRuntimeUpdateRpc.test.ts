import { describe, it, expect, vi } from 'vitest';
import { registerBrowserRuntimeUpdateRpc } from './browserRuntimeUpdateRpc';

function register(invoke: ReturnType<typeof vi.fn>, env: NodeJS.ProcessEnv): (params: unknown) => Promise<unknown> {
    const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
    registerBrowserRuntimeUpdateRpc({ registerHandler: (name, handler) => { handlers.set(name, handler); } }, invoke, env);
    return handlers.get('browser-runtime:update')!;
}

describe('browser runtime update carrier', () => {
    it('rejects command fields and missing signatures before invoking a privileged helper', async () => {
        const invoke = vi.fn();
        const handler = register(invoke, {});
        await expect(handler({ command: 'sudo anything' })).rejects.toThrow();
        await expect(handler({ token: 'abp2.a.b.c', command: 'anything' })).rejects.toThrow();
        expect(invoke).not.toHaveBeenCalled();
        invoke.mockResolvedValue({ phase: 'idle' });
        expect(await handler({ token: 'abp2.a.b.c' })).toEqual({ phase: 'idle' });
        expect(invoke).toHaveBeenCalledWith('abp2.a.b.c');
    });

    it('tells browser-only hosts to update locally instead of calling the helper they never receive', async () => {
        const invoke = vi.fn();
        const env: NodeJS.ProcessEnv = {};
        const handler = register(invoke, env);
        env.HAPPY_BROWSER_TASK_HOST_MODE = 'browser-only';
        await expect(handler({ command: 'sudo anything' })).rejects.toThrow('INVALID_UPDATE_REQUEST');
        await expect(handler({ token: 'abp2.a.b.c' })).rejects.toThrow('BROWSER_UPDATE_LOCAL_REQUIRED');
        expect(invoke).not.toHaveBeenCalled();
    });

    it('keeps invoking the helper on dedicated hosts', async () => {
        const invoke = vi.fn().mockResolvedValue({ phase: 'running' });
        const handler = register(invoke, { HAPPY_BROWSER_TASK_HOST_MODE: 'dedicated-host' });
        expect(await handler({ token: 'abp2.a.b.c' })).toEqual({ phase: 'running' });
        expect(invoke).toHaveBeenCalledWith('abp2.a.b.c');
    });
});
