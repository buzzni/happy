import { describe, expect, it, vi } from 'vitest';

import {
    buildCodexMcpRecoveryMetadataStatuses,
    CodexMcpRuntimeRecovery,
} from './codexMcpRuntimeRecovery';

describe('buildCodexMcpRecoveryMetadataStatuses', () => {
    it('maps mixed recovery results to connector-aware wire statuses', () => {
        expect(buildCodexMcpRecoveryMetadataStatuses({
            recovery: {
                status: 'failed',
                affectedServers: ['argos', 'gmail', 'notion'],
                serverStatuses: [
                    { name: 'argos', status: 'recovered' },
                    { name: 'gmail', status: 'failed' },
                    { name: 'notion', status: 'needs-auth' },
                ],
            },
            connectorNames: ['gmail', 'notion'],
            checkedAt: 1_000,
        })).toEqual([
            { name: 'argos', status: 'connected', checkedAt: 1_000 },
            {
                name: 'gmail',
                status: 'connector-runtime-failed',
                error: 'MCP runtime initialization failed',
                checkedAt: 1_000,
            },
            {
                name: 'notion',
                status: 'connector-needs-auth',
                error: 'MCP authentication is required',
                checkedAt: 1_000,
            },
        ]);
    });

    it('uses non-connector statuses and never copies MCP configuration into metadata', () => {
        const statuses = buildCodexMcpRecoveryMetadataStatuses({
            recovery: { status: 'failed', affectedServers: ['argos'] },
            connectorNames: [],
            checkedAt: 1_000,
        });

        expect(statuses).toEqual([{
            name: 'argos',
            status: 'failed',
            error: 'MCP runtime initialization failed',
            checkedAt: 1_000,
        }]);
        expect(Object.keys(statuses[0] ?? {}).sort()).toEqual(['checkedAt', 'error', 'name', 'status']);
        const serialized = JSON.stringify(statuses).toLowerCase();
        for (const forbidden of ['url', 'header', 'token', 'grant', 'api key', 'account label']) {
            expect(serialized).not.toContain(forbidden);
        }
    });
});

