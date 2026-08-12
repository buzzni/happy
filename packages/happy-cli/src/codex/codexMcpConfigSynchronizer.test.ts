import { describe, expect, it, vi } from 'vitest';
import type { AplusMcpServersMap } from '@/aplus/fetchAplusMcpServers';
import { CodexMcpConfigSynchronizer } from './codexMcpConfigSynchronizer';

const baseServers = {
    happy: { command: 'node', args: ['happy-mcp'] },
};

const initialAplusServers = {
    'aplus-common': {
        type: 'http' as const,
        url: 'https://saycode.test/mcp/common',
        headers: { Authorization: 'Bearer common-1' },
    },
};

function bridge(servers: AplusMcpServersMap) {
    return Object.fromEntries(Object.entries(servers).map(([name, server]) => [
        name,
        {
            command: 'node',
            args: ['happy-mcp', '--url', server.url],
            env: { HAPPY_HTTP_MCP_HEADERS: JSON.stringify(server.headers) },
        },
    ]));
}

describe('CodexMcpConfigSynchronizer', () => {
    it('resumes the same active thread with a newly connected server before the turn', async () => {
        const fetchAplusServers = vi.fn(async () => ({
            ok: true as const,
            servers: {
                ...initialAplusServers,
                notion: {
                    type: 'http' as const,
                    url: 'https://saycode.test/mcp/connector/notion',
                    headers: { Authorization: 'Bearer notion-1' },
                },
            },
        }));
        const resumeThread = vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-test' }));
        const synchronizer = new CodexMcpConfigSynchronizer({
            baseServers,
            initialAplusServers,
            fetchAplusServers,
            bridgeAplusServers: bridge,
            now: () => 1_000,
        });

        const result = await synchronizer.sync({ threadId: 'thread-1', resumeThread });

        expect(resumeThread).toHaveBeenCalledWith({
            threadId: 'thread-1',
            mcpServers: expect.objectContaining({
                happy: baseServers.happy,
                notion: expect.objectContaining({
                    args: ['happy-mcp', '--url', 'https://saycode.test/mcp/connector/notion'],
                }),
            }),
        });
        expect(result.threadId).toBe('thread-1');
        expect(result.mcpServers).toHaveProperty('notion');
    });

    it('resumes without a disconnected server', async () => {
        const connected = {
            ...initialAplusServers,
            slack: {
                type: 'http' as const,
                url: 'https://saycode.test/mcp/connector/slack',
                headers: { Authorization: 'Bearer slack-1' },
            },
        };
        const resumeThread = vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-test' }));
        const synchronizer = new CodexMcpConfigSynchronizer({
            baseServers,
            initialAplusServers: connected,
            fetchAplusServers: async () => ({ ok: true, servers: initialAplusServers }),
            bridgeAplusServers: bridge,
            now: () => 1_000,
        });

        const result = await synchronizer.sync({ threadId: 'thread-1', resumeThread });

        expect(resumeThread).toHaveBeenCalledOnce();
        expect(result.mcpServers).not.toHaveProperty('slack');
    });

    it('keeps the active thread and current servers when config fetch fails', async () => {
        const resumeThread = vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-test' }));
        const synchronizer = new CodexMcpConfigSynchronizer({
            baseServers,
            initialAplusServers,
            fetchAplusServers: async () => ({
                ok: false,
                reason: 'network-error' as const,
                error: 'mcp-config network request failed',
            }),
            bridgeAplusServers: bridge,
            now: () => 1_000,
        });

        const result = await synchronizer.sync({ threadId: 'thread-1', resumeThread });

        expect(resumeThread).not.toHaveBeenCalled();
        expect(result.threadId).toBe('thread-1');
        expect(result.mcpServers).toEqual({
            ...baseServers,
            ...bridge(initialAplusServers),
        });
    });

    it('reports a persistent expected connector mismatch distinctly', async () => {
        const onStatus = vi.fn();
        const synchronizer = new CodexMcpConfigSynchronizer({
            baseServers,
            initialAplusServers,
            fetchAplusServers: async () => ({
                ok: false,
                reason: 'connector-config-missing' as const,
                error: 'Expected connector configuration is missing: knoi',
                expected: ['gmail', 'knoi'],
                configured: ['gmail'],
                missing: ['knoi'],
            }),
            bridgeAplusServers: bridge,
            onStatus,
        });

        const result = await synchronizer.sync({ threadId: 'thread-1' });

        expect(result.threadId).toBe('thread-1');
        expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
            name: 'knoi', status: 'connector-config-missing',
        }));
    });

    it('keeps the active thread and current servers when config fetch throws', async () => {
        const resumeThread = vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-test' }));
        const synchronizer = new CodexMcpConfigSynchronizer({
            baseServers,
            initialAplusServers,
            fetchAplusServers: async () => {
                throw new Error('network exploded');
            },
            bridgeAplusServers: bridge,
            now: () => 1_000,
        });

        const result = await synchronizer.sync({ threadId: 'thread-1', resumeThread });

        expect(resumeThread).not.toHaveBeenCalled();
        expect(result.threadId).toBe('thread-1');
        expect(result.mcpServers).toEqual({
            ...baseServers,
            ...bridge(initialAplusServers),
        });
    });

    it('keeps the current config when applying a changed config fails', async () => {
        const resumeThread = vi.fn(async () => {
            throw new Error('resume failed');
        });
        const synchronizer = new CodexMcpConfigSynchronizer({
            baseServers,
            initialAplusServers,
            fetchAplusServers: async () => ({
                ok: true,
                servers: {
                    ...initialAplusServers,
                    notion: {
                        type: 'http',
                        url: 'https://saycode.test/mcp/connector/notion',
                    },
                },
            }),
            bridgeAplusServers: bridge,
            now: () => 1_000,
        });

        const result = await synchronizer.sync({ threadId: 'thread-1', resumeThread });

        expect(result.threadId).toBe('thread-1');
        expect(result.mcpServers).not.toHaveProperty('notion');
    });

    it('refreshes connector credentials on the same thread after the refresh interval', async () => {
        let now = 0;
        const refreshedServers = {
            'aplus-common': {
                ...initialAplusServers['aplus-common'],
                headers: { Authorization: 'Bearer common-2' },
            },
        };
        const resumeThread = vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-test' }));
        const synchronizer = new CodexMcpConfigSynchronizer({
            baseServers,
            initialAplusServers,
            fetchAplusServers: async () => ({ ok: true, servers: refreshedServers }),
            bridgeAplusServers: bridge,
            credentialRefreshMs: 100,
            now: () => now,
        });
        now = 100;

        const result = await synchronizer.sync({ threadId: 'thread-1', resumeThread });

        expect(resumeThread).toHaveBeenCalledOnce();
        expect(result.mcpServers['aplus-common']).toEqual(expect.objectContaining({
            env: { HAPPY_HTTP_MCP_HEADERS: JSON.stringify(refreshedServers['aplus-common'].headers) },
        }));
    });
});
