import { describe, expect, it, vi } from 'vitest';

import {
    buildSideForkConfig,
    chooseSideToolProfile,
    CODEX_SIDE_BOUNDARY_PROMPT,
    CODEX_SIDE_DEVELOPER_INSTRUCTIONS,
    CodexSideQuestionBridge,
    createCodexSideQuestionRpcHandler,
    declineServerRequest,
    type CodexSideConnection,
    type CodexSideQuestionSource,
} from './codexSideQuestion';

const SOURCE: CodexSideQuestionSource = {
    threadId: 'main-thread',
    rolloutPath: '/codex/sessions/rollout-main.jsonl',
    cwd: '/work/project',
    model: 'gpt-test',
    effort: 'medium',
    sandboxManagedByHappy: false,
};

const LAUNCH = { command: 'codex', args: ['app-server', '--listen', 'stdio://'], env: {} };

type ForkReply = { thread?: { id?: string; ephemeral?: boolean }; sandbox?: { type: string }; model?: string } | Error;

/** A scripted side app-server. `turn` decides what the side turn emits once it starts. */
function fakeConnection(options: {
    forks?: ForkReply[];
    configRead?: unknown | Error;
    turn?: (emit: (method: string, params: Record<string, unknown>) => void, threadId: string) => void;
    denied?: number;
} = {}) {
    const listeners = new Set<(method: string, params: unknown) => void>();
    const forks = [...(options.forks ?? [{ thread: { id: 'side-1', ephemeral: true }, sandbox: { type: 'readOnly' }, model: 'gpt-test' }])];
    const calls: { method: string; params: any }[] = [];
    const emit = (method: string, params: Record<string, unknown>) => { for (const listener of [...listeners]) listener(method, params); };
    const connection: CodexSideConnection & { calls: typeof calls; closed: number } = {
        calls,
        closed: 0,
        request: vi.fn(async (method: string, params: any) => {
            calls.push({ method, params });
            if (method === 'config/read') {
                const value = options.configRead ?? { config: { mcp_servers: { memory: {}, browser: {} } } };
                if (value instanceof Error) throw value;
                return value;
            }
            if (method === 'thread/fork') {
                const reply = forks.shift() ?? new Error('no more forks scripted');
                if (reply instanceof Error) throw reply;
                return reply;
            }
            if (method === 'turn/start') {
                queueMicrotask(() => (options.turn ?? answerTurn('the answer'))(emit, params.threadId));
                return { turn: { id: 'side-turn' } };
            }
            return {};
        }),
        onNotification: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        deniedRequests: () => options.denied ?? 0,
        close: vi.fn(async () => { connection.closed += 1; }),
    };
    return connection;
}

function answerTurn(text: string, usage = [{ totalTokens: 120, inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5 }]) {
    return (emit: (method: string, params: Record<string, unknown>) => void, threadId: string) => {
        emit('item/completed', { threadId, item: { type: 'agentMessage', text: 'Let me look.', phase: 'commentary' } });
        for (const last of usage) emit('thread/tokenUsage/updated', { threadId, tokenUsage: { total: { totalTokens: 99_999 }, last } });
        // Another thread on the same process (the parent's own events never reach this one, but be strict).
        emit('item/completed', { threadId: 'main-thread', item: { type: 'agentMessage', text: 'main thread text', phase: 'final_answer' } });
        emit('item/completed', { threadId, item: { type: 'agentMessage', text: `  ${text}  `, phase: 'final_answer' } });
        emit('turn/completed', { threadId, turn: { id: 'side-turn', status: 'completed' } });
    };
}

function bridgeWith(connection: CodexSideConnection, overrides: Partial<ConstructorParameters<typeof CodexSideQuestionBridge>[0]> = {}) {
    const launch = vi.fn(async () => LAUNCH);
    const connect = vi.fn(async () => connection);
    const bridge = new CodexSideQuestionBridge({ source: () => SOURCE, launch, connect, platform: 'darwin', ...overrides });
    return { bridge, launch, connect };
}

