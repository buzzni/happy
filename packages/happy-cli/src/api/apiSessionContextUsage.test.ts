/**
 * The context-usage frame the session client sends Desktop over `session-stream`.
 *
 * Saycode Desktop specs/desktop-chat-context-window-meter, plan.md tests H1–H6. Each signal has
 * to reach Desktop on its own: a normal turn result, a compaction and a reset make no
 * `usage-report`, so a meter that waited for one would never see them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from './types';
import { decodeBase64, decrypt } from './encryption';
import { ApiSessionClient } from './apiSession';

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));

vi.mock('socket.io-client', () => ({ io: mockIo }));
vi.mock('axios', () => ({
    default: {
        get: vi.fn(async () => ({ data: { messages: [], events: [], sessions: [], hasMore: false } })),
        post: vi.fn(async () => ({ data: { messages: [] } })),
        put: vi.fn(async () => ({ data: {} })),
    },
}));
vi.mock('@/configuration', () => ({
    configuration: { serverUrl: 'https://server.test', happyHomeDir: '/tmp/happy-test-home', currentCliVersion: '0.0.0-test' },
}));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn(), warn: vi.fn() } }));
vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
        registerHandler = vi.fn();
    },
}));
vi.mock('@/modules/common/registerCommonHandlers', () => ({ registerCommonHandlers: vi.fn() }));
vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionRuntime: vi.fn(async () => ({ status: 'ok' })),
    notifyDaemonAutomationTurnResult: vi.fn(async () => ({ status: 'ok' })),
}));

const MODEL = 'claude-sonnet-4-5-20250929';

function makeSession() {
    return {
        id: 'test-session-id',
        seq: 0,
        metadata: {
            path: '/tmp', host: 'localhost', homeDir: '/home/user', happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib', happyToolsDir: '/home/user/.happy/tools',
        } as Metadata,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy' as const,
    };
}

const mainAssistant = (input: number, extra: Record<string, unknown> = {}) => ({
    type: 'assistant',
    uuid: `assistant-${input}`,
    isSidechain: false,
    message: { id: `msg-${input}`, model: MODEL, content: [], usage: { input_tokens: input, output_tokens: 10, cache_read_input_tokens: 0 } },
    ...extra,
}) as any;

const result = (uuid: string, extra: Record<string, unknown> = {}) => ({
    uuid,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { [MODEL]: { inputTokens: 1, outputTokens: 1, contextWindow: 200000 } },
    ...extra,
});

describe('ApiSessionClient context-usage frames', () => {
    let handlers: Record<string, Array<(...args: any[]) => void>>;
    let socket: any;
    let session: ReturnType<typeof makeSession>;
    const fire = (event: string, ...args: any[]) => (handlers[event] ?? []).forEach((handler) => handler(...args));

    /** Every decrypted context-usage frame, in send order. */
    const frames = () => socket.volatile.emit.mock.calls
        .filter(([event]: [string]) => event === 'session-stream')
        .map(([, payload]: [string, { sid: string; data: string }]) => {
            expect(payload.sid).toBe('test-session-id');
            return decrypt(session.encryptionKey, session.encryptionVariant, decodeBase64(payload.data));
        })
        .filter((frame: { type?: unknown }) => frame?.type === 'context-usage');
    const usageReports = () => socket.emit.mock.calls.filter(([event]: [string]) => event === 'usage-report');

    beforeEach(() => {
        vi.clearAllMocks();
        handlers = {};
        session = makeSession();
        socket = {
            connected: true,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: (...args: any[]) => void) => { (handlers[event] ??= []).push(handler); }),
            off: vi.fn(),
            emit: vi.fn(),
            timeout: vi.fn(function (this: unknown) { return this; }),
            emitWithAck: vi.fn(async () => ({ result: 'error' })),
            volatile: { emit: vi.fn() },
            close: vi.fn(),
        };
        mockIo.mockReturnValue(socket);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('sends the contract snapshot as an encrypted volatile session-stream frame', async () => {
        const client = new ApiSessionClient('fake-token', session);
        client.sendClaudeSessionMessage(mainAssistant(1234));

        expect(socket.emit).not.toHaveBeenCalledWith('session-stream', expect.anything());
        expect(frames()).toEqual([{
            version: 1, type: 'context-usage', epoch: expect.any(String), seq: 1, used: 1234, window: null, model: MODEL,
        }]);
        await client.close();
    });

    it('H1: sidechain, compaction summary, /btw and result fallback usage never move occupancy', async () => {
        const client = new ApiSessionClient('fake-token', session);
        client.sendClaudeSessionMessage(mainAssistant(500, { isSidechain: true, parent_tool_use_id: 'toolu_task' }));
        client.sendClaudeSessionMessage(mainAssistant(600, { isCompactSummary: true }));
        client.reportSideQuestionUsage({ requestId: 'btw-1', usage: { input_tokens: 700, output_tokens: 1 }, model: MODEL, quality: 'exact' });

        expect(frames()).toEqual([]);
        // The existing usage metering still saw all of them.
        expect(usageReports()).toHaveLength(3);
        await client.close();
    });

    it('H1: a turn booked from the result fallback shows nothing either', async () => {
        const client = new ApiSessionClient('fake-token', session);
        // Z.AI-compatible turn: zero assistant usage, so the result is booked as a fallback.
        const zero = mainAssistant(0);
        zero.message.usage = { input_tokens: 0, output_tokens: 0 };
        client.sendClaudeSessionMessage(zero);
        client.applyClaudeTurnResult(result('result-fallback', { usage: { input_tokens: 800, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));

        expect(frames()).toEqual([]);
        expect(usageReports().map(([, report]: [string, any]) => report.tokens.input)).toEqual([0, 800]);
        await client.close();
    });

    it('H2: a normal turn result shows the window without waiting for another response, metering unchanged', async () => {
        const client = new ApiSessionClient('fake-token', session);
        client.sendClaudeSessionMessage(mainAssistant(124000));
        client.applyClaudeTurnResult(result('result-1'));

        expect(frames().map((frame: any) => [frame.seq, frame.used, frame.window])).toEqual([
            [1, 124000, null],
            [2, 124000, 200000],
        ]);
        // No fallback for a turn whose assistant usage was real: still exactly one usage-report,
        // and its tokens object has no new keys (the server sums every key it finds).
        expect(usageReports()).toHaveLength(1);
        expect(Object.keys(usageReports()[0][1].tokens).sort()).toEqual(['cache_creation', 'cache_read', 'input', 'output', 'total']);
        await client.close();
    });

    it('H2: a result that changes nothing resends the current snapshot under the same seq', async () => {
        const client = new ApiSessionClient('fake-token', session);
        client.sendClaudeSessionMessage(mainAssistant(1000));
        client.applyClaudeTurnResult(result('result-1'));
        client.sendClaudeSessionMessage(mainAssistant(1000));
        client.applyClaudeTurnResult(result('result-2'));
        // The SDK delivering the same result twice is still one turn.
        client.applyClaudeTurnResult(result('result-2'));

        expect(frames().map((frame: any) => frame.seq)).toEqual([1, 2, 2]);
        await client.close();
    });

    it('H3: a compaction boundary hides occupancy, and the next main response shows again from the cache', async () => {
        const client = new ApiSessionClient('fake-token', session);
        client.sendClaudeSessionMessage(mainAssistant(150000));
        client.applyClaudeTurnResult(result('result-1'));
        const epoch = frames()[0].epoch;

        client.noteContextUsageSignal({ kind: 'compact-boundary' });
        expect(frames().at(-1)).toMatchObject({ epoch, seq: 3, used: null, window: 200000 });

        client.sendClaudeSessionMessage(mainAssistant(20000));
        expect(frames().at(-1)).toMatchObject({ epoch, seq: 4, used: 20000, window: 200000 });
        await client.close();
    });

    it('H4: a reset drops every cached window under a new epoch until the new session reports its own', async () => {
        const client = new ApiSessionClient('fake-token', session);
        client.sendClaudeSessionMessage(mainAssistant(150000));
        client.applyClaudeTurnResult(result('result-1'));
        const before = frames()[0].epoch;

        client.resetContextUsage();
        const reset = frames().at(-1);
        expect(reset).toEqual({ version: 1, type: 'context-usage', epoch: expect.any(String), seq: 0, used: null, window: null, model: null });
        expect(reset.epoch).not.toBe(before);

        client.sendClaudeSessionMessage(mainAssistant(9000));
        expect(frames().at(-1)).toMatchObject({ epoch: reset.epoch, seq: 1, used: 9000, window: null });
        client.applyClaudeTurnResult(result('result-2'));
        expect(frames().at(-1)).toMatchObject({ epoch: reset.epoch, seq: 2, used: 9000, window: 200000 });
        await client.close();
    });

    it('H5: a socket reconnect resends the current snapshot under the same seq', async () => {
        const client = new ApiSessionClient('fake-token', session);
        fire('connect');
        expect(frames()).toEqual([]);

        client.sendClaudeSessionMessage(mainAssistant(1000));
        client.applyClaudeTurnResult(result('result-1'));
        fire('disconnect', 'transport close');
        fire('connect');

        expect(frames().map((frame: any) => [frame.seq, frame.window])).toEqual([[1, null], [2, 200000], [2, 200000]]);
        await client.close();
    });

    it('H6: resends every 30 seconds while something is shown, and stops on reset and close', async () => {
        vi.useFakeTimers();
        const client = new ApiSessionClient('fake-token', session);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(frames()).toEqual([]);

        client.sendClaudeSessionMessage(mainAssistant(1000));
        await vi.advanceTimersByTimeAsync(29_999);
        expect(frames()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(frames().map((frame: any) => frame.seq)).toEqual([1, 1]);

        // A compaction still leaves a hide to repair: keep resending it.
        client.noteContextUsageSignal({ kind: 'compact-boundary' });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(frames().slice(2).map((frame: any) => [frame.seq, frame.used])).toEqual([[2, null], [2, null]]);

        // The take-down itself is repeated on the next two ticks — a lost one would leave the old
        // numbers on screen — and then the timer stops.
        client.resetContextUsage();
        const takeDown = frames().at(-1);
        expect(takeDown).toMatchObject({ seq: 0, used: null, window: null, model: null });
        await vi.advanceTimersByTimeAsync(90_000);
        expect(frames().slice(-3)).toEqual([takeDown, takeDown, takeDown]);
        const afterRepeats = frames().length;
        await vi.advanceTimersByTimeAsync(90_000);
        expect(frames()).toHaveLength(afterRepeats);

        client.sendClaudeSessionMessage(mainAssistant(2000));
        await client.close();
        const afterClose = frames().length;
        await vi.advanceTimersByTimeAsync(90_000);
        expect(frames()).toHaveLength(afterClose);
    });

    it('skips ticks while disconnected and repairs a take-down lost in the gap on reconnect', async () => {
        vi.useFakeTimers();
        const client = new ApiSessionClient('fake-token', session);
        client.sendClaudeSessionMessage(mainAssistant(1000));
        socket.connected = false;
        fire('disconnect', 'transport close');
        // /clear while the socket is down: the take-down frame goes nowhere.
        client.resetContextUsage();
        const sent = frames().length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(frames()).toHaveLength(sent);

        socket.connected = true;
        fire('connect');
        expect(frames().at(-1)).toMatchObject({ seq: 0, used: null, window: null, model: null });
        // Still owed its two ticks, now that they can arrive.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(frames()).toHaveLength(sent + 3);
        await client.close();
    });

    it('hides for a switch to local without forgetting the windows of this conversation', async () => {
        const client = new ApiSessionClient('fake-token', session);
        client.sendClaudeSessionMessage(mainAssistant(1000));
        client.applyClaudeTurnResult(result('result-1'));
        client.hideContextUsage();
        expect(frames().at(-1)).toMatchObject({ used: null, window: null, model: null });

        client.sendClaudeSessionMessage(mainAssistant(2000));
        expect(frames().at(-1)).toMatchObject({ used: 2000, window: 200000 });
        await client.close();
    });

    it('keeps two sessions in one process apart: each frame carries its own sid and state', async () => {
        const other = { ...makeSession(), id: 'other-session-id', encryptionKey: new Uint8Array(32).fill(7) };
        const first = new ApiSessionClient('fake-token', session);
        const second = new ApiSessionClient('fake-token', other);
        first.sendClaudeSessionMessage(mainAssistant(1000));
        second.sendClaudeSessionMessage(mainAssistant(5000));
        second.resetContextUsage();
        first.applyClaudeTurnResult(result('result-1'));

        const bySession = socket.volatile.emit.mock.calls.map(([, payload]: [string, { sid: string; data: string }]) => {
            const key = payload.sid === other.id ? other.encryptionKey : session.encryptionKey;
            const frame = decrypt(key, 'legacy', decodeBase64(payload.data));
            return [payload.sid, frame.seq, frame.used, frame.window];
        });
        expect(bySession).toEqual([
            ['test-session-id', 1, 1000, null],
            ['other-session-id', 1, 5000, null],
            ['other-session-id', 0, null, null],
            ['test-session-id', 2, 1000, 200000],
        ]);
        await first.close();
        await second.close();
    });

    it('sends nothing for a local terminal session, which has no turn result to name a window', async () => {
        const client = new ApiSessionClient('fake-token', session);
        client.keepAlive(false, 'local');
        client.sendClaudeSessionMessage(mainAssistant(1000));
        client.noteContextUsageSignal({ kind: 'compact-boundary' });
        await client.sendClaudeSessionMessageFromLocalTranscript(mainAssistant(2000));

        expect(frames()).toEqual([]);
        expect(usageReports()).toHaveLength(2);
        await client.close();
    });
});
