import { describe, expect, it, vi } from 'vitest';
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { Session } from './session';
import type { EnhancedMode } from './loop';
import type { Metadata } from '@/api/types';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: vi.fn(),
}));

// Claude Code 2.1.308 as the runtime meets it: `init` opens every turn of a process, not only its first;
// `background_tasks_changed` comes only when the set changes; nothing is listed at startup.
const INIT = { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [] };
const AGENT = { task_id: 'agent-1', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'sleeper' };
const SERVER = { task_id: 'server-1', task_type: 'local_bash', description: 'dev server' };
const listed = (tasks: object[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks });
const result = (n: number) => ({ type: 'result', subtype: 'success', result: '', is_error: false, uuid: `result-${n}` });
const AGENT_RUNNING = { available: true, tasks: [{ taskId: 'agent-1', label: 'sleeper', kind: 'agent' }] };
const SERVER_RUNNING = { available: true, tasks: [{ taskId: 'server-1', label: 'dev server', kind: 'shell' }] };
const UNKNOWN = { available: true, tasks: null };

type Listed = NonNullable<Metadata['claudeBackgroundTasks']>;

function recordingClient(sessionId: string, handlers: Map<string, () => Promise<unknown>>) {
    let metadata: Record<string, any> = {};
    const published: Listed[] = [];
    const client = {
        sessionId,
        rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
        updateAgentState: vi.fn(), updateMetadata: vi.fn((update) => {
            const before = metadata.claudeBackgroundTasks;
            metadata = update(metadata);
            if (metadata.claudeBackgroundTasks !== before) published.push(metadata.claudeBackgroundTasks);
        }), getMetadata: () => metadata,
        setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
        setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
        applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
    };
    return { client, published, current: () => metadata.claudeBackgroundTasks as Listed | undefined };
}

function sessionOf(queue: MessageQueue2<EnhancedMode>, client: unknown): Session {
    return {
        lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
        cancelLessonReview: vi.fn(),
        sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
        api: { push: () => ({ sendSessionNotification: vi.fn() }) },
        consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
    } as unknown as Session;
}

function engine(response: AsyncGenerator<unknown>, engineChanges: unknown[]) {
    return Object.assign(response, {
        mcpServerStatus: async () => [], setPermissionMode: async () => {},
        setModel: async (model?: string) => { engineChanges.push({ model }); },
        applyFlagSettings: async (settings: unknown) => { engineChanges.push(settings); },
    }) as unknown as ReturnType<typeof query>;
}