describe('declineServerRequest (R4-b)', () => {
    it('declines every approval and input request instead of answering it', () => {
        expect(declineServerRequest('item/commandExecution/requestApproval')).toEqual({ result: { decision: 'decline' } });
        expect(declineServerRequest('item/fileChange/requestApproval')).toEqual({ result: { decision: 'decline' } });
        expect(declineServerRequest('execCommandApproval')).toEqual({ result: { decision: 'denied' } });
        expect(declineServerRequest('applyPatchApproval')).toEqual({ result: { decision: 'denied' } });
        expect(declineServerRequest('item/tool/requestUserInput')).toEqual({ result: { answers: {} } });
        expect(declineServerRequest('mcpServer/elicitation/request')).toEqual({ result: { action: 'decline', content: null, _meta: null } });
    });

    it('refuses permission grants and unknown requests with an error, never an empty result', () => {
        for (const method of ['item/permissions/requestApproval', 'item/tool/call', 'account/chatgptAuthTokens/refresh', 'something/new']) {
            expect(declineServerRequest(method)).toHaveProperty('error');
        }
    });
});

describe('chooseSideToolProfile (R3a/R3b)', () => {
    it('explores read-only by default', () => {
        expect(chooseSideToolProfile({ requested: undefined, sandboxManagedByHappy: false, platform: 'darwin' })).toBe('read-only');
    });

    it('turns tools off under Happy\'s sandbox, on Windows, and when asked (recap)', () => {
        expect(chooseSideToolProfile({ requested: undefined, sandboxManagedByHappy: true, platform: 'darwin' })).toBe('none');
        expect(chooseSideToolProfile({ requested: undefined, sandboxManagedByHappy: false, platform: 'win32' })).toBe('none');
        expect(chooseSideToolProfile({ requested: 'none', sandboxManagedByHappy: false, platform: 'linux' })).toBe('none');
    });
});

describe('buildSideForkConfig (R4-c)', () => {
    it('turns off every path the sandbox does not cover, in both profiles', () => {
        for (const profile of ['read-only', 'none'] as const) {
            const config = buildSideForkConfig(profile, ['memory']);
            expect(config).toMatchObject({
                'features.apps': false,
                'features.plugins': false,
                'features.goals': false,
                'features.hooks': false,
                'features.memories': false,
                'features.multi_agent': false,
                'features.image_generation': false,
                'features.request_permissions_tool': false,
                'tools.experimental_request_user_input.enabled': false,
                'tools.update_plan.enabled': false,
                web_search: 'disabled',
                mcp_servers: { memory: { enabled: false } },
            });
        }
    });

    it('keeps the shell only in the read-only profile', () => {
        expect(buildSideForkConfig('read-only', [])).not.toHaveProperty('features.shell_tool');
        expect(buildSideForkConfig('none', [])).toMatchObject({ 'features.shell_tool': false, 'features.unified_exec': false });
    });
});

