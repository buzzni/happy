import { describe, expect, it, vi } from 'vitest';
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { Session } from './session';
import type { EnhancedMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: vi.fn(),
}));

describe('Claude model changes across provider restarts', () => {
    it('reports a routing epoch reset only when the queued clear resets the provider session', async () => {
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const clearSessionId = vi.fn(() => { void handlers.get('switch')!(); });
        const onSessionReset = vi.fn(() => {
            expect(clearSessionId).toHaveBeenCalledOnce();
        });
        const client = {
            sessionId: 'clear-epoch-test',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        queue.pushIsolated('/clear', { permissionMode: 'default', model: 'claude-sonnet-5' });
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), clearSessionId, onSessionReset,
        } as unknown as Session;
        expect(onSessionReset).not.toHaveBeenCalled();
        await claudeRemoteLauncher(session);
        expect(onSessionReset).toHaveBeenCalledOnce();
    });

    it.each(['model', 'effort', 'boundary-model', 'boundary-effort'] as const)('applies consecutive %s changes at the SDK boundary', async (field) => {
        const modes: EnhancedMode[] = field.endsWith('model')
            ? ['claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-opus-5'].map(model => ({ permissionMode: 'default', model }))
            : ['low', 'high', 'medium', 'medium'].map(effort => ({ permissionMode: 'default', model: 'claude-opus-5', effort: effort as EnhancedMode['effort'] }));
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const received: Array<{ text: unknown; model: Options['model']; effort: Options['effort'] }> = [];
        const launches: Options[] = [];
        const boundary = field.startsWith('boundary-');
        const resolveMode = () => boundary ? { model: modes[received.length].model!, effort: modes[received.length].effort ?? null } : null;
        const onModeApplied = vi.fn((_ids: string[] | undefined, _executionId: string) => resolveMode());
        const onModeResolved = vi.fn(resolveMode);
        const queuedMode = (index: number) => boundary ? modes[0] : modes[index];
        let metadata: Record<string, any> = {};
        const snapshots: any[] = [];
        const client = {
            sessionId: 'model-switch-test',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn((update) => {
                metadata = update(metadata);
                if (metadata.claudeBackgroundTasks) snapshots.push(metadata.claudeBackgroundTasks);
            }), getMetadata: () => metadata,
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const generation = launches.length;
            const response = (async function* () {
                yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [] };
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    received.push({ text: message.message.content, model: options?.model, effort: options?.effort });
                    yield { type: 'system', subtype: 'background_tasks_changed', tasks: [
                        { task_id: `bg-${generation}`, task_type: 'local_bash', description: 'server' },
                        { task_id: 'watcher', task_type: 'local_bash', description: 'watch', ambient: true },
                    ] };
                    if (generation > 1) {
                        // No task_notification: the full empty snapshot must clear it.
                        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
                        // Bookends may arrive after a newer full snapshot; do not resurrect it.
                        yield { type: 'system', subtype: 'task_started', task_id: `bg-${generation}`, description: 'server' };
                    }
                    yield { type: 'result', subtype: 'success' , result: '', is_error: false, uuid: `result-${received.length}` };
                    if (received.length === modes.length) {
                        void handlers.get('switch')!();
                        return;
                    }
                    queue.push(`turn-${received.length}`, queuedMode(received.length), undefined, [`req-${received.length}`]);
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        queue.push('turn-0', queuedMode(0), undefined, ['req-0']);
        const lessonReviewLifecycle = { controller: new AbortController(), completedAssistantTurns: 0 };
        const cancelLessonReview = vi.fn(() => lessonReviewLifecycle.controller.abort());
        const guidance = vi.fn(async () => 'checkpoint test guidance');
        const session = {
            checkpointComposition: { agentReader: { guidance } },
            lessonReviewLifecycle, cancelLessonReview,
            sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onModeApplied, onModeResolved,
        } as unknown as Session;
        await claudeRemoteLauncher(session);
        expect(received).toEqual(modes.map((mode, index) => ({ text: `turn-${index}`, model: mode.model, effort: mode.effort })));
        expect(launches).toHaveLength(3);
        expect(guidance).toHaveBeenCalledTimes(3);
        for (const launch of launches) expect(launch.systemPrompt).toMatchObject({ append: expect.stringContaining('checkpoint test guidance') });
        expect(onModeApplied.mock.calls.map(([ids]) => ids)).toEqual(modes.map((_, i) => [`req-${i}`]));
        expect(new Set(onModeApplied.mock.calls.map(([, id]) => id)).size).toBe(modes.length);
        expect(snapshots.filter(s => s.tasks === null && s.available).length).toBeGreaterThanOrEqual(3);
        expect(snapshots).toContainEqual(expect.objectContaining({ tasks: [{ taskId: 'bg-1', label: 'server', kind: 'shell' }], available: true }));
        expect(snapshots).toContainEqual(expect.objectContaining({ tasks: [{ taskId: 'bg-1', label: 'server', kind: 'shell' }], available: false }));
        expect(snapshots.at(-1)).toEqual(expect.objectContaining({ tasks: [], available: false }));
        expect(lessonReviewLifecycle.completedAssistantTurns).toBe(modes.length);
        expect(cancelLessonReview).toHaveBeenCalled();
        expect(lessonReviewLifecycle.controller.signal.aborted).toBe(true);
        expect(client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Process exited unexpectedly' }));
    });

    it('fails the turn of a launch that dies before its first message, after flushing, and keeps the session', async () => {
        // Desktop specs/headless-standalone-server R21: root makes Claude Code exit at once; clients
        // stayed on "responding" because no turn was open to close.
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const order: string[] = [];
        const client = {
            sessionId: 'launch-failure-test',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(),
            closeClaudeSessionTurn: vi.fn((status: string) => order.push(`close:${status}`)),
            failClaudeLaunchTurn: vi.fn(() => order.push('fail-turn')),
            sendSessionEvent: vi.fn((event: { message?: string }) => order.push(`event:${event.message}`)),
        };
        vi.mocked(query).mockImplementation(({ prompt }) => {
            const response = (async function* () {
                for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
                    throw new Error('Claude Code process exited with code 1. stderr: --dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons');
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        queue.push('hello', { permissionMode: 'bypassPermissions', model: 'claude-sonnet-5' });
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
        } as unknown as Session;
        const running = claudeRemoteLauncher(session);
        await vi.waitFor(() => expect(client.failClaudeLaunchTurn).toHaveBeenCalledOnce());
        // Still waiting for the next prompt rather than exiting.
        void handlers.get('switch')!();
        await running;
        expect(order).toEqual([expect.stringMatching(/^event:Claude Code could not start: .*root/), 'fail-turn']);
        expect(client.closeClaudeSessionTurn).not.toHaveBeenCalledWith('failed');
    });

    it('tells the user to sign in to Claude Code on this machine when it answers "Not logged in"', async () => {
        // Desktop specs/headless-standalone-server R36 (M1): without a Claude login Claude Code answers with a
        // synthetic "Not logged in · Please run /login" (shape captured from claude-code 2.1.296), which said
        // neither which machine nor how; Desktop showed it as an ordinary reply.
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const order: string[] = [];
        const client = {
            sessionId: 'not-signed-in-test',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(),
            closeClaudeSessionTurn: vi.fn((status: string) => order.push(`close:${status}`)),
            failClaudeLaunchTurn: vi.fn(),
            sendSessionEvent: vi.fn((event: { message?: string }) => order.push(`event:${event.message}`)),
        };
        vi.mocked(query).mockImplementation(({ prompt }) => {
            const response = (async function* () {
                for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
                    yield { type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { id: 'm1', model: '<synthetic>', role: 'assistant', type: 'message', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } };
                    yield { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' };
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        queue.push('hello', { permissionMode: 'bypassPermissions', model: 'claude-sonnet-5' });
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
        } as unknown as Session;
        const running = claudeRemoteLauncher(session);
        await vi.waitFor(() => expect(order.some((entry) => entry.startsWith('event:Claude Code is not signed in'))).toBe(true));
        void handlers.get('switch')!();
        await running;
        expect(order.filter((entry) => entry.startsWith('event:Claude Code is not signed in'))).toHaveLength(1);
        expect(client.failClaudeLaunchTurn).not.toHaveBeenCalled();
    });

    it('logs a failed OAuth refresh to the session log without calling it a logout', async () => {
        // aplus-dev-studio specs/machine-session-readiness-hardening D2: 2026-10-18 a session failed with this
        // result while the terminal login worked; nothing recorded it, so the cause stayed a guess.
        const { logger } = await import('@/ui/logger');
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const order: string[] = [];
        const client = {
            sessionId: 'refresh-failed-test',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(),
            closeClaudeSessionTurn: vi.fn((status: string) => order.push(`close:${status}`)),
            failClaudeLaunchTurn: vi.fn(),
            sendSessionEvent: vi.fn((event: { message?: string }) => order.push(`event:${event.message}`)),
        };
        const text = 'Failed to authenticate: OAuth session expired and could not be refreshed';
        vi.mocked(query).mockImplementation(({ prompt }) => {
            const response = (async function* () {
                for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
                    yield { type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { id: 'm1', model: '<synthetic>', role: 'assistant', type: 'message', content: [{ type: 'text', text }] } };
                    yield { type: 'result', subtype: 'success', is_error: true, result: text };
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        queue.push('hello', { permissionMode: 'bypassPermissions', model: 'claude-sonnet-5' });
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
        } as unknown as Session;
        const running = claudeRemoteLauncher(session);
        await vi.waitFor(() => expect(warn.mock.calls.some(([message]) => /OAuth token refresh failed/.test(String(message)))).toBe(true));
        void handlers.get('switch')!();
        await running;
        warn.mockRestore();
        expect(order.some((entry) => entry.startsWith('event:Claude Code is not signed in'))).toBe(false);
    });

    it('records turn latency for a turn held back behind a provider restart', async () => {
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const modes: EnhancedMode[] = ['claude-sonnet-5', 'claude-opus-5'].map(model => ({ permissionMode: 'default', model }));
        const launches: Options[] = [];
        let received = 0;
        const client = {
            sessionId: 'restart-latency-test',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(), sendTurnLatency: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const response = (async function* () {
                yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [] };
                for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
                    received++;
                    yield { type: 'result', subtype: 'success', result: '', is_error: false, uuid: `result-${received}` };
                    if (received === modes.length) {
                        void handlers.get('switch')!();
                        return;
                    }
                    queue.push(`turn-${received}`, modes[received], undefined, undefined, { id: `trace-${received}`, receivedAt: performance.now() });
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        queue.push('turn-0', modes[0], undefined, undefined, { id: 'trace-0', receivedAt: performance.now() });
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
        } as unknown as Session;
        await claudeRemoteLauncher(session);
        expect(launches).toHaveLength(2);
        expect(client.sendTurnLatency.mock.calls.map(([diagnostic]) => diagnostic.id)).toEqual(['trace-0', 'trace-1']);
    });
});

describe('/btw side question on the live provider', () => {
    it('answers mid-turn through the SDK control request and meters it apart from the transcript', async () => {
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, (params?: Record<string, unknown>) => Promise<unknown>>();
        const usageCalls = [{ inputTokens: 100, outputTokens: 10 }, { inputTokens: 130, outputTokens: 18 }];
        const controlRequests: unknown[] = [];
        const replies: unknown[] = [];
        const client = {
            sessionId: 'btw-test',
            rpcHandlerManager: { registerHandler: (name: string, handler: (params?: Record<string, unknown>) => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
            reportSideQuestionUsage: vi.fn(),
        };
        vi.mocked(query).mockImplementation(({ prompt }) => {
            const response = (async function* () {
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    void message;
                    // Mid-turn: the side question runs while this turn has not reached its result.
                    replies.push(await handlers.get('side-question')!({ question: 'which file?' }));
                    yield { type: 'system', subtype: 'control_request_progress', request_id: 'x', status: 'started' };
                    yield { type: 'result', subtype: 'success', result: '', is_error: false, uuid: 'result-1' };
                    void handlers.get('switch')!();
                    return;
                }
            })();
            return Object.assign(response, {
                mcpServerStatus: async () => [], setPermissionMode: async () => {},
                request: async (body: { subtype: string }) => {
                    controlRequests.push(body);
                    if (body.subtype === 'get_usage') return { response: { session: { model_usage: { 'claude-opus-5-5': usageCalls.shift() } } } };
                    return { response: { response: 'src/app.ts', synthetic: false } };
                },
            }) as unknown as ReturnType<typeof query>;
        });
        queue.push('main turn', { permissionMode: 'default' }, undefined, ['req-0']);
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
        } as unknown as Session;

        await claudeRemoteLauncher(session);

        expect(controlRequests).toContainEqual({ subtype: 'side_question', question: 'which file?' });
        expect(replies).toEqual([expect.objectContaining({
            success: true, answer: 'src/app.ts', usageQuality: 'estimated',
            usage: { input: 30, output: 8, cacheRead: 0, cacheWrite: 0, total: 38 },
        })]);
        expect(client.reportSideQuestionUsage).toHaveBeenCalledOnce();
        expect(client.reportSideQuestionUsage.mock.calls[0][0]).toMatchObject({ model: 'claude-opus-5-5', quality: 'estimated' });
        expect(client.sendClaudeSessionMessage.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ subtype: 'control_request_progress' }));
        expect(await handlers.get('side-question')!({ question: 'after exit?' })).toEqual({ success: false, error: 'side-question:not-running' });
    });
});
