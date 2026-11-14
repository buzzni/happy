import { afterEach, describe, expect, it, vi } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import { readLiveOauthAccount, type LiveOauthAccount } from './aiAuthObservation';
import type { Session } from './session';
import type { EnhancedMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(), query: vi.fn(),
}));
vi.mock('./utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }));
vi.mock('./aiAuthObservation', async (original) => ({
    ...await original<typeof import('./aiAuthObservation')>(), readLiveOauthAccount: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());

const first: LiveOauthAccount = { email: 'first@example.test', organizationUuid: 'org-1', organizationName: 'Org' };

async function runSwitch(next: LiveOauthAccount | null, managedRun = false) {
    let live: LiveOauthAccount | null = first;
    vi.mocked(readLiveOauthAccount).mockImplementation(async () => live);
    const queue = new MessageQueue2<EnhancedMode>(hashObject);
    const handlers = new Map<string, () => Promise<unknown>>();
    const generations: Array<{ resume?: string; prompts: string[] }> = [];
    const client = {
        sessionId: 'oauth-switch-test',
        rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
        updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
        sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
        setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
        applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
    };
    vi.mocked(query).mockImplementation(({ prompt, options }) => {
        const generation = { resume: options?.resume, prompts: [] as string[] };
        generations.push(generation);
        const response = (async function* () {
            for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                generation.prompts.push(JSON.stringify(message.message.content));
                yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
                const initial = generation.prompts.length === 1 && generations.length === 1;
                yield { type: 'result', subtype: 'success', result: initial ? "You've hit your weekly limit" : 'done', is_error: initial, uuid: `result-${generations.length}` };
                if (initial) {
                    // Switch while the old provider is waiting; keep model and effort identical.
                    setTimeout(() => {
                        live = next;
                        queue.push('retry on selected account', { permissionMode: 'default', model: 'claude-sonnet-5' });
                    }, 10);
                } else {
                    void handlers.get('switch')!();
                    return;
                }
            }
        })();
        return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
    });
    queue.push('original request', { permissionMode: 'default', model: 'claude-sonnet-5' });
    await claudeRemoteLauncher({
        lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
        cancelLessonReview: vi.fn(), sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
        api: { push: () => ({ sendSessionNotification: vi.fn() }) },
        consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), managedRun,
    } as unknown as Session);
    return generations;
}

describe('ambient Claude account switching without a model change', () => {
    it.each([
        { ...first, email: 'second@example.test' },
        { ...first, organizationUuid: 'org-2' },
    ])('resumes on a fresh provider after identity changes: %j', async next => {
        const generations = await runSwitch(next);
        expect(generations).toHaveLength(2);
        expect(generations[0].prompts).toHaveLength(1);
        expect(generations[1].resume).toBe('claude-1');
        expect(generations[1].prompts).toHaveLength(1);
        expect(generations[1].prompts[0]).toContain('retry on selected account');
    });
    it.each([first, null])('keeps the provider when identity is unchanged or unavailable: %j', async next => {
        expect(await runSwitch(next)).toHaveLength(1);
    });
});
