import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { Session } from './session';
import type { EnhancedMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { requestSetupTokenRebind, reportSetupTokenUsage } from '@/daemon/controlClient';
import { CONTINUE_PROMPT, SWITCHED_NOTICE } from './setupTokenAccountSwitching';

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
    it('restarts the provider on the same conversation with the new account and continues the refused turn', async () => {
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
                        yield { type: 'result', subtype: 'success', result: 'Claude AI usage limit reached', is_error: true, uuid: 'result-1' };
                        continue;
                    }
                    yield assistant(`msg-${generation.prompts.length + 1}`);
                    yield { type: 'result', subtype: 'success', result: 'done', is_error: false, uuid: `result-${generation.prompts.length + 1}` };
                    if (generation.prompts.length < 2) continue;
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
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
        };

        await claudeRemoteLauncher(session as unknown as Session);

        expect(generations.map(generation => generation.token)).toEqual(['sk-ant-oat01-first', 'sk-ant-oat01-second']);
        expect(generations.map(generation => generation.resume)).toEqual(['claude-1', 'claude-1']);
        // The continuation runs first and on its own; the user's queued message follows it.
        expect(generations[1].prompts[0]).toContain(CONTINUE_PROMPT);
        expect(generations[1].prompts[0]).not.toContain('queued while refused');
        expect(generations[1].prompts[1]).toContain('queued while refused');
        expect(requestSetupTokenRebind).toHaveBeenCalledWith('happy-session-1', '{"account":"first"}');
        expect(reportSetupTokenUsage).toHaveBeenCalledWith('happy-session-1', '{"account":"first"}', expect.objectContaining({ reason: 'rate-limited' }));
        expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: SWITCHED_NOTICE });
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
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
        };

        await claudeRemoteLauncher(session as unknown as Session);

        expect(generations.map(generation => generation.token)).toEqual(['sk-ant-oat01-first', 'sk-ant-oat01-second']);
        expect(generations[0].prompts.join()).not.toContain('after the switch');
        expect(generations[1].prompts[0]).toContain('after the switch');
        expect(requestSetupTokenRebind).not.toHaveBeenCalled();
    });
});
