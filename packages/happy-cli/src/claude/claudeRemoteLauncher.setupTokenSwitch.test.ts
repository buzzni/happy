import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { Session } from './session';
import type { EnhancedMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { requestSetupTokenRebind, reportSetupTokenUsage } from '@/daemon/controlClient';
import { APPLY_REQUIRED_NOTICE, CONTINUE_PROMPT, SWITCHED_NOTICE } from './setupTokenAccountSwitching';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: vi.fn(),
}));
// The Claude conversation file lives in the provider's config directory, which a test does not have.
vi.mock('./utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }));
vi.mock('@/daemon/controlClient', async (original) => ({
    ...await original<typeof import('@/daemon/controlClient')>(),
    reportSetupTokenUsage: vi.fn(async () => {}),
    requestSetupTokenRebind: vi.fn(async () => ({ ok: true, environment: {
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-second', HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: '{"account":"second"}' } })),
}));

const saved = { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, binding: process.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING };
beforeEach(() => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-first';
    process.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING = '{"account":"first"}';
});
afterEach(() => {
    for (const [key, value] of [['CLAUDE_CODE_OAUTH_TOKEN', saved.token], ['HAPPY_AI_AUTH_SETUP_TOKEN_BINDING', saved.binding]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    vi.clearAllMocks();
});

const assistant = (id: string) => ({ type: 'assistant', uuid: `uuid-${id}`, session_id: 'claude-1', parent_tool_use_id: null,
    message: { id, role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } } });
const refused = { type: 'rate_limit_event', uuid: 'rl-1', session_id: 'claude-1',
    rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 } };

describe('setup-token account switch in the remote launcher (Saycode specs/claude-setup-token-account-selection)', () => {
    it.each(['result', 'exception'])('restarts the same conversation after a known account refusal (%s) and prioritizes the queued user message', async failure => {
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const client = {
            sessionId: 'happy-session-1',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        const generations: Array<{ token?: string; resume?: string; prompts: string[] }> = [];
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            const generation = { token: options?.env?.CLAUDE_CODE_OAUTH_TOKEN, resume: options?.resume, prompts: [] as string[] };
            generations.push(generation);
            const first = generations.length === 1;
            const response = (async function* () {
                // An empty id: a reported id makes claudeRemote wait for the transcript file on disk.
                yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    generation.prompts.push(JSON.stringify(message.message.content));
                    if (first) {
                        // The user queued another message while the refused turn ran.
                        queue.push('queued while refused', { permissionMode: 'default', model: 'claude-sonnet-5' });
                        yield refused;
                        if (failure === 'exception') throw new Error('Provider exited after known account-wide quota refusal');
                        yield { type: 'result', subtype: 'success', result: 'Claude AI usage limit reached', is_error: true, uuid: 'result-1' };
                        continue;
                    }
                    yield assistant(`msg-${generation.prompts.length + 1}`);
                    yield { type: 'result', subtype: 'success', result: 'done', is_error: false, uuid: `result-${generation.prompts.length + 1}` };
                    if (generation.prompts.length < 1) continue;
                    void handlers.get('switch')!();
                    return;
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        queue.push('hello', { permissionMode: 'default', model: 'claude-sonnet-5' });
        const session: Record<string, unknown> = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            // Continuing an existing Claude conversation; both providers must resume it.
            sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onAbort: vi.fn(),
        };

        await claudeRemoteLauncher(session as unknown as Session);

        expect(generations.map(generation => generation.token)).toEqual(['sk-ant-oat01-first', 'sk-ant-oat01-second']);
        expect(generations.map(generation => generation.resume)).toEqual(['claude-1', 'claude-1']);
        // A queued user turn replaces automatic continuation and runs alone on the new account.
        expect(generations[1].prompts[0]).toContain('queued while refused');
        expect(generations[1].prompts[0]).not.toContain(CONTINUE_PROMPT);
        expect(requestSetupTokenRebind).toHaveBeenCalledWith('happy-session-1', '{"account":"first"}', expect.objectContaining({ reason: 'rate-limited' }), expect.any(AbortSignal));
        expect(reportSetupTokenUsage).toHaveBeenCalledWith('happy-session-1', '{"account":"first"}', expect.objectContaining({ reason: 'rate-limited' }), expect.any(AbortSignal));
        expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: SWITCHED_NOTICE, setupTokenRotation: { version: 1, state: 'switched' } });
        expect(requestSetupTokenRebind).toHaveBeenCalledTimes(1);
        expect(generations[0].prompts).toHaveLength(1);
        expect(generations[1].prompts).toHaveLength(1);
        // A restarted provider is not enough: the new reply must reach the user's session once.
        const replies = client.sendClaudeSessionMessage.mock.calls.flatMap(([body]) =>
            body.type === 'assistant' ? [body.message] : []);
        expect(replies).toEqual([
            expect.objectContaining({ id: 'msg-2', content: [{ type: 'text', text: 'hi' }] }),
        ]);
        const successfulResults = client.applyClaudeTurnResult.mock.calls.flatMap(([result]) =>
            result.is_error === false ? [result.uuid] : []);
        expect(successfulResults).toEqual(['result-2']);
    });

    it('closes a refused turn as failed when the provider throws and rebind fails', async () => {
        vi.mocked(requestSetupTokenRebind).mockResolvedValueOnce({ ok: false, reason: 'FORBIDDEN' });
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const client = {
            sessionId: 'happy-session-1',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
            failClaudeLaunchTurn: vi.fn(),
        };
        vi.mocked(query).mockImplementation(({ prompt }) => Object.assign((async function* () {
            yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
            for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
                yield refused;
                throw new Error('Provider exited after refusal');
            }
        })(), { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>);
        queue.push('hello', { permissionMode: 'default', model: 'claude-sonnet-5' });
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 }, cancelLessonReview: vi.fn(),
            sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onAbort: vi.fn(),
        };
        const launched = claudeRemoteLauncher(session as unknown as Session);
        try {
            await vi.waitFor(() => expect(client.failClaudeLaunchTurn).toHaveBeenCalledTimes(1));
            expect(requestSetupTokenRebind).toHaveBeenCalledTimes(1);
            expect(query).toHaveBeenCalledTimes(1);
        } finally { await handlers.get('switch')?.(); await launched; }
    });

    it('hands a message that arrives after a switch to a provider restarted on the new account', async () => {
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const client = {
            sessionId: 'happy-session-1',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        const generations: Array<{ token?: string; prompts: string[] }> = [];
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            const generation = { token: options?.env?.CLAUDE_CODE_OAUTH_TOKEN, prompts: [] as string[] };
            generations.push(generation);
            const first = generations.length === 1;
            const response = (async function* () {
                yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    generation.prompts.push(JSON.stringify(message.message.content));
                    yield assistant(`msg-${generations.length}`);
                    yield { type: 'result', subtype: 'success', result: 'done', is_error: false, uuid: `result-${generations.length}` };
                    if (first) {
                        // Another turn boundary switched the account while this provider waits for its next message.
                        setTimeout(() => {
                            process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-second';
                            process.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING = '{"account":"second"}';
                            queue.push('after the switch', { permissionMode: 'default', model: 'claude-sonnet-5' });
                        }, 10);
                        continue;
                    }
                    void handlers.get('switch')!();
                    return;
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        queue.push('hello', { permissionMode: 'default', model: 'claude-sonnet-5' });
        const session: Record<string, unknown> = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onAbort: vi.fn(),
        };

        await claudeRemoteLauncher(session as unknown as Session);

        expect(generations.map(generation => generation.token)).toEqual(['sk-ant-oat01-first', 'sk-ant-oat01-second']);
        expect(generations[0].prompts.join()).not.toContain('after the switch');
        expect(generations[1].prompts[0]).toContain('after the switch');
        expect(requestSetupTokenRebind).not.toHaveBeenCalled();
    });
    it('retries a switch that failed at the turn boundary before the next message reaches the used-up account', async () => {
        vi.mocked(requestSetupTokenRebind).mockResolvedValueOnce({ ok: false, reason: 'REQUEST_FAILED' });
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const client = {
            sessionId: 'happy-session-1',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        const generations: Array<{ token?: string; prompts: string[] }> = [];
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            const generation = { token: options?.env?.CLAUDE_CODE_OAUTH_TOKEN, prompts: [] as string[] };
            generations.push(generation);
            const first = generations.length === 1;
            const response = (async function* () {
                yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    generation.prompts.push(JSON.stringify(message.message.content));
                    if (first) {
                        yield refused;
                        yield { type: 'result', subtype: 'success', result: 'Claude AI usage limit reached', is_error: true, uuid: 'result-1' };
                        // The boundary's switch fails for now; the user writes again a little later.
                        setTimeout(() => queue.push('try again', { permissionMode: 'default', model: 'claude-sonnet-5' }), 10);
                        continue;
                    }
                    yield assistant('msg-2');
                    yield { type: 'result', subtype: 'success', result: 'done', is_error: false, uuid: 'result-2' };
                    void handlers.get('switch')!();
                    return;
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        queue.push('hello', { permissionMode: 'default', model: 'claude-sonnet-5' });
        const session: Record<string, unknown> = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onAbort: vi.fn(),
        };

        await claudeRemoteLauncher(session as unknown as Session);

        expect(requestSetupTokenRebind).toHaveBeenCalledTimes(2);
        expect(generations.map(generation => generation.token)).toEqual(['sk-ant-oat01-first', 'sk-ant-oat01-second']);
        expect(generations[0].prompts.join()).not.toContain('try again');
        expect(generations[1].prompts.join()).toContain('try again');
    });
    // Saycode specs/claude-setup-token-managed-sync R7: the newly assigned account is applied to this PC after the refusal.
    it.each(['continue', 'stop'])('handles background rotation after account application: %s', async action => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        try {
            vi.mocked(requestSetupTokenRebind).mockResolvedValueOnce({ ok: false, reason: 'APPLY_REQUIRED' });
            const queue = new MessageQueue2<EnhancedMode>(hashObject);
            const handlers = new Map<string, () => Promise<unknown>>();
            const client = {
                sessionId: 'happy-session-1',
                rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
                updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
                sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
                setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
                applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
            };
            const generations: Array<{ token?: string; prompts: string[] }> = [];
            vi.mocked(query).mockImplementation(({ prompt, options }) => {
                const generation = { token: options?.env?.CLAUDE_CODE_OAUTH_TOKEN, prompts: [] as string[] };
                generations.push(generation);
                const first = generations.length === 1;
                const response = (async function* () {
                    yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
                    for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                        generation.prompts.push(JSON.stringify(message.message.content));
                        if (first) {
                            yield refused;
                            yield { type: 'result', subtype: 'success', result: 'Claude AI usage limit reached', is_error: true, uuid: 'result-1' };
                            continue;
                        }
                        yield assistant('msg-2');
                        yield { type: 'result', subtype: 'success', result: 'done', is_error: false, uuid: 'result-2' };
                        void handlers.get('switch')!();
                        return;
                    }
                })();
                return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
            });
            queue.push('hello', { permissionMode: 'default', model: 'claude-sonnet-5' });
            const session: Record<string, unknown> = {
                lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
                cancelLessonReview: vi.fn(),
                sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
                api: { push: () => ({ sendSessionNotification: vi.fn() }) },
                consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onAbort: vi.fn(),
            };

            const launched = claudeRemoteLauncher(session as unknown as Session);
            await vi.waitFor(() => expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: APPLY_REQUIRED_NOTICE, setupTokenRotation: { version: 1, state: 'apply-required' } }));
            expect(generations).toHaveLength(1);
            if (action === 'stop') {
                await handlers.get('abort')!();
                const notices = client.sendSessionEvent.mock.calls.filter(([event]) => 'setupTokenRotation' in event).length;
                await vi.advanceTimersByTimeAsync(5 * 60000);
                expect(requestSetupTokenRebind).toHaveBeenCalledTimes(1);
                expect(generations).toHaveLength(1);
                expect(client.sendSessionEvent.mock.calls.filter(([event]) => 'setupTokenRotation' in event).length).toBe(notices);
                await handlers.get('switch')!(); await launched;
                return;
            }
            // Nobody writes; a minute later the retry finds the account applied.
            await vi.advanceTimersByTimeAsync(60_000);
            await launched;

            expect(requestSetupTokenRebind).toHaveBeenCalledTimes(2);
            expect(generations.map(generation => generation.token)).toEqual(['sk-ant-oat01-first', 'sk-ant-oat01-second']);
            expect(generations[1].prompts[0]).toContain(CONTINUE_PROMPT);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: SWITCHED_NOTICE, setupTokenRotation: { version: 1, state: 'switched' } });
        } finally {
            vi.useRealTimers();
        }
    });
    it('continues the refused turn in the live provider when the refused provider exited while the background wait was pending', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        try {
            // Refused at the turn boundary and again when the next provider starts; the background retry then succeeds.
            vi.mocked(requestSetupTokenRebind).mockResolvedValueOnce({ ok: false, reason: 'APPLY_REQUIRED' }).mockResolvedValueOnce({ ok: false, reason: 'APPLY_REQUIRED' });
            const queue = new MessageQueue2<EnhancedMode>(hashObject);
            const handlers = new Map<string, () => Promise<unknown>>();
            const client = {
                sessionId: 'happy-session-1',
                rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
                updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
                sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
                setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
                applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
            };
            const generations: Array<{ token?: string; prompts: string[] }> = [];
            vi.mocked(query).mockImplementation(({ prompt, options }) => {
                const generation = { token: options?.env?.CLAUDE_CODE_OAUTH_TOKEN, prompts: [] as string[] };
                generations.push(generation);
                const index = generations.length;
                const response = (async function* () {
                    // Like the real CLI, a provider reports `init` only once its first message arrived.
                    const init = { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
                    for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                        if (generation.prompts.length === 0) yield init;
                        generation.prompts.push(JSON.stringify(message.message.content));
                        if (index === 1) {
                            yield refused;
                            yield { type: 'result', subtype: 'success', result: 'Claude AI usage limit reached', is_error: true, uuid: 'result-1' };
                            // The refused provider process ends on its own while the background wait is pending.
                            return;
                        }
                        yield assistant(`msg-${index}`);
                        yield { type: 'result', subtype: 'success', result: 'done', is_error: false, uuid: `result-${index}` };
                        void handlers.get('switch')!();
                        return;
                    }
                })();
                return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
            });
            queue.push('hello', { permissionMode: 'default', model: 'claude-sonnet-5' });
            const session: Record<string, unknown> = {
                lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
                cancelLessonReview: vi.fn(),
                sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
                api: { push: () => ({ sendSessionNotification: vi.fn() }) },
                consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onAbort: vi.fn(),
            };

            const launched = claudeRemoteLauncher(session as unknown as Session);
            await vi.waitFor(() => expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: APPLY_REQUIRED_NOTICE, setupTokenRotation: { version: 1, state: 'apply-required' } }));
            // The loop has started the next provider, which waits for its first input next to the wait the exited one left behind.
            for (let tick = 0; tick < 50; tick++) await new Promise(resolve => setImmediate(resolve));
            expect(generations).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(60_000);
            // Lost to the exited provider's wait, the continuation never starts a provider on the new account.
            await vi.waitFor(() => expect(generations).toHaveLength(2), { timeout: 3_000 });
            await launched;

            expect(requestSetupTokenRebind).toHaveBeenCalledTimes(3);
            const continued = generations.find(generation => generation.prompts.some(prompt => prompt.includes(CONTINUE_PROMPT)));
            expect(continued?.token).toBe('sk-ant-oat01-second');
            expect(continued?.prompts[0]).toContain(CONTINUE_PROMPT);
        } finally {
            vi.useRealTimers();
        }
    });
});