describe('background work across the turns of one Claude process', () => {
    it.each([
        ['sub-agent', AGENT, AGENT_RUNNING],
        // Never ends on its own: a message held for a restart would wait for it indefinitely.
        ['background command', SERVER, SERVER_RUNNING],
    ] as const)('keeps a running %s listed and answers in place every message it outlives', async (_work, task, running) => {
        const before: EnhancedMode = { permissionMode: 'default', model: 'claude-sonnet-5' };
        const after: EnhancedMode = { ...before, model: 'claude-fable-5-1' };
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const { client, current } = recordingClient('work-across-turns', handlers);
        const received: Array<{ text: string; generation: number }> = [];
        const listedAfter: Record<string, Listed | undefined> = {};
        const launches: Options[] = [];
        const engineChanges: unknown[] = [];
        let workRunning = false;
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const generation = launches.length;
            return engine((async function* () {
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    const text = String(message.message.content);
                    received.push({ text, generation });
                    yield INIT;
                    if (text === 'turn-0') { workRunning = true; yield listed([task]); }
                    yield result(received.length);
                    listedAfter[text] = current();
                    // The work outlives turn-1 and turn-2, then ends.
                    if (text === 'turn-2' && workRunning) { workRunning = false; yield listed([]); }
                    if (text === 'turn-3') { void handlers.get('switch')!(); return; }
                    queue.push(`turn-${received.length}`, after);
                }
                // Like Claude Code: an ended input does not end a process whose background work runs. Reached only
                // when a lost list sends a message to a restart; ending the work lets the test fail, not hang.
                if (workRunning) { await new Promise(resolve => setTimeout(resolve, 20)); workRunning = false; yield listed([]); }
            })(), engineChanges);
        });
        queue.push('turn-0', before);
        await claudeRemoteLauncher(sessionOf(queue, client));
        // What the apps show while the work runs: it stays listed through every turn it outlives.
        expect.soft(listedAfter['turn-0']).toEqual(expect.objectContaining(running));
        expect.soft(listedAfter['turn-1']).toEqual(expect.objectContaining(running));
        expect.soft(listedAfter['turn-2']).toEqual(expect.objectContaining(running));
        // Both messages sent while it ran are answered by the live provider; the first after it, by a restart.
        expect.soft(received).toEqual([
            { text: 'turn-0', generation: 1 },
            { text: 'turn-1', generation: 1 },
            { text: 'turn-2', generation: 1 },
            { text: 'turn-3', generation: 2 },
        ]);
        expect.soft(engineChanges).toEqual([{ model: 'claude-fable-5-1' }]);
        expect.soft(launches).toHaveLength(2);
        expect.soft(launches[1]).toMatchObject({ model: 'claude-fable-5-1' });
    }, 15_000);

    it('starts every provider process from an unknown list, even when the last one ended with work listed', async () => {
        const before: EnhancedMode = { permissionMode: 'default', model: 'claude-sonnet-5' };
        const planned: EnhancedMode = { ...before, permissionMode: 'plan' };
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const { client, published, current } = recordingClient('restart-resets-list', handlers);
        const received: Array<{ text: string; generation: number }> = [];
        const listedAfter: Record<string, Listed | undefined> = {};
        const launches: Options[] = [];
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const generation = launches.length;
            return engine((async function* () {
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    const text = String(message.message.content);
                    received.push({ text, generation });
                    yield INIT;
                    if (text === 'turn-0') yield listed([AGENT]);
                    yield result(received.length);
                    listedAfter[text] = current();
                    if (text === 'turn-1') { void handlers.get('switch')!(); return; }
                    // Plan mode reaches the SDK only at launch, so this message restarts the provider.
                    queue.push('turn-1', planned);
                }
                // The process goes away with the sub-agent still listed (no closing list arrives).
            })(), []);
        });
        queue.push('turn-0', before);
        await claudeRemoteLauncher(sessionOf(queue, client));
        expect(received).toEqual([{ text: 'turn-0', generation: 1 }, { text: 'turn-1', generation: 2 }]);
        // The ended process is marked unavailable, and the next one starts unknown rather than inheriting it.
        expect(published).toEqual([
            expect.objectContaining(UNKNOWN),
            expect.objectContaining(AGENT_RUNNING),
            expect.objectContaining({ ...AGENT_RUNNING, available: false }),
            expect.objectContaining(UNKNOWN),
            expect.objectContaining({ ...UNKNOWN, available: false }),
        ]);
        expect(listedAfter['turn-1']).toEqual(expect.objectContaining(UNKNOWN));
    }, 15_000);

    it('without background work the list stays unknown across turns and a settings change still restarts', async () => {
        const before: EnhancedMode = { permissionMode: 'default', model: 'claude-sonnet-5' };
        const after: EnhancedMode = { ...before, model: 'claude-fable-5-1' };
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const { client, published, current } = recordingClient('no-background-work', handlers);
        const received: Array<{ text: string; generation: number }> = [];
        const listedAfter: Record<string, Listed | undefined> = {};
        const launches: Options[] = [];
        const engineChanges: unknown[] = [];
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const generation = launches.length;
            return engine((async function* () {
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    const text = String(message.message.content);
                    received.push({ text, generation });
                    yield INIT;
                    yield result(received.length);
                    listedAfter[text] = current();
                    if (text === 'turn-2') { void handlers.get('switch')!(); return; }
                    queue.push(text === 'turn-0' ? 'turn-1' : 'turn-2', text === 'turn-0' ? before : after);
                }
            })(), engineChanges);
        });
        queue.push('turn-0', before);
        await claudeRemoteLauncher(sessionOf(queue, client));
        expect(received).toEqual([
            { text: 'turn-0', generation: 1 },
            { text: 'turn-1', generation: 1 },
            { text: 'turn-2', generation: 2 },
        ]);
        for (const turn of ['turn-0', 'turn-1', 'turn-2']) expect(listedAfter[turn]).toEqual(expect.objectContaining(UNKNOWN));
        // Every turn still starts a fresh unknown list, so a transcript fallback window starts at the turn.
        expect(published).toEqual([
            expect.objectContaining(UNKNOWN),
            expect.objectContaining(UNKNOWN),
            expect.objectContaining({ ...UNKNOWN, available: false }),
            expect.objectContaining(UNKNOWN),
            expect.objectContaining({ ...UNKNOWN, available: false }),
        ]);
        expect(engineChanges).toEqual([]);
        expect(launches[1]).toMatchObject({ model: 'claude-fable-5-1' });
    }, 15_000);

    it('starts the turn after the work ended from an unknown list, not from the empty one', async () => {
        const mode: EnhancedMode = { permissionMode: 'default', model: 'claude-sonnet-5' };
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const { client, published, current } = recordingClient('ended-work', handlers);
        const listedAfter: Record<string, Listed | undefined> = {};
        let turns = 0;
        vi.mocked(query).mockImplementation(({ prompt }) => engine((async function* () {
            for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                const text = String(message.message.content);
                turns += 1;
                yield INIT;
                if (text === 'turn-0') { yield listed([AGENT]); yield listed([]); }
                yield result(turns);
                listedAfter[text] = current();
                if (text === 'turn-1') { void handlers.get('switch')!(); return; }
                queue.push('turn-1', mode);
            }
        })(), []));
        queue.push('turn-0', mode);
        await claudeRemoteLauncher(sessionOf(queue, client));
        expect(listedAfter['turn-0']).toEqual(expect.objectContaining({ available: true, tasks: [] }));
        expect(listedAfter['turn-1']).toEqual(expect.objectContaining(UNKNOWN));
        expect(published).toEqual([
            expect.objectContaining(UNKNOWN),
            expect.objectContaining(AGENT_RUNNING),
            expect.objectContaining({ available: true, tasks: [] }),
            expect.objectContaining(UNKNOWN),
            expect.objectContaining({ ...UNKNOWN, available: false }),
        ]);
    }, 15_000);
});
