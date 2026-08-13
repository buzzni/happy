import { describe, expect, it, vi } from 'vitest';

import { CodexMcpRuntimeRecovery } from './codexMcpRuntimeRecovery';

describe('CodexMcpRuntimeRecovery', () => {
    it('recovers the same thread when an expected MCP server changes from ready to failed', async () => {
        let startupStatus: 'ready' | 'failed' = 'ready';
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: startupStatus }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'argos', authStatus: 'unsupported', tools: { search: {} } }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => {
                startupStatus = 'ready';
                return { threadId: 'thread-1', model: 'gpt-5.4' };
            }),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 0 });
        const input = {
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
            developerInstructions: 'Use Argos through its MCP tools.',
        };

        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'ready',
            affectedServers: [],
        });

        startupStatus = 'failed';

        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'recovered',
            affectedServers: ['argos'],
        });
        expect(client.resumeThread).toHaveBeenCalledOnce();
        expect(client.resumeThread).toHaveBeenCalledWith({
            threadId: 'thread-1',
            mcpServers: input.mcpServers,
            developerInstructions: input.developerInstructions,
        });
    });

    it('reports reauthentication without repeatedly resuming the thread', async () => {
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{
                name: 'notion',
                status: 'failed',
                failureReason: 'reauthenticationRequired',
            }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'notion', authStatus: 'notLoggedIn', tools: {} }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 0 });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { notion: { url: 'https://notion.test/mcp' } },
            expectedServerNames: ['notion'],
            developerInstructions: 'Use Notion through its MCP tools.',
        })).resolves.toEqual({
            status: 'needs-auth',
            affectedServers: ['notion'],
        });
        expect(client.resumeThread).not.toHaveBeenCalled();
    });

    it('recovers a failed server even when another server needs authentication', async () => {
        const client = {
            getMcpStartupStatuses: vi.fn(() => [
                { name: 'argos', status: 'failed' },
                { name: 'notion', status: 'failed', failureReason: 'reauthenticationRequired' },
            ]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [
                    { name: 'argos', authStatus: 'unsupported', tools: {} },
                    { name: 'notion', authStatus: 'notLoggedIn', tools: {} },
                ],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-5.4' })),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 0, maxAttempts: 1 });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: {
                argos: { url: 'https://argos.test/mcp' },
                notion: { url: 'https://notion.test/mcp' },
            },
            expectedServerNames: ['argos', 'notion'],
        })).resolves.toEqual({
            status: 'failed',
            affectedServers: ['argos', 'notion'],
            serverStatuses: [
                { name: 'argos', status: 'failed' },
                { name: 'notion', status: 'needs-auth' },
            ],
        });
        expect(client.resumeThread).toHaveBeenCalledOnce();
    });

    it('reports partial recovery separately from a server that still needs authentication', async () => {
        const client = {
            getMcpStartupStatuses: vi.fn()
                .mockReturnValueOnce([
                    { name: 'argos', status: 'failed' },
                    { name: 'notion', status: 'failed', failureReason: 'reauthenticationRequired' },
                ])
                .mockReturnValue([
                    { name: 'argos', status: 'ready' },
                    { name: 'notion', status: 'failed', failureReason: 'reauthenticationRequired' },
                ]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [
                    { name: 'argos', authStatus: 'unsupported', tools: { search: {} } },
                    { name: 'notion', authStatus: 'notLoggedIn', tools: {} },
                ],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-5.4' })),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 0, maxAttempts: 1 });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: {
                argos: { url: 'https://argos.test/mcp' },
                notion: { url: 'https://notion.test/mcp' },
            },
            expectedServerNames: ['argos', 'notion'],
        })).resolves.toEqual({
            status: 'needs-auth',
            affectedServers: ['argos', 'notion'],
            serverStatuses: [
                { name: 'argos', status: 'recovered' },
                { name: 'notion', status: 'needs-auth' },
            ],
        });
    });

    it('bounds retries and cools down a persistent runtime failure', async () => {
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: 'failed' }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'argos', authStatus: 'unsupported', tools: {} }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-5.4' })),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, {
            backoffMs: 0,
            cooldownMs: 60_000,
        });
        const input = {
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
            developerInstructions: 'Use Argos through its MCP tools.',
        };

        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'failed',
            affectedServers: ['argos'],
        });
        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'failed',
            affectedServers: ['argos'],
        });
        expect(client.resumeThread).toHaveBeenCalledTimes(2);
    });

    it('returns a bounded runtime failure when resume RPCs reject', async () => {
        const sleep = vi.fn(async () => {});
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: 'failed' }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'argos', authStatus: 'unsupported', tools: {} }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => {
                throw new Error('resume transport failed');
            }),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 10, sleep });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
            developerInstructions: 'Use Argos through its MCP tools.',
        })).resolves.toEqual({ status: 'failed', affectedServers: ['argos'] });
        expect(client.resumeThread).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenNthCalledWith(1, 10);
        expect(sleep).toHaveBeenNthCalledWith(2, 20);
    });

    it('does not restart a server that is still reporting startup progress', async () => {
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: 'starting' }]),
            listMcpServerStatus: vi.fn(async () => ({ data: [], nextCursor: null })),
            resumeThread: vi.fn(),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 0 });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
            developerInstructions: 'Use Argos through its MCP tools.',
        })).resolves.toEqual({ status: 'ready', affectedServers: [] });
        expect(client.resumeThread).not.toHaveBeenCalled();
    });

    it('reports a previously failed server as recovered when it becomes ready before the next turn', async () => {
        let startupStatus: 'failed' | 'ready' = 'failed';
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: startupStatus }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'argos', authStatus: 'unsupported', tools: { search: {} } }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-5.4' })),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, {
            maxAttempts: 0,
            backoffMs: 0,
            cooldownMs: 0,
        });
        const input = {
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
        };

        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'failed',
            affectedServers: ['argos'],
        });
        startupStatus = 'ready';

        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'recovered',
            affectedServers: ['argos'],
        });
        expect(client.resumeThread).not.toHaveBeenCalled();
    });
});
