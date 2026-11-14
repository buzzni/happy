import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { Session } from './session';
import type { EnhancedMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { runAiCredentialCommand } from '../daemon/aiCredentialRuntime';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: vi.fn(),
}));
vi.mock('./utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }));
// The pin's account verification is covered by credentialPin tests; here only the bearer handed to it matters.
vi.mock('./sdk/credentialPin', async (original) => ({
    ...await original<typeof import('./sdk/credentialPin')>(),
    queryWithPinnedCredential: (create: (params: unknown) => unknown, params: unknown) => create(params),
}));
vi.mock('../daemon/aiCredentialRuntime', async (original) => ({
    ...await original<typeof import('../daemon/aiCredentialRuntime')>(),
    runAiCredentialCommand: vi.fn(),
}));

const IDENTITY = JSON.stringify(['a@example.com', '']);
const MODE: EnhancedMode = { permissionMode: 'default', model: 'claude-sonnet-5' };
const answer = { type: 'assistant', uuid: 'uuid-1', session_id: 'claude-1', parent_tool_use_id: null,
    message: { id: 'msg-1', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } } };
const textOf = (message: SDKUserMessage) => typeof message.message.content === 'string'
    ? message.message.content
    : message.message.content.map(block => block.type === 'text' ? block.text : '').join('');
const activeBundle = (token: string) => JSON.stringify({ version: 1, encrypted: false, activeAccountNumber: 1, accounts: [{
    number: 1, email: 'a@example.com', organizationUuid: '',
    credentials: { claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 3_600_000, saycodeRefreshOwnerVersion: 1 } } }] });

beforeEach(() => {
    process.env.HAPPY_CLAUDE_OWNER_IDENTITY = IDENTITY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token-1';
});
afterEach(() => {
    delete process.env.HAPPY_CLAUDE_OWNER_IDENTITY; delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    vi.clearAllMocks();
});

function harness() {
    const queue = new MessageQueue2<EnhancedMode>(hashObject);
    const handlers = new Map<string, (params?: Record<string, unknown>) => Promise<unknown>>();
    const received: string[] = [];
    const client = {
        sessionId: 'happy-session-1',
        rpcHandlerManager: { registerHandler: (name: string, handler: (params?: Record<string, unknown>) => Promise<unknown>) => handlers.set(name, handler) },
        updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
        setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
        setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
        applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        failClaudeLaunchTurn: vi.fn(),
    };
    vi.mocked(query).mockImplementation(({ prompt }) => Object.assign((async function* () {
        yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
        for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
            received.push(textOf(message));
            yield answer;
            yield { type: 'result', subtype: 'success', result: 'hi', is_error: false, uuid: 'result-1', session_id: 'claude-1' };
            void handlers.get('switch')!();
            return;
        }
    })(), { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>);
    queue.push('hello', MODE);
    const session = {
        lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 }, cancelLessonReview: vi.fn(),
        sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
        api: { push: () => ({ sendSessionNotification: vi.fn() }) },
        consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onAbort: vi.fn(),
    };
    return { session: session as unknown as Session, received };
}

describe('owner-managed Claude bearer refresh in the remote launcher', () => {
    it('still sends the input with the current bearer when the source check fails', async () => {
        vi.mocked(runAiCredentialCommand).mockRejectedValue(new Error('cswap unavailable'));
        const h = harness();

        await expect(claudeRemoteLauncher(h.session)).resolves.toBe('switch');

        expect(h.received).toEqual(['hello']);
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-1');
    });

    it('restarts the provider with a new bearer and keeps the input for it', async () => {
        vi.mocked(runAiCredentialCommand).mockResolvedValue({ stdout: activeBundle('token-2'), stderr: '' } as never);
        const h = harness();

        await expect(claudeRemoteLauncher(h.session)).resolves.toBe('switch');

        expect(h.received).toEqual(['hello']);
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-2');
    });
});
