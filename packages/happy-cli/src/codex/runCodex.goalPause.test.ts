import { TurnInputEvidence } from '@/api/turnInputEvidence';
/**
 * Stopping a Codex conversation pauses its active goal (Codex would otherwise start the next goal turn on its own),
 * and the goal-action RPC can resume it. Driven through the real consumer loop with only the app-server client,
 * the API and the process boundary faked (same harness as runCodex.capacityRetry.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecSyncOptions } from 'node:child_process';

vi.mock('@/utils/broadKillShims', () => ({ installBroadKillShims: vi.fn() }));
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
/** The developer machine's own memory hook must not decide whether a turn is sent. */
vi.mock('@/memory/codexRecallHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/memory/codexRecallHost')>(),
    prepareCodexRecallHost: vi.fn(async () => null),
}));

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


let eventHandler: ((msg: unknown) => void) | null = null;
let goalActionsSupported = true;
const calls: string[] = [];
const setGoal = vi.fn(async (opts: { status?: string }) => { calls.push(`setGoal:${opts.status}`); return { goal: goalOf(opts.status ?? 'active') }; });
const goalOf = (status: string) => ({ threadId: 'thread-1', objective: 'ship it', status, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 });
let duringTurn: () => Promise<void> = async () => {};

vi.mock('@/codex/codexAppServerClient', () => ({ CodexAppServerClient: class {
    threadId = 'thread-1';
    setCuaShadow = () => {};
    setEventHandler = vi.fn((handler: (msg: unknown) => void) => { eventHandler = handler; });
    setApprovalHandler = vi.fn();
    setUserInputHandler = vi.fn();
    supportsGoalActions = () => goalActionsSupported;
    hasActiveThread = () => true;
    readThread = vi.fn(async () => ({ thread: { id: 'thread-1', turns: [] } }));
    async connect() { await onConnect?.(); }
    async resumeThread() { return { id: 'thread-1' }; }
    async startThread() { return { id: 'thread-1' }; }
    clearThreadState = vi.fn();
    async sendTurnAndWait() {
        eventHandler?.({ type: 'task_started', turn_id: 'turn-1' });
        await duringTurn();
        eventHandler?.({ type: 'task_complete', status: 'completed', turn_id: 'turn-1' });
        queues.at(-1)!.close();
        return { aborted: false };
    }
    abortPreparedTurn = vi.fn();
    abortTurnWithFallback = vi.fn(async () => { calls.push('interrupt'); return { forcedRestart: false }; });
    interruptTurn = vi.fn(async () => {});
    prepareProtectedTurn = vi.fn(() => ({ release: vi.fn() }));
    endInputAndAwaitExit = vi.fn(async () => {});
    reconnectAndResumeThread = vi.fn(async () => ({ id: 'thread-1' }));
    setGoal = setGoal;
    clearGoal = vi.fn();
    disconnect = vi.fn(async () => {});
    dispose = vi.fn(async () => {});
} }));

let onConnect: (() => Promise<void>) | null = null;
const rpc = new Map<string, (params: unknown) => unknown>();
const agentStates: Record<string, unknown>[] = [];
let sessionMetadata: Record<string, unknown> = { path: '/workspace/project', codexThreadId: 'thread-1' };

