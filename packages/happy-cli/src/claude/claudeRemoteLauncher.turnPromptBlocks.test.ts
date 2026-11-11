import { describe, expect, it, vi } from 'vitest';
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { wrapClientTurnPrompt } from '@slopus/happy-wire';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { Session } from './session';
import type { EnhancedMode } from './loop';
import { CLAUDE_TRANSIENT_CONTINUE_PROMPT } from './claudeTransientRetry';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: vi.fn(),
}));
// Real ladder, test-sized waits.
vi.mock('./claudeTransientRetry', async (original) => {
    const actual = await original<typeof import('./claudeTransientRetry')>();
    return { ...actual, get CLAUDE_TRANSIENT_RETRY_DELAYS_MS() { return [20, 20, 20, 20, 20]; } };
});

const INIT = { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [] };
const succeeded = (n: number) => ({ type: 'result', subtype: 'success', result: '', is_error: false, uuid: `result-${n}` });
const overloaded = (n: number) => ({ type: 'result', subtype: 'success', result: 'API Error: 529', is_error: true, api_error_status: 529, uuid: `result-${n}` });
const appended = (options: Options) => (options.systemPrompt as { append?: string } | undefined)?.append ?? '';
// The fields runClaude hashes: `turnOnlyPromptTokens` is deliberately not one of them.
const runClaudeHash = (mode: EnhancedMode) => hashObject({
    isPlan: mode.permissionMode === 'plan', model: mode.model, fallbackModel: mode.fallbackModel,
    customSystemPrompt: mode.customSystemPrompt, appendSystemPrompt: mode.appendSystemPrompt,
    saycodeSystemPromptEnabled: mode.saycodeSystemPromptEnabled, saycodePromptBlocks: mode.saycodePromptBlocks,
    allowedTools: mode.allowedTools, disallowedTools: mode.disallowedTools, effort: mode.effort,
});

