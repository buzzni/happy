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
            onCompletionEvent,
            onSessionReset,
        });

        expect(onCompletionEvent).toHaveBeenCalledWith('Context was reset');
        expect(onSessionReset).toHaveBeenCalledOnce();
        expect(onReady).toHaveBeenCalledOnce();
        expect(callbackOrder).toEqual(['event:Context was reset', 'reset', 'ready']);
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

    it('marks assistant messages from /compact as compact summaries', async () => {
        const setPermissionMode = vi.fn();
        vi.mocked(query).mockReturnValue({
            setPermissionMode,
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
});
