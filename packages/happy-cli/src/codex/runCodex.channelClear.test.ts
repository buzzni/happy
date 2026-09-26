/**
 * Channel input is never read as Codex session control — driven through the real consumer loop.
 *
 * `shouldHandleCodexClear` has its own unit tests, but nothing proved that `runCodex` *uses* it:
 * replacing the call with the ungated `isCodexClearText(message.message)` passed the entire suite.
 * That mutation lets an external sender wipe a session's Codex thread with seven characters, and
 * the daemon advertises `codex`, so the path is reachable today.
 *
 * So this drives the real runner: the real `MessageQueue2`, the real channel RPC handlers, the
 * real acceptance and approval, the real gate. Only the things that would reach the network, a
 * process, or a provider are faked (Saycode specs/desktop-messenger-channels — R1/R5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecSyncOptions } from 'node:child_process';

vi.mock('@/utils/broadKillShims', () => ({ installBroadKillShims: vi.fn() }));

/** Only that one command: a prefix would let any future `codex …` call be answered by a fake. */
vi.mock('node:child_process', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:child_process')>();
    const execSync = ((command: string, options?: ExecSyncOptions) => {
        if (command === 'codex --version') return 'codex-cli 0.140.0';
        return original.execSync(command, options);
    }) as typeof original.execSync;
    return { ...original, execSync };
});

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), debugLargeJson: vi.fn(), info: vi.fn(), infoDeveloper: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/daemon/controlClient', () => ({ notifyDaemonSessionStarted: vi.fn(async () => {}) }));
vi.mock('@/daemon/run', () => ({ initialMachineMetadata: {} }));
vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readSettings: vi.fn(async () => ({ machineId: 'machine-test' })),
}));
vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: vi.fn(async () => ({ url: 'http://127.0.0.1:1/', toolNames: [], stop: vi.fn(async () => {}) })),
}));

/** The real queue, with the instance the runner built handed back to the test. */
const queues: InstanceType<typeof import('@/utils/MessageQueue2').MessageQueue2>[] = [];
vi.mock('@/utils/MessageQueue2', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/utils/MessageQueue2')>();
    class Recorded<T> extends original.MessageQueue2<T> {
        constructor(...args: ConstructorParameters<typeof original.MessageQueue2<T>>) {
            super(...args);
            queues.push(this as never);
        }
    }
    return { ...original, MessageQueue2: Recorded };
});

/** What the fake app-server client did, so a scenario can assert on real effects. */
const clientLog: string[] = [];
let threadId: string | null = 'thread-before';
let onConnect: (() => Promise<void>) | null = null;
let turnsSent: { text: string }[] = [];

vi.mock('@/codex/codexAppServerClient', () => ({
    CodexAppServerClient: class {
        setEventHandler = vi.fn();
        setApprovalHandler = vi.fn();
        supportsGoalActions = () => false;
        hasActiveThread = () => threadId !== null;
        readThread = vi.fn(async () => ({ thread: { id: threadId ?? 'thread-x', turns: [] } }));
        async connect() { await onConnect?.(); }
        async resumeThread() { clientLog.push('resumeThread'); return { id: threadId }; }
        async startThread() { threadId = 'thread-after'; clientLog.push('startThread'); return { id: threadId }; }
        clearThreadState = vi.fn(() => { clientLog.push('clearThreadState'); threadId = null; });
        async sendTurnAndWait(input: unknown) {
            const text = typeof input === 'object' && input !== null && 'text' in input
                ? String((input as { text: unknown }).text) : String(input);
            turnsSent.push({ text });
            clientLog.push('sendTurnAndWait');
            return { ok: true };
        }
        abortPreparedTurn = vi.fn();
        abortTurnWithFallback = vi.fn(async () => {});
        interruptTurn = vi.fn(async () => {});
        prepareProtectedTurn = vi.fn(() => ({ release: vi.fn() }));
        endInputAndAwaitExit = vi.fn(async () => {});
        reconnectAndResumeThread = vi.fn(async () => ({ id: threadId }));
        setGoal = vi.fn();
        clearGoal = vi.fn();
        disconnect = vi.fn(async () => { clientLog.push('disconnect'); });
        dispose = vi.fn(async () => {});
    },
}));

const rpc = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
const protocolMessages: unknown[] = [];
const sessionEvents: unknown[] = [];
let sessionMetadata: Record<string, unknown> = { path: '/workspace/project', codexThreadId: 'thread-before' };

