import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexSubagentTracker, formatCodexAgentLabel, type CodexSubagentSnapshot } from './codexSubagentTracker';
import { logger } from '@/ui/logger';

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

/** Captured before fake timers replace it: lets Node report unhandled rejections. */
const realSetImmediate = globalThis.setImmediate;

type Deps = ConstructorParameters<typeof CodexSubagentTracker>[0];
type PendingRequest = { method: string; params: unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void };

/** A tracker whose `thread/read` requests stay pending until a test answers them. */
function setup(overrides: Partial<Deps> = {}) {
    const calls: PendingRequest[] = [];
    const request = vi.fn((method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
        calls.push({ method, params, resolve, reject });
    }));
    const publish = vi.fn<(snapshot: CodexSubagentSnapshot) => void>();
    const tracker = new CodexSubagentTracker({
        request,
        publish,
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
        ...overrides,
    });
    const published = () => publish.mock.calls.map(([snapshot]) => snapshot.tasks);
    return { tracker, request, publish, calls, published };
}

/** Lets settled `thread/read` promises run their continuations. */
async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** The `thread/read {includeTurns:false}` answer shape recorded from Codex 0.157.1. */
function threadRead(threadId: string, parentId: string | null, fields: {
    nickname?: string | null; role?: string | null; path?: string | null; status?: string; source?: unknown;
} = {}) {
    const status = fields.status ?? 'active';
    return {
        thread: {
            id: threadId,
            sessionId: parentId,
            forkedFromId: null,
            parentThreadId: parentId,
            preview: '',
            ephemeral: true,
            status: status === 'active' ? { type: 'active', activeFlags: [] } : { type: status },
            source: 'source' in fields ? fields.source : {
                subAgent: {
                    thread_spawn: {
                        parent_thread_id: parentId,
                        depth: 1,
                        agent_path: fields.path ?? null,
                        agent_nickname: fields.nickname ?? null,
                        agent_role: fields.role ?? null,
                    },
                },
            },
            canAcceptDirectInput: false,
            threadSource: 'subagent',
            agentNickname: fields.nickname ?? null,
            agentRole: fields.role ?? null,
            turns: [],
        },
    };
}

const statusChanged = (threadId: string, type: string) => ({ threadId, status: type === 'active' ? { type, activeFlags: [] } : { type } });
const turnEvent = (threadId: string, turnId: string, status = 'inProgress') => ({
    threadId,
    turn: { id: turnId, items: [], itemsView: 'notLoaded', status, error: null },
});
const task = (taskId: string, label: string) => ({ taskId, label, kind: 'agent' });

// a-default-terra-v2: Codex 0.157.1 default model, V2 multi-agent tools.
const V2 = {
    main: '01a17e3f-a8dc-7db0-b6e1-a4bd0d65ac7d',
    child: '01a17e3f-c662-7f91-badc-ed6f4599c813',
    turn: '01a17e3f-a9cc-7df2-b2fe-b9a50a02fb99',
    childTurn: '01a17e3f-c69a-7301-a7f7-e4b975e1e071',
};
const v2Activity = (kind: string, id = 'call_07c6369d05fa4621b401b257e794358b') => ({
    type: 'subAgentActivity', id, kind, agentThreadId: V2.child, agentPath: '/root/ok_reply',
});
const v2Wait = (status: string) => ({
    type: 'collabAgentToolCall', id: 'call_277055b5f2de459abab1c3e638f2e2f9', tool: 'wait', status, senderThreadId: V2.main,
    receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null, agentsStates: {},
});