describe('CodexSideQuestionBridge', () => {
    it('forks the session thread ephemeral and read-only on its own connection and returns the final answer', async () => {
        const connection = fakeConnection({ denied: 2 });
        const { bridge, launch, connect } = bridgeWith(connection);

        const outcome = await bridge.ask('  what file did you change?  ');

        expect(outcome).toEqual({
            ok: true,
            answer: 'the answer',
            usage: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5 },
            model: 'gpt-test',
            toolProfile: 'read-only',
            deniedRequests: 2,
        });
        expect(launch).toHaveBeenCalledTimes(1);
        expect(connect).toHaveBeenCalledWith(LAUNCH, '/work/project');
        const fork = connection.calls.find((call) => call.method === 'thread/fork')!.params;
        expect(fork).toMatchObject({
            threadId: 'main-thread',
            path: '/codex/sessions/rollout-main.jsonl',
            cwd: '/work/project',
            model: 'gpt-test',
            approvalPolicy: 'never',
            sandbox: 'read-only',
            ephemeral: true,
            excludeTurns: true,
            developerInstructions: CODEX_SIDE_DEVELOPER_INSTRUCTIONS,
        });
        expect(fork.config.mcp_servers).toEqual({ memory: { enabled: false }, browser: { enabled: false } });
        const turn = connection.calls.find((call) => call.method === 'turn/start')!.params;
        expect(turn.threadId).toBe('side-1');
        expect(turn.effort).toBe('medium');
        expect(turn.input[0].text).toBe(`${CODEX_SIDE_BOUNDARY_PROMPT}\n\nwhat file did you change?`);
        // R5: unsubscribed and the process ended; a completed turn needs no interrupt.
        expect(connection.calls.map((call) => call.method)).toEqual(['config/read', 'thread/fork', 'turn/start', 'thread/unsubscribe']);
        expect(connection.closed).toBe(1);
    });

    it('keeps the Codex /side mutation allowance out of the boundary text (R3a)', () => {
        for (const text of [CODEX_SIDE_BOUNDARY_PROMPT, CODEX_SIDE_DEVELOPER_INSTRUCTIONS]) {
            expect(text).not.toMatch(/unless the user explicitly/i);
            expect(text).toMatch(/main conversation/);
        }
    });

    it('sums each response of the side thread, not the running total inherited from the parent (R8)', async () => {
        const step = { totalTokens: 10, inputTokens: 8, cachedInputTokens: 4, cacheWriteInputTokens: 1, outputTokens: 2, reasoningOutputTokens: 1 };
        const connection = fakeConnection({ turn: answerTurn('ok', [step, step, step]) });
        const outcome = await bridgeWith(connection).bridge.ask('q');
        expect(outcome.ok && outcome.usage).toEqual({ totalTokens: 30, inputTokens: 24, cachedInputTokens: 12, cacheWriteInputTokens: 3, outputTokens: 6, reasoningOutputTokens: 3 });
    });

    it('reopens the fork once without tools when its sandbox is not read-only (R4-a)', async () => {
        const connection = fakeConnection({
            forks: [
                { thread: { id: 'side-1', ephemeral: true }, sandbox: { type: 'workspaceWrite' } },
                { thread: { id: 'side-2', ephemeral: true }, sandbox: { type: 'readOnly' } },
            ],
        });
        const outcome = await bridgeWith(connection).bridge.ask('q');

        expect(outcome).toMatchObject({ ok: true, toolProfile: 'none' });
        const forks = connection.calls.filter((call) => call.method === 'thread/fork');
        expect(forks).toHaveLength(2);
        expect(forks[1].params.config).toMatchObject({ 'features.shell_tool': false });
        expect(connection.calls).toContainEqual({ method: 'thread/unsubscribe', params: { threadId: 'side-1' } });
        expect(connection.calls.find((call) => call.method === 'turn/start')!.params.threadId).toBe('side-2');
    });

    it('reopens without tools when Codex refuses a config key, and fails when that is refused too', async () => {
        const refused = new Error('failed to load configuration: invalid type');
        const retried = fakeConnection({ forks: [refused, { thread: { id: 'side-2', ephemeral: true }, sandbox: { type: 'readOnly' } }] });
        expect(await bridgeWith(retried).bridge.ask('q')).toMatchObject({ ok: true, toolProfile: 'none' });

        const both = fakeConnection({ forks: [refused, refused] });
        const outcome = await bridgeWith(both).bridge.ask('q');
        expect(outcome).toMatchObject({ ok: false, error: 'failed' });
        expect(both.calls.some((call) => call.method === 'turn/start')).toBe(false);
        expect(both.closed).toBe(1);
    });

    it('fails without answering when even the tool-less fork is not read-only', async () => {
        const connection = fakeConnection({
            forks: [
                { thread: { id: 'side-1', ephemeral: true }, sandbox: { type: 'dangerFullAccess' } },
                { thread: { id: 'side-2', ephemeral: true }, sandbox: { type: 'dangerFullAccess' } },
            ],
        });
        const outcome = await bridgeWith(connection).bridge.ask('q');
        expect(outcome).toMatchObject({ ok: false, error: 'failed', detail: 'fork sandbox is dangerFullAccess' });
        expect(connection.calls.some((call) => call.method === 'turn/start')).toBe(false);
    });

    it('fails, without a retry, when the fork is not ephemeral (R6)', async () => {
        const connection = fakeConnection({ forks: [{ thread: { id: 'side-1', ephemeral: false }, sandbox: { type: 'readOnly' } }] });
        const outcome = await bridgeWith(connection).bridge.ask('q');
        expect(outcome).toMatchObject({ ok: false, error: 'failed', detail: 'fork is not ephemeral' });
        expect(connection.calls.filter((call) => call.method === 'thread/fork')).toHaveLength(1);
    });

    it('fails closed when the effective config cannot be read', async () => {
        const connection = fakeConnection({ configRead: new Error('config/read unsupported') });
        const outcome = await bridgeWith(connection).bridge.ask('q');
        expect(outcome).toMatchObject({ ok: false, error: 'failed' });
        expect(connection.calls.some((call) => call.method === 'thread/fork')).toBe(false);
    });

    it('stops a tool-less turn that shows a tool the profile turned off (ignored config key)', async () => {
        const connection = fakeConnection({
            forks: [{ thread: { id: 'side-1', ephemeral: true }, sandbox: { type: 'readOnly' } }],
            turn: (emit, threadId) => emit('item/started', { threadId, item: { type: 'commandExecution' } }),
        });
        const outcome = await bridgeWith(connection).bridge.ask('q', { toolProfile: 'none' });
        expect(outcome).toMatchObject({ ok: false, error: 'failed', detail: 'tool-boundary: commandExecution' });
        expect(connection.calls).toContainEqual({ method: 'turn/interrupt', params: { threadId: 'side-1', turnId: 'side-turn' } });
        expect(connection.closed).toBe(1);
    });

    it('stops a read-only turn that calls an MCP tool or a sub-agent', async () => {
        for (const type of ['mcpToolCall', 'collabAgentToolCall', 'webSearch', 'somethingNew']) {
            const connection = fakeConnection({ turn: (emit, threadId) => emit('item/started', { threadId, item: { type } }) });
            expect(await bridgeWith(connection).bridge.ask('q')).toMatchObject({ ok: false, detail: `tool-boundary: ${type}` });
        }
    });

    it('times out, keeps the usage already spent, and cleans up in order', async () => {
        const connection = fakeConnection({
            turn: (emit, threadId) => emit('thread/tokenUsage/updated', { threadId, tokenUsage: { last: { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 } } }),
        });
        const outcome = await bridgeWith(connection).bridge.ask('q', { timeoutMs: 30 });
        expect(outcome).toMatchObject({ ok: false, error: 'timeout', usage: { totalTokens: 7 }, model: 'gpt-test' });
        expect(connection.calls.map((call) => call.method).slice(-2)).toEqual(['turn/interrupt', 'thread/unsubscribe']);
        expect(connection.closed).toBe(1);
    });

    it('answers one side question at a time per session', async () => {
        let finish!: () => void;
        const connection = fakeConnection({ turn: (emit, threadId) => { finish = () => answerTurn('first')(emit, threadId); } });
        const { bridge } = bridgeWith(connection);
        const first = bridge.ask('one');
        await vi.waitFor(() => expect(connection.calls.some((call) => call.method === 'turn/start')).toBe(true));
        expect(await bridge.ask('two')).toEqual({ ok: false, error: 'busy' });
        finish();
        expect(await first).toMatchObject({ ok: true, answer: 'first' });
    });

    it('reports a session without a live client, a thread before its first message, and a session that may not start a second process', async () => {
        const connection = fakeConnection();
        expect(await bridgeWith(connection, { source: () => null }).bridge.ask('q')).toEqual({ ok: false, error: 'not-running' });
        expect(await bridgeWith(connection, { source: () => ({ ...SOURCE, threadId: null }) }).bridge.ask('q')).toEqual({ ok: false, error: 'not-started' });
        expect(await bridgeWith(connection, { launch: async () => null }).bridge.ask('q')).toEqual({ ok: false, error: 'not-allowed' });

        const unwritten = fakeConnection({ forks: [new Error('no rollout found for thread id main-thread')] });
        expect(await bridgeWith(unwritten).bridge.ask('q')).toMatchObject({ ok: false, error: 'not-started' });
        expect(unwritten.calls.filter((call) => call.method === 'thread/fork')).toHaveLength(1);
    });

    it('rejects an empty or overlong question before launching anything', async () => {
        const connection = fakeConnection();
        const { bridge, launch } = bridgeWith(connection);
        expect(await bridge.ask('   ')).toEqual({ ok: false, error: 'empty-question' });
        expect(await bridge.ask('x'.repeat(8001))).toEqual({ ok: false, error: 'too-long' });
        expect(launch).not.toHaveBeenCalled();
    });

    it('stops a pending side question when the session ends', async () => {
        const connection = fakeConnection({ turn: () => {} });
        const { bridge } = bridgeWith(connection);
        const pending = bridge.ask('q');
        await vi.waitFor(() => expect(connection.calls.some((call) => call.method === 'turn/start')).toBe(true));
        bridge.dispose();
        expect(await pending).toMatchObject({ ok: false, error: 'failed', detail: 'session ended' });
        expect(connection.closed).toBe(1);
    });
});

