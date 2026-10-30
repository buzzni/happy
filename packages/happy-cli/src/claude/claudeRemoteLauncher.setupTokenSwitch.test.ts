import { TurnInputEvidence, type EvidenceBatch } from '@/api/turnInputEvidence';
import { closeClaudeTurnWithStatus, mapClaudeLogMessageToSessionEnvelopes, mapClaudeChannelFinalAnswer,
    failClaudeLaunchTurn, type ClaudeSessionProtocolState } from './utils/sessionProtocolMapper';
import { createEnvelope, type SessionEnvelope, type SessionTurnEndStatus, type InputEvidenceV1 } from '@slopus/happy-wire';
import type { RawJSONLines } from './types';
import { formatSetupTokenBinding } from '@/daemon/sessionEnv';
import { readPersonalClaudeCredential } from './personalClaudeCredential';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { Session } from './session';
import type { EnhancedMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { requestSetupTokenStart, requestSetupTokenRebind, reportSetupTokenActivity, reportSetupTokenUsage, requestSetupTokenAvailability, returnFromPersonalClaude } from '@/daemon/controlClient';
import { APPLY_REQUIRED_NOTICE, CONTINUE_PROMPT, RESUME_REBOUND_NOTICE, SWITCHED_NOTICE } from './setupTokenAccountSwitching';
import { PERSONAL_RECHECK_NOTICE } from './personalClaudeFallback';
import { claudeCheckSession } from './utils/claudeCheckSession';
import { describeClaudeLaunchFailure } from './utils/launchFailureMessage';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: vi.fn(),
}));
// The Claude conversation file lives in the provider's config directory, which a test does not have.
vi.mock('./utils/claudeCheckSession', () => ({ claudeCheckSession: vi.fn(() => true) }));
vi.mock('@/daemon/controlClient', async (original) => ({
    ...await original<typeof import('@/daemon/controlClient')>(),
    requestSetupTokenStart: vi.fn(async () => ({ state: 'allowed', validForMs: 15000 })),
    requestSetupTokenAvailability: vi.fn(), returnFromPersonalClaude: vi.fn(),
    reportSetupTokenUsage: vi.fn(async () => {}),
    reportSetupTokenActivity: vi.fn(async () => ({ ok: true })),
    requestSetupTokenRebind: vi.fn(async () => ({ ok: true, environment: {
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-second', HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: '{"account":"second"}' } })),
}));

vi.mock('./personalClaudeCredential', () => ({ readPersonalClaudeCredential: vi.fn() }));
const saved = { source: process.env.HAPPY_AI_AUTH_SOURCE, token: process.env.CLAUDE_CODE_OAUTH_TOKEN, binding: process.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING };
beforeEach(() => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-first';
    process.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING = '{"account":"first"}';
});
afterEach(() => {
    for (const [key, value] of [['HAPPY_AI_AUTH_SOURCE', saved.source], ['CLAUDE_CODE_OAUTH_TOKEN', saved.token], ['HAPPY_AI_AUTH_SETUP_TOKEN_BINDING', saved.binding]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    vi.clearAllMocks();
});

const assistant = (id: string) => ({ type: 'assistant', uuid: `uuid-${id}`, session_id: 'claude-1', parent_tool_use_id: null,
    message: { id, role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } } });
const refused = { type: 'rate_limit_event', uuid: 'rl-1', session_id: 'claude-1',
    rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 } };

function attachInputEvidence(client: {
    sendClaudeSessionMessage: ReturnType<typeof vi.fn>; setPendingTurnRequestId: ReturnType<typeof vi.fn>;
    sendFinalAnswerForChannelTurn: ReturnType<typeof vi.fn>; closeClaudeSessionTurn: ReturnType<typeof vi.fn>;
    failClaudeLaunchTurn?: ReturnType<typeof vi.fn>;
}) {
    const events: SessionEnvelope[] = [];
    const tracker = new TurnInputEvidence('host', event => events.push(event));
    const state: ClaudeSessionProtocolState = { currentTurnId: null };
    const accept = (envelopes: SessionEnvelope[]) => {
        for (const envelope of envelopes) {
            events.push(tracker.stamp(envelope));
        }
    };
    Object.assign(client, {
        inputEvidence: tracker,
        startClaudeInputEvidence: (batch: EvidenceBatch) => { tracker.setPending(batch); },
        continueClaudeInputEvidence: (kind: InputEvidenceV1['continuation']['kind']) => { tracker.continuePending(kind); },
    });
    client.setPendingTurnRequestId.mockImplementation((id: string | null) => { state.pendingRequestId = id; });
    client.sendClaudeSessionMessage.mockImplementation((body: RawJSONLines) => accept(mapClaudeLogMessageToSessionEnvelopes(body, state).envelopes));
    client.sendFinalAnswerForChannelTurn.mockImplementation((text: string) => {
        const mapped = mapClaudeChannelFinalAnswer(state, text).envelopes;
        accept(mapped.length || !text.trim() ? mapped : (state.currentTurnId ? [createEnvelope('agent', { t: 'final-answer', text }, { turn: state.currentTurnId })] : [tracker.unmappedFinalEvidence()]));
    });
    client.closeClaudeSessionTurn.mockImplementation((status: SessionTurnEndStatus) => {
        const mapped = closeClaudeTurnWithStatus(state, status).envelopes;
        if (!mapped.length) tracker.setPending(null);
        accept(mapped);
    });
    client.failClaudeLaunchTurn?.mockImplementation(() => {
        const mapped = failClaudeLaunchTurn(state).envelopes;
        accept(mapped);
    });
    return { events, tracker };
}

describe('setup-token account switch in the remote launcher (Saycode specs/claude-setup-token-account-selection)', () => {
    // Saycode specs/managed-account-session-continuation — the daemon moved this conversation at resume.
    it('records once that a resumed conversation moved onto another organization account', async () => {
        process.env.HAPPY_SETUP_TOKEN_RESUME_REBOUND = '1';
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const client = {
            sessionId: 'happy-session-1',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        vi.mocked(query).mockImplementation(({ prompt }) => Object.assign((async function* () {
            yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
            for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
                yield assistant('msg-1');
                yield { type: 'result', subtype: 'success', result: 'done', is_error: false, uuid: 'result-1' };
                void handlers.get('switch')!();
                return;
            }
        })(), { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>);
        queue.push('hello', { permissionMode: 'default', model: 'claude-sonnet-5' });
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 }, cancelLessonReview: vi.fn(),
            sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onAbort: vi.fn(),
        };

        await claudeRemoteLauncher(session as unknown as Session);

        const notices = client.sendSessionEvent.mock.calls.filter(([event]) => event.setupTokenRotation?.state === 'resume-rebound');
        expect(notices).toEqual([[{ type: 'message', message: RESUME_REBOUND_NOTICE, setupTokenRotation: { version: 1, state: 'resume-rebound' } }]]);
        expect(process.env.HAPPY_SETUP_TOKEN_RESUME_REBOUND).toBeUndefined();
    });
    it('holds the actual SDK input until start admission is granted', async () => {
        let admit!: (value: { state: 'allowed'; validForMs: number }) => void;
        vi.mocked(requestSetupTokenStart).mockImplementationOnce(() => new Promise(resolve => { admit = resolve; }));
        const inputs = vi.fn();
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const client = {
            sessionId: 'happy-session-1',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        vi.mocked(query).mockImplementation(({ prompt }) => Object.assign((async function* () {
            yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
            for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
                inputs();
                yield assistant('msg-1');
                yield { type: 'result', subtype: 'success', result: 'done', is_error: false, uuid: 'result-1' };
                void handlers.get('switch')!();
                return;
            }
        })(), { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>);
        queue.push('hello', { permissionMode: 'default', model: 'claude-sonnet-5' });
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 }, cancelLessonReview: vi.fn(),
            sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onAbort: vi.fn(),
        };

        const running = claudeRemoteLauncher(session as unknown as Session);
        await vi.waitFor(() => expect(requestSetupTokenStart).toHaveBeenCalledTimes(1));
        expect(inputs).not.toHaveBeenCalled();
        admit({ state: 'allowed', validForMs: 15000 });
        await running;
        expect(inputs).toHaveBeenCalledTimes(1);
    });
    it.each(['abort', 'switch'])('handles a budget-waiting input without execution on %s', async action => {
        vi.mocked(requestSetupTokenStart).mockImplementationOnce((_session, _binding, _request, signal) => new Promise(resolve => {
            signal.addEventListener('abort', () => resolve({ state: 'allowed', validForMs: 15000 }), { once: true });
        }));
        const inputs = vi.fn();
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const client = {
            sessionId: 'happy-session-1',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        vi.mocked(query).mockImplementation(({ prompt }) => Object.assign((async function* () {
            yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
            for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
                inputs();
                yield assistant('msg-1');
                yield { type: 'result', subtype: 'success', result: 'done', is_error: false, uuid: 'result-1' };
                void handlers.get('switch')!();
                return;
            }
        })(), { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>);
        queue.push('hello', { permissionMode: 'default', model: 'claude-sonnet-5' });
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 }, cancelLessonReview: vi.fn(),
            sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onAbort: vi.fn(),
        };

        const running = claudeRemoteLauncher(session as unknown as Session);
        await vi.waitFor(() => expect(requestSetupTokenStart).toHaveBeenCalledTimes(1));
        expect(inputs).not.toHaveBeenCalled();
        await handlers.get(action)!();
        await new Promise(resolve => setTimeout(resolve, 100));
        if (action === 'abort') await handlers.get('switch')!();
        await running;
        expect(queue.size()).toBe(action === 'switch' ? 1 : 0);
        expect(inputs).not.toHaveBeenCalled();
        expect(requestSetupTokenStart).toHaveBeenCalledTimes(1);
    });
    it('reports a start admission failure on a later turn instead of dropping the message silently', async () => {
        vi.mocked(requestSetupTokenStart)
            .mockResolvedValueOnce({ state: 'allowed', validForMs: 15000 })
            .mockRejectedValueOnce(new Error('SETUP_TOKEN_START_UNAVAILABLE'));
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const client = {
            sessionId: 'happy-session-1',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            failClaudeLaunchTurn: vi.fn(() => { void handlers.get('switch')!(); }),
            applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        const prompts: string[] = [];
        vi.mocked(query).mockImplementation(({ prompt }) => Object.assign((async function* () {
            yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
            for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                prompts.push(JSON.stringify(message.message.content));
                yield assistant(`msg-${prompts.length}`);
                yield { type: 'result', subtype: 'success', result: 'done', is_error: false, uuid: `result-${prompts.length}` };
                if (prompts.length === 1) queue.push('second message', { permissionMode: 'default', model: 'claude-sonnet-5' });
            }
        })(), { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>);
        queue.push('first message', { permissionMode: 'default', model: 'claude-sonnet-5' });
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 }, cancelLessonReview: vi.fn(),
            sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onAbort: vi.fn(),
        };

        const running = claudeRemoteLauncher(session as unknown as Session);
        await vi.waitFor(() => expect(client.failClaudeLaunchTurn).toHaveBeenCalledTimes(1), { timeout: 3000 });
        await running;

        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain('first message');
        expect(requestSetupTokenStart).toHaveBeenCalledTimes(2);
        expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message',
            message: describeClaudeLaunchFailure(new Error('SETUP_TOKEN_START_UNAVAILABLE')) });
    });
    it('queues a batch held back after start admission once when switching to local mode', async () => {
        vi.mocked(requestSetupTokenStart)
            .mockResolvedValueOnce({ state: 'allowed', validForMs: 15000 })
            .mockImplementationOnce(async () => {
                // Another turn boundary rebinds the account while this turn waits for admission.
                process.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING = '{"account":"second"}';
                return { state: 'allowed', validForMs: 15000 };
            });
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const client = {
            sessionId: 'happy-session-1',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        const prompts: string[] = [];
        vi.mocked(query).mockImplementation(({ prompt }) => Object.assign((async function* () {
            yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
            for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                prompts.push(JSON.stringify(message.message.content));
                yield assistant('msg-1');
                yield { type: 'result', subtype: 'success', result: 'done', is_error: false, uuid: 'result-1' };
                queue.push('second message', { permissionMode: 'default', model: 'claude-sonnet-5' });
            }
            // The input ended for the stale provider; the user switches to local mode while it still exits.
            void handlers.get('switch')!();
            await new Promise(resolve => setTimeout(resolve, 200));
        })(), { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>);
        queue.push('first message', { permissionMode: 'default', model: 'claude-sonnet-5' });
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 }, cancelLessonReview: vi.fn(),
            sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onAbort: vi.fn(),
        };

        await claudeRemoteLauncher(session as unknown as Session);

        expect(prompts).toHaveLength(1);
        expect(queue.size()).toBe(1);
    });

    it.each(['result', 'exception', 'auth-result', 'auth-exception', 'auth-continuation', 'auth-fresh', 'auth-thrown', 'auth-refresh'])('restarts the same conversation after a known account refusal (%s) and prioritizes the queued user message', async failure => {
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const client = {
            sessionId: 'happy-session-1',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            failClaudeLaunchTurn: vi.fn(() => { void handlers.get('switch')!(); }),
            applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
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
                        if (!['auth-continuation', 'auth-fresh', 'auth-thrown', 'auth-refresh'].includes(failure)) queue.push('queued while refused', { permissionMode: 'default', model: 'claude-sonnet-5' });
                        if (failure === 'auth-thrown') throw new Error('Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.');
                        if (failure === 'auth-exception') yield { ...assistant('auth'), error: 'authentication_failed' };
                        else if (!failure.startsWith('auth')) yield refused;
                        if (failure === 'exception' || failure === 'auth-exception') throw new Error('Provider exited after known account-wide quota refusal');
                        yield { type: 'result', subtype: 'success', result: failure === 'auth-refresh' ? 'Failed to authenticate: OAuth session expired and could not be refreshed' : failure.startsWith('auth') ? 'Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.' : 'Claude AI usage limit reached', is_error: true, uuid: 'result-1' };
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
        queue.push('hello', { permissionMode: 'default', model: 'claude-sonnet-5' }, failure === 'auth-fresh' ? [{ data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: 'image/png', name: 'example.png' }] : undefined);
        const session: Record<string, unknown> = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            // A failed first request may not have created a native conversation yet.
            sessionId: failure === 'auth-fresh' ? null : 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onAbort: vi.fn(),
        };

        await claudeRemoteLauncher(session as unknown as Session);

        expect(generations.map(generation => generation.token)).toEqual(['sk-ant-oat01-first', 'sk-ant-oat01-second']);
        const activeBindings = vi.mocked(reportSetupTokenActivity).mock.calls.filter(c => c[2].state === 'active').map(c => c[1]);
        expect(activeBindings).toContain('{"account":"first"}');
        expect(activeBindings.at(-1)).toBe('{"account":"second"}');
        expect(vi.mocked(reportSetupTokenActivity).mock.calls.at(-1)?.[2].state).toBe('finished');
        expect(client.setClaudeRuntimeAccount.mock.calls.map(([binding]) => JSON.parse(String(binding)).account)).toEqual(['first', 'second']);
        expect(generations.map(generation => generation.resume)).toEqual(failure === 'auth-fresh' ? [undefined, undefined] : ['claude-1', 'claude-1']);
        // A queued user turn replaces automatic continuation and runs alone on the new account.
        const automaticallyContinued = ['auth-continuation', 'auth-thrown', 'auth-refresh'].includes(failure);
        expect(generations[1].prompts[0]).toContain(failure === 'auth-fresh' ? 'hello' : automaticallyContinued ? CONTINUE_PROMPT : 'queued while refused');
        if (!automaticallyContinued) expect(generations[1].prompts[0]).not.toContain(CONTINUE_PROMPT);
        if (failure === 'auth-fresh') expect(generations[1].prompts[0]).toContain('iVBORw0KGgo=');
        expect(requestSetupTokenRebind).toHaveBeenCalledWith('happy-session-1', '{"account":"first"}', ['auth-refresh', 'auth-exception'].includes(failure) ? undefined : expect.objectContaining({ reason: failure.startsWith('auth') ? 'authentication-failed' : 'rate-limited' }), expect.any(AbortSignal));
        if (!failure.startsWith('auth')) expect(reportSetupTokenUsage).toHaveBeenCalledWith('happy-session-1', '{"account":"first"}', expect.objectContaining({ reason: failure.startsWith('auth') ? 'authentication-failed' : 'rate-limited' }), expect.any(AbortSignal));
        expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: failure.startsWith('auth') ? 'This organization Claude account could not authenticate, so the session moved to another organization account.' : SWITCHED_NOTICE, setupTokenRotation: { version: 1, state: 'switched' } });
        expect(requestSetupTokenRebind).toHaveBeenCalledTimes(1);
        expect(generations[0].prompts).toHaveLength(1);
        expect(generations[1].prompts).toHaveLength(1);
        // A restarted provider is not enough: the new reply must reach the user's session once.
        const replies = client.sendClaudeSessionMessage.mock.calls.flatMap(([body]) =>
            body.type === 'assistant' && body.message.id !== 'auth' ? [body.message] : []);
        expect(replies).toEqual([
            expect.objectContaining({ id: 'msg-2', content: [{ type: 'text', text: 'hi' }] }),
        ]);
        const successfulResults = client.applyClaudeTurnResult.mock.calls.flatMap(([result]) =>
            result.is_error === false ? [result.uuid] : []);
        expect(successfulResults).toEqual(['result-2']);
    });

    // Saycode specs/shared-pc-session-account-continuation — a shared PC session has no Studio binding.
    it('moves an unbound shared-PC session off a used-up account and continues the refused turn', async () => {
        const SHARED_A = '0b6f2c1e-1111-4a2b-8c3d-000000000001';
        const SHARED_B = '0b6f2c1e-1111-4a2b-8c3d-000000000002';
        delete process.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING;
        process.env.HAPPY_AI_AUTH_SETUP_TOKEN_LEGACY_SHARED = '1';
        process.env.HAPPY_AI_AUTH_SETUP_TOKEN_SHARED_ACCOUNT = SHARED_A;
        vi.mocked(requestSetupTokenRebind).mockResolvedValueOnce({ ok: true, environment: {
            CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-second', HAPPY_AI_AUTH_SETUP_TOKEN_LEGACY_SHARED: '1', HAPPY_AI_AUTH_SETUP_TOKEN_SHARED_ACCOUNT: SHARED_B } });
        try {
            const queue = new MessageQueue2<EnhancedMode>(hashObject);
            const handlers = new Map<string, () => Promise<unknown>>();
            const client = {
                sessionId: 'happy-session-1',
                rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
                updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
                setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
                setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
                applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
            };
            const witness = attachInputEvidence(client);
            const generations: Array<{ token?: string; resume?: string; prompts: string[] }> = [];
            vi.mocked(query).mockImplementation(({ prompt, options }) => {
                const generation = { token: options?.env?.CLAUDE_CODE_OAUTH_TOKEN, resume: options?.resume, prompts: [] as string[] };
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
            queue.push('hello', { permissionMode: 'default', model: 'claude-sonnet-5' }, undefined, undefined, undefined, undefined,
                { ref: { kind: 'rest', serverMessageId: 'original-input', serverSeq: 1 } });
            const session: Record<string, unknown> = {
                lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
                cancelLessonReview: vi.fn(),
                sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
                api: { push: () => ({ sendSessionNotification: vi.fn() }) },
                consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onAbort: vi.fn(),
            };

            await claudeRemoteLauncher(session as unknown as Session);

            expect(generations.map(generation => generation.token)).toEqual(['sk-ant-oat01-first', 'sk-ant-oat01-second']);
        expect(reportSetupTokenActivity).not.toHaveBeenCalled();
            expect(generations.map(generation => generation.resume)).toEqual(['claude-1', 'claude-1']);
            expect(generations[1].prompts[0]).toContain(CONTINUE_PROMPT);
            const ends = witness.events.filter(event => event.ev.t === 'turn-end');
            expect(ends[0].ev).toMatchObject({ inputEvidence: { terminal: true,
                continuation: { kind: 'none', state: 'none' } } });
            expect(ends.at(-1)?.ev).toMatchObject({ inputEvidence: { inputCount: 1,
                inputs: [{ kind: 'unidentified' }],
                terminal: true, continuation: { kind: 'none', state: 'none' } } });
            const running = `shared-machine:${SHARED_A}`;
            expect(requestSetupTokenRebind).toHaveBeenCalledWith('happy-session-1', running, expect.objectContaining({ reason: 'rate-limited' }), expect.any(AbortSignal));
            expect(reportSetupTokenUsage).toHaveBeenCalledWith('happy-session-1', running, expect.objectContaining({ reason: 'rate-limited' }), expect.any(AbortSignal));
            // The organization account shown for a session still comes only from a signed binding.
            expect(client.setClaudeRuntimeAccount.mock.calls).toEqual([[undefined], [undefined]]);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: SWITCHED_NOTICE, setupTokenRotation: { version: 1, state: 'switched' } });
        } finally {
            delete process.env.HAPPY_AI_AUTH_SETUP_TOKEN_LEGACY_SHARED;
            delete process.env.HAPPY_AI_AUTH_SETUP_TOKEN_SHARED_ACCOUNT;
        }
    });

    it('closes a refused turn as failed when the provider throws and rebind fails', async () => {
        vi.mocked(requestSetupTokenRebind).mockResolvedValueOnce({ ok: false, reason: 'FORBIDDEN' });
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const client = {
            sessionId: 'happy-session-1',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
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
            setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
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
        const activeBindings = vi.mocked(reportSetupTokenActivity).mock.calls.filter(c => c[2].state === 'active').map(c => c[1]);
        expect(activeBindings).toContain('{"account":"first"}');
        expect(activeBindings.at(-1)).toBe('{"account":"second"}');
        expect(vi.mocked(reportSetupTokenActivity).mock.calls.at(-1)?.[2].state).toBe('finished');
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
            setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
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
        const activeBindings = vi.mocked(reportSetupTokenActivity).mock.calls.filter(c => c[2].state === 'active').map(c => c[1]);
        expect(activeBindings).toContain('{"account":"first"}');
        expect(activeBindings.at(-1)).toBe('{"account":"second"}');
        expect(vi.mocked(reportSetupTokenActivity).mock.calls.at(-1)?.[2].state).toBe('finished');
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
                setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
                setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
                applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
            };
            const witness = attachInputEvidence(client);
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
            queue.push('hello', { permissionMode: 'default', model: 'claude-sonnet-5' }, undefined, undefined, undefined, undefined,
                { ref: { kind: 'rest', serverMessageId: 'original-input', serverSeq: 1 } });
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
                expect(witness.tracker.snapshot()).toBeNull();
                expect(witness.tracker.takeContinuation()).toBeUndefined();
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
        const activeBindings = vi.mocked(reportSetupTokenActivity).mock.calls.filter(c => c[2].state === 'active').map(c => c[1]);
        expect(activeBindings).toContain('{"account":"first"}');
        expect(activeBindings.at(-1)).toBe('{"account":"second"}');
        expect(vi.mocked(reportSetupTokenActivity).mock.calls.at(-1)?.[2].state).toBe('finished');
            expect(generations[1].prompts[0]).toContain(CONTINUE_PROMPT);
            const ends = witness.events.filter(event => event.ev.t === 'turn-end');
            expect(ends[0].ev).toMatchObject({ inputEvidence: { terminal: true,
                continuation: { kind: 'none', state: 'none' } } });
            expect(ends.at(-1)?.ev).toMatchObject({ inputEvidence: { inputCount: 1,
                inputs: [{ kind: 'unidentified' }],
                terminal: true, continuation: { kind: 'none', state: 'none' } } });
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
                setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
                setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
                applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
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

    it('answers the next user message in the live provider when the refused provider exited while no account was left', async () => {
        // The rebind is still in flight when the refused provider exits, so both generations wait for it.
        let finishRebind!: () => void;
        vi.mocked(requestSetupTokenRebind).mockImplementation(() => new Promise(resolve => {
            finishRebind = () => resolve({ ok: false, reason: 'NO_ACCOUNT' });
        }));
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const client = {
            sessionId: 'happy-session-1',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        const generations: Array<{ prompts: string[] }> = [];
        vi.mocked(query).mockImplementation(({ prompt }) => {
            const generation = { prompts: [] as string[] };
            generations.push(generation);
            const index = generations.length;
            const response = (async function* () {
                const init = { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    if (generation.prompts.length === 0) yield init;
                    generation.prompts.push(JSON.stringify(message.message.content));
                    if (index === 1) {
                        yield refused;
                        yield { type: 'result', subtype: 'success', result: 'Claude AI usage limit reached', is_error: true, uuid: 'result-1' };
                        // The refused provider process ends on its own while the rebind is pending.
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
        await vi.waitFor(() => expect(requestSetupTokenRebind).toHaveBeenCalledTimes(1));
        // Let the refused provider end and the next generation start waiting for its first input.
        for (let tick = 0; tick < 50; tick++) await new Promise(resolve => setImmediate(resolve));
        finishRebind();
        for (let tick = 0; tick < 50; tick++) await new Promise(resolve => setImmediate(resolve));
        queue.push('continue please', { permissionMode: 'default', model: 'claude-sonnet-5' });
        // Taken by the ended generation's wait, the message was dropped and the live one waited forever.
        await vi.waitFor(() => expect(generations).toHaveLength(2), { timeout: 3_000 });
        await launched;

        expect(generations[1].prompts[0]).toContain('continue please');
    });

    // The ended generation was already waiting for input when its provider exited on its own.
    it.each([
        ['after the ended generation returned', 'consumeOneTimeFlags'],
        ['while the next generation starts', 'claudeCheckSession'],
    ] as const)('answers a message that arrives %s in the live provider', async (_when, hook) => {
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const client = {
            sessionId: 'happy-session-1',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        const generations: Array<{ prompts: string[] }> = [];
        vi.mocked(query).mockImplementation(({ prompt }) => {
            const generation = { prompts: [] as string[] };
            generations.push(generation);
            const index = generations.length;
            const response = (async function* () {
                const init = { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    if (generation.prompts.length === 0) yield init;
                    generation.prompts.push(JSON.stringify(message.message.content));
                    yield assistant(`msg-${index}`);
                    yield { type: 'result', subtype: 'success', result: 'done', is_error: false, uuid: `result-${index}` };
                    if (index === 1) {
                        // The provider exits on its own once its next-input wait is registered.
                        await vi.waitFor(() => expect(Reflect.get(queue, 'waiter')).not.toBeNull());
                        return;
                    }
                    void handlers.get('switch')!();
                    return;
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        let arrived = false;
        const arrive = () => {
            if (arrived) return;
            arrived = true;
            queue.push('after exit', { permissionMode: 'default', model: 'claude-sonnet-5' });
        };
        let checks = 0;
        vi.mocked(claudeCheckSession).mockImplementation(() => {
            if (hook === 'claudeCheckSession' && ++checks === 2) arrive();
            return true;
        });
        queue.push('hello', { permissionMode: 'default', model: 'claude-sonnet-5' });
        const session: Record<string, unknown> = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(() => { if (hook === 'consumeOneTimeFlags') arrive(); }),
            onThinkingChange: vi.fn(), onAbort: vi.fn(),
        };

        try {
            const launched = claudeRemoteLauncher(session as unknown as Session);
            // Taken by the ended generation's wait, the message was dropped and the live one waited forever.
            await vi.waitFor(() => expect(generations).toHaveLength(2), { timeout: 3_000 });
            await launched;
        } finally {
            vi.mocked(claudeCheckSession).mockImplementation(() => true);
        }

        expect(generations[1].prompts[0]).toContain('after exit');
    });
});

function pinnedSdkControls() {
    let effective: Record<string, unknown> = {};
    return {
        initializationResult: async () => ({ claude_code_version: '2.1.308', hooks_applied: true }),
        applyFlagSettings: async (settings: Record<string, unknown>) => { effective = settings; },
        getSettings: async () => ({ effective, sources: [] }),
        reinitialize: async () => ({ account: { apiProvider: 'firstParty', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' } }),
        close: () => {},
    };
}

it.each(['automatic', 'organization-only', 'authentication', 'consent-during-rebind'].flatMap(returnMode => [false, true].map(witnessed => ({ returnMode, witnessed }))))('keeps one conversation through organization, approved personal continuation and verified organization return ($returnMode, evidence=$witnessed)', async ({ returnMode, witnessed }) => {
    const original = formatSetupTokenBinding({ companyId:'org',groupScope:'org',userId:'owner',machineId:'pc',managedAccountId:'11111111-1111-4111-8111-111111111111',credentialGeneration:1,keyId:'f'.repeat(64),nonce:'22222222-2222-4222-8222-222222222222',issuedAt:1 })
    process.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING = original;
    let available = false;
    let finishRebind: (() => void) | undefined;
    vi.mocked(requestSetupTokenRebind).mockImplementation(async () => {
        if (returnMode !== 'consent-during-rebind') return { ok: false, reason: 'NO_ACCOUNT' };
        return new Promise(resolve => { finishRebind = () => resolve({ ok: false, reason: 'NO_ACCOUNT' }); });
    });
    vi.mocked(requestSetupTokenAvailability).mockImplementation(async (_id,_binding,consent) => ({allLimited:!available && returnMode!=='authentication',availableAccountIds:available?['org-account']:[],consentApproved:!!consent,...(!available && returnMode==='authentication'?{fallbackReason:'organization-authentication' as const}:{})}));
    vi.mocked(returnFromPersonalClaude).mockResolvedValue({ok:true,environment:{CLAUDE_CODE_OAUTH_TOKEN:'fixture-org-return',HAPPY_AI_AUTH_SETUP_TOKEN_BINDING:original,HAPPY_AI_AUTH_SOURCE:'org-bundle'}});
    vi.mocked(readPersonalClaudeCredential).mockResolvedValue({accountRef:'a'.repeat(64),label:'pe…@example.test',accessToken:'fixture-personal',expiresAt:Date.now()+600000});
    const queue = new MessageQueue2<EnhancedMode>(hashObject), handlers = new Map<string, (params?: any) => Promise<any>>();
    const client = { sessionId:'happy-session-1',rpcHandlerManager:{registerHandler:(name:string,handler:any)=>handlers.set(name,handler)},
        updateAgentState:vi.fn(),updateMetadata:vi.fn(),getMetadata:()=>({}),setPersonalClaudeFallback:vi.fn(),setClaudeRuntimeAccount:vi.fn(),
        sendClaudeSessionMessage:vi.fn(),sendStreamDelta:vi.fn(),setPendingTurnRequestId:vi.fn(),sendFinalAnswerForChannelTurn:vi.fn(),
        applyClaudeTurnResult:vi.fn(),noteContextUsageSignal:vi.fn(),closeClaudeSessionTurn:vi.fn(),sendSessionEvent:vi.fn() };
    const evidence = witnessed ? attachInputEvidence(client) : null;
    const generations: Array<{token:string|undefined,resume:string|undefined,settingSources?:string[],prompts:string[]}> = [];
    vi.mocked(query).mockImplementation(({prompt,options}) => {
        const generation = {token:process.env.CLAUDE_CODE_OAUTH_TOKEN,resume:options?.resume,settingSources:options?.settingSources,prompts:[] as string[]};generations.push(generation);
        const nth=generations.length;
        return Object.assign((async function* () {
            yield {type:'system',subtype:'init',session_id:'',tools:[],mcp_servers:[],apiKeySource:'none'};
            for await(const message of prompt as AsyncIterable<SDKUserMessage>) {
                generation.prompts.push(JSON.stringify(message.message.content));
                if(nth===1) {
                    if(returnMode==='authentication') yield {...assistant('auth-refused'),error:'authentication_failed'}; else yield refused;
                    setTimeout(() => { void (async () => {
                        if (returnMode === 'consent-during-rebind') await vi.waitFor(() => expect(finishRebind).toBeTypeOf('function'));
                        // After an authentication failure the automatic organization switch answers first (specs/org-auth-failure-account-switch).
                        let offer: any;
                        await vi.waitFor(async () => { offer=(await handlers.get('personal-claude-fallback')!({action:'status'})).offer; expect(offer?.state).toBe('offer'); });
                        await handlers.get('personal-claude-fallback')!({action:'accept',accountRef:offer.accountRef,nonce:offer.nonce,consentProof:'fixture-proof'});
                        finishRebind?.();
                    })(); }, 0);
                    yield {type:'result',subtype:'error_during_execution',is_error:true,errors:[returnMode==='authentication'?'API Error: 401 token expired':'usage limit'],uuid:'refused-personal'};
                } else {
                    yield assistant(`personal-${nth}`);
                    if(nth===2) {
                        available=true;
                        if(returnMode!=='organization-only') queue.push('next request after recovery',{permissionMode:'default',model:'claude-sonnet-5'});
                        else setTimeout(()=>{void(async()=>{
                            const restored=await handlers.get('personal-claude-fallback')!({action:'restore-organization'});expect(restored.restored).toBe(true);
                            queue.push('next request after recovery',{permissionMode:'default',model:'claude-sonnet-5'});
                        })();},0);
                    }
                    else {void handlers.get('switch')!();}
                    yield {type:'result',subtype:'success',result:'done',is_error:false,uuid:`result-personal-${nth}`};
                    if(nth===3) return;
                }
            }
        })(),{...pinnedSdkControls(),mcpServerStatus:async()=>[],setPermissionMode:async()=>{}}) as unknown as ReturnType<typeof query>;
    });
    queue.push('continue this task',{permissionMode:'default',model:'claude-sonnet-5'}, undefined, undefined, undefined, undefined,
        { ref: { kind: 'rest', serverMessageId: 'refused-input', serverSeq: 1 } });
    const session={lessonReviewLifecycle:{controller:new AbortController(),completedAssistantTurns:0},cancelLessonReview:vi.fn(),sessionId:'claude-1',path:process.cwd(),queue,client,mcpServers:{},
        api:{push:()=>({sendSessionNotification:vi.fn()})},consumeOneTimeFlags:vi.fn(),onThinkingChange:vi.fn(),onAbort:vi.fn()};
    await claudeRemoteLauncher(session as unknown as Session);
    if (evidence) {
        const starts = evidence.events.filter(event => event.ev.t === 'turn-start');
        const original = (starts[0].ev as { inputEvidence: InputEvidenceV1 }).inputEvidence;
        if (returnMode === 'authentication') {
            // This refusal has actual mapped assistant activity, so its root is witnessed.
            expect(starts).toHaveLength(3);
            expect(starts[1].ev).toMatchObject({ inputEvidence: { rootBatchId: original.rootBatchId,
                inputs: [{ kind: 'rest', serverMessageId: 'refused-input', serverSeq: 1 }],
                continuation: { kind: 'claude-account-switch', state: 'running' } } });
            expect(starts[2].ev).not.toMatchObject({ inputEvidence: { rootBatchId: original.rootBatchId } });
        } else {
            // Textless refusal opens no turn. Neither subsequent real turn may borrow A.
            expect(starts).toHaveLength(2);
            for (const start of starts) expect((start.ev as { inputEvidence: InputEvidenceV1 }).inputEvidence.inputs)
                .not.toContainEqual({ kind: 'rest', serverMessageId: 'refused-input', serverSeq: 1 });
        }
    }
    expect(generations.map(g=>g.resume)).toEqual(['claude-1','claude-1','claude-1']);
    expect(generations.map(g=>g.token)).toEqual(['sk-ant-oat01-first','fixture-personal','fixture-org-return']);
    expect(generations.map(g=>g.prompts.length)).toEqual([1,1,1]);
    expect(client.setPersonalClaudeFallback).toHaveBeenLastCalledWith(undefined);
    expect(client.setClaudeRuntimeAccount).toHaveBeenLastCalledWith(undefined);
    expect(generations[1].settingSources).toEqual(generations[0].settingSources);
    expect(returnFromPersonalClaude).toHaveBeenCalledOnce();
    expect(client.setPersonalClaudeFallback.mock.calls.filter(([v])=>v!==undefined).map(([v])=>v.personal?.accountRef??null)).toEqual([null,'a'.repeat(64),null]);
});

it.each((['authority', 'channel', 'pending-authority', 'pending-recovery'] as const).flatMap(kind => [false, true].map(witnessed => ({ kind, witnessed }))))('reports refused personal input with its request identity ($kind, evidence=$witnessed)', async ({ kind, witnessed }) => {
    const original = formatSetupTokenBinding({ companyId:'org',groupScope:'org',userId:'owner',machineId:'pc',managedAccountId:'11111111-1111-4111-8111-111111111111',credentialGeneration:1,keyId:'f'.repeat(64),nonce:'22222222-2222-4222-8222-222222222222',issuedAt:1 })
    process.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING = original;
    let recheckFails = false, recovered = false;
    vi.mocked(requestSetupTokenRebind).mockResolvedValue({ok:false,reason:'NO_ACCOUNT'});
    vi.mocked(requestSetupTokenAvailability).mockImplementation(async (_id,_binding,consent) => {
        if (recheckFails) throw new Error('daemon unreachable');
        return recovered ? {allLimited:false,availableAccountIds:['org-return'],consentApproved:false} : {allLimited:true,availableAccountIds:[],consentApproved:!!consent};
    });
    vi.mocked(returnFromPersonalClaude).mockResolvedValue({ok:true,environment:{CLAUDE_CODE_OAUTH_TOKEN:'fixture-org-return',HAPPY_AI_AUTH_SETUP_TOKEN_BINDING:original}});
    vi.mocked(readPersonalClaudeCredential).mockResolvedValue({accountRef:'a'.repeat(64),label:'pe…@example.test',accessToken:'fixture-personal',expiresAt:Date.now()+600000});
    const queue = new MessageQueue2<EnhancedMode>(hashObject), handlers = new Map<string, (params?: any) => Promise<any>>();
    const client = { sessionId:'happy-session-1',rpcHandlerManager:{registerHandler:(name:string,handler:any)=>handlers.set(name,handler)},
        updateAgentState:vi.fn(),updateMetadata:vi.fn(),getMetadata:()=>({}),setPersonalClaudeFallback:vi.fn(),setClaudeRuntimeAccount:vi.fn(),
        sendClaudeSessionMessage:vi.fn(),sendStreamDelta:vi.fn(),setPendingTurnRequestId:vi.fn(),sendFinalAnswerForChannelTurn:vi.fn(),
        applyClaudeTurnResult:vi.fn(),noteContextUsageSignal:vi.fn(),closeClaudeSessionTurn:vi.fn(),sendSessionEvent:vi.fn(),failClaudeLaunchTurn:vi.fn() };
    const evidence = witnessed ? attachInputEvidence(client) : null;
    const generations: Array<{token:string|undefined,prompts:string[];sources:unknown}> = [];
    vi.mocked(query).mockImplementation(({prompt,options}) => {
        const generation = {token:process.env.CLAUDE_CODE_OAUTH_TOKEN,prompts:[] as string[],sources:options?.settingSources};generations.push(generation);
        const nth=generations.length;
        return Object.assign((async function* () {
            yield {type:'system',subtype:'init',session_id:'',tools:[],mcp_servers:[],apiKeySource:'none'};
            for await(const message of prompt as AsyncIterable<SDKUserMessage>) {
                generation.prompts.push(JSON.stringify(message.message.content));
                if(nth===1) {
                    yield refused;
                    setTimeout(() => { void (async () => {
                        const offer=(await handlers.get('personal-claude-fallback')!({action:'status'})).offer;
                        await handlers.get('personal-claude-fallback')!({action:'accept',accountRef:offer.accountRef,nonce:offer.nonce,consentProof:'fixture-proof'});
                    })(); }, 0);
                    yield {type:'result',subtype:'error_during_execution',is_error:true,errors:['usage limit'],uuid:'refused-personal'};
                } else {
                    yield assistant(`personal-${nth}`);
                    // The second request of this personal generation meets a failing authority recheck.
                    if(nth===2 && generation.prompts.length===1) setTimeout(()=>{
                        recheckFails=kind==='authority';
                        const mode:EnhancedMode={permissionMode:'default',model:kind.startsWith('pending-')?'claude-opus-5':'claude-sonnet-5'};
                        if(kind==='channel') queue.pushIsolated('blocked channel request',mode,undefined,undefined,'channel-1');
                        else queue.push('second request while personal',mode);
                    },0);
                    yield {type:'result',subtype:'success',result:'done',is_error:false,uuid:`result-personal-${nth}-${generation.prompts.length}`};
                    if(kind==='pending-recovery' && nth===3) setTimeout(()=>{void handlers.get('switch')!();},20);
                }
            }
            if(nth===2 && kind==='pending-authority') recheckFails=true;
            if(nth===2 && kind==='pending-recovery') recovered=true;
            if(nth>1 && kind!=='pending-recovery') setTimeout(()=>{void handlers.get('switch')!();},20);
        })(),{...pinnedSdkControls(),mcpServerStatus:async()=>[],setPermissionMode:async()=>{}}) as unknown as ReturnType<typeof query>;
    });
    queue.push('continue this task',{permissionMode:'default',model:'claude-sonnet-5'}, undefined, undefined, undefined, undefined,
        { ref: { kind: 'rest', serverMessageId: 'refused-input', serverSeq: 1 } });
    const session={lessonReviewLifecycle:{controller:new AbortController(),completedAssistantTurns:0},cancelLessonReview:vi.fn(),sessionId:'claude-1',path:process.cwd(),queue,client,mcpServers:{},
        api:{push:()=>({sendSessionNotification:vi.fn()})},consumeOneTimeFlags:vi.fn(),onThinkingChange:vi.fn(),onAbort:vi.fn()};
    await claudeRemoteLauncher(session as unknown as Session);
    expect(generations.map(g=>g.token)).toEqual(kind==='pending-recovery'?['sk-ant-oat01-first','fixture-personal','fixture-org-return']:['sk-ant-oat01-first','fixture-personal']);
    if (evidence) {
        const starts = evidence.events.filter(event => event.ev.t === 'turn-start');
        const original = (starts[0].ev as { inputEvidence: InputEvidenceV1 }).inputEvidence;
        expect(starts[1].ev).not.toMatchObject({ inputEvidence: { rootBatchId: original.rootBatchId } });
        expect((starts[1].ev as { inputEvidence: InputEvidenceV1 }).inputEvidence.inputs)
            .not.toContainEqual({ kind: 'rest', serverMessageId: 'refused-input', serverSeq: 1 });
    }
    if(kind==='pending-recovery') {expect(generations[2].prompts).toHaveLength(1);expect(generations[2].sources).not.toEqual([]);}
    expect(generations[1].prompts).toHaveLength(1);
    expect(queue.size()).toBe(0);
    const notices=client.sendSessionEvent.mock.calls.map(([event])=>event.message);
    if(kind==='pending-recovery') {expect(notices).not.toContain(PERSONAL_RECHECK_NOTICE);expect(client.failClaudeLaunchTurn).not.toHaveBeenCalled();}
    else {expect(notices).toContain(PERSONAL_RECHECK_NOTICE);expect(client.failClaudeLaunchTurn).toHaveBeenCalledOnce();}
    if(kind==='channel') {
        expect(client.setPendingTurnRequestId).toHaveBeenLastCalledWith('channel-1');
        expect(client.sendFinalAnswerForChannelTurn).toHaveBeenCalledWith(PERSONAL_RECHECK_NOTICE);
        const notice=client.sendFinalAnswerForChannelTurn.mock.calls.findIndex(([text])=>text===PERSONAL_RECHECK_NOTICE);
        expect(client.setPendingTurnRequestId.mock.invocationCallOrder.at(-1)).toBeLessThan(client.sendFinalAnswerForChannelTurn.mock.invocationCallOrder[notice]);
        expect(client.sendFinalAnswerForChannelTurn.mock.invocationCallOrder[notice]).toBeLessThan(client.failClaudeLaunchTurn.mock.invocationCallOrder[0]);
    }
});

// Saycode specs/org-auth-failure-account-switch — after an organization authentication failure the switch runs by
// itself (#990); the member can take another account now instead of waiting, or send the refused turn again.
describe('organization authentication failure recovery the member can take', () => {
    beforeEach(() => {
        vi.mocked(requestSetupTokenAvailability).mockReset();
        vi.mocked(readPersonalClaudeCredential).mockResolvedValue(null);
    });
    const dedicated = () => formatSetupTokenBinding({ companyId:'org',groupScope:'org',userId:'owner',machineId:'pc',managedAccountId:'11111111-1111-4111-8111-111111111111',credentialGeneration:1,keyId:'f'.repeat(64),nonce:'22222222-2222-4222-8222-222222222222',issuedAt:1 });
    function harness(afterRefusal: (rpc: (params: Record<string, unknown>) => Promise<any>, end: () => void) => Promise<void>) {
        process.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING = dedicated();
        const queue = new MessageQueue2<EnhancedMode>(hashObject), handlers = new Map<string, (params?: any) => Promise<any>>();
        const client = { sessionId:'happy-session-1',rpcHandlerManager:{registerHandler:(name:string,handler:any)=>handlers.set(name,handler)},
            updateAgentState:vi.fn(),updateMetadata:vi.fn(),getMetadata:()=>({}),setPersonalClaudeFallback:vi.fn(),setClaudeRuntimeAccount:vi.fn(),
            sendClaudeSessionMessage:vi.fn(),sendStreamDelta:vi.fn(),setPendingTurnRequestId:vi.fn(),sendFinalAnswerForChannelTurn:vi.fn(),
            applyClaudeTurnResult:vi.fn(),noteContextUsageSignal:vi.fn(),closeClaudeSessionTurn:vi.fn(),sendSessionEvent:vi.fn() };
        const generations: Array<{ token: string | undefined; resume: string | undefined; prompts: string[] }> = [];
        const rpc = (params: Record<string, unknown>) => handlers.get('personal-claude-fallback')!(params);
        const end = () => { void handlers.get('switch')!(); };
        let refusedOnce = false;
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            const generation = { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, resume: options?.resume, prompts: [] as string[] };
            generations.push(generation);
            return Object.assign((async function* () {
                yield { type:'system',subtype:'init',session_id:'',tools:[],mcp_servers:[],apiKeySource:'none' };
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    generation.prompts.push(JSON.stringify(message.message.content));
                    if (!refusedOnce) {
                        refusedOnce = true;
                        yield { ...assistant('auth-refused'), error: 'authentication_failed', message: { ...assistant('auth-refused').message, content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.' }] } };
                        setTimeout(() => { void afterRefusal(rpc, end); }, 0);
                        yield { type:'result',subtype:'error_during_execution',is_error:true,errors:['Failed to authenticate. API Error: 401 OAuth access token has been revoked.'],uuid:'refused' };
                        continue;
                    }
                    yield assistant(`answered-${generations.length}-${generation.prompts.length}`);
                    yield { type:'result',subtype:'success',result:'done',is_error:false,uuid:`done-${generations.length}-${generation.prompts.length}` };
                    end();
                    return;
                }
            })(), { ...pinnedSdkControls(), mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        // An existing conversation: the refused turn continues by a note, not by replaying its input.
        queue.push('review and open a PR', { permissionMode: 'default', model: 'claude-sonnet-5' });
        const session = { lessonReviewLifecycle:{controller:new AbortController(),completedAssistantTurns:0},cancelLessonReview:vi.fn(),sessionId:'claude-1',path:process.cwd(),queue,client,mcpServers:{},
            api:{push:()=>({sendSessionNotification:vi.fn()})},consumeOneTimeFlags:vi.fn(),onThinkingChange:vi.fn(),onAbort:vi.fn() };
        return { generations, client, run: () => claudeRemoteLauncher(session as unknown as Session) };
    }
    const offerOf = async (rpc: (params: Record<string, unknown>) => Promise<any>, state: string) => {
        let offer: any;
        await vi.waitFor(async () => { offer = (await rpc({ action: 'status', personal: false })).offer; expect(offer?.state).toBe(state); });
        return offer;
    };

    it('offers another organization account while the automatic switch could not finish, and continues on it when taken', async () => {
        // The automatic attempt at the turn boundary meets a passing failure and waits in the background.
        vi.mocked(requestSetupTokenRebind).mockReset()
            .mockResolvedValueOnce({ ok: false, reason: 'REQUEST_FAILED' })
            .mockResolvedValue({ ok: true, environment: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-second', HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: '{"account":"second"}' } });
        let switched: any;
        const h = harness(async rpc => { await offerOf(rpc, 'organization-offer'); switched = await rpc({ action: 'switch-organization' }); });
        await h.run();
        expect(switched).toMatchObject({ version: 1, supported: true, switched: true });
        expect(requestSetupTokenRebind).toHaveBeenCalledTimes(2);
        expect(h.generations.map(g => g.token)).toEqual(['sk-ant-oat01-first', 'sk-ant-oat01-second']);
        expect(h.generations.map(g => g.resume)).toEqual(['claude-1', 'claude-1']);
        expect(h.generations[1].prompts).toEqual([expect.stringContaining('another account')]);
    });

    it('says no other account is left once the automatic switch found none, and sends the refused turn again on request', async () => {
        vi.mocked(requestSetupTokenRebind).mockReset().mockResolvedValue({ ok: false, reason: 'NO_ACCOUNT' });
        let none: any, retried: any;
        const h = harness(async rpc => { none = await offerOf(rpc, 'none'); retried = await rpc({ action: 'retry' }); });
        await h.run();
        expect(none).toEqual({ state: 'none' });
        expect(retried).toMatchObject({ version: 1, supported: true, retried: true });
        expect(h.generations.every(g => g.token === 'sk-ant-oat01-first' && g.resume === 'claude-1')).toBe(true);
        expect(h.generations.flatMap(g => g.prompts)).toEqual([JSON.stringify('review and open a PR'), expect.stringContaining('Try the request again')]);
        // Personal availability is not asked where personal Claude is off.
        expect(requestSetupTokenAvailability).not.toHaveBeenCalled();
    });

    it.each(['STUDIO_UNAVAILABLE', 'UNSUPPORTED', 'ROTATION_LIMIT', 'NOT_BOUND', 'STALE'])('offers no organization switch that cannot pass after %s', async reason => {
        vi.mocked(requestSetupTokenRebind).mockReset().mockResolvedValue({ ok: false, reason });
        let none: any;
        const h = harness(async rpc => { none = await offerOf(rpc, 'none'); await rpc({ action: 'retry' }); });
        await h.run();
        expect(none).toEqual({ state: 'none' });
    });

    it('keeps the personal Claude offer when this binding cannot rotate', async () => {
        vi.mocked(requestSetupTokenRebind).mockReset().mockResolvedValue({ ok: false, reason: 'STUDIO_UNAVAILABLE' });
        vi.mocked(requestSetupTokenAvailability).mockImplementation(async (_id, _binding, consent) => ({ allLimited: false, availableAccountIds: [], consentApproved: !!consent, fallbackReason: 'organization-authentication' as const }));
        vi.mocked(readPersonalClaudeCredential).mockResolvedValue({ accountRef: 'a'.repeat(64), label: 'pe…@example.test', accessToken: 'fixture-personal', expiresAt: Date.now() + 600000 });
        let offer: any;
        const h = harness(async rpc => {
            await vi.waitFor(async () => { offer = (await rpc({ action: 'status' })).offer; expect(offer?.state).toBe('offer'); });
            await rpc({ action: 'retry' });
        });
        await h.run();
        expect(offer).toMatchObject({ state: 'offer' });
        expect(requestSetupTokenRebind).toHaveBeenCalledTimes(1);
    });
});