// a-luna-v1: gpt-5.6-luna (`multi_agent_version: v1`), V1 collab tool calls.
const V1 = {
    main: '01a17e45-612e-7d52-825a-5f629481bb07',
    child: '01a17e45-7995-7073-95b8-8199e9c068cc',
    turn: '01a17e45-61dd-7383-9491-38ab364268dd',
    childTurn: '01a17e45-79d1-7c83-9200-b80ea2a902cc',
    spawnCall: 'exec-bcc101d1-3cc2-4a0a-ab0a-ee07561cb1ce',
    waitCall: 'exec-087e300a-b8c3-44d3-8767-2471ee975be4',
};
type AgentStates = Record<string, { status: string; message: string | null }>;
const v1Call = (tool: string, id: string, status: string, receiverThreadIds: string[], agentsStates: AgentStates = {}, senderThreadId = V1.main) => ({
    type: 'collabAgentToolCall', id, tool, status, senderThreadId, receiverThreadIds,
    prompt: tool === 'spawnAgent' ? 'Reply with exactly the word OK and nothing else.' : null, model: null, reasoningEffort: null, agentsStates,
});

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T00:00:00Z'));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('[1] V2 spawn flow (a-default-terra-v2)', () => {
    it('reads the new child, confirms the spawn once, and publishes it only while it runs', async () => {
        const { tracker, request, calls, publish, published } = setup();
        tracker.setAvailable(true);
        tracker.setMainThread(V2.main);

        tracker.observeOtherThread('thread/status/changed', statusChanged(V2.child, 'idle'));
        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith('thread/read', { threadId: V2.child, includeTurns: false });

        expect(tracker.observeMainItem('item/started', v2Activity('started'), V2.turn)).toBeNull();
        expect(tracker.observeMainItem('item/completed', v2Activity('started'), V2.turn)).toEqual({
            callId: 'call_07c6369d05fa4621b401b257e794358b', threadId: V2.child, turnId: V2.turn, label: 'ok_reply',
        });
        // Rule B: running, but its first listing waits for the thread/read answer instead of flashing 'ok_reply'.
        expect(published()).toEqual([[]]);
        const label = tracker.awaitLabel(V2.child, 1500);
        calls[0].resolve(threadRead(V2.child, V2.main, { nickname: 'Linnaeus', path: '/root/ok_reply' }));
        await expect(label).resolves.toBe('Linnaeus');

        tracker.observeOtherThread('turn/started', turnEvent(V2.child, V2.childTurn));
        expect(published()).toEqual([[], [task(V2.child, 'Linnaeus')]]);
        expect(tracker.running).toEqual([{ threadId: V2.child, label: 'Linnaeus' }]);

        tracker.observeOtherThread('turn/completed', turnEvent(V2.child, V2.childTurn, 'completed'));
        expect(published()).toEqual([[], [task(V2.child, 'Linnaeus')], []]);
        // Two list changes plus the initial availability publish.
        expect(publish).toHaveBeenCalledTimes(3);
        expect(publish.mock.calls.every(([snapshot]) => snapshot.available && snapshot.startedAt === Date.parse('2026-10-28T00:00:00Z'))).toBe(true);
        expect(tracker.running).toEqual([]);
    });

    it('replays the recorded notification order and publishes exactly [] -> [Linnaeus] -> []', async () => {
        const { tracker, request, calls, published } = setup();
        tracker.setAvailable(true);
        tracker.setMainThread(V2.main);
        const child = { threadId: V2.child, turnId: V2.childTurn };

        tracker.observeOtherThread('thread/status/changed', statusChanged(V2.child, 'idle'));
        expect(tracker.observeMainItem('item/started', v2Activity('started'), V2.turn)).toBeNull();
        expect(tracker.observeMainItem('item/completed', v2Activity('started'), V2.turn)?.threadId).toBe(V2.child);
        tracker.observeOtherThread('mcpServer/startupStatus/updated', { threadId: V2.child, name: 'codex_apps', status: 'starting', error: null, failureReason: null });
        tracker.observeOtherThread('thread/status/changed', statusChanged(V2.child, 'active'));
        tracker.observeOtherThread('turn/started', turnEvent(V2.child, V2.childTurn));
        expect(published()).toEqual([[]]);
        calls[0].resolve(threadRead(V2.child, V2.main, { nickname: 'Linnaeus', path: '/root/ok_reply' }));
        await flush();
        expect(published()).toEqual([[], [task(V2.child, 'Linnaeus')]]);

        tracker.observeOtherThread('mcpServer/startupStatus/updated', { threadId: V2.child, name: 'codex_apps', status: 'ready', error: null, failureReason: null });
        expect(tracker.observeMainItem('item/started', v2Wait('inProgress'), V2.turn)).toBeNull();
        tracker.observeOtherThread('item/started', { ...child, item: { type: 'agentMessage', id: 'msg_0949', text: '', phase: 'final_answer' } });
        tracker.observeOtherThread('item/agentMessage/delta', { ...child, itemId: 'msg_0949', delta: 'OK' });
        tracker.observeOtherThread('turn/moderationMetadata', { ...child, metadata: {} });
        tracker.observeOtherThread('item/completed', { ...child, item: { type: 'agentMessage', id: 'msg_0949', text: 'OK', phase: 'final_answer' } });
        tracker.observeOtherThread('thread/tokenUsage/updated', { ...child, tokenUsage: { total: { totalTokens: 23097 } } });
        expect(published()).toHaveLength(2);

        tracker.observeOtherThread('thread/status/changed', statusChanged(V2.child, 'idle'));
        tracker.observeOtherThread('turn/completed', turnEvent(V2.child, V2.childTurn, 'completed'));
        const completed = v2Activity('completed', `subagent-completed-${V2.childTurn}`);
        expect(tracker.observeMainItem('item/started', completed, V2.turn)).toBeNull();
        expect(tracker.observeMainItem('item/completed', completed, V2.turn)).toBeNull();
        expect(tracker.observeMainItem('item/completed', v2Wait('completed'), V2.turn)).toBeNull();

        expect(published()).toEqual([[], [task(V2.child, 'Linnaeus')], []]);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('rule B: lists the child with the fallback label after 1.5 s without a thread/read answer, then republishes the nickname', async () => {
        const { tracker, calls, published } = setup();
        tracker.setAvailable(true);
        tracker.setMainThread(V2.main);
        tracker.observeOtherThread('thread/status/changed', statusChanged(V2.child, 'idle'));
        tracker.observeMainItem('item/completed', v2Activity('started'), V2.turn);
        tracker.observeOtherThread('turn/started', turnEvent(V2.child, V2.childTurn));
        await vi.advanceTimersByTimeAsync(1499);
        expect(published()).toEqual([[]]);
        await vi.advanceTimersByTimeAsync(1);
        expect(published()).toEqual([[], [task(V2.child, 'ok_reply')]]);

        calls[0].resolve(threadRead(V2.child, V2.main, { nickname: 'Linnaeus', path: '/root/ok_reply' }));
        await flush();
        expect(published()).toEqual([[], [task(V2.child, 'ok_reply')], [task(V2.child, 'Linnaeus')]]);
        tracker.observeOtherThread('turn/completed', turnEvent(V2.child, V2.childTurn, 'completed'));
        expect(published()).toEqual([[], [task(V2.child, 'ok_reply')], [task(V2.child, 'Linnaeus')], []]);
    });

    it('rule B: publishes nothing for a child that stops while its first listing waits', async () => {
        const { tracker, calls, published } = setup();
        tracker.setAvailable(true);
        tracker.setMainThread(V2.main);
        tracker.observeOtherThread('thread/status/changed', statusChanged(V2.child, 'idle'));
        tracker.observeMainItem('item/completed', v2Activity('started'), V2.turn);
        tracker.observeOtherThread('turn/started', turnEvent(V2.child, V2.childTurn));
        await vi.advanceTimersByTimeAsync(1000);
        tracker.observeOtherThread('turn/completed', turnEvent(V2.child, V2.childTurn, 'completed'));
        await vi.advanceTimersByTimeAsync(1000);
        // Answered while the child still ran: older than its turn end, so it does not bring it back.
        calls[0].resolve(threadRead(V2.child, V2.main, { nickname: 'Linnaeus', status: 'active' }));
        await flush();
        expect(published()).toEqual([[]]);
    });

    it('rule B: keeps a child without spawn evidence out of the list until its thread/read answers', async () => {
        const { tracker, calls, published } = setup();
        tracker.setAvailable(true);
        tracker.setMainThread(V2.main);
        tracker.observeOtherThread('turn/started', turnEvent(V2.child, V2.childTurn));
        await vi.advanceTimersByTimeAsync(2900);
        expect(published()).toEqual([[]]);
        calls[0].resolve(threadRead(V2.child, V2.main, { nickname: 'Linnaeus' }));
        await flush();
        expect(published()).toEqual([[], [task(V2.child, 'Linnaeus')]]);
    });
});

