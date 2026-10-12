/**
 * A turn that Codex ends with "Selected model is at capacity" is continued automatically —
 * driven through the real consumer loop and the real `MessageQueue2`, with only the
 * app-server client, the API and the process boundary faked (same harness as
 * runCodex.channelClear.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecSyncOptions } from 'node:child_process';
import { CODEX_CAPACITY_CONTINUE_PROMPT } from './codexCapacityRetry';

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
/** Real policy, shorter waits: the scenarios are about what is sent, not how long it waits. */
vi.mock('@/codex/codexCapacityRetry', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/codex/codexCapacityRetry')>(),
    CODEX_CAPACITY_RETRY_DELAYS_MS: [20, 20],
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

type Outcome = 'overloaded' | 'ok';
let script: { outcome: Outcome; after?: () => void | Promise<void> }[] = [];
let turnsSent: string[] = [];
let eventHandler: ((msg: unknown) => void) | null = null;

const OVERLOADED = {
    type: 'task_complete',
    status: 'failed',
    error: {
        message: 'Selected model is at capacity. Please try a different model.',
        codexErrorInfo: 'serverOverloaded',
        additionalDetails: null,
    },
};

vi.mock('@/codex/codexAppServerClient', () => ({
    CodexAppServerClient: class {
        setEventHandler = vi.fn((handler: (msg: unknown) => void) => { eventHandler = handler; });
        setApprovalHandler = vi.fn();
        supportsGoalActions = () => false;
        hasActiveThread = () => true;
        readThread = vi.fn(async () => ({ thread: { id: 'thread-1', turns: [] } }));
        async connect() { await onConnect?.(); }
        async resumeThread() { return { id: 'thread-1' }; }
        async startThread() { return { id: 'thread-1' }; }
        clearThreadState = vi.fn();
        async sendTurnAndWait(input: unknown) {
            turnsSent.push(String(input));
            const step = script.shift() ?? { outcome: 'ok' as const };
            eventHandler?.({ type: 'task_started', turn_id: `turn-${turnsSent.length}` });
            eventHandler?.(step.outcome === 'overloaded'
                ? { ...OVERLOADED, turn_id: `turn-${turnsSent.length}` }
                : { type: 'task_complete', status: 'completed', turn_id: `turn-${turnsSent.length}` });
            await step.after?.();
            return { aborted: false };
        }
        abortPreparedTurn = vi.fn();
        abortTurnWithFallback = vi.fn(async () => {});
        interruptTurn = vi.fn(async () => {});
        prepareProtectedTurn = vi.fn(() => ({ release: vi.fn() }));
        endInputAndAwaitExit = vi.fn(async () => {});
        reconnectAndResumeThread = vi.fn(async () => ({ id: 'thread-1' }));
        setGoal = vi.fn();
        clearGoal = vi.fn();
        disconnect = vi.fn(async () => {});
        dispose = vi.fn(async () => {});
    },
}));

let onConnect: (() => Promise<void>) | null = null;
const rpc = new Map<string, (params: unknown) => unknown>();
const sessionEvents: { message?: string }[] = [];
let sessionMetadata: Record<string, unknown> = { path: '/workspace/project', codexThreadId: 'thread-1' };

function sessionStub() {
    return {
        sessionId: 'sess-1',
        runtimeId: 'runtime-test',
        awaitMessageAck: vi.fn(async () => ({ ok: true })),
        sendSessionEvent: vi.fn((event: { message?: string }) => { sessionEvents.push(event); }),
        sendSessionProtocolMessage: vi.fn(),
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const closeQueue = () => { queues[0]!.close(); };

describe('automatic continuation after a capacity failure', () => {
    beforeEach(() => {
        queues.length = 0; sessionEvents.length = 0; rpc.clear(); turnsSent = []; script = []; eventHandler = null;
        sessionMetadata = { path: '/workspace/project', codexThreadId: 'thread-1' };
        // Run from inside a Saycode session, the runner would otherwise pick up that
        // session's own lesson host, reconnect target and sandbox settings, and never exit.
        for (const key of Object.keys(process.env)) {
            if (/^(HAPPY|SAYCODE|APLUS|CODEX)_/.test(key)) vi.stubEnv(key, undefined);
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
    }

    const continuations = () => turnsSent.filter(text => text.includes(CODEX_CAPACITY_CONTINUE_PROMPT));
    const notices = () => sessionEvents.filter(e => e.message?.includes('at capacity') && e.message.includes('continuing automatically'));

    it('continues the same thread once the overloaded turn has ended', async () => {
        script = [{ outcome: 'overloaded' }, { outcome: 'ok', after: closeQueue }];
        await run(async () => {
            queues[0]!.pushIsolated('fix the bug', { permissionMode: 'default' } as never);
        });

        expect(turnsSent).toHaveLength(2);
        expect(turnsSent[0]).toContain('fix the bug');
        expect(turnsSent[1]).toContain(CODEX_CAPACITY_CONTINUE_PROMPT);
        expect(notices()).toHaveLength(1);
    }, 60_000);

    it('gives up after the retry budget and leaves the failure to the user', async () => {
        script = [
            { outcome: 'overloaded' },
            { outcome: 'overloaded' },
            { outcome: 'overloaded', after: () => { setTimeout(closeQueue, 200); } },
        ];
        await run(async () => {
            queues[0]!.pushIsolated('fix the bug', { permissionMode: 'default' } as never);
        });

        expect(turnsSent).toHaveLength(3);
        expect(continuations()).toHaveLength(2);
        expect(notices()).toHaveLength(2);
    }, 60_000);

    it('does not continue on its own once the user has sent something new', async () => {
        script = [
            {
                outcome: 'overloaded',
                after: () => { queueMicrotask(() => queues[0]!.pushIsolated('try another approach', { permissionMode: 'default' } as never)); },
            },
            { outcome: 'ok', after: async () => { await sleep(100); setTimeout(closeQueue, 100); } },
        ];
        await run(async () => {
            queues[0]!.pushIsolated('fix the bug', { permissionMode: 'default' } as never);
        });

        expect(turnsSent).toHaveLength(2);
        expect(turnsSent[1]).toContain('try another approach');
        expect(continuations()).toHaveLength(0);
    }, 60_000);

    it('does not resume work the user stopped while it was waiting', async () => {
        script = [{
            outcome: 'overloaded',
            after: () => {
                setTimeout(() => { void rpc.get('abort')?.({}); }, 0);
                setTimeout(closeQueue, 200);
            },
        }];
        await run(async () => {
            queues[0]!.pushIsolated('fix the bug', { permissionMode: 'default' } as never);
        });

        expect(rpc.has('abort')).toBe(true);
        expect(notices()).toHaveLength(1);
        expect(continuations()).toHaveLength(0);
    }, 60_000);
});
