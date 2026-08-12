import { describe, expect, it, vi } from 'vitest';
import { McpRuntimeRecovery, sanitizeMcpError } from './mcpRuntimeRecovery';

describe('McpRuntimeRecovery', () => {
    it('retries a failed server at most twice with backoff and reports recovery', async () => {
        const mcpServerStatus = vi.fn()
            .mockResolvedValueOnce([{ name: 'argos', status: 'failed', error: 'offline' }])
            .mockResolvedValueOnce([{ name: 'argos', status: 'failed', error: 'offline' }])
            .mockResolvedValueOnce([{ name: 'argos', status: 'connected' }]);
        const reconnectMcpServer = vi.fn(async () => {});
        const sleep = vi.fn(async () => {});
        const onStatus = vi.fn();
        const recovery = new McpRuntimeRecovery({ mcpServerStatus, reconnectMcpServer }, {
            backoffMs: 250,
            sleep,
            onStatus,
        });

        await recovery.recoverFailedServers();

        expect(reconnectMcpServer).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledWith(250);
        expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ name: 'argos', status: 'reconnecting' }));
        expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'argos', status: 'connected' }));
    });

    it('does not reconnect a server that needs authentication', async () => {
        const reconnectMcpServer = vi.fn();
        const recovery = new McpRuntimeRecovery({
            mcpServerStatus: vi.fn(async () => [{ name: 'argos', status: 'needs-auth' as const }]),
            reconnectMcpServer,
        });

        await recovery.recoverFailedServers();

        expect(reconnectMcpServer).not.toHaveBeenCalled();
    });

    it('classifies expected connector runtime and authentication failures distinctly', async () => {
        const onStatus = vi.fn();
        const recovery = new McpRuntimeRecovery({
            mcpServerStatus: vi.fn(async () => [
                { name: 'gmail', status: 'failed' as const, error: 'connection refused' },
                { name: 'knoi', status: 'needs-auth' as const },
                { name: 'argos', status: 'failed' as const, error: 'offline' },
            ]),
            reconnectMcpServer: vi.fn(async () => {}),
        }, {
            connectorNames: ['gmail', 'knoi'],
            maxAttempts: 0,
            onStatus,
        });

        await recovery.recoverFailedServers();

        expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
            name: 'gmail', status: 'connector-runtime-failed',
        }));
        expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
            name: 'knoi', status: 'connector-needs-auth',
        }));
        expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
            name: 'argos', status: 'failed',
        }));
    });

    it('deduplicates concurrent recovery for the same server', async () => {
        let releaseReconnect!: () => void;
        const reconnectBlocked = new Promise<void>((resolve) => { releaseReconnect = resolve; });
        const reconnectMcpServer = vi.fn(() => reconnectBlocked);
        const mcpServerStatus = vi.fn(async () => [{ name: 'argos', status: 'failed' as const }]);
        const recovery = new McpRuntimeRecovery({ mcpServerStatus, reconnectMcpServer }, {
            maxAttempts: 1,
        });

        const first = recovery.recoverFailedServers();
        const second = recovery.recoverFailedServers();
        await vi.waitFor(() => expect(reconnectMcpServer).toHaveBeenCalledOnce());
        releaseReconnect();
        await Promise.all([first, second]);

        expect(reconnectMcpServer).toHaveBeenCalledOnce();
    });

    it('opens a cooldown after repeated failure', async () => {
        let now = 1_000;
        const reconnectMcpServer = vi.fn(async () => { throw new Error('still offline'); });
        const recovery = new McpRuntimeRecovery({
            mcpServerStatus: vi.fn(async () => [{ name: 'argos', status: 'failed' as const }]),
            reconnectMcpServer,
        }, {
            maxAttempts: 2,
            backoffMs: 0,
            cooldownMs: 5_000,
            now: () => now,
        });

        await recovery.recoverFailedServers();
        await recovery.recoverFailedServers();
        expect(reconnectMcpServer).toHaveBeenCalledTimes(2);

        now += 5_001;
        await recovery.recoverFailedServers();
        expect(reconnectMcpServer).toHaveBeenCalledTimes(4);
    });

    it('deduplicates concurrent manual reconnect requests and returns a wire result', async () => {
        let releaseReconnect!: () => void;
        const blocked = new Promise<void>((resolve) => { releaseReconnect = resolve; });
        const reconnectMcpServer = vi.fn(() => blocked);
        const mcpServerStatus = vi.fn(async () => [{ name: 'argos', status: 'connected' as const }]);
        const recovery = new McpRuntimeRecovery({ mcpServerStatus, reconnectMcpServer }, {
            maxAttempts: 1,
        });

        const first = recovery.reconnectServer('argos');
        const second = recovery.reconnectServer('argos');
        await vi.waitFor(() => expect(reconnectMcpServer).toHaveBeenCalledOnce());
        releaseReconnect();

        await expect(Promise.all([first, second])).resolves.toEqual([
            { serverName: 'argos', status: 'success' },
            { serverName: 'argos', status: 'success' },
        ]);
    });

    it('returns not_available for an unknown manual reconnect target', async () => {
        const recovery = new McpRuntimeRecovery({
            mcpServerStatus: vi.fn(async () => []),
            reconnectMcpServer: vi.fn(),
        });

        await expect(recovery.reconnectServer('missing')).resolves.toEqual({
            serverName: 'missing',
            status: 'not_available',
        });
    });
});

describe('sanitizeMcpError', () => {
    it('redacts Authorization and bearer token values', () => {
        expect(sanitizeMcpError('Authorization: Bearer secret-token; Bearer another-secret')).toBe(
            'Authorization: [REDACTED]; Bearer [REDACTED]',
        );
        expect(sanitizeMcpError('{"Authorization":"Bearer json-secret"}')).toBe(
            '{"Authorization":"[REDACTED]"}',
        );
    });
});
