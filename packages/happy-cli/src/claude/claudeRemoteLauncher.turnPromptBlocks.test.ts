import { describe, expect, it, vi } from 'vitest';
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { wrapClientTurnPrompt } from '@slopus/happy-wire';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { Session } from './session';
import type { EnhancedMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: vi.fn(),
}));

const INIT = { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [] };
const result = (n: number) => ({ type: 'result', subtype: 'success', result: '', is_error: false, uuid: `result-${n}` });

const appended = (options: Options) => (options.systemPrompt as { append?: string } | undefined)?.append ?? '';

function sessionOf(queue: MessageQueue2<EnhancedMode>, handlers: Map<string, () => Promise<unknown>>): Session {
    let metadata: Record<string, any> = {};
    const client = {
        sessionId: 'turn-prompt-blocks',
        rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
        updateAgentState: vi.fn(), updateMetadata: vi.fn((update) => { metadata = update(metadata); }), getMetadata: () => metadata,
        setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
        setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
        applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
    };
    return {
        lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
        cancelLessonReview: vi.fn(),
        sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
        api: { push: () => ({ sendSessionNotification: vi.fn() }) },
        consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
    } as unknown as Session;
}

/*
 * Desktop composes `appendSystemPrompt` again for every turn. In measured sessions more than
 * half of the later turns differed from the turn before, mostly by one client-turn block — a
 * guide for that question — and each one restarted Claude Code: seconds before the first token
 * (Saycode specs/claude-turn-relaunch-latency).
 */
describe('client-turn prompt blocks across the turns of one Claude process', () => {
    const preview = wrapClientTurnPrompt('DESKTOP PREVIEW PROMPT')!;
    const guide = wrapClientTurnPrompt('DESKTOP GUIDE PROMPT')!;
    const started: EnhancedMode = { permissionMode: 'default', appendSystemPrompt: `USER CONTEXT\n\n${preview}` };
    const withGuide: EnhancedMode = { ...started, appendSystemPrompt: `USER CONTEXT\n\n${preview}\n\n${guide}` };
    const withoutPreview: EnhancedMode = { ...started, appendSystemPrompt: 'USER CONTEXT' };

    it('answers a turn that only adds a block on the running provider, and restarts once a block it started with is gone', async () => {
        const turns: EnhancedMode[] = [started, withGuide, started, withoutPreview];
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const received: Array<{ text: string; generation: number }> = [];
        const launches: Options[] = [];
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const generation = launches.length;
            return Object.assign((async function* () {
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    received.push({ text: String(message.message.content), generation });
                    yield INIT;
                    yield result(received.length);
                    if (received.length === turns.length) { void handlers.get('switch')!(); return; }
                    queue.push(`turn-${received.length}`, turns[received.length]);
                }
            })(), { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        queue.push('turn-0', turns[0]);
        await claudeRemoteLauncher(sessionOf(queue, handlers));

        expect(received).toEqual([
            { text: 'turn-0', generation: 1 },
            { text: `${guide}\n\nturn-1`, generation: 1 },
            { text: 'turn-2', generation: 1 },
            { text: 'turn-3', generation: 2 },
        ]);
        expect(launches).toHaveLength(2);
        expect(appended(launches[0])).toContain(preview);
        expect(appended(launches[0])).not.toContain(guide);
        expect(appended(launches[1])).not.toContain(preview);
    }, 15_000);
});