describe('[2] V1 spawn flow (a-luna-v1)', () => {
    it('ignores spawnAgent item/started, confirms the spawn from item/completed, and clears it on wait completed', async () => {
        const { tracker, calls, published } = setup();
        tracker.setAvailable(true);
        tracker.setMainThread(V1.main);
        tracker.observeOtherThread('thread/status/changed', statusChanged(V1.child, 'idle'));

        expect(tracker.observeMainItem('item/started', v1Call('spawnAgent', V1.spawnCall, 'inProgress', []), V1.turn)).toBeNull();
        expect(tracker.observeMainItem('item/completed', v1Call('spawnAgent', V1.spawnCall, 'completed', [V1.child], {
            [V1.child]: { status: 'pendingInit', message: null },
        }), V1.turn)).toEqual({ callId: V1.spawnCall, threadId: V1.child, turnId: V1.turn, label: 'Agent' });
        expect(published()).toEqual([[]]);
        calls[0].resolve(threadRead(V1.child, V1.main, { nickname: 'Plato' }));
        await flush();
        expect(published()).toEqual([[], [task(V1.child, 'Plato')]]);

        expect(tracker.observeMainItem('item/started', v1Call('wait', V1.waitCall, 'inProgress', [V1.child]), V1.turn)).toBeNull();
        expect(tracker.observeMainItem('item/completed', v1Call('wait', V1.waitCall, 'completed', [V1.child], {
            [V1.child]: { status: 'completed', message: 'OK' },
        }), V1.turn)).toBeNull();
        expect(published()).toEqual([[], [task(V1.child, 'Plato')], []]);
    });

    it('replays the recorded notification order and publishes exactly [] -> [Plato] -> []', async () => {
        const { tracker, request, calls, published } = setup();
        tracker.setAvailable(true);
        tracker.setMainThread(V1.main);
        const child = { threadId: V1.child, turnId: V1.childTurn };

        expect(tracker.observeMainItem('item/started', v1Call('spawnAgent', V1.spawnCall, 'inProgress', []), V1.turn)).toBeNull();
        tracker.observeOtherThread('thread/status/changed', statusChanged(V1.child, 'idle'));
        expect(tracker.observeMainItem('item/completed', v1Call('spawnAgent', V1.spawnCall, 'completed', [V1.child], {
            [V1.child]: { status: 'pendingInit', message: null },
        }), V1.turn)?.threadId).toBe(V1.child);
        expect(tracker.observeMainItem('item/started', v1Call('wait', V1.waitCall, 'inProgress', [V1.child]), V1.turn)).toBeNull();
        tracker.observeOtherThread('mcpServer/startupStatus/updated', { threadId: V1.child, name: 'codex_apps', status: 'starting', error: null, failureReason: null });
        tracker.observeOtherThread('thread/status/changed', statusChanged(V1.child, 'active'));
        tracker.observeOtherThread('turn/started', turnEvent(V1.child, V1.childTurn));
        calls[0].resolve(threadRead(V1.child, V1.main, { nickname: 'Plato' }));
        await flush();
        expect(published()).toEqual([[], [task(V1.child, 'Plato')]]);

        tracker.observeOtherThread('item/started', { ...child, item: { type: 'userMessage', id: '01a17e45-7e8f', content: [] } });
        tracker.observeOtherThread('item/completed', { ...child, item: { type: 'userMessage', id: '01a17e45-7e8f', content: [] } });
        tracker.observeOtherThread('item/agentMessage/delta', { ...child, itemId: 'msg_0491', delta: 'OK' });
        tracker.observeOtherThread('thread/tokenUsage/updated', { ...child, tokenUsage: { total: { totalTokens: 20661 } } });
        tracker.observeOtherThread('thread/status/changed', statusChanged(V1.child, 'idle'));
        tracker.observeOtherThread('turn/completed', turnEvent(V1.child, V1.childTurn, 'completed'));
        expect(tracker.observeMainItem('item/completed', v1Call('wait', V1.waitCall, 'completed', [V1.child], {
            [V1.child]: { status: 'completed', message: 'OK' },
        }), V1.turn)).toBeNull();

        expect(published()).toEqual([[], [task(V1.child, 'Plato')], []]);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('needs no parent completion item: the child turn end alone clears it (b-luna-v1)', async () => {
        const mencius = '01a17e45-b4f1-7ef1-9495-994311ed86f6';
        const { tracker, calls, published } = setup();
        tracker.setAvailable(true);
        tracker.setMainThread(V1.main);
        tracker.observeOtherThread('thread/status/changed', statusChanged(mencius, 'idle'));
        tracker.observeMainItem('item/completed', v1Call('spawnAgent', 'exec-b', 'completed', [mencius], { [mencius]: { status: 'pendingInit', message: null } }), V1.turn);
        tracker.observeOtherThread('turn/started', turnEvent(mencius, 'child-turn'));
        calls[0].resolve(threadRead(mencius, V1.main, { nickname: 'Mencius' }));
        await flush();
        // The parent turn ends here; the child keeps running and is still listed.
        expect(published()).toEqual([[], [task(mencius, 'Mencius')]]);
        tracker.observeOtherThread('thread/status/changed', statusChanged(mencius, 'idle'));
        tracker.observeOtherThread('turn/completed', turnEvent(mencius, 'child-turn', 'completed'));
        expect(published()).toEqual([[], [task(mencius, 'Mencius')], []]);
    });
});

const MAIN = 'main-thread';
const CHILD = 'child-a';

type Setup = ReturnType<typeof setup>;

/** Answers the classification read of a newly seen thread as a direct child of `parentId`. */
async function adopt(t: Setup, threadId: string, nickname: string, parentId: string = MAIN, status = 'idle'): Promise<void> {
    t.tracker.observeOtherThread('thread/status/changed', statusChanged(threadId, 'idle'));
    t.calls[t.calls.length - 1].resolve(threadRead(threadId, parentId, { nickname, status }));
    await flush();
}

function started(overrides: Partial<Deps> = {}): Setup {
    const t = setup(overrides);
    t.tracker.setAvailable(true);
    t.tracker.setMainThread(MAIN);
    return t;
}

describe('[3] out-of-order and duplicate notifications', () => {
    it('re-enters the list on a late active after turn/completed, until the next poll reads idle', async () => {
        const t = started();
        await adopt(t, CHILD, 'Kant');
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.tracker.observeOtherThread('turn/completed', turnEvent(CHILD, 't1', 'completed'));
        t.tracker.observeOtherThread('thread/status/changed', statusChanged(CHILD, 'active'));
        expect(t.published()).toEqual([[], [task(CHILD, 'Kant')], [], [task(CHILD, 'Kant')]]);

        await vi.advanceTimersByTimeAsync(5000);
        expect(t.request).toHaveBeenCalledTimes(2);
        expect(t.request).toHaveBeenLastCalledWith('thread/read', { threadId: CHILD, includeTurns: false });
        t.calls[1].resolve(threadRead(CHILD, MAIN, { nickname: 'Kant', status: 'idle' }));
        await flush();
        expect(t.published()).toEqual([[], [task(CHILD, 'Kant')], [], [task(CHILD, 'Kant')], []]);
        expect(t.tracker.running).toEqual([]);
    });

    it('publishes once for the same turn/started delivered twice', async () => {
        const t = started();
        await adopt(t, CHILD, 'Kant');
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.tracker.observeOtherThread('thread/status/changed', statusChanged(CHILD, 'active'));
        expect(t.published()).toEqual([[], [task(CHILD, 'Kant')]]);
    });

    it('returns a spawn only once for the same child', async () => {
        const t = started();
        const spawnItem = v1Call('spawnAgent', 'call-1', 'completed', [CHILD], { [CHILD]: { status: 'pendingInit', message: null } }, MAIN);
        expect(t.tracker.observeMainItem('item/completed', spawnItem, 'turn-1')?.threadId).toBe(CHILD);
        expect(t.tracker.observeMainItem('item/completed', spawnItem, 'turn-1')).toBeNull();
        expect(t.tracker.observeMainItem('item/completed', { type: 'subAgentActivity', id: 'call-2', kind: 'started', agentThreadId: CHILD, agentPath: '/root/x' }, 'turn-1')).toBeNull();
    });

    it('shows a child seen only through item notifications from the thread/read status (no turn/started)', async () => {
        const t = started();
        t.tracker.observeOtherThread('item/started', { threadId: CHILD, turnId: 't1', item: { type: 'reasoning', id: 'rs_1' } });
        expect(t.request).toHaveBeenCalledWith('thread/read', { threadId: CHILD, includeTurns: false });
        t.calls[0].resolve(threadRead(CHILD, MAIN, { nickname: 'Kant', status: 'active' }));
        await flush();
        expect(t.published()).toEqual([[], [task(CHILD, 'Kant')]]);
    });

    it('keeps a newer notification over an older thread/read answer', async () => {
        const t = started();
        t.tracker.observeOtherThread('thread/status/changed', statusChanged(CHILD, 'idle'));
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        // Answered from the state before the child's turn started.
        t.calls[0].resolve(threadRead(CHILD, MAIN, { nickname: 'Kant', status: 'idle' }));
        await flush();
        expect(t.tracker.running).toEqual([{ threadId: CHILD, label: 'Kant' }]);

        await vi.advanceTimersByTimeAsync(5000);
        expect(t.request).toHaveBeenCalledTimes(2);
        t.tracker.observeOtherThread('turn/completed', turnEvent(CHILD, 't1', 'completed'));
        // A poll answered before the child's turn ended must not bring it back.
        t.calls[1].resolve(threadRead(CHILD, MAIN, { nickname: 'Kant', status: 'active' }));
        await flush();
        expect(t.tracker.running).toEqual([]);
        expect(t.published()).toEqual([[], [task(CHILD, 'Kant')], []]);
    });
});

const spawnEvidence = (threadId: string, sender = MAIN) => v1Call('spawnAgent', `call-${threadId}`, 'completed', [threadId], {
    [threadId]: { status: 'pendingInit', message: null },
}, sender);

describe('[4] classification failure', () => {
    it('retries a failed thread/read once after 2 s, then keeps the child hidden until spawn evidence names it', async () => {
        const t = started();
        t.tracker.observeOtherThread('thread/status/changed', statusChanged(CHILD, 'idle'));
        t.calls[0].reject(new Error('Request timed out'));
        await flush();
        await vi.advanceTimersByTimeAsync(1999);
        expect(t.request).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(t.request).toHaveBeenCalledTimes(2);
        expect(t.request).toHaveBeenLastCalledWith('thread/read', { threadId: CHILD, includeTurns: false });
        t.calls[1].reject(new Error('Request timed out'));
        await flush();

        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        expect(t.tracker.running).toEqual([]);
        expect(t.published()).toEqual([[]]);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(t.request).toHaveBeenCalledTimes(2);

        expect(t.tracker.observeMainItem('item/completed', spawnEvidence(CHILD), 'turn-1')?.threadId).toBe(CHILD);
        expect(t.published()).toEqual([[], [task(CHILD, 'Agent')]]);
    });

    it('promotes on V2 evidence too, labelled from the agent path', async () => {
        const t = started();
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.calls[0].reject(new Error('unsupported'));
        await flush();
        await vi.advanceTimersByTimeAsync(2000);
        t.calls[1].resolve({ unexpected: true });
        await flush();
        expect(t.tracker.running).toEqual([]);

        t.tracker.observeMainItem('item/completed', { type: 'subAgentActivity', id: 'call-1', kind: 'started', agentThreadId: CHILD, agentPath: '/root/ok_reply' }, 'turn-1');
        expect(t.published()).toEqual([[], [task(CHILD, 'ok_reply')]]);
    });

    it('classifies normally when the retry succeeds', async () => {
        const t = started();
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.calls[0].reject(new Error('busy'));
        await flush();
        await vi.advanceTimersByTimeAsync(2000);
        t.calls[1].resolve(threadRead(CHILD, MAIN, { nickname: 'Kant' }));
        await flush();
        expect(t.published()).toEqual([[], [task(CHILD, 'Kant')]]);
    });
});

describe('[5] internal helper threads', () => {
    it.each([
        ['review', 'review'],
        ['compact', 'compact'],
        ['memory_consolidation', 'memory_consolidation'],
        ['other', { other: 'x' }],
    ])('never shows a %s thread, even one parented to the main thread, and keeps diverting it', async (_name, subAgent) => {
        const t = started();
        t.tracker.observeOtherThread('thread/status/changed', statusChanged(CHILD, 'active'));
        t.calls[0].resolve(threadRead(CHILD, MAIN, { nickname: 'Reviewer', source: { subAgent } }));
        await flush();
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        expect(t.tracker.running).toEqual([]);
        expect(t.published()).toEqual([[]]);
        expect(t.tracker.shouldDivert(CHILD, MAIN)).toBe(true);
        expect(t.tracker.shouldDivert(CHILD, null)).toBe(true);
    });
});

const GRANDCHILD = 'grandchild-b';

describe('[6] grandchildren', () => {
    it('learns a grandchild from a tracked child spawnAgent item and tracks it through thread/read lineage', async () => {
        const t = started();
        await adopt(t, CHILD, 'Kant');
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.tracker.observeOtherThread('item/completed', { threadId: CHILD, turnId: 't1', item: spawnEvidence(GRANDCHILD, CHILD) });
        expect(t.request).toHaveBeenLastCalledWith('thread/read', { threadId: GRANDCHILD, includeTurns: false });
        t.calls[t.calls.length - 1].resolve(threadRead(GRANDCHILD, CHILD, { nickname: 'Mencius' }));
        await flush();
        expect(t.tracker.running).toEqual([{ threadId: CHILD, label: 'Kant' }, { threadId: GRANDCHILD, label: 'Mencius' }]);
        expect(t.published()).toEqual([[], [task(CHILD, 'Kant')], [task(CHILD, 'Kant'), task(GRANDCHILD, 'Mencius')]]);
    });

    it('learns a V2 grandchild from a tracked child even when its own thread/read fails, and the child reports its end', async () => {
        const t = started();
        await adopt(t, CHILD, 'Kant');
        const activity = (kind: string) => ({ threadId: CHILD, turnId: 't1', item: {
            type: 'subAgentActivity', id: `call-${kind}`, kind, agentThreadId: GRANDCHILD, agentPath: '/root/kant/helper',
        } });
        t.tracker.observeOtherThread('item/completed', activity('started'));
        t.calls[t.calls.length - 1].reject(new Error('busy'));
        await flush();
        await vi.advanceTimersByTimeAsync(2000);
        t.calls[t.calls.length - 1].reject(new Error('busy'));
        await flush();
        expect(t.tracker.running).toEqual([{ threadId: GRANDCHILD, label: 'helper' }]);

        t.tracker.observeOtherThread('item/completed', activity('completed'));
        expect(t.tracker.running).toEqual([]);
    });

    it('ignores sub-agent items reported by a thread that is not tracked', () => {
        const t = started();
        t.tracker.observeOtherThread('thread/status/changed', statusChanged(CHILD, 'idle'));
        t.tracker.observeOtherThread('item/completed', { threadId: CHILD, item: spawnEvidence(GRANDCHILD, CHILD) });
        expect(t.request).toHaveBeenCalledTimes(1);
        expect(t.tracker.shouldDivert(GRANDCHILD, null)).toBe(false);
    });
});

describe('[7] threads outside the main lineage', () => {
    it('keeps a thread whose parent is an unknown thread foreign: diverted, never shown', async () => {
        const t = started();
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.calls[0].resolve(threadRead(CHILD, 'stranger-thread', { nickname: 'Stranger' }));
        await flush();
        t.tracker.observeOtherThread('thread/status/changed', statusChanged(CHILD, 'active'));
        expect(t.tracker.running).toEqual([]);
        expect(t.published()).toEqual([[]]);
        expect(t.tracker.shouldDivert(CHILD, MAIN)).toBe(true);
        expect(t.tracker.shouldDivert(CHILD, null)).toBe(true);
    });

    it('keeps a top-level thread without any parent foreign', async () => {
        const t = started();
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.calls[0].resolve(threadRead(CHILD, null, { source: 'vscode' }));
        await flush();
        expect(t.tracker.running).toEqual([]);
    });

    it('shows a grandchild read before its parent only once the parent is tracked', async () => {
        const t = started();
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.tracker.observeOtherThread('turn/started', turnEvent(GRANDCHILD, 't2'));
        t.calls[1].resolve(threadRead(GRANDCHILD, CHILD, { nickname: 'Mencius' }));
        await flush();
        expect(t.tracker.running).toEqual([]);
        t.calls[0].resolve(threadRead(CHILD, MAIN, { nickname: 'Kant' }));
        await flush();
        expect(t.tracker.running).toEqual([{ threadId: CHILD, label: 'Kant' }, { threadId: GRANDCHILD, label: 'Mencius' }]);
    });

    it('keeps a grandchild of a foreign thread foreign', async () => {
        const t = started();
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.tracker.observeOtherThread('turn/started', turnEvent(GRANDCHILD, 't2'));
        t.calls[0].resolve(threadRead(CHILD, 'stranger-thread', { nickname: 'Stranger' }));
        t.calls[1].resolve(threadRead(GRANDCHILD, CHILD, { nickname: 'Mencius' }));
        await flush();
        expect(t.tracker.running).toEqual([]);
    });
});

describe('[8] invalidate() and setMainThread(null)', () => {
    it.each([
        ['invalidate()', (tracker: CodexSubagentTracker) => tracker.invalidate()],
        ['setMainThread(null)', (tracker: CodexSubagentTracker) => tracker.setMainThread(null)],
    ])('after %s nothing runs, [] is published once, and the old ids stay diverted', async (_name, reset) => {
        const t = started();
        await adopt(t, CHILD, 'Kant');
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.tracker.observeOtherThread('turn/started', turnEvent(GRANDCHILD, 't2'));
        expect(t.published()).toEqual([[], [task(CHILD, 'Kant')]]);

        reset(t.tracker);
        expect(t.tracker.running).toEqual([]);
        expect(t.published()).toEqual([[], [task(CHILD, 'Kant')], []]);
        expect(t.tracker.shouldDivert(CHILD, null)).toBe(true);
        expect(t.tracker.shouldDivert(GRANDCHILD, null)).toBe(true);
        expect(t.tracker.shouldDivert('new-thread', null)).toBe(false);

        // The old generation's late thread/read answer, notifications and spawn items change nothing.
        t.calls[1].resolve(threadRead(GRANDCHILD, MAIN, { nickname: 'Late' }));
        await flush();
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't3'));
        expect(t.tracker.observeMainItem('item/completed', spawnEvidence(CHILD), 'turn-2')).toBeNull();
        expect(t.tracker.observeMainItem('item/completed', {
            type: 'subAgentActivity', id: 'call-late', kind: 'started', agentThreadId: CHILD, agentPath: '/root/kant',
        }, 'turn-2')).toBeNull();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(t.request).toHaveBeenCalledTimes(2);
        expect(t.tracker.running).toEqual([]);

        reset(t.tracker);
        expect(t.publish).toHaveBeenCalledTimes(3);
    });

    it('drops a pending retry and an in-flight poll of the old generation', async () => {
        const t = started();
        await adopt(t, CHILD, 'Kant');
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.tracker.observeOtherThread('turn/started', turnEvent(GRANDCHILD, 't2'));
        t.calls[1].reject(new Error('busy'));
        await vi.advanceTimersByTimeAsync(5000);
        expect(t.request).toHaveBeenCalledTimes(4);
        expect(t.calls.slice(2).map(call => (call.params as { threadId: string }).threadId)).toEqual([GRANDCHILD, CHILD]);

        t.tracker.invalidate();
        t.calls[3].resolve(threadRead(CHILD, MAIN, { nickname: 'Kant', status: 'active' }));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(t.request).toHaveBeenCalledTimes(4);
        expect(t.published()).toEqual([[], [task(CHILD, 'Kant')], []]);
    });

    it('tracks new children normally after invalidate()', async () => {
        const t = started();
        await adopt(t, CHILD, 'Kant');
        t.tracker.invalidate();
        await adopt(t, 'child-new', 'Hume');
        t.tracker.observeOtherThread('turn/started', turnEvent('child-new', 't1'));
        expect(t.tracker.running).toEqual([{ threadId: 'child-new', label: 'Hume' }]);
    });

    it('setMainThread(new) retires the previous children but never the new main thread', async () => {
        const t = started();
        await adopt(t, CHILD, 'Kant');
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        // A fork's thread/started can be diverted before the client moves its main thread id.
        t.tracker.observeOtherThread('thread/started', { thread: { id: 'forked-main', status: { type: 'idle' } } });
        expect(t.request).toHaveBeenLastCalledWith('thread/read', { threadId: 'forked-main', includeTurns: false });
        t.tracker.setMainThread('forked-main');
        expect(t.published()).toEqual([[], [task(CHILD, 'Kant')], []]);
        expect(t.tracker.shouldDivert(CHILD, 'forked-main')).toBe(true);
        expect(t.tracker.shouldDivert('forked-main', 'forked-main')).toBe(false);

        t.tracker.setMainThread(null);
        expect(t.tracker.shouldDivert(CHILD, null)).toBe(true);
        expect(t.tracker.shouldDivert('forked-main', null)).toBe(false);
    });
});