function sessionStub() {
    return {
        inputEvidence: new TurnInputEvidence('runtime-test', () => {}),
        configureInputQueue: vi.fn((queue: InstanceType<typeof import('@/utils/MessageQueue2').MessageQueue2>) => {
            queue.setInputValidator(() => true);
        }),
        setInputSteerAvailable: vi.fn(),
        setPendingInputEvidence: vi.fn(),
        queueInput: () => ({ ref: { kind: 'rest', serverMessageId: 'x', serverSeq: 1 } }),
        sessionId: 'sess-1',
        runtimeId: 'runtime-test',
        awaitMessageAck: vi.fn(async () => ({ ok: true })),
        sendSessionEvent: vi.fn(),
        sendSessionProtocolMessage: vi.fn(),
        sendStreamDelta: vi.fn(),
        sendProviderUsageEvent: vi.fn(),
        uploadLocalImageAttachmentEnvelope: vi.fn(),
        updateMetadata: vi.fn((fn: (m: Record<string, unknown>) => Record<string, unknown>) => { sessionMetadata = fn(sessionMetadata); }),
        getMetadata: vi.fn(() => sessionMetadata),
        updateAgentState: vi.fn((fn: (s: Record<string, unknown>) => Record<string, unknown>) => { agentStates.push(fn({})); }),
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

const lastGoal = () => ([...agentStates].reverse().find(state => state.agentGoalStatus)?.agentGoalStatus ?? null) as Record<string, unknown> | null;

describe('Codex goal pause and resume', () => {
    beforeEach(() => {
        queues.length = 0; rpc.clear(); calls.length = 0; agentStates.length = 0; eventHandler = null; goalActionsSupported = true;
        setGoal.mockClear(); duringTurn = async () => {};
        sessionMetadata = { path: '/workspace/project', codexThreadId: 'thread-1' };
        for (const key of Object.keys(process.env)) {
            if (key !== 'HAPPY_HOME_DIR' && /^(HAPPY|SAYCODE|APLUS|CODEX)_/.test(key)) vi.stubEnv(key, undefined);
        }
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    async function run() {
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
        onConnect = async () => { queues.at(-1)!.push('hello', { permissionMode: 'default' } as never); };
        try {
            await runCodex({ principal: { kind: 'account', credentials: { token: 't', secret: new Uint8Array(32) } as never } });
        } finally {
            createSpy.mockRestore();
            cwdSpy.mockRestore();
        }
    }
    const goalEvent = (status: string) => eventHandler?.({ type: 'thread_goal_updated', threadId: 'thread-1', goal: goalOf(status) });

    it('pauses an active goal before interrupting when the user stops the turn', async () => {
        duringTurn = async () => { goalEvent('active'); await rpc.get('abort')!({}); };
        await run();
        expect(calls).toEqual(['setGoal:paused', 'interrupt']);
        expect(setGoal).toHaveBeenCalledWith({ threadId: 'thread-1', status: 'paused' });
    }, 20_000);

    it('keeps the paused phase runtime-local for installed strict app schemas', async () => {
        duringTurn = async () => { goalEvent('active'); await rpc.get('abort')!({}); };
        await run();
        expect(lastGoal()).toMatchObject({ status: 'active', text: 'ship it', capabilities: { clear: true, edit: true } });
        expect(lastGoal()).not.toHaveProperty('phase');
        expect(lastGoal()?.capabilities).not.toHaveProperty('resume');
    }, 20_000);

    it.each(['paused', 'blocked', 'usageLimited'])('leaves a %s goal alone on stop', async phase => {
        duringTurn = async () => { goalEvent(phase); await rpc.get('abort')!({}); };
        await run();
        expect(setGoal).not.toHaveBeenCalled();
        expect(calls).toEqual(['interrupt']);
    }, 20_000);

    it('does not touch the goal when there is none, or when the Codex build has no goal actions', async () => {
        duringTurn = async () => { await rpc.get('abort')!({}); };
        await run();
        expect(setGoal).not.toHaveBeenCalled();
        goalActionsSupported = false; calls.length = 0;
        duringTurn = async () => { goalEvent('active'); await rpc.get('abort')!({}); };
        await run();
        expect(setGoal).not.toHaveBeenCalled();
    }, 20_000);

    it('still interrupts when pausing the goal fails', async () => {
        setGoal.mockRejectedValueOnce(new Error('goals feature is disabled'));
        duringTurn = async () => { goalEvent('active'); await rpc.get('abort')!({}); };
        await run();
        expect(calls).toEqual(['interrupt']);
    }, 20_000);

    it('interrupts within the stop deadline even when the goal pause never responds', async () => {
        let releasePause!: (value: { goal: ReturnType<typeof goalOf> }) => void;
        let interruptedAtDeadline = false;
        setGoal.mockImplementationOnce(() => new Promise(resolve => { releasePause = resolve; }));
        duringTurn = async () => {
            goalEvent('active');
            const stopping = rpc.get('abort')!({});
            try {
                await new Promise(resolve => setTimeout(resolve, 1500));
                interruptedAtDeadline = calls.includes('interrupt');
            } finally {
                releasePause({ goal: goalOf('paused') });
                await stopping;
            }
        };
        await run();
        expect(interruptedAtDeadline).toBe(true);
    }, 20_000);

    it('resumes a paused goal through goal-action without changing the objective', async () => {
        duringTurn = async () => {
            goalEvent('paused');
            await expect(rpc.get('goal-action')!({ action: 'resume' })).resolves.toEqual({ ok: true });
        };
        await run();
        expect(setGoal).toHaveBeenCalledWith({ threadId: 'thread-1', status: 'active' });
        expect(lastGoal()).toMatchObject({ status: 'active', text: 'ship it' });
    }, 20_000);

    it('does not let a late pause response overwrite a subsequent resume', async () => {
        let releasePause!: (value: { goal: ReturnType<typeof goalOf> }) => void;
        setGoal.mockImplementationOnce(() => new Promise(resolve => { releasePause = resolve; }));
        duringTurn = async () => {
            goalEvent('active');
            try {
                await rpc.get('abort')!({});
                await rpc.get('goal-action')!({ action: 'resume' });
            } finally {
                releasePause({ goal: goalOf('paused') });
            }
            await new Promise(resolve => setImmediate(resolve));
            await rpc.get('abort')!({});
        };
        await run();
        expect(setGoal.mock.calls.map(([params]) => params.status)).toEqual(['paused', 'active', 'paused']);
    }, 20_000);
});