describe('createCodexSideQuestionRpcHandler', () => {
    const usage = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 5, outputTokens: 20, reasoningOutputTokens: 5 };

    function handlerWith(ask: CodexSideQuestionBridge['ask'], extra: Partial<Parameters<typeof createCodexSideQuestionRpcHandler>[0]> = {}) {
        const reportUsage = vi.fn();
        const handler = createCodexSideQuestionRpcHandler({
            bridge: { ask },
            isManagedRun: () => false,
            gate: () => undefined,
            reportUsage,
            newRequestId: () => 'req-1',
            ...extra,
        });
        return { handler, reportUsage };
    }

    it('answers with the Claude reply fields plus toolProfile and deniedRequests (R7)', async () => {
        const ask = vi.fn(async () => ({ ok: true as const, answer: 'a', usage, model: 'gpt-test', toolProfile: 'read-only' as const, deniedRequests: 1 }));
        const { handler, reportUsage } = handlerWith(ask);

        expect(await handler({ question: 'q' })).toEqual({
            success: true,
            answer: 'a',
            synthetic: false,
            usage: { input: 35, output: 20, cacheRead: 60, cacheWrite: 5, total: 120 },
            usageQuality: 'exact',
            model: 'gpt-test',
            toolProfile: 'read-only',
            deniedRequests: 1,
        });
        expect(ask).toHaveBeenCalledWith('q', { timeoutMs: undefined, toolProfile: undefined });
        expect(reportUsage).toHaveBeenCalledWith({ requestId: 'req-1', usage, model: 'gpt-test' });
    });

    it('passes the tool-less profile a recap asks for, and nothing else', async () => {
        const ask = vi.fn(async () => ({ ok: false as const, error: 'failed' as const }));
        const { handler } = handlerWith(ask);
        await handler({ question: 'q', toolProfile: 'none' });
        await handler({ question: 'q', toolProfile: 'read-write' });
        expect(ask.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
            { timeoutMs: undefined, toolProfile: 'none' },
            { timeoutMs: undefined, toolProfile: undefined },
        ]);
    });

    it('reports usage a failed side question already spent, and returns the coded failure', async () => {
        const ask = vi.fn(async () => ({ ok: false as const, error: 'timeout' as const, usage, model: 'gpt-test' }));
        const { handler, reportUsage } = handlerWith(ask);
        expect(await handler({ question: 'q' })).toEqual({ success: false, error: 'side-question:timeout' });
        expect(reportUsage).toHaveBeenCalledTimes(1);
        const notStarted = handlerWith(vi.fn(async () => ({ ok: false as const, error: 'not-started' as const })));
        expect(await notStarted.handler({ question: 'q' })).toEqual({ success: false, error: 'side-question:not-started' });
        expect(notStarted.reportUsage).not.toHaveBeenCalled();
    });

    it('refuses a managed run and a session that is shutting down, and admits the rest as a writer', async () => {
        const ask = vi.fn();
        expect(await handlerWith(ask, { isManagedRun: () => true }).handler({ question: 'q' })).toEqual({ success: false, error: 'side-question:managed-run' });
        expect(await handlerWith(ask, { gate: () => ({ isClosed: () => true, admit: vi.fn() }) }).handler({ question: 'q' })).toEqual({ success: false, error: 'side-question:shutting-down' });
        expect(ask).not.toHaveBeenCalled();

        const admit = vi.fn((work: () => Promise<unknown>, kind?: string) => { expect(kind).toBe('writer'); return work(); });
        const okAsk = vi.fn(async () => ({ ok: true as const, answer: 'a', usage: null, model: null, toolProfile: 'none' as const, deniedRequests: 0 }));
        const reply = await handlerWith(okAsk, { gate: () => ({ isClosed: () => false, admit: admit as never }) }).handler({ question: 'q' });
        expect(reply).toMatchObject({ success: true, usage: null, usageQuality: null, toolProfile: 'none' });
        expect(admit).toHaveBeenCalledTimes(1);
    });
});