describe('[9] availability', () => {
    const T0 = Date.parse('2026-10-28T00:00:00Z');

    it('publishes nothing before availability is known, tasks:null while unavailable, and [] once available', () => {
        const t = setup();
        t.tracker.setMainThread(MAIN);
        expect(t.publish).not.toHaveBeenCalled();
        t.tracker.setAvailable(false);
        expect(t.publish.mock.calls.map(([snapshot]) => snapshot)).toEqual([{ startedAt: T0, available: false, tasks: null }]);
        vi.advanceTimersByTime(1000);
        t.tracker.setAvailable(true);
        expect(t.publish.mock.calls.map(([snapshot]) => snapshot)).toEqual([
            { startedAt: T0, available: false, tasks: null },
            { startedAt: T0, available: true, tasks: [] },
        ]);
    });

    it('keeps tasks:null while unavailable even with a running child, then publishes the list once available', async () => {
        const t = setup();
        t.tracker.setMainThread(MAIN);
        t.tracker.setAvailable(false);
        await adopt(t, CHILD, 'Kant');
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        expect(t.published()).toEqual([null]);
        t.tracker.setAvailable(true);
        t.tracker.setAvailable(true);
        expect(t.published()).toEqual([null, [task(CHILD, 'Kant')]]);
    });
});

