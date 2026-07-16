import { McpReconnectRequestSchema, type McpReconnectResult } from '@slopus/happy-wire';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { McpRuntimeRecovery } from './mcpRuntimeRecovery';

type McpReconnectController = Pick<McpRuntimeRecovery, 'reconnectServer'>;

export function registerMcpReconnectHandler(
    rpcHandlerManager: RpcHandlerManager,
    sessionId: string,
    getController: () => McpReconnectController | null,
): void {
    rpcHandlerManager.registerHandler<unknown, McpReconnectResult>('mcp-reconnect', async (params) => {
        const parsed = McpReconnectRequestSchema.safeParse(params);
        if (!parsed.success) {
            return { serverName: 'unknown', status: 'failed', error: 'Invalid MCP reconnect request' };
        }
        const { serverName } = parsed.data;
        if (parsed.data.sessionId !== sessionId) {
            return { serverName, status: 'not_available' };
        }
        const controller = getController();
        if (!controller) {
            return { serverName, status: 'not_available' };
        }
        return controller.reconnectServer(serverName);
    });
}
