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

    it('applies changed MCP config at an idle turn boundary', async () => {
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
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => {
                messageCount += 1;
                return messageCount === 1 ? { message: 'hello', mode } : null;
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
                fetchAplusServers: vi.fn(async () => ({
                    ok: true as const,
                    servers: { argos: { type: 'http' as const, url: 'https://argos.test/mcp' } },
                })),
                onApplied,
            },
        });

        expect(setMcpServers).toHaveBeenCalledWith({
            happy: { type: 'http', url: 'http://happy.test/mcp' },
            argos: { type: 'http', url: 'https://argos.test/mcp' },
        });
        expect(onApplied).toHaveBeenCalledOnce();
    });
});
