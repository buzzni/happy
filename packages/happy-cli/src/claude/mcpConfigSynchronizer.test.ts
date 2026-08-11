import { describe, expect, it, vi } from 'vitest';
import { McpConfigSynchronizer } from './mcpConfigSynchronizer';

const { loggerDebug } = vi.hoisted(() => ({ loggerDebug: vi.fn() }));

vi.mock('@/ui/logger', () => ({
    logger: { debug: loggerDebug },
}));

const baseServers = {
    happy: { type: 'http', url: 'http://127.0.0.1:4000/mcp' },
};
const initialAplusServers = {
    argos: {
        type: 'http' as const,
        url: 'https://argos.test/mcp',
        headers: { Authorization: 'Bearer old-secret', 'X-Project': 'project-1' },
    },
};

describe('McpConfigSynchronizer', () => {
    it('treats an unconfigured A+ source as disabled instead of failed', async () => {
        const onStatus = vi.fn();
        const synchronizer = new McpConfigSynchronizer({ setMcpServers: vi.fn() } as any, {
            baseServers,
            initialAplusServers: {},
            fetchAplusServers: vi.fn(async () => ({
                ok: false as const,
                reason: 'not-configured' as const,
                error: 'mcp-config URL is not configured',
            })),
            onStatus,
        });

        await synchronizer.sync();

        expect(onStatus).not.toHaveBeenCalled();
    });

    it('keeps last-known-good servers when config fetch fails', async () => {
        const setMcpServers = vi.fn();
        const onStatus = vi.fn();
        const synchronizer = new McpConfigSynchronizer({ setMcpServers } as any, {
            baseServers,
            initialAplusServers,
            fetchAplusServers: vi.fn(async () => ({
                ok: false as const,
                reason: 'http-error' as const,
                error: 'mcp-config responded with 503',
            })),
            onStatus,
        });

        await synchronizer.sync();

        expect(setMcpServers).not.toHaveBeenCalled();
        expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
            name: 'aplus-config',
            status: 'config-fetch-failed',
        }));
    });

    it('keeps last-known-good servers when config fetch throws', async () => {
        const setMcpServers = vi.fn();
        const onStatus = vi.fn();
        const synchronizer = new McpConfigSynchronizer({ setMcpServers } as any, {
            baseServers,
            initialAplusServers,
            fetchAplusServers: vi.fn(async () => {
                throw new Error('network exploded');
            }),
            onStatus,
        });

        await synchronizer.sync();

        expect(setMcpServers).not.toHaveBeenCalled();
        expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
            name: 'aplus-config',
            status: 'config-fetch-failed',
        }));
    });

    it('does not apply a semantically identical config', async () => {
        const setMcpServers = vi.fn();
        const synchronizer = new McpConfigSynchronizer({ setMcpServers } as any, {
            baseServers,
            initialAplusServers,
            fetchAplusServers: vi.fn(async () => ({
                ok: true as const,
                servers: {
                    argos: {
                        headers: { 'X-Project': 'project-1', Authorization: 'Bearer old-secret' },
                        url: 'https://argos.test/mcp',
                        type: 'http' as const,
                    },
                },
            })),
        });

        await synchronizer.sync();

        expect(setMcpServers).not.toHaveBeenCalled();
    });

    it('applies a changed header once without exposing it in status', async () => {
        const setMcpServers = vi.fn(async () => ({ added: [], removed: [], errors: {} }));
        const onApplied = vi.fn();
        const onStatus = vi.fn();
        const changed = {
            argos: {
                ...initialAplusServers.argos,
                headers: { ...initialAplusServers.argos.headers, Authorization: 'Bearer new-secret' },
            },
        };
        const fetchAplusServers = vi.fn(async () => ({ ok: true as const, servers: changed }));
        const synchronizer = new McpConfigSynchronizer({ setMcpServers } as any, {
            baseServers,
            initialAplusServers,
            fetchAplusServers,
            onApplied,
            onStatus,
        });

        await synchronizer.sync();
        await synchronizer.sync();

        expect(setMcpServers).toHaveBeenCalledOnce();
        expect(setMcpServers).toHaveBeenCalledWith({ ...baseServers, ...changed });
        expect(onApplied).toHaveBeenCalledWith({ ...baseServers, ...changed }, changed);
        expect(JSON.stringify(onStatus.mock.calls)).not.toContain('new-secret');
    });

    it('logs only added and removed server names when applying config', async () => {
        loggerDebug.mockClear();
        const setMcpServers = vi.fn(async () => ({
            added: ['slack'],
            removed: ['argos'],
            errors: {},
        }));
        const synchronizer = new McpConfigSynchronizer({ setMcpServers } as any, {
            baseServers,
            initialAplusServers,
            fetchAplusServers: vi.fn(async () => ({
                ok: true as const,
                servers: {
                    slack: {
                        type: 'http' as const,
                        url: 'https://slack.test/mcp',
                        headers: { Authorization: 'Bearer must-not-leak' },
                    },
                },
            })),
        });

        await synchronizer.sync();

        expect(loggerDebug).toHaveBeenCalledWith(
            '[MCP CONFIG] Applied server changes added=slack removed=argos',
        );
        expect(JSON.stringify(loggerDebug.mock.calls)).not.toContain('must-not-leak');
    });
});