function sessionStub() {
    return {
        sessionId: 'sess-1',
        runtimeId: 'runtime-test',
        awaitMessageAck: vi.fn(async () => ({ ok: true })),
        sendSessionEvent: vi.fn((event: unknown) => { sessionEvents.push(event); }),
        sendSessionProtocolMessage: vi.fn((envelope: unknown) => {
            protocolMessages.push(envelope);
            // `channel-ready` is raised at the dispatch boundary, not at accept time. Core answers
            // it out of band, so the harness does too rather than trying to pre-answer it.
            const ev = (envelope as { ev?: { t?: string; requestId?: string; nonce?: string } }).ev;
            if (ev?.t === 'channel-ready' && ev.requestId && ev.nonce) {
                const { requestId, nonce } = ev;
                queueMicrotask(() => {
                    void rpc.get('channel-authorize')?.({
                        requestId, expectedRuntimeId: 'runtime-test', nonce, decision: 'allow',
                    });
                });
            }
        }),
        sendStreamDelta: vi.fn(),
        sendProviderUsageEvent: vi.fn(),
        uploadLocalImageAttachmentEnvelope: vi.fn(),
        updateMetadata: vi.fn((fn: (m: Record<string, unknown>) => Record<string, unknown>) => {
            sessionMetadata = fn(sessionMetadata);
        }),
        getMetadata: vi.fn(() => sessionMetadata),
        updateAgentState: vi.fn(),
        onUserMessage: vi.fn(),
        onFileEvent: vi.fn(),
        on: vi.fn(),
        hasTitle: vi.fn(() => true),
        skipExistingMessages: vi.fn(),
        capRuntimeProcessedSeq: vi.fn(),
        suppressNextArchiveSignal: vi.fn(),
        trackAttachmentDownload: vi.fn(),
        drainAttachmentsForUserMessage: vi.fn(async () => []),
        rpcHandlerManager: {
            registerHandler: vi.fn((name: string, handler: (params: unknown) => unknown) => { rpc.set(name, handler); }),
        },
        keepAlive: vi.fn(),
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
    };
}