function sessionOf(queue: MessageQueue2<EnhancedMode>, handlers: Map<string, () => Promise<unknown>>, extra: Partial<Session> = {}): Session {
    let metadata: Record<string, any> = {};
    // Any client method the launcher calls along a path under test; only these few carry state.
    const client = new Proxy({
        sessionId: 'turn-prompt-blocks',
        rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
        updateMetadata: (update: (current: Record<string, any>) => Record<string, any>) => { metadata = update(metadata); },
        getMetadata: () => metadata,
    } as Record<string, any>, {
        get: (target, key: string) => key in target ? target[key] : (key === 'inputEvidence' || key === 'then' ? undefined : (target[key] = vi.fn())),
    });
    return {
        lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
        cancelLessonReview: vi.fn(),
        sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
        api: { push: () => ({ sendSessionNotification: vi.fn() }) },
        consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
        ...extra,
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
    const guideToken = guide.split('\n')[0].replace('<!-- saycode:client-turn-prompt:', '').replace(':start -->', '');
    const started: EnhancedMode = { permissionMode: 'default', appendSystemPrompt: `USER CONTEXT\n\n${preview}` };
    const withGuide: EnhancedMode = { ...started, appendSystemPrompt: `USER CONTEXT\n\n${preview}\n\n${guide}` };
    const withMarkedGuide: EnhancedMode = { ...withGuide, turnOnlyPromptTokens: [guideToken] };
    const withoutPreview: EnhancedMode = { ...started, appendSystemPrompt: 'USER CONTEXT' };

    type Turn = { mode: EnhancedMode; text?: string; fails?: true };

    /** Sends the turns one after another, each once the previous one ended; a failing turn ends its provider. */
    async function run(turns: Turn[], extra: Partial<Session> = {}) {
        const queue = new MessageQueue2<EnhancedMode>(runClaudeHash);
        const handlers = new Map<string, () => Promise<unknown>>();
        const received: Array<{ text: string; generation: number }> = [];
        const launches: Options[] = [];
        let sent = 0;
        const send = () => { const turn = turns[sent]; queue.push(turn.text ?? `turn-${sent}`, turn.mode); sent += 1; };
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const generation = launches.length;
            return Object.assign((async function* () {
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    const text = String(message.message.content);
                    received.push({ text, generation });
                    yield INIT;
                    const retried = text === CLAUDE_TRANSIENT_CONTINUE_PROMPT;
                    if (!retried && turns[sent - 1].fails) { yield overloaded(received.length); return; }
                    yield succeeded(received.length);
                    if (sent === turns.length) { void handlers.get('switch')!(); return; }
                    send();
                }
            })(), { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        send();
        await claudeRemoteLauncher(sessionOf(queue, handlers, extra));
        return { received, launches };
    }

    it('answers a turn that only adds a block on the running provider, and restarts once a block it started with is gone', async () => {
        const { received, launches } = await run([{ mode: started }, { mode: withGuide }, { mode: started }, { mode: withoutPreview }]);

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

    // The client knows which block belongs to one turn (`turnOnlyPromptTokens`): that one never
    // enters the system prompt, so the turn after the one that started the provider needs no restart.
    it('keeps the provider across a one-turn block carried by the very turn that started it', async () => {
        const { received, launches } = await run([{ mode: withMarkedGuide }, { mode: started }, { mode: withMarkedGuide }]);

        expect(received).toEqual([
            { text: `${guide}\n\nturn-0`, generation: 1 },
            { text: 'turn-1', generation: 1 },
            { text: `${guide}\n\nturn-2`, generation: 1 },
        ]);
        expect(launches).toHaveLength(1);
        expect(appended(launches[0])).toContain(preview);
        expect(appended(launches[0])).not.toContain(guide);
    }, 15_000);

    // A slash command must stay the first input token, so its block cannot ride the turn: the block
    // reaches the model the way it always did, in the system prompt of a new provider.
    it('restarts for an added block when the turn text starts like a command', async () => {
        const { received, launches } = await run([{ mode: started }, { mode: withGuide, text: '/Users/me/app.log why does this fail?' }]);

        expect(received).toEqual([
            { text: 'turn-0', generation: 1 },
            { text: '/Users/me/app.log why does this fail?', generation: 2 },
        ]);
        expect(appended(launches[1])).toContain(guide);
    }, 15_000);

    // The organization gate rewrites a batch after the queue hashed it (blanket tool blocks). What must
    // match the provider is the mode it started with, as rewritten — not the queue's earlier hash.
    it('still keeps the provider when the organization adds its tool blocks to every turn', async () => {
        const orgRequirements = {
            checkTurn: (mode: EnhancedMode) => ({ kind: 'run', modeClamped: false, mode: { ...mode, disallowedTools: ['WebFetch'] } }),
            allowsRoutedModel: () => true, declinesForCeiling: () => false, recordCeilingDenial: () => {}, clampAnswer: <T>(answer: T) => answer,
        } as unknown as Session['orgRequirements'];
        const { received, launches } = await run([{ mode: started }, { mode: withGuide }, { mode: started }], { orgRequirements });

        expect(received.map(({ generation }) => generation)).toEqual([1, 1, 1]);
        expect(launches[0].disallowedTools).toEqual(['WebFetch']);
    }, 15_000);

    // The same text sent unmarked and then marked hashes the same. The provider's prompt is the one it
    // started with — the unmarked block is in it — whatever a later message says about that block.
    it('compares with what the provider started with, not with a later message of the same hash', async () => {
        const { received, launches } = await run([{ mode: withGuide }, { mode: withMarkedGuide }, { mode: started }]);

        expect(appended(launches[0])).toContain(guide);
        expect(received).toEqual([
            { text: 'turn-0', generation: 1 },
            { text: 'turn-1', generation: 1 },
            { text: 'turn-2', generation: 2 },
        ]);
    }, 15_000);

    // A transient retry repeats the failed turn with that turn's mode. When it has to start the next
    // provider, that mode — added block included — is what the provider holds from then on.
    it('restarts after a retried turn started the next provider with a block the following turn drops', async () => {
        const { received, launches } = await run([{ mode: started }, { mode: withGuide, fails: true }, { mode: started }]);

        expect(received).toEqual([
            { text: 'turn-0', generation: 1 },
            { text: `${guide}\n\nturn-1`, generation: 1 },
            { text: CLAUDE_TRANSIENT_CONTINUE_PROMPT, generation: 2 },
            { text: 'turn-2', generation: 3 },
        ]);
        expect(appended(launches[1])).toContain(guide);
        expect(appended(launches[2])).not.toContain(guide);
    }, 30_000);
});
