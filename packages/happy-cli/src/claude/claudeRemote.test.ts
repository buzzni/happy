import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { query } from '@/claude/sdk';
import type { EnhancedMode } from './loop';

vi.mock('@/claude/sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {},
}));

const mode: EnhancedMode = {
    permissionMode: 'default',
};

describe('claudeRemote', () => {
    beforeEach(() => {
        vi.mocked(query).mockReset();
    });

    it('reports that the provider never started when mode switching aborts before the first message', async () => {
        const result = await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => null,
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        });

        expect(result).toBe('not-started');
        expect(query).not.toHaveBeenCalled();
    });

    it('returns after the first completed turn without waiting for more automation input', async () => {
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield { type: 'result', subtype: 'success' };
            },
        } as any);
        const nextMessage = vi.fn(async () => ({ message: 'scheduled prompt', mode }));

        const result = await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            exitAfterFirstTurn: true,
            nextMessage,
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        });

        expect(result).toBe('turn-complete');
        expect(nextMessage).toHaveBeenCalledOnce();
    });

    it('routes stream_event partials to onStreamEvent and keeps them out of the persisted onMessage path', async () => {
        const streamEvent = {
            type: 'stream_event',
            uuid: 'evt-1',
            session_id: 'claude-session',
            parent_tool_use_id: null,
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
        };
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield streamEvent;
                yield { type: 'result', subtype: 'success' };
            },
        } as any);
        const onMessage = vi.fn();
        const onStreamEvent = vi.fn();

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            exitAfterFirstTurn: true,
            nextMessage: vi.fn(async () => ({ message: 'hi', mode })),
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage,
            onStreamEvent,
        });

        expect(onStreamEvent).toHaveBeenCalledWith(streamEvent);
        expect(onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'stream_event' }));
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'result' }));
    });

    it('pushes active-turn input into the running SDK prompt stream', async () => {
        let releaseResult!: () => void;
        const resultGate = new Promise<void>((resolve) => {
            releaseResult = resolve;
        });
        let prompt!: AsyncIterator<unknown>;
        vi.mocked(query).mockImplementation((request) => {
            prompt = (request.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
            return {
                setPermissionMode: vi.fn(),
                mcpServerStatus: vi.fn(async () => []),
                async *[Symbol.asyncIterator]() {
                    await resultGate;
                    yield { type: 'result', subtype: 'success' };
                },
            } as any;
        });
        let activeInputSender: ((text: string) => boolean) | null = null;
        let resolveActiveInputSender!: (sender: (text: string) => boolean) => void;
        const activeInputSenderReady = new Promise<(text: string) => boolean>((resolve) => {
            resolveActiveInputSender = resolve;
        });
        let messageCount = 0;

        const running = claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => (
                messageCount++ === 0 ? { message: 'initial request', mode } : null
            ),
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onActiveInputReady: (sender) => {
                activeInputSender = sender;
                if (sender) resolveActiveInputSender(sender);
            },
        });

        const sendActiveInput = await activeInputSenderReady;
        expect(await prompt.next()).toMatchObject({
            value: { message: { content: 'initial request' } },
        });
        expect(sendActiveInput('apply this now')).toBe(true);
        expect(await prompt.next()).toMatchObject({
            value: { message: { content: 'apply this now' } },
        });

        releaseResult();
        await running;
        expect(activeInputSender).toBeNull();
        expect(sendActiveInput('too late')).toBe(false);
    });

    it('marks /clear as a completed reset turn', async () => {
        const callbackOrder: string[] = [];
        const onCompletionEvent = vi.fn((message: string) => {
            callbackOrder.push(`event:${message}`);
        });
        const onSessionReset = vi.fn(() => {
            callbackOrder.push('reset');
        });
        const onReady = vi.fn(() => {
            callbackOrder.push('ready');
        });
        const onPromptSuggestionChange = vi.fn((suggestion: string | null) => {
            callbackOrder.push(`suggestion:${suggestion ?? 'clear'}`);
        });

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => ({
                message: '/clear',
                mode,
            }),
            onReady,
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onPromptSuggestionChange,
            onCompletionEvent,
            onSessionReset,
        });

        expect(onCompletionEvent).toHaveBeenCalledWith('Context was reset');
        expect(onSessionReset).toHaveBeenCalledOnce();
        expect(onReady).toHaveBeenCalledOnce();
        expect(callbackOrder).toEqual(['suggestion:clear', 'event:Context was reset', 'reset', 'ready']);
    });

    it('injects worker agents + delegation prompt when HAPPY_WORKER_MODEL is set', async () => {
        const prev = { model: process.env.HAPPY_WORKER_MODEL, effort: process.env.HAPPY_WORKER_EFFORT };
        process.env.HAPPY_WORKER_MODEL = 'haiku';
        process.env.HAPPY_WORKER_EFFORT = 'low';
        try {
            vi.mocked(query).mockReturnValue({
                setPermissionMode: vi.fn(),
                async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success' }; },
            } as any);

            let count = 0;
            await claudeRemote({
                sessionId: null,
                path: process.cwd(),
                allowedTools: [],
                hookSettingsPath: '/tmp/happy-test-settings.json',
                nextMessage: async () => (count++ === 0 ? { message: 'do the thing', mode } : null),
                onReady: vi.fn(),
                canCallTool: async () => ({ behavior: 'allow' }) as any,
                isAborted: () => false,
                onSessionFound: vi.fn(),
                onThinkingChange: vi.fn(),
                onMessage: vi.fn(),
                onCompletionEvent: vi.fn(),
                onSessionReset: vi.fn(),
            });

            const options = vi.mocked(query).mock.calls[0][0].options!;
            expect(options.agents?.worker?.model).toBe('haiku');
            expect(options.agents?.worker?.effort).toBe('low');
            expect(options.appendSystemPrompt).toMatch(/delegate/i);
        } finally {
            if (prev.model === undefined) delete process.env.HAPPY_WORKER_MODEL; else process.env.HAPPY_WORKER_MODEL = prev.model;
            if (prev.effort === undefined) delete process.env.HAPPY_WORKER_EFFORT; else process.env.HAPPY_WORKER_EFFORT = prev.effort;
        }
    });

    it('leaves agents undefined when no worker model is set (backward compatible)', async () => {
        const prev = process.env.HAPPY_WORKER_MODEL;
        delete process.env.HAPPY_WORKER_MODEL;
        try {
            vi.mocked(query).mockReturnValue({
                setPermissionMode: vi.fn(),
                async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success' }; },
            } as any);

            let count = 0;
            await claudeRemote({
                sessionId: null,
                path: process.cwd(),
                allowedTools: [],
                hookSettingsPath: '/tmp/happy-test-settings.json',
                nextMessage: async () => (count++ === 0 ? { message: 'hi', mode } : null),
                onReady: vi.fn(),
                canCallTool: async () => ({ behavior: 'allow' }) as any,
                isAborted: () => false,
                onSessionFound: vi.fn(),
                onThinkingChange: vi.fn(),
                onMessage: vi.fn(),
                onCompletionEvent: vi.fn(),
                onSessionReset: vi.fn(),
            });

            const options = vi.mocked(query).mock.calls[0][0].options!;
            expect(options.agents).toBeUndefined();
        } finally {
            if (prev === undefined) delete process.env.HAPPY_WORKER_MODEL; else process.env.HAPPY_WORKER_MODEL = prev;
        }
    });

    it('instructs the agent to discover connector and runtime MCP tools before browser fallback', async () => {
        process.env.HAPPY_APLUS_EXPECTED_CONNECTORS = '["gmail"]';
        process.env.HAPPY_APLUS_EXPECTED_MCP_SERVICES = '["argos","gmail"]';
        try {
            vi.mocked(query).mockReturnValue({
                setPermissionMode: vi.fn(),
                mcpServerStatus: vi.fn(async () => []),
                async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success' }; },
            } as any);
            let count = 0;

            await claudeRemote({
                sessionId: null,
                path: process.cwd(),
                mcpServers: {
                    happy: { type: 'http', url: 'http://happy.test/mcp' },
                    argos: { type: 'http', url: 'https://argos.test/mcp' },
                },
                allowedTools: [],
                hookSettingsPath: '/tmp/happy-test-settings.json',
                nextMessage: async () => (count++ === 0 ? { message: 'check gmail', mode } : null),
                onReady: vi.fn(),
                canCallTool: async () => ({ behavior: 'allow' }) as any,
                isAborted: () => false,
                onSessionFound: vi.fn(),
                onThinkingChange: vi.fn(),
                onMessage: vi.fn(),
            });

            const prompt = vi.mocked(query).mock.calls[0][0].options?.appendSystemPrompt;
            expect(prompt).toContain('argos, gmail');
            expect(prompt).toContain('deferred MCP tool discovery');
            expect(prompt).not.toContain('aplus-common');
        } finally {
            delete process.env.HAPPY_APLUS_EXPECTED_CONNECTORS;
            delete process.env.HAPPY_APLUS_EXPECTED_MCP_SERVICES;
        }
    });

    it('keeps skill governance and expected MCP service guidance together', async () => {
        const previous = {
            settingSources: process.env.HAPPY_SETTING_SOURCES,
            skillAllowlist: process.env.HAPPY_SKILL_ALLOWLIST,
            connectors: process.env.HAPPY_APLUS_EXPECTED_CONNECTORS,
            mcpServices: process.env.HAPPY_APLUS_EXPECTED_MCP_SERVICES,
        };
        process.env.HAPPY_SETTING_SOURCES = 'project,local';
        process.env.HAPPY_SKILL_ALLOWLIST = 'pdf';
        process.env.HAPPY_APLUS_EXPECTED_CONNECTORS = '["gmail"]';
        process.env.HAPPY_APLUS_EXPECTED_MCP_SERVICES = '["argos","gmail"]';
        try {
            vi.mocked(query).mockReturnValue({
                setPermissionMode: vi.fn(),
                mcpServerStatus: vi.fn(async () => []),
                async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success' }; },
            } as any);
            let count = 0;

            await claudeRemote({
                sessionId: null,
                path: process.cwd(),
                allowedTools: [],
                hookSettingsPath: '/tmp/happy-test-settings.json',
                nextMessage: async () => (count++ === 0 ? { message: 'check services', mode } : null),
                onReady: vi.fn(),
                canCallTool: async () => ({ behavior: 'allow' }) as any,
                isAborted: () => false,
                onSessionFound: vi.fn(),
                onThinkingChange: vi.fn(),
                onMessage: vi.fn(),
            });

            const options = vi.mocked(query).mock.calls[0][0].options!;
            expect(options.settingSources).toEqual(['project', 'local']);
            expect(options.skills).toEqual(['pdf']);
            expect(options.appendSystemPrompt).toContain('argos, gmail');
        } finally {
            for (const [key, value] of Object.entries(previous)) {
                const envKey = key === 'settingSources' ? 'HAPPY_SETTING_SOURCES'
                    : key === 'skillAllowlist' ? 'HAPPY_SKILL_ALLOWLIST'
                    : key === 'connectors' ? 'HAPPY_APLUS_EXPECTED_CONNECTORS'
                    : 'HAPPY_APLUS_EXPECTED_MCP_SERVICES';
                if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
            }
        }
    });

    it('enables prompt suggestions and routes them outside the conversation transcript', async () => {
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield { type: 'result', subtype: 'success' };
                yield {
                    type: 'prompt_suggestion',
                    suggestion: '  Run the focused tests  ',
                    uuid: 'suggestion-1',
                    session_id: 'session-1',
                };
            },
        } as any);

        const onMessage = vi.fn();
        const onPromptSuggestionChange = vi.fn();
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => (messageCount++ === 0 ? { message: 'implement it', mode } : null),
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage,
            onPromptSuggestionChange,
        });

        expect(vi.mocked(query).mock.calls[0][0].options?.promptSuggestions).toBe(true);
        expect(onPromptSuggestionChange.mock.calls.map(([value]) => value)).toEqual([
            null,
            'Run the focused tests',
        ]);
        expect(onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt_suggestion' }));
    });

    it('drops a completed-turn suggestion that arrives after the next user input was accepted', async () => {
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield { type: 'result', subtype: 'success' };
                await Promise.resolve();
                yield {
                    type: 'prompt_suggestion',
                    suggestion: 'Stale previous-turn suggestion',
                    uuid: 'suggestion-1',
                    session_id: 'session-1',
                };
            },
        } as any);

        const onPromptSuggestionChange = vi.fn();
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => {
                messageCount += 1;
                if (messageCount === 1) return { message: 'first', mode };
                if (messageCount === 2) return { message: 'next', mode };
                return null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onPromptSuggestionChange,
        });

        expect(onPromptSuggestionChange.mock.calls.map(([value]) => value)).toEqual([null, null]);
    });

    it('marks assistant messages from /compact as compact summaries', async () => {
        const setPermissionMode = vi.fn();
        vi.mocked(query).mockReturnValue({
            setPermissionMode,
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'Long compaction summary' }],
                    },
                };
                yield {
                    type: 'result',
                    subtype: 'success',
                };
            },
        } as any);

        const onMessage = vi.fn();
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => {
                messageCount += 1;
                return messageCount === 1
                    ? {
                        message: '/compact',
                        mode,
                    }
                    : null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage,
            onCompletionEvent: vi.fn(),
            onSessionReset: vi.fn(),
        });

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            isCompactSummary: true,
        }));
    });

    it('reconnects a server that changes from connected init metadata to failed SDK runtime status', async () => {
        const reconnectMcpServer = vi.fn(async () => {});
        const mcpServerStatus = vi.fn()
            .mockResolvedValueOnce([{
                name: 'argos',
                status: 'failed',
                error: 'connection refused',
            }])
            .mockResolvedValueOnce([{ name: 'argos', status: 'connected' }]);
        const onMcpStatus = vi.fn();
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            mcpServerStatus,
            reconnectMcpServer,
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'system',
                    subtype: 'init',
                    mcp_servers: [{ name: 'argos', status: 'connected' }],
                };
                yield {
                    type: 'result',
                    subtype: 'success',
                };
            },
        } as any);

        let messageCount = 0;
        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => {
                messageCount += 1;
                return messageCount === 1 ? { message: 'use argos', mode } : null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onMcpStatus,
        });

        expect(mcpServerStatus).toHaveBeenCalled();
        expect(reconnectMcpServer).toHaveBeenCalledOnce();
        expect(reconnectMcpServer).toHaveBeenCalledWith('argos');
        expect(onMcpStatus.mock.calls.map(([status]) => status.status)).toEqual([
            'failed',
            'reconnecting',
            'connected',
        ]);
    });

    it('refreshes MCP config after idle input arrives and before the next turn starts', async () => {
        const setMcpServers = vi.fn(async () => ({ added: ['argos'], removed: [], errors: {} }));
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            setMcpServers,
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield { type: 'result', subtype: 'success' };
            },
        } as any);
        const onApplied = vi.fn();
        const boundaryOrder: string[] = [];
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => {
                boundaryOrder.push('next-message');
                messageCount += 1;
                return messageCount <= 2 ? { message: `hello-${messageCount}`, mode } : null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            mcpConfig: {
                baseServers: { happy: { type: 'http', url: 'http://happy.test/mcp' } },
                initialAplusServers: {},
                fetchAplusServers: vi.fn(async () => {
                    boundaryOrder.push('mcp-sync');
                    return {
                        ok: true as const,
                        servers: { argos: { type: 'http' as const, url: 'https://argos.test/mcp' } },
                    };
                }),
                onApplied,
            },
        });

        expect(boundaryOrder.slice(0, 3)).toEqual(['next-message', 'next-message', 'mcp-sync']);
        await vi.waitFor(() => {
            expect(setMcpServers).toHaveBeenCalledWith({
                happy: { type: 'http', url: 'http://happy.test/mcp' },
                argos: { type: 'http', url: 'https://argos.test/mcp' },
            });
            expect(onApplied).toHaveBeenCalledOnce();
        });
    });
});
