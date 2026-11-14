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

async function runSwitch(next: LiveOauthAccount | null, switchDuringRead = false) {
    let live: LiveOauthAccount | null = first;
    vi.mocked(readLiveOauthAccount).mockImplementation(async () => {
        if (switchDuringRead && live === next) void handlers.get('switch')!();
        return live;
    });
    const queue = new MessageQueue2<EnhancedMode>(hashObject);
    const handlers = new Map<string, () => Promise<unknown>>();
    const generations: Array<{ resume?: string; model?: string; prompts: string[] }> = [];
    const onModeApplied = vi.fn();
    const attachment = { name: 'pixel.png', mimeType: 'image/png', data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) };
    const client = {
        sessionId: 'oauth-switch-test',
        rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
        setClaudeRuntimeAccount: vi.fn(), noteContextUsageSignal: vi.fn(),
        failClaudeLaunchTurn: vi.fn(), updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
        sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
        setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
        applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
    };
    vi.mocked(query).mockImplementation(({ prompt, options }) => {
        const generation = { resume: options?.resume, model: options?.model, prompts: [] as string[] };
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
                        queue.push('retry on selected account', { permissionMode: 'default', model: 'claude-sonnet-5' }, [attachment], ['request-2']);
                    }, 10);
                } else {
                    void handlers.get('switch')!();
                    return;
                }
            }
        })();
        return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
    });
    queue.push('original request', { permissionMode: 'default', model: 'claude-sonnet-5' }, undefined, ['request-1']);
    await claudeRemoteLauncher({
        lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
        cancelLessonReview: vi.fn(), sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
        api: { push: () => ({ sendSessionNotification: vi.fn() }) },
        consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onModeApplied,
    } as unknown as Session);
    return { generations, queue, onModeApplied };
}

describe('ambient Claude account switching without a model change', () => {
    it.each([
        { ...first, email: 'second@example.test' },
        { ...first, organizationUuid: 'org-2' },
    ])('resumes on a fresh provider after identity changes: %j', async next => {
        const { generations, onModeApplied } = await runSwitch(next);
        expect(generations).toHaveLength(2);
        expect(generations[0].prompts).toHaveLength(1);
        expect(generations[1].resume).toBe('claude-1');
        expect(generations[1].prompts).toHaveLength(1);
        expect(generations[1].prompts[0]).toContain('retry on selected account');
        expect(generations[1].prompts[0]).toContain('image/png');
        expect(generations[1].prompts[0]).toContain('iVBORw0KGgo=');
        expect(generations.map(g => g.model)).toEqual(['claude-sonnet-5', 'claude-sonnet-5']);
        expect(onModeApplied.mock.calls.map(([ids]) => ids)).toEqual([['request-1'], ['request-2']]);
    });
    it('keeps unsubmitted input queued when switching to local mode during the account read', async () => {
        const { generations, queue } = await runSwitch({ ...first, email: 'second@example.test' }, true);
        expect(generations).toHaveLength(1);
        expect(generations[0].prompts).toHaveLength(1);
        expect(queue.size()).toBe(1);
        expect(queue.queue[0].message).toBe('retry on selected account');
        expect(queue.queue[0].requestIds).toEqual(['request-2']);
        expect(queue.queue[0].attachments?.[0].name).toBe('pixel.png');
    });
    it.each([first, null])('keeps the provider when identity is unchanged or unavailable: %j', async next => {
        expect((await runSwitch(next)).generations).toHaveLength(1);
    });
});
