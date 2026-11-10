import { afterEach, describe, expect, it, vi } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { Session } from './session';
import type { EnhancedMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { ClaudeAuthNotVerifiedError, ORGANIZATION_CLAUDE_AUTH_FAILURE, describeClaudeLaunchFailure } from './utils/launchFailureMessage';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: vi.fn(),
}));
vi.mock('./utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }));

afterEach(() => { vi.clearAllMocks(); });

const MODE: EnhancedMode = { permissionMode: 'default', model: 'claude-sonnet-5' };
const answer = { type: 'assistant', uuid: 'uuid-1', session_id: 'claude-1', parent_tool_use_id: null,
    message: { id: 'msg-1', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } } };
const textOf = (message: SDKUserMessage) => typeof message.message.content === 'string'
    ? message.message.content
    : message.message.content.map(block => block.type === 'text' ? block.text : '').join('');

/** An old conversation (it has a Claude session id) whose provider the account check may refuse. */
function harness(launches: Array<'refuse' | 'refuse-delivered' | 'refuse-policy' | 'refuse-queued' | 'refuse-steer' | 'answer'>) {
    const queue = new MessageQueue2<EnhancedMode>(hashObject);
    const handlers = new Map<string, (params?: Record<string, unknown>) => Promise<unknown>>();
    const received: string[] = [];
    const steers: unknown[] = [];
    const client = {
        sessionId: 'happy-session-1',
        rpcHandlerManager: { registerHandler: (name: string, handler: (params?: Record<string, unknown>) => Promise<unknown>) => handlers.set(name, handler) },
        updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
        setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
        setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
        applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        failClaudeLaunchTurn: vi.fn(),
    };
    let launch = 0;
    vi.mocked(query).mockImplementation(({ prompt }) => {
        const kind = launches[Math.min(launch++, launches.length - 1)];
        return Object.assign((async function* () {
            if (kind === 'refuse-policy') throw new ClaudeAuthNotVerifiedError(ORGANIZATION_CLAUDE_AUTH_FAILURE, 'recheck', 'policy', true);
            // Input the user sent while the refused provider was still starting.
            if (kind === 'refuse-queued') queue.push('second', MODE);
            if (kind === 'refuse-steer') {
                // The turn's request reached Claude; the account recheck then refuses the steer that follows it.
                yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
                const input = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
                received.push(textOf((await input.next()).value as SDKUserMessage));
                yield answer;
                steers.push(await handlers.get('steer')!({ text: 'more' }));
                await input.next();
                throw new ClaudeAuthNotVerifiedError(ORGANIZATION_CLAUDE_AUTH_FAILURE, 'recheck', 'timeout', true);
            }
            if (kind !== 'answer') {
                throw new ClaudeAuthNotVerifiedError(ORGANIZATION_CLAUDE_AUTH_FAILURE, 'initialize', 'timeout', kind !== 'refuse-delivered');
            }
            yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
            for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                received.push(textOf(message));
                yield answer;
                yield { type: 'result', subtype: 'success', result: 'hi', is_error: false, uuid: 'result-1', session_id: 'claude-1' };
                void handlers.get('switch')!();
                return;
            }
        })(), { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
    });
    queue.push('hello', MODE);
    const session = {
        lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 }, cancelLessonReview: vi.fn(),
        sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
        api: { push: () => ({ sendSessionNotification: vi.fn() }) },
        consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onAbort: vi.fn(),
    };
    const errors = () => client.sendSessionEvent.mock.calls.map(([event]) => event).filter(event => event.isError);
    return { session: session as unknown as Session, client, handlers, received, steers, errors };
}

describe('organization account check refusals in the remote launcher', () => {
    it('sends a request the account check held back once more, unchanged, without reporting a failure', async () => {
        const h = harness(['refuse', 'answer']);

        await expect(claudeRemoteLauncher(h.session)).resolves.toBe('switch');

        expect(query).toHaveBeenCalledTimes(2);
        // The request never reached Claude: a "continue" note in its place would lose it.
        expect(h.received).toEqual(['hello']);
        expect(h.errors()).toEqual([]);
        expect(h.client.failClaudeLaunchTurn).not.toHaveBeenCalled();
    });

    it('sends a held request before input queued during the refusal', async () => {
        const h = harness(['refuse-queued', 'answer']);

        await expect(claudeRemoteLauncher(h.session)).resolves.toBe('switch');

        expect(query).toHaveBeenCalledTimes(2);
        expect(h.received).toEqual(['hello']);
        expect(h.errors()).toEqual([]);
        expect(h.client.failClaudeLaunchTurn).not.toHaveBeenCalled();
    });

    it('reports a refused steer instead of sending the request Claude already received again', async () => {
        const h = harness(['refuse-steer', 'answer']);
        const launched = claudeRemoteLauncher(h.session);
        try {
            await vi.waitFor(() => expect(h.client.failClaudeLaunchTurn).toHaveBeenCalledTimes(1));
            expect(h.steers).toEqual([{ success: true }]);
            expect(query).toHaveBeenCalledTimes(1);
            expect(h.received).toEqual(['hello']);
        } finally { await h.handlers.get('switch')?.(); await launched; }
    });

    it('reports the failure and ends this process when the retried request is held back again', async () => {
        const h = harness(['refuse', 'refuse']);

        await expect(claudeRemoteLauncher(h.session)).resolves.toBe('exit');

        expect(query).toHaveBeenCalledTimes(2);
        const refusal = new ClaudeAuthNotVerifiedError(ORGANIZATION_CLAUDE_AUTH_FAILURE, 'initialize', 'timeout', true);
        expect(h.errors()).toEqual([expect.objectContaining({ message: expect.stringContaining(describeClaudeLaunchFailure(refusal)) })]);
        expect(h.client.failClaudeLaunchTurn).toHaveBeenCalledTimes(1);
    });

    // A policy refuses again until an administrator changes it; restarting would not help either.
    it.each(['refuse-delivered', 'refuse-policy'] as const)('reports a %s refusal once and sends nothing again', async (refusal) => {
        const h = harness([refusal, 'answer']);
        const launched = claudeRemoteLauncher(h.session);
        try {
            await vi.waitFor(() => expect(h.client.failClaudeLaunchTurn).toHaveBeenCalledTimes(1));
            expect(query).toHaveBeenCalledTimes(1);
            expect(h.received).toEqual([]);
        } finally { await h.handlers.get('switch')?.(); await launched; }
    });
});