describe('the real Codex consumer loop', () => {
    beforeEach(() => {
        queues.length = 0; clientLog.length = 0; protocolMessages.length = 0; sessionEvents.length = 0;
        turnsSent = []; rpc.clear(); threadId = 'thread-before'; onConnect = null;
        sessionMetadata = { path: '/workspace/project', codexThreadId: 'thread-before' };
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('HAPPY_RECONNECT_') || key.startsWith('HAPPY_FORK')
                || key.startsWith('HAPPY_INITIAL_') || key.startsWith('HAPPY_CREATED_BY')) delete process.env[key];
        }
    });
    afterEach(() => { vi.unstubAllEnvs(); });

    async function run(seed: () => Promise<void>) {
        const { runCodex } = await import('@/codex/runCodex');
        const { ApiClient } = await import('@/api/api');
        const stub = sessionStub();
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace/project');
        const createSpy = vi.spyOn(ApiClient, 'create').mockResolvedValue({
            getOrCreateMachine: vi.fn(async () => ({ id: 'machine-test' })),
            getOrCreateSession: vi.fn(async () => ({
                id: 'sess-1', seq: 0, encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'dataKey', metadata: sessionMetadata, metadataVersion: 0,
                agentState: null, agentStateVersion: 0,
            })),
            sessionSyncClient: vi.fn(() => stub),
            push: vi.fn(() => ({ sendToAllDevices: vi.fn() })),
        } as never);
        onConnect = seed;
        try {
            await runCodex({ principal: { kind: 'account', credentials: { token: 't', secret: new Uint8Array(32) } as never } });
        } finally {
            createSpy.mockRestore();
            cwdSpy.mockRestore();
        }
        return { stub };
    }

    /**
     * Drive a channel turn through the *real* RPCs: accept it, then answer the approval the
     * runner asks for with the nonce it actually minted. Nothing here short-circuits
     * `prepareExecution`/`beginExecution` — the approval round is the real one.
     */
    /**
     * Accept a channel turn through the *real* RPC. The approval that follows is answered by the
     * session stub when the runner actually asks for it — at the dispatch boundary, which is the
     * only place `prepareExecution` runs. Nothing here short-circuits the approval round.
     */
    async function sendChannelTurn(text: string, requestId: string) {
        const accept = await rpc.get('channel-prompt')!({ text, requestId, expectedRuntimeId: 'runtime-test' });
        expect(accept, `channel-prompt refused ${requestId}`).toMatchObject({ ok: true, accepted: true });
    }

    /** The clear branch's own announcement — the effect nothing else in the loop produces. */
    function resetAnnouncements(): unknown[] {
        return sessionEvents.filter(e =>
            typeof e === 'object' && e !== null && (e as { message?: unknown }).message === 'Context was reset');
    }

    /** The approval actually happened, rather than the turn having skipped it. */
    function expectApproved(requestId: string) {
        const ready = protocolMessages
            .map(m => (m as { ev?: { t?: string; requestId?: string } }).ev)
            .filter(ev => ev?.t === 'channel-ready' && ev.requestId === requestId);
        expect(ready, `no channel-ready for ${requestId}`).toHaveLength(1);
    }

    /** Step A: the harness itself. Nothing below means anything if this cannot run one turn. */
    it('consumes one local message, takes a turn, and ends when the queue closes', async () => {
        await run(async () => {
            const queue = queues[0]!;
            queue.pushIsolated('hello', { permissionMode: 'default' } as never);
            queue.close();
        });

        expect(turnsSent).toHaveLength(1);
        expect(clientLog).toContain('sendTurnAndWait');
    }, 60_000);

    /**
     * S1 — the property the whole contract exists for. A channel `/clear` is ordinary text to
     * Codex: it must reach the provider as a turn and must not reset anything.
     */
    it('does not let a channel /clear reset the Codex thread', async () => {
        await run(async () => {
            await sendChannelTurn('/clear', 'req-clear');
            queues[0]!.close();
        });

        expectApproved('req-clear');
        // The reset itself, and the durable record of it. `startThread` is not part of the
        // judgement: this harness's client starts one for an ordinary turn too, and asserting on
        // it would be asserting on the fake rather than on the reset.
        expect(clientLog).not.toContain('clearThreadState');
        expect(resetAnnouncements()).toEqual([]);
        // And it was not silently dropped either — it ran as a turn.
        expect(turnsSent).toHaveLength(1);
    }, 60_000);

    /**
     * S2 — the control. "clearThreadState was not called" means nothing unless a local `/clear`
     * does call it through this same harness.
     */
    it('still lets a local /clear reset the Codex thread', async () => {
        await run(async () => {
            const queue = queues[0]!;
            queue.pushIsolated('/clear', { permissionMode: 'default' } as never);
            queue.close();
        });

        expect(clientLog).toContain('clearThreadState');
        expect(resetAnnouncements()).toHaveLength(1);
        expect(sessionMetadata.codexThreadId).toBeUndefined();
        // A reset takes no turn.
        expect(turnsSent).toHaveLength(0);
    }, 60_000);

    /**
     * S3 — the isolation holds once the session is already in use, and the id does not leak into
     * the local turn that follows.
     */
    it('keeps the channel turn separate from the local turns around it', async () => {
        await run(async () => {
            const queue = queues[0]!;
            queue.pushIsolated('before', { permissionMode: 'default' } as never);
            await sendChannelTurn('/clear', 'req-mid');
            queue.pushIsolated('after', { permissionMode: 'default' } as never);
            queue.close();
        });

        expectApproved('req-mid');
        expect(clientLog).not.toContain('clearThreadState');
        expect(resetAnnouncements()).toEqual([]);
        expect(turnsSent.map(t => t.text.includes('before') || t.text.includes('after') || t.text.includes('/clear')))
            .toEqual([true, true, true]);
        expect(turnsSent).toHaveLength(3);
    }, 60_000);

    /**
     * S4 — the same shape locally, as the other half of the control. A local reset in the middle
     * really does reset, and the turns on either side still run.
     */
    it('resets in the middle of local turns and starts a new thread', async () => {
        await run(async () => {
            const queue = queues[0]!;
            queue.pushIsolated('before', { permissionMode: 'default' } as never);
            queue.pushIsolated('/clear', { permissionMode: 'default' } as never);
            queue.pushIsolated('after', { permissionMode: 'default' } as never);
            queue.close();
        });

        expect(clientLog).toContain('clearThreadState');
        expect(resetAnnouncements()).toHaveLength(1);
        // The reset takes no turn of its own, so only the two ordinary ones run.
        expect(turnsSent).toHaveLength(2);
        // And the run kept going after it rather than ending on the reset.
        expect(clientLog.filter(c => c === 'startThread').length).toBeGreaterThanOrEqual(1);
    }, 60_000);
});