describe('[10] formatCodexAgentLabel (Codex TUI rules)', () => {
    it.each([
        [{ nickname: 'Linnaeus', role: 'explorer' }, 'Linnaeus [explorer]'],
        [{ nickname: 'Plato', role: null }, 'Plato'],
        [{ nickname: 'Plato', agentPath: '/root/ok_reply' }, 'Plato'],
        [{ agentPath: '/root/ok_reply' }, 'ok_reply'],
        [{ agentPath: '/root/number_writer/', role: 'worker' }, 'number_writer'],
        [{ role: 'explorer' }, '[explorer]'],
        [{}, 'Agent'],
        [{ nickname: null, role: null, agentPath: null }, 'Agent'],
        [{ nickname: '  ', role: ' ', agentPath: '/' }, 'Agent'],
        [{ nickname: ' Bohr ', role: ' explorer ' }, 'Bohr [explorer]'],
    ])('%o -> %s', (input, expected) => {
        expect(formatCodexAgentLabel(input)).toBe(expected);
    });

    it('cuts a 201-character label to 200 characters', () => {
        expect(formatCodexAgentLabel({ nickname: 'x'.repeat(201) })).toBe('x'.repeat(200));
        expect(formatCodexAgentLabel({ nickname: 'x'.repeat(200) })).toBe('x'.repeat(200));
        expect(formatCodexAgentLabel({ nickname: 'x'.repeat(198), role: 'r' })).toHaveLength(200);
    });

    it('never splits a surrogate pair at the cut', () => {
        expect(formatCodexAgentLabel({ nickname: `${'x'.repeat(199)}😀` })).toBe('x'.repeat(199));
    });

    it('labels published tasks with the same rule', async () => {
        const t = started();
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.calls[0].resolve(threadRead(CHILD, MAIN, { nickname: 'Linnaeus', role: 'explorer' }));
        await flush();
        expect(t.published()).toEqual([[], [task(CHILD, 'Linnaeus [explorer]')]]);
    });

    it('falls back to the agent path thread/read reports when there is no nickname', async () => {
        const t = started();
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.calls[0].resolve(threadRead(CHILD, MAIN, { nickname: null, path: '/root/number_writer' }));
        await flush();
        expect(t.tracker.running).toEqual([{ threadId: CHILD, label: 'number_writer' }]);
    });
});

