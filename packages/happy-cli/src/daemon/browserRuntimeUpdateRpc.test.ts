import { describe, it, expect, vi } from 'vitest';
import { registerBrowserRuntimeUpdateRpc } from './browserRuntimeUpdateRpc';
describe('browser runtime update carrier', () => {
    it('rejects command fields and missing signatures before invoking a privileged helper', async () => {
        const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
        const invoke = vi.fn();
        registerBrowserRuntimeUpdateRpc({ registerHandler: (name, handler) => { handlers.set(name, handler); } }, invoke);
        const handler = handlers.get('browser-runtime:update')!;
        await expect(handler({ command: 'sudo anything' })).rejects.toThrow();
        await expect(handler({ token: 'abp2.a.b.c', command: 'anything' })).rejects.toThrow();
        expect(invoke).not.toHaveBeenCalled();
        invoke.mockResolvedValue({ phase: 'idle' });
        expect(await handler({ token: 'abp2.a.b.c' })).toEqual({ phase: 'idle' });
        expect(invoke).toHaveBeenCalledWith('abp2.a.b.c');
    });
});
