import { describe, expect, it, vi } from 'vitest';
import { McpRuntimeRecovery } from './mcpRuntimeRecovery';
import { registerMcpReconnectHandler } from './registerMcpReconnectHandler';

describe('registerMcpReconnectHandler', () => {
    it('deduplicates concurrent requests for the current session', async () => {
        let handler!: (params: unknown) => Promise<unknown>;
        const rpcHandlerManager = {
            registerHandler: vi.fn((_method: string, registered: typeof handler) => { if (_method === 'mcp-reconnect') handler = registered; }),
        };
        let releaseReconnect!: () => void;
        const blocked = new Promise<void>((resolve) => { releaseReconnect = resolve; });
        const reconnectMcpServer = vi.fn(() => blocked);
        const recovery = new McpRuntimeRecovery({
            mcpServerStatus: vi.fn(async () => [{ name: 'argos', status: 'connected' as const }]),
            reconnectMcpServer,
        }, { maxAttempts: 1 });
        registerMcpReconnectHandler(rpcHandlerManager as any, 'session-1', () => recovery);

        const first = handler({ sessionId: 'session-1', serverName: 'argos' });
        const second = handler({ sessionId: 'session-1', serverName: 'argos' });
        await vi.waitFor(() => expect(reconnectMcpServer).toHaveBeenCalledOnce());
        releaseReconnect();

        await expect(Promise.all([first, second])).resolves.toEqual([
            { serverName: 'argos', status: 'success' },
            { serverName: 'argos', status: 'success' },
        ]);
        expect(rpcHandlerManager.registerHandler).toHaveBeenCalledWith('mcp-reconnect', expect.any(Function));
    });

    it('rejects a request for another session before reaching the controller', async () => {
        let handler!: (params: unknown) => Promise<unknown>;
        const reconnectServer = vi.fn();
        registerMcpReconnectHandler({
            registerHandler: (_method: string, registered: typeof handler) => { if (_method === 'mcp-reconnect') handler = registered; },
        } as any, 'session-1', () => ({ reconnectServer } as any));

        await expect(handler({ sessionId: 'session-2', serverName: 'argos' })).resolves.toEqual({
            serverName: 'argos',
            status: 'not_available',
        });
        expect(reconnectServer).not.toHaveBeenCalled();
    });
});


it('serves status through the read-only controller while mutation is unavailable', async () => {
    const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
    const readStatuses = vi.fn(async () => [{ name: 'qa', status: 'connected' as const, checkedAt: 123 }]);
    registerMcpReconnectHandler({ registerHandler: (name: string, handler: (params: unknown) => Promise<unknown>) => handlers.set(name, handler) } as any,
        'session-1', () => null, () => ({ readStatuses }));
    expect(await handlers.get('mcp-status')!({ sessionId: 'session-1' })).toEqual({ statuses: [{ name: 'qa', status: 'connected', checkedAt: 123 }] });
    await expect(handlers.get('mcp-status')!({ sessionId: 'session-2' })).rejects.toThrow('Session mismatch');
    expect(readStatuses).toHaveBeenCalledOnce();
    expect(await handlers.get('mcp-reconnect')!({ sessionId: 'session-1', serverName: 'qa' })).toEqual({ serverName: 'qa', status: 'not_available' });
});