describe('[11] awaitLabel', () => {
    const v2Spawn = { type: 'subAgentActivity', id: 'call-1', kind: 'started', agentThreadId: CHILD, agentPath: '/root/ok_reply' };

    it('falls back after the timeout (V2: agent path name) and answers the nickname once thread/read lands', async () => {
        const t = started();
        t.tracker.observeOtherThread('thread/status/changed', statusChanged(CHILD, 'idle'));
        t.tracker.observeMainItem('item/completed', v2Spawn, 'turn-1');
        let settled: string | undefined;
        void t.tracker.awaitLabel(CHILD, 1500).then(label => { settled = label; });
        await vi.advanceTimersByTimeAsync(1499);
        expect(settled).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe('ok_reply');

        t.calls[0].resolve(threadRead(CHILD, MAIN, { nickname: 'Linnaeus', path: '/root/ok_reply' }));
        await flush();
        await expect(t.tracker.awaitLabel(CHILD, 1500)).resolves.toBe('Linnaeus');
    });

    it('falls back to "Agent" for a V1 child whose thread/read is still pending', async () => {
        const t = started();
        t.tracker.observeMainItem('item/completed', spawnEvidence(CHILD), 'turn-1');
        const label = t.tracker.awaitLabel(CHILD, 1500);
        await vi.advanceTimersByTimeAsync(1500);
        await expect(label).resolves.toBe('Agent');
    });

    it('answers at once for an unknown thread and for a child whose thread/read failed twice', async () => {
        const t = started();
        await expect(t.tracker.awaitLabel('unknown-thread', 1500)).resolves.toBe('Agent');
        t.tracker.observeMainItem('item/completed', v2Spawn, 'turn-1');
        t.calls[0].reject(new Error('busy'));
        await flush();
        await vi.advanceTimersByTimeAsync(2000);
        t.calls[1].reject(new Error('busy'));
        await flush();
        await expect(t.tracker.awaitLabel(CHILD, 1500)).resolves.toBe('ok_reply');
    });

    it('settles a pending wait with the current label when the tracker is reset, without waiting', async () => {
        const t = started();
        t.tracker.observeMainItem('item/completed', v2Spawn, 'turn-1');
        const label = t.tracker.awaitLabel(CHILD, 60_000);
        t.tracker.invalidate();
        await expect(label).resolves.toBe('ok_reply');
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('[12] never throws', () => {
    const badParams: unknown[] = [
        null, undefined, 'turn/started', ['child-a'], 42, {}, { threadId: 5 }, { threadId: '' }, { thread: 'child-a' }, { thread: { id: 7 } },
        { threadId: CHILD, status: null }, { threadId: CHILD, status: 'active' }, { threadId: CHILD, item: null }, { threadId: CHILD, item: ['x'] },
    ];
    const badItems: unknown[] = [
        null, undefined, 'item', ['item'], 42, {},
        { type: 'subAgentActivity' },
        { type: 'subAgentActivity', kind: 'started', agentThreadId: 5 },
        { type: 'subAgentActivity', kind: 'started', agentThreadId: 'child-x', agentPath: 7, id: null },
        { type: 'subAgentActivity', kind: 7, agentThreadId: CHILD },
        { type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: 'child-y', agentsStates: [] },
        { type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: [null, 3, ''], agentsStates: { a: null, b: 'running', c: { status: 5 } } },
        { type: 'collabAgentToolCall', tool: 'wait', status: 'completed', agentsStates: null },
    ];
    const methods = ['turn/started', 'turn/completed', 'thread/status/changed', 'item/completed', 'thread/closed', 'item/agentMessage/delta'];

    it('accepts malformed notifications and items without throwing, and reads only real thread ids', async () => {
        const t = started();
        await adopt(t, CHILD, 'Kant');
        for (const method of methods) {
            for (const params of badParams) expect(() => t.tracker.observeOtherThread(method, params)).not.toThrow();
        }
        for (const item of badItems) {
            expect(() => t.tracker.observeMainItem('item/completed', item, 'turn-1')).not.toThrow();
            expect(() => t.tracker.observeOtherThread('item/completed', { threadId: CHILD, item })).not.toThrow();
        }
        expect(t.request.mock.calls.map(([, params]) => (params as { threadId: unknown }).threadId)).toEqual([CHILD, 'child-x']);
        expect(t.tracker.observeMainItem('item/completed', badItems[8], 'turn-1')).toBeNull();
    });

    it('accepts malformed arguments in every public method', async () => {
        const t = setup();
        const loose = t.tracker as unknown as Record<string, (...args: unknown[]) => unknown>;
        expect(() => loose.setAvailable('yes')).not.toThrow();
        expect(t.publish.mock.calls.map(([snapshot]) => snapshot.available)).toEqual([false]);
        expect(() => loose.setMainThread(42)).not.toThrow();
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        expect(t.request).not.toHaveBeenCalled();
        expect(loose.shouldDivert(null, MAIN)).toBe(false);
        expect(loose.shouldDivert(['x'], null)).toBe(false);
        expect(loose.shouldDivert(CHILD, 5)).toBe(false);
        expect(t.tracker.observeMainItem('item/whatever' as 'item/completed', spawnEvidence(CHILD), null)).toBeNull();
        await expect(loose.awaitLabel(null, Number.NaN)).resolves.toBe('Agent');
        expect(formatCodexAgentLabel(null as unknown as {})).toBe('Agent');
        expect(formatCodexAgentLabel({ nickname: 5, role: {}, agentPath: 9 } as unknown as {})).toBe('Agent');
        expect(() => { t.tracker.invalidate(); t.tracker.dispose(); t.tracker.dispose(); t.tracker.invalidate(); }).not.toThrow();
    });

    it.each([
        ['throws synchronously', () => { throw new Error('sync failure'); }],
        ['rejects', () => Promise.reject(new Error('async failure'))],
        ['answers without a promise', () => undefined],
        ['answers garbage', () => Promise.resolve('garbage')],
    ])('survives a request that %s, without unhandled rejections', async (_name, failing) => {
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            const t = started({ request: failing as unknown as Deps['request'] });
            expect(() => t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'))).not.toThrow();
            expect(t.tracker.observeMainItem('item/completed', spawnEvidence(CHILD), 'turn-1')?.threadId).toBe(CHILD);
            await vi.advanceTimersByTimeAsync(2000);
            await flush();
            expect(t.tracker.running).toEqual([{ threadId: CHILD, label: 'Agent' }]);
            await vi.advanceTimersByTimeAsync(15_000);
            expect(t.tracker.running).toEqual([{ threadId: CHILD, label: 'Agent' }]);
            await new Promise(resolve => realSetImmediate(resolve));
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });

    it('survives params and items whose property reads throw', () => {
        const t = started();
        const hostile = new Proxy({}, { get: () => { throw new Error('hostile getter'); } });
        expect(() => t.tracker.observeOtherThread('turn/started', hostile)).not.toThrow();
        expect(t.tracker.observeMainItem('item/completed', hostile, 'turn-1')).toBeNull();
        expect(t.tracker.shouldDivert(hostile as unknown as string, null)).toBe(false);
        expect(t.request).not.toHaveBeenCalled();
    });

    it('logs a background step that fails unexpectedly instead of leaving an unhandled rejection', async () => {
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            const t = started();
            vi.mocked(logger.debug).mockClear();
            // The read failure is logged first; a logger that throws there makes the classification step reject.
            vi.mocked(logger.debug).mockImplementationOnce(() => { throw new Error('log file unavailable'); });
            t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
            t.calls[0].reject(new Error('busy'));
            await flush();
            await new Promise(resolve => realSetImmediate(resolve));
            expect(logger.debug).toHaveBeenLastCalledWith('[CodexSubagents] Classification failed', { error: 'Error: log file unavailable' });
            expect(unhandled).not.toHaveBeenCalled();
            expect(() => t.tracker.observeOtherThread('turn/completed', turnEvent(CHILD, 't1', 'completed'))).not.toThrow();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });

    it('keeps tracking when publish throws, and publishes the change on the next attempt', async () => {
        const publish = vi.fn<(snapshot: CodexSubagentSnapshot) => void>()
            .mockImplementationOnce(() => { throw new Error('metadata update failed'); });
        const t = setup({ publish });
        expect(() => t.tracker.setAvailable(true)).not.toThrow();
        t.tracker.setMainThread(MAIN);
        expect(publish).toHaveBeenCalledTimes(2);
        await adopt(t, CHILD, 'Kant');
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        expect(publish.mock.calls.map(([snapshot]) => snapshot.tasks)).toEqual([[], [], [task(CHILD, 'Kant')]]);
    });

    it('keeps working when the injected timer functions throw', async () => {
        const t = started({
            setTimer: () => { throw new Error('no timers'); },
            clearTimer: () => { throw new Error('no timers'); },
        });
        await adopt(t, CHILD, 'Kant');
        expect(() => t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'))).not.toThrow();
        expect(t.tracker.running).toEqual([{ threadId: CHILD, label: 'Kant' }]);
        await expect(t.tracker.awaitLabel('unknown-thread', 10)).resolves.toBe('Agent');
        t.tracker.observeOtherThread('thread/status/changed', statusChanged(GRANDCHILD, 'idle'));
        await expect(t.tracker.awaitLabel(GRANDCHILD, 10)).resolves.toBe('Agent');
        expect(() => { t.tracker.invalidate(); t.tracker.dispose(); }).not.toThrow();
    });
});

describe('[T] running-state table (design §1.1)', () => {
    type Input = (t: Setup) => void;
    const fromChild = (method: string, params: unknown): Input => t => t.tracker.observeOtherThread(method, params);
    const fromMain = (item: unknown): Input => t => { t.tracker.observeMainItem('item/completed', item, 'turn-1'); };
    const status = (type: string) => fromChild('thread/status/changed', statusChanged(CHILD, type));
    const agentState = (state: string) => fromMain(v1Call('wait', 'wait-1', 'completed', [CHILD], { [CHILD]: { status: state, message: null } }, MAIN));
    const activity = (kind: string) => fromMain({ type: 'subAgentActivity', id: `call-${kind}`, kind, agentThreadId: CHILD, agentPath: '/root/kant' });

    async function child(running: boolean): Promise<Setup> {
        const t = started();
        await adopt(t, CHILD, 'Kant');
        if (running) t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        return t;
    }

    it.each([
        ['child turn/started', fromChild('turn/started', turnEvent(CHILD, 't2'))],
        ['child thread/status/changed active', status('active')],
        ['agentsStates pendingInit', agentState('pendingInit')],
        ['agentsStates running', agentState('running')],
        ['subAgentActivity started', activity('started')],
    ])('%s marks a child running', async (_name, input) => {
        const t = await child(false);
        input(t);
        expect(t.tracker.running).toEqual([{ threadId: CHILD, label: 'Kant' }]);
    });

    it.each([
        ['child turn/completed (completed)', fromChild('turn/completed', turnEvent(CHILD, 't1', 'completed'))],
        ['child turn/completed (failed)', fromChild('turn/completed', turnEvent(CHILD, 't1', 'failed'))],
        ['child turn/completed (interrupted)', fromChild('turn/completed', turnEvent(CHILD, 't1', 'interrupted'))],
        ['child thread/status/changed idle', status('idle')],
        ['child thread/status/changed systemError', status('systemError')],
        ['agentsStates completed', agentState('completed')],
        ['agentsStates errored', agentState('errored')],
        ['agentsStates interrupted', agentState('interrupted')],
        ['subAgentActivity completed', activity('completed')],
        ['subAgentActivity interrupted', activity('interrupted')],
    ])('%s stops a running child, and any running input starts it again', async (_name, input) => {
        const t = await child(true);
        input(t);
        expect(t.tracker.running).toEqual([]);
        agentState('running')(t);
        expect(t.tracker.running).toEqual([{ threadId: CHILD, label: 'Kant' }]);
    });

    it.each([
        ['child thread/status/changed notLoaded', status('notLoaded')],
        ['child thread/closed', fromChild('thread/closed', { threadId: CHILD })],
        ['child thread/deleted', fromChild('thread/deleted', { threadId: CHILD })],
        ['child thread/archived', fromChild('thread/archived', { threadId: CHILD })],
        ['agentsStates shutdown', agentState('shutdown')],
        ['agentsStates notFound', agentState('notFound')],
    ])('%s closes a child: a parent snapshot cannot reopen it, its own next turn can', async (_name, input) => {
        const t = await child(true);
        input(t);
        expect(t.tracker.running).toEqual([]);
        // app-server broadcasts notLoaded before the closeAgent item, which carries the pre-close state.
        fromMain(v1Call('closeAgent', 'close-1', 'completed', [CHILD], { [CHILD]: { status: 'running', message: null } }, MAIN))(t);
        activity('started')(t);
        expect(t.tracker.running).toEqual([]);
        // resume_agent: the child runs a turn of its own again.
        fromChild('turn/started', turnEvent(CHILD, 't2'))(t);
        expect(t.tracker.running).toEqual([{ threadId: CHILD, label: 'Kant' }]);
    });

    it('reopens a closed child on its own active status as well', async () => {
        const t = await child(true);
        status('notLoaded')(t);
        status('active')(t);
        expect(t.tracker.running).toEqual([{ threadId: CHILD, label: 'Kant' }]);
    });

    it('creates nothing for a completion item about a thread it never saw', () => {
        const t = started();
        fromMain({ type: 'subAgentActivity', id: 'call-x', kind: 'completed', agentThreadId: 'never-seen', agentPath: '/root/x' })(t);
        fromMain(v1Call('wait', 'wait-x', 'completed', ['never-seen'], { 'never-seen': { status: 'completed', message: 'OK' } }, MAIN))(t);
        expect(t.request).not.toHaveBeenCalled();
        expect(t.tracker.shouldDivert('never-seen', null)).toBe(false);
    });

    it('leaves the state alone on subAgentActivity interacted', async () => {
        const running = await child(true);
        activity('interacted')(running);
        expect(running.tracker.running).toHaveLength(1);
        const idle = await child(false);
        activity('interacted')(idle);
        expect(idle.tracker.running).toEqual([]);
    });

    it.each([
        ['active', [{ threadId: CHILD, label: 'Kant' }]],
        ['idle', []],
        ['systemError', []],
        ['notLoaded', []],
    ])('takes a poll answer of %s', async (type, expected) => {
        const t = await child(true);
        await vi.advanceTimersByTimeAsync(5000);
        t.calls[1].resolve(threadRead(CHILD, MAIN, { nickname: 'Kant', status: type }));
        await flush();
        expect(t.tracker.running).toEqual(expected);
    });

    it('treats a poll answer of notLoaded as closed', async () => {
        const t = await child(true);
        await vi.advanceTimersByTimeAsync(5000);
        t.calls[1].resolve(threadRead(CHILD, MAIN, { nickname: 'Kant', status: 'notLoaded' }));
        await flush();
        agentState('running')(t);
        expect(t.tracker.running).toEqual([]);
    });
});

describe('[13] polling and dispose', () => {
    it('keeps a 5 s timer only while a child is shown, and reads the shown children one at a time', async () => {
        const setTimer = vi.fn((fn: () => void, ms: number) => setTimeout(fn, ms));
        const t = started({ setTimer });
        await adopt(t, CHILD, 'Kant');
        await adopt(t, 'child-b', 'Hume');
        expect(vi.getTimerCount()).toBe(0);

        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.tracker.observeOtherThread('turn/started', turnEvent('child-b', 't2'));
        expect(vi.getTimerCount()).toBe(1);
        expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), 5000);

        await vi.advanceTimersByTimeAsync(5000);
        expect(t.request).toHaveBeenCalledTimes(3);
        expect(t.calls[2].params).toEqual({ threadId: CHILD, includeTurns: false });
        t.calls[2].resolve(threadRead(CHILD, MAIN, { nickname: 'Kant', status: 'active' }));
        await flush();
        expect(t.request).toHaveBeenCalledTimes(4);
        expect(t.calls[3].params).toEqual({ threadId: 'child-b', includeTurns: false });
        // A failed poll keeps the state the notifications gave.
        t.calls[3].reject(new Error('Request timed out'));
        await flush();
        expect(t.tracker.running).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(1);

        t.tracker.observeOtherThread('turn/completed', turnEvent(CHILD, 't1', 'completed'));
        expect(vi.getTimerCount()).toBe(1);
        t.tracker.observeOtherThread('turn/completed', turnEvent('child-b', 't2', 'completed'));
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(t.request).toHaveBeenCalledTimes(4);
    });

    it('starts no second round while one is in flight, and schedules the next after it', async () => {
        const t = started();
        await adopt(t, CHILD, 'Kant');
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        await vi.advanceTimersByTimeAsync(5000);
        t.tracker.observeOtherThread('turn/completed', turnEvent(CHILD, 't1', 'completed'));
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't2'));
        expect(vi.getTimerCount()).toBe(0);
        t.calls[1].resolve(threadRead(CHILD, MAIN, { nickname: 'Kant', status: 'active' }));
        await flush();
        expect(vi.getTimerCount()).toBe(1);
    });

    it('dispose() clears every timer and ignores later answers, notifications and calls', async () => {
        const t = started();
        await adopt(t, CHILD, 'Kant');
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.tracker.observeOtherThread('turn/started', turnEvent('child-b', 't2'));
        t.calls[1].reject(new Error('busy'));
        await flush();
        t.tracker.observeMainItem('item/completed', spawnEvidence('child-c'), 'turn-1');
        const label = t.tracker.awaitLabel('child-c', 60_000);
        // The poll, child-b's read retry, child-c's held first listing (rule B) and this label wait.
        expect(vi.getTimerCount()).toBe(4);

        t.tracker.dispose();
        expect(vi.getTimerCount()).toBe(0);
        await expect(label).resolves.toBe('Agent');
        const publishes = t.publish.mock.calls.length;
        const requests = t.request.mock.calls.length;
        t.calls[2].resolve(threadRead('child-c', MAIN, { nickname: 'Late' }));
        t.tracker.observeOtherThread('turn/started', turnEvent('child-d', 't3'));
        expect(t.tracker.observeMainItem('item/completed', spawnEvidence('child-e'), 'turn-1')).toBeNull();
        t.tracker.setAvailable(false);
        t.tracker.invalidate();
        t.tracker.setMainThread('other-main');
        await expect(t.tracker.awaitLabel('child-d', 60_000)).resolves.toBe('Agent');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(t.publish).toHaveBeenCalledTimes(publishes);
        expect(t.request).toHaveBeenCalledTimes(requests);
        expect(vi.getTimerCount()).toBe(0);
        expect(t.tracker.running).toEqual([]);
    });

    it('unrefs its default timers and clears them on dispose', () => {
        const unref = vi.fn();
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((() => ({ unref })) as unknown as typeof setTimeout);
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
        try {
            const tracker = new CodexSubagentTracker({ request: vi.fn(() => new Promise<unknown>(() => {})), publish: vi.fn() });
            tracker.setAvailable(true);
            tracker.setMainThread(MAIN);
            tracker.observeMainItem('item/completed', spawnEvidence(CHILD), 'turn-1');
            void tracker.awaitLabel(CHILD, 1500);
            // The held first listing (rule B) and this label wait.
            expect(setTimeoutSpy.mock.calls.map(([, ms]) => ms)).toEqual([1500, 1500]);
            expect(unref).toHaveBeenCalledTimes(2);
            tracker.dispose();
            expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
        } finally {
            setTimeoutSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
        }
    });
});

describe('[L] published list', () => {
    it('lists at most 50 running children, first seen first', async () => {
        const t = started();
        const ids = Array.from({ length: 51 }, (_, index) => `child-${String(index).padStart(2, '0')}`);
        for (const threadId of ids) t.tracker.observeOtherThread('turn/started', turnEvent(threadId, 't'));
        for (let index = ids.length - 1; index >= 0; index--) t.calls[index].resolve(threadRead(ids[index], MAIN, { nickname: `N${index}` }));
        await flush();
        expect(t.tracker.running.map(({ threadId }) => threadId)).toEqual(ids.slice(0, 50));
        expect(t.published().at(-1)).toHaveLength(50);

        t.tracker.observeOtherThread('turn/completed', turnEvent(ids[0], 't', 'completed'));
        expect(t.tracker.running.map(({ threadId }) => threadId)).toEqual(ids.slice(1));
    });

    it('keeps first-seen order when a child stops and runs again', async () => {
        const t = started();
        await adopt(t, CHILD, 'Kant');
        await adopt(t, 'child-b', 'Hume');
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        t.tracker.observeOtherThread('turn/started', turnEvent('child-b', 't2'));
        t.tracker.observeOtherThread('turn/completed', turnEvent(CHILD, 't1', 'completed'));
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't3'));
        expect(t.published()).toEqual([
            [], [task(CHILD, 'Kant')], [task(CHILD, 'Kant'), task('child-b', 'Hume')], [task('child-b', 'Hume')],
            [task(CHILD, 'Kant'), task('child-b', 'Hume')],
        ]);
    });

    it('republishes when a poll changes a label, and not when the answer changes nothing', async () => {
        const t = started();
        await adopt(t, CHILD, 'Kant');
        t.tracker.observeOtherThread('turn/started', turnEvent(CHILD, 't1'));
        await vi.advanceTimersByTimeAsync(5000);
        t.calls[1].resolve(threadRead(CHILD, MAIN, { nickname: 'Kant', status: 'active' }));
        await flush();
        expect(t.published()).toEqual([[], [task(CHILD, 'Kant')]]);
        await vi.advanceTimersByTimeAsync(5000);
        t.calls[2].resolve(threadRead(CHILD, MAIN, { nickname: 'Kant', role: 'explorer', status: 'active' }));
        await flush();
        expect(t.published()).toEqual([[], [task(CHILD, 'Kant')], [task(CHILD, 'Kant [explorer]')]]);
    });
});
