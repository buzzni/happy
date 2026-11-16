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
const AGENT_RUNNING = { available: true, tasks: [{ taskId: 'agent-1', label: 'sleeper', kind: 'agent', taskType: 'local_agent', startedAt: expect.any(Number) }] };
const SERVER_RUNNING = { available: true, tasks: [{ taskId: 'server-1', label: 'dev server', kind: 'shell', taskType: 'local_bash', startedAt: expect.any(Number) }] };
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

function engine(response: AsyncGenerator<unknown>, engineChanges: unknown[], stopTask = async (_taskId: string) => {}) {
    return Object.assign(response, {
        mcpServerStatus: async () => [], setPermissionMode: async () => {}, stopTask,
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
        const after: EnhancedMode = { ...before, model: 'claude-fable-5-2' };
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
        expect.soft(engineChanges).toEqual([{ model: 'claude-fable-5-2' }]);
        expect.soft(launches).toHaveLength(2);
        expect.soft(launches[1]).toMatchObject({ model: 'claude-fable-5-2' });
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
        const after: EnhancedMode = { ...before, model: 'claude-fable-5-2' };
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
        expect(launches[1]).toMatchObject({ model: 'claude-fable-5-2' });
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

    it('stops one listed task through the live query and advertises it (specs/agent-background-work-panel R2)', async () => {
        const mode: EnhancedMode = { permissionMode: 'default', model: 'claude-sonnet-5' };
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, (params?: unknown) => Promise<unknown>>();
        const { client, published } = recordingClient('stop-background-task', handlers as Map<string, () => Promise<unknown>>);
        const stopTask = vi.fn(async (_taskId: string) => {});
        const answers: unknown[] = [];
        const stop = (taskId: string) => handlers.get('background-task-stop')!({ taskId });
        vi.mocked(query).mockImplementation(({ prompt }) => engine((async function* () {
            for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
                yield INIT;
                yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'use-1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }] } };
                yield listed([SERVER]);
                yield { type: 'system', subtype: 'task_started', task_id: 'server-1', tool_use_id: 'use-1', description: 'dev server' };
                answers.push(await stop('server-1'), await stop('not-listed'));
                yield listed([]);
                yield result(1);
                void handlers.get('switch')!();
                return;
            }
        })(), [], stopTask));
        queue.push('turn-0', mode);
        await claudeRemoteLauncher(sessionOf(queue, client));
        expect(client.getMetadata().runtimeCapabilities).toEqual(expect.objectContaining({ backgroundTaskStop: 1 }));
        // The command reaches the list once its `task_started` names the Bash call.
        expect(published).toContainEqual(expect.objectContaining({ tasks: [expect.objectContaining({ taskId: 'server-1', command: 'npm run dev', toolName: 'Bash' })] }));
        expect(answers).toEqual([{ status: 'requested' }, { status: 'not_found' }]);
        expect(stopTask).toHaveBeenCalledTimes(1);
        expect(stopTask).toHaveBeenCalledWith('server-1');
        // Without a live query (the process ended), a stop is not attempted.
        await expect(stop('server-1')).resolves.toEqual({ status: 'not_found' });
    }, 15_000);

    it('decides a settings change that lands in a turn Claude opened itself at that turn\'s end, where the work it started keeps the provider', async () => {
        // A background wait reported and Claude opened a turn of its own; the person's reply came in during it with a
        // routed model. Nothing was listed at that moment, so the reply used to restart the provider - its input ended -
        // but the turn then started a new wait, the process could not exit, and the reply was held until a stop.
        const before: EnhancedMode = { permissionMode: 'default', model: 'claude-opus-5', effort: 'max' };
        const routed: EnhancedMode = { ...before, model: 'claude-sonnet-5', effort: 'medium' };
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const { client } = recordingClient('reply-in-own-turn', handlers);
        const received: Array<{ text: string; generation: number }> = [];
        const launches: Options[] = [];
        const engineChanges: unknown[] = [];
        // The reply must be taken while the turn runs, however slow the machine: that is the case under test.
        let replyTaken!: () => void;
        const taken = new Promise<void>(resolve => { replyTaken = resolve; });
        const collectBatch = (queue as any).collectBatch.bind(queue);
        (queue as any).collectBatch = (claim?: () => boolean) => {
            const batch = collectBatch(claim);
            if (batch?.message === 'reply') replyTaken();
            return batch;
        };
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const generation = launches.length;
            let workRunning = false;
            return engine((async function* () {
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    const text = String(message.message.content);
                    received.push({ text, generation });
                    yield INIT;
                    yield result(received.length);
                    if (text !== 'turn-0') continue;
                    // The wait's report: a turn with no prompt of ours.
                    yield INIT;
                    queue.push('reply', routed);
                    await taken;
                    await new Promise(resolve => setTimeout(resolve, 20));
                    // That turn starts a new wait before it ends.
                    workRunning = true;
                    yield listed([SERVER]);
                    yield result(received.length);
                }
                // Like Claude Code: an ended input does not end a process whose background work runs.
                if (workRunning) await untilAborted(options!.abortController!.signal);
            })(), engineChanges);
        });
        queue.push('turn-0', before);
        const launcher = claudeRemoteLauncher(sessionOf(queue, client));
        try {
            await vi.waitFor(() => expect(received).toContainEqual({ text: 'reply', generation: 1 }), { timeout: 10_000 });
        } finally {
            await handlers.get('switch')!();
            await launcher;
        }
        // Answered by the same process, its engine switched in place.
        expect(launches).toHaveLength(1);
        expect(engineChanges).toEqual([{ model: 'claude-sonnet-5' }, { effortLevel: 'medium' }]);
    }, 15_000);

    it.each([
        // Nothing keeps the process: the restart the change asks for happens at that turn's end, as it always did.
        ['the turn starts no work', 'ends'],
        // A stop ends the turn while it runs: the held reply goes to the next provider, as a held message always has.
        ['the turn is stopped while it runs', 'stopped'],
    ] as const)('still hands a settings change that lands in a turn Claude opened itself to a new provider when %s', async (_case, ownTurn) => {
        const before: EnhancedMode = { permissionMode: 'default', model: 'claude-opus-5', effort: 'max' };
        const routed: EnhancedMode = { ...before, model: 'claude-sonnet-5', effort: 'medium' };
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const { client } = recordingClient(`reply-in-own-turn-${ownTurn}`, handlers);
        const received: Array<{ text: string; generation: number }> = [];
        const launches: Options[] = [];
        const engineChanges: unknown[] = [];
        let replyTaken!: () => void;
        const taken = new Promise<void>(resolve => { replyTaken = resolve; });
        const collectBatch = (queue as any).collectBatch.bind(queue);
        (queue as any).collectBatch = (claim?: () => boolean) => {
            const batch = collectBatch(claim);
            if (batch?.message === 'reply') replyTaken();
            return batch;
        };
        let markDecided!: () => void;
        const decided = new Promise<void>(resolve => { markDecided = resolve; });
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const generation = launches.length;
            return engine((async function* () {
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    const text = String(message.message.content);
                    received.push({ text, generation });
                    yield INIT;
                    yield result(received.length);
                    if (text !== 'turn-0') continue;
                    yield INIT;
                    queue.push('reply', routed);
                    await taken;
                    await new Promise(resolve => setTimeout(resolve, 20));
                    markDecided();
                    if (ownTurn === 'stopped') {
                        await untilAborted(options!.abortController!.signal);
                        return;
                    }
                    yield result(received.length);
                }
            })(), engineChanges);
        });
        queue.push('turn-0', before);
        const launcher = claudeRemoteLauncher({ ...sessionOf(queue, client), onAbort: vi.fn() } as unknown as Session);
        try {
            if (ownTurn === 'stopped') {
                await decided;
                await handlers.get('abort')!();
            }
            await vi.waitFor(() => expect(received).toContainEqual({ text: 'reply', generation: 2 }), { timeout: 10_000 });
        } finally {
            await handlers.get('switch')!();
            await launcher;
        }
        expect(received).toEqual([{ text: 'turn-0', generation: 1 }, { text: 'reply', generation: 2 }]);
        expect(launches[1]).toMatchObject({ model: 'claude-sonnet-5', effort: 'medium' });
        expect(engineChanges).toEqual([]);
    }, 15_000);

    it('keeps reading a provider whose input a restart ended while its work runs, and hands the held message to the next one', async () => {
        // The process stays for its work and opens turns of its own when the work reports. The status check after such
        // a turn went unanswered, so nothing it said reached the app; and the input request after it would have taken
        // the held message into a provider that could no longer accept any.
        const before: EnhancedMode = { permissionMode: 'default', model: 'claude-sonnet-5' };
        const planned: EnhancedMode = { ...before, permissionMode: 'plan' };
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const { client } = recordingClient('ended-input-own-turns', handlers);
        const received: Array<{ text: string; generation: number }> = [];
        const launches: Options[] = [];
        const report = (id: string) => ({ type: 'assistant', uuid: id, session_id: 'claude-1', parent_tool_use_id: null,
            message: { id, role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: id }], usage: { input_tokens: 1, output_tokens: 1 } } });
        let endWork!: () => void;
        const workEnded = new Promise<void>(resolve => { endWork = resolve; });
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const generation = launches.length;
            const signal = options!.abortController!.signal;
            let inputEnded = false;
            const response = engine((async function* () {
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    received.push({ text: String(message.message.content), generation });
                    yield INIT;
                    if (generation === 1) yield listed([SERVER]);
                    yield result(received.length);
                    // Plan mode reaches the SDK only at launch, so this message restarts the provider.
                    if (generation === 1) queue.push('plan this', planned);
                }
                inputEnded = true;
                if (generation > 1) return;
                for (const id of ['report-1', 'report-2']) {
                    yield INIT;
                    yield report(id);
                    yield result(received.length);
                }
                await workEnded;
                yield listed([]);
            })(), []);
            // Like Claude Code: a control request after the input ended is never answered, and fails when the query closes.
            return Object.assign(response, {
                mcpServerStatus: () => inputEnded
                    ? untilAborted(signal).then(() => { throw new Error('Query closed before response received'); })
                    : Promise.resolve([]),
            });
        });
        queue.push('turn-0', before);
        const launcher = claudeRemoteLauncher(sessionOf(queue, client));
        const sentReport = () => client.sendClaudeSessionMessage.mock.calls.some(([body]) => (body as { message?: { id?: string } }).message?.id === 'report-2');
        try {
            await vi.waitFor(() => expect(sentReport()).toBe(true), { timeout: 5_000 });
            endWork();
            await vi.waitFor(() => expect(received).toContainEqual({ text: 'plan this', generation: 2 }), { timeout: 5_000 });
        } finally {
            endWork();
            await handlers.get('switch')!();
            await launcher;
        }
        expect(received).toEqual([{ text: 'turn-0', generation: 1 }, { text: 'plan this', generation: 2 }]);
    }, 15_000);
});

function untilAborted(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
    });
}