describe('CodexMcpRuntimeRecovery', () => {
    it('shares one recovery sequence for concurrent calls on the same thread', async () => {
        let releaseResume!: () => void;
        const resumeBlocked = new Promise<void>((resolve) => {
            releaseResume = resolve;
        });
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: 'failed' }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'argos', authStatus: 'unsupported', tools: {} }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => {
                await resumeBlocked;
                return { threadId: 'thread-1', model: 'gpt-5.4' };
            }),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { maxAttempts: 1, backoffMs: 0 });
        const input = {
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
        };

        const first = recovery.recoverBeforeTurn(input);
        const second = recovery.recoverBeforeTurn(input);

        expect(second).toBe(first);
        await vi.waitFor(() => expect(client.resumeThread).toHaveBeenCalledOnce());
        releaseResume();
        await expect(Promise.all([first, second])).resolves.toEqual([
            { status: 'failed', affectedServers: ['argos'] },
            { status: 'failed', affectedServers: ['argos'] },
        ]);
        expect(client.resumeThread).toHaveBeenCalledOnce();
    });

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
        const sleep = vi.fn(async () => {});
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
        const recovery = new CodexMcpRuntimeRecovery(client, { sleep });

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
        expect(sleep).not.toHaveBeenCalled();
    });

    it('retries a stale authentication failure when current inventory is logged in', async () => {
        let startupStatus: 'failed' | 'ready' = 'failed';
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{
                name: 'notion',
                status: startupStatus,
                failureReason: startupStatus === 'failed' ? 'reauthenticationRequired' : null,
            }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'notion', authStatus: 'oAuth', tools: { search: {} } }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => {
                startupStatus = 'ready';
                return { threadId: 'thread-1', model: 'gpt-5.4' };
            }),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 0 });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { notion: { url: 'https://notion.test/mcp' } },
            expectedServerNames: ['notion'],
        })).resolves.toEqual({
            status: 'recovered',
            affectedServers: ['notion'],
        });
        expect(client.resumeThread).toHaveBeenCalledOnce();
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
        let now = 1_000;
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
            now: () => now,
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

        now += 60_000;
        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'failed',
            affectedServers: ['argos'],
        });
        expect(client.resumeThread).toHaveBeenCalledTimes(4);
    });

    it('does not let one server cooldown hide a newly failed server on the same thread', async () => {
        let startupStatuses = [
            { name: 'argos', status: 'failed' },
            { name: 'notion', status: 'ready' },
        ];
        const client = {
            getMcpStartupStatuses: vi.fn(() => startupStatuses),
            listMcpServerStatus: vi.fn(async () => ({
                data: [
                    { name: 'argos', authStatus: 'unsupported', tools: {} },
                    { name: 'notion', authStatus: 'unsupported', tools: {} },
                ],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-5.4' })),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, {
            maxAttempts: 1,
            backoffMs: 0,
            cooldownMs: 60_000,
        });
        const input = {
            threadId: 'thread-1',
            mcpServers: {
                argos: { url: 'https://argos.test/mcp' },
                notion: { url: 'https://notion.test/mcp' },
            },
            expectedServerNames: ['argos', 'notion'],
        };

        await recovery.recoverBeforeTurn(input);
        await recovery.recoverBeforeTurn(input);
        expect(client.resumeThread).toHaveBeenCalledOnce();

        startupStatuses = [
            { name: 'argos', status: 'ready' },
            { name: 'notion', status: 'failed' },
        ];
        await recovery.recoverBeforeTurn(input);

        expect(client.resumeThread).toHaveBeenCalledTimes(2);
    });

    it('clears the failure cooldown after the thread reports ready', async () => {
        let startupStatus: 'failed' | 'ready' = 'failed';
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: startupStatus }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'argos', authStatus: 'unsupported', tools: {} }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-5.4' })),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, {
            maxAttempts: 1,
            backoffMs: 0,
            cooldownMs: 60_000,
        });
        const input = {
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
        };

        await recovery.recoverBeforeTurn(input);
        await recovery.recoverBeforeTurn(input);
        expect(client.resumeThread).toHaveBeenCalledOnce();

        startupStatus = 'ready';
        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'recovered',
            affectedServers: ['argos'],
        });

        startupStatus = 'failed';
        await recovery.recoverBeforeTurn(input);
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

    it('uses the default 250ms and 500ms bounded backoff before reinspection', async () => {
        const sleep = vi.fn(async () => {});
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: 'failed' }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'argos', authStatus: 'unsupported', tools: {} }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-5.4' })),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { sleep });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
        })).resolves.toEqual({ status: 'failed', affectedServers: ['argos'] });
        expect(client.resumeThread).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenNthCalledWith(1, 250);
        expect(sleep).toHaveBeenNthCalledWith(2, 500);
    });

    it('does not restart a server that is still reporting startup progress', async () => {
        const sleep = vi.fn(async () => {});
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: 'starting' }]),
            listMcpServerStatus: vi.fn(async () => ({ data: [], nextCursor: null })),
            resumeThread: vi.fn(),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { sleep });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
            developerInstructions: 'Use Argos through its MCP tools.',
        })).resolves.toEqual({ status: 'ready', affectedServers: [] });
        expect(client.resumeThread).not.toHaveBeenCalled();
        expect(sleep).not.toHaveBeenCalled();
    });

    it('falls back to a structured startup failure when the inventory API is unavailable', async () => {
        let startupStatus: 'failed' | 'ready' = 'failed';
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: startupStatus }]),
            listMcpServerStatus: vi.fn(async () => {
                throw new Error('method not found');
            }),
            resumeThread: vi.fn(async () => {
                startupStatus = 'ready';
                return { threadId: 'thread-1', model: 'gpt-5.4' };
            }),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 0 });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
        })).resolves.toEqual({ status: 'recovered', affectedServers: ['argos'] });
        expect(client.resumeThread).toHaveBeenCalledOnce();
    });

    it('does not infer a runtime failure when neither inventory nor startup evidence is available', async () => {
        const client = {
            getMcpStartupStatuses: vi.fn(() => []),
            listMcpServerStatus: vi.fn(async () => {
                throw new Error('method not found');
            }),
            resumeThread: vi.fn(),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 0 });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
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

    it('reports a previous recovery when a different server fails on the next turn', async () => {
        let startupStatuses = [
            { name: 'argos', status: 'failed' },
            { name: 'notion', status: 'ready' },
        ];
        const client = {
            getMcpStartupStatuses: vi.fn(() => startupStatuses),
            listMcpServerStatus: vi.fn(async () => ({
                data: [
                    { name: 'argos', authStatus: 'unsupported', tools: { search: {} } },
                    { name: 'notion', authStatus: 'unsupported', tools: { search: {} } },
                ],
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
            mcpServers: {
                argos: { url: 'https://argos.test/mcp' },
                notion: { url: 'https://notion.test/mcp' },
            },
            expectedServerNames: ['argos', 'notion'],
        };

        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'failed',
            affectedServers: ['argos'],
        });
        startupStatuses = [
            { name: 'argos', status: 'ready' },
            { name: 'notion', status: 'failed' },
        ];

        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'failed',
            affectedServers: ['argos', 'notion'],
            serverStatuses: [
                { name: 'argos', status: 'recovered' },
                { name: 'notion', status: 'failed' },
            ],
        });
    });
});
