import { TurnInputEvidence, type EvidenceBatch } from '@/api/turnInputEvidence';
import type { SessionEnvelope } from '@slopus/happy-wire';
import type { UserMessage } from '@/api/types';
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
const reportCapacityFailure = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/codex/reportAgentTaskCapacityFailure', () => ({ reportAgentTaskCapacityFailure: reportCapacityFailure }));
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

const protocolMessages: SessionEnvelope[] = [];
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
        setCuaShadow = () => {};
        setEventHandler = vi.fn((handler: (msg: unknown) => void) => { eventHandler = handler; });
        setApprovalHandler = vi.fn();
        setUserInputHandler = vi.fn();
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
            if (step.outcome === 'ok') eventHandler?.({ type: 'agent_message', phase: 'final_answer', message: 'fixed', turn_id: `turn-${turnsSent.length}` });
            eventHandler?.(step.outcome === 'overloaded'
                ? { ...OVERLOADED, turn_id: `turn-${turnsSent.length}` }
                : { type: 'task_complete', status: 'completed', turn_id: `turn-${turnsSent.length}` });
            await step.after?.();
            return { aborted: false };
        }
        abortPreparedTurn = vi.fn();
        abortTurnWithFallback = vi.fn(async () => ({ forcedRestart: false }));
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
let onUserMessage: ((message: { content: { type: 'text'; text: string } }) => unknown) | null = null;
const rpc = new Map<string, (params: unknown) => unknown>();
const sessionEvents: { message?: string }[] = [];
let sessionMetadata: Record<string, unknown> = { path: '/workspace/project', codexThreadId: 'thread-1' };

function sessionStub() {
    const evidence = new TurnInputEvidence('runtime-test', envelope => protocolMessages.push(envelope));
    return {
        inputEvidence: evidence,
        configureInputQueue: (queue: InstanceType<typeof import('@/utils/MessageQueue2').MessageQueue2>) => {
            queue.setInputValidator(input => !input.continuation || evidence.isContinuationCurrent(input.continuation));
        },
        setInputSteerAvailable: vi.fn(),
        setPendingInputEvidence: (batch: EvidenceBatch | null) => evidence.setPending(batch),
        queueInput: (message: UserMessage) => ({ ref: { kind: 'rest', serverMessageId: message.serverMessageId ?? 'test-input', serverSeq: message.serverSeq ?? 1 } }),
        sessionId: 'sess-1',
        runtimeId: 'runtime-test',
        awaitMessageAck: vi.fn(async () => ({ ok: true })),
        sendSessionEvent: vi.fn((event: { message?: string }) => { sessionEvents.push(event); }),
        sendSessionProtocolMessage: vi.fn((envelope: typeof protocolMessages[number]) => {
            protocolMessages.push(evidence.stamp(envelope));
            const ev = envelope.ev;
            if (ev?.t === 'channel-ready') queueMicrotask(() => {
                void rpc.get('channel-authorize')?.({ requestId: ev.requestId, expectedRuntimeId: 'runtime-test', nonce: ev.nonce, decision: 'allow' });
            });
        }),
        sendStreamDelta: vi.fn(),
        sendProviderUsageEvent: vi.fn(),
        uploadLocalImageAttachmentEnvelope: vi.fn(),
        updateMetadata: vi.fn((fn: (m: Record<string, unknown>) => Record<string, unknown>) => {
            sessionMetadata = fn(sessionMetadata);
        }),
        getMetadata: vi.fn(() => sessionMetadata),
        updateAgentState: vi.fn(),
        onUserMessage: vi.fn((handler: NonNullable<typeof onUserMessage>) => { onUserMessage = handler; }),
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
let getOrCreateSession: ReturnType<typeof vi.fn>;
const closeQueue = () => { queues[0]!.close(); };

describe('automatic continuation after a capacity failure', () => {
    beforeEach(() => {
        protocolMessages.length = 0; queues.length = 0; sessionEvents.length = 0; rpc.clear(); turnsSent = []; script = []; eventHandler = null; onUserMessage = null; reportCapacityFailure.mockClear();
        sessionMetadata = { path: '/workspace/project', codexThreadId: 'thread-1' };
        // Run from inside a Saycode session, the runner would otherwise pick up that
        // session's own lesson host, reconnect target and sandbox settings, and never exit.
        for (const key of Object.keys(process.env)) {
            if (key !== 'HAPPY_HOME_DIR' && /^(HAPPY|SAYCODE|APLUS|CODEX)_/.test(key)) vi.stubEnv(key, undefined);
        }
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    async function run(seed: () => Promise<void>) {
        const { runCodex } = await import('@/codex/runCodex');
        const { ApiClient } = await import('@/api/api');
        const stub = sessionStub();
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace/project');
        getOrCreateSession = vi.fn(async () => ({
            id: 'sess-1', seq: 0, encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'dataKey', metadata: sessionMetadata, metadataVersion: 0,
            agentState: null, agentStateVersion: 0,
        }));
        const createSpy = vi.spyOn(ApiClient, 'create').mockResolvedValue({
            getOrCreateMachine: vi.fn(async () => ({ id: 'machine-test' })),
            getOrCreateSession,
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
            queues[0]!.pushIsolated('fix the bug', { permissionMode: 'default' } as never, undefined, undefined, undefined, undefined,
                { ref: { kind: 'rest', serverMessageId: 'original-input', serverSeq: 1 } });
        });

        expect(turnsSent).toHaveLength(2);
        expect(turnsSent[0]).toContain('fix the bug');
        expect(turnsSent[1]).toContain(CODEX_CAPACITY_CONTINUE_PROMPT);
        expect(notices()).toHaveLength(1);
        const ends = protocolMessages.filter(event => event.ev.t === 'turn-end');
        expect(ends[0].ev).toMatchObject({ inputEvidence: { terminal: false,
            continuation: { kind: 'codex-capacity', state: 'pending' } } });
        expect(ends[1].ev).toMatchObject({ inputEvidence: { inputCount: 1,
            inputs: [{ kind: 'rest', serverMessageId: 'original-input', serverSeq: 1 }],
            terminal: true, continuation: { kind: 'codex-capacity', state: 'completed' } } });
    }, 60_000);

    it('gives up after the retry budget and leaves the failure to the user', async () => {
        script = [
            { outcome: 'overloaded' },
            { outcome: 'overloaded' },
            { outcome: 'overloaded', after: () => { setTimeout(closeQueue, 200); } },
        ];
        await run(async () => {
            queues[0]!.pushIsolated('fix the bug', { permissionMode: 'default' } as never, undefined, undefined, undefined, undefined,
                { ref: { kind: 'rest', serverMessageId: 'original-input', serverSeq: 1 } });
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
            queues[0]!.pushIsolated('fix the bug', { permissionMode: 'default' } as never, undefined, undefined, undefined, undefined,
                { ref: { kind: 'rest', serverMessageId: 'original-input', serverSeq: 1 } });
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
            queues[0]!.pushIsolated('fix the bug', { permissionMode: 'default' } as never, undefined, undefined, undefined, undefined,
                { ref: { kind: 'rest', serverMessageId: 'original-input', serverSeq: 1 } });
        });

        expect(rpc.has('abort')).toBe(true);
        expect(notices()).toHaveLength(1);
        expect(continuations()).toHaveLength(0);
    }, 60_000);
    it('does not resume work stopped between terminal notification and cleanup completion', async () => {
        script = [{
            outcome: 'overloaded',
            after: async () => {
                await rpc.get('abort')?.({});
                setTimeout(closeQueue, 150);
            },
        }];
        await run(async () => {
            queues[0]!.pushIsolated('fix the bug', { permissionMode: 'default' } as never, undefined, undefined, undefined, undefined,
                { ref: { kind: 'rest', serverMessageId: 'original-input', serverSeq: 1 } });
        });
        expect(continuations()).toHaveLength(0);
        expect(notices()).toHaveLength(0);
    }, 60_000);

    it('leaves a failed channel request terminal without an uncorrelated continuation', async () => {
        script = [{ outcome: 'overloaded', after: () => { setTimeout(closeQueue, 150); } }];
        await run(async () => {
            const accepted = await rpc.get('channel-prompt')?.({ text: 'fix the bug', requestId: 'request-1', expectedRuntimeId: 'runtime-test' });
            expect(accepted).toMatchObject({ ok: true, accepted: true });
        });
        expect(protocolMessages.filter(e => e.ev?.t === 'channel-ready')).toHaveLength(1);
        expect(protocolMessages.filter(e => e.ev?.t === 'turn-end')).toContainEqual(expect.objectContaining({ ev: expect.objectContaining({ requestId: 'request-1', status: 'failed' }) }));
        expect(continuations()).toHaveLength(0);
        expect(notices()).toHaveLength(0);
        expect(turnsSent).toHaveLength(1);
    }, 60_000);

    it('still delivers a correlated final answer for a successful channel request', async () => {
        script = [{ outcome: 'ok', after: closeQueue }];
        await run(async () => {
            const accepted = await rpc.get('channel-prompt')?.({ text: 'fix the bug', requestId: 'request-control', expectedRuntimeId: 'runtime-test' });
            expect(accepted).toMatchObject({ ok: true, accepted: true });
        });
        expect(protocolMessages.filter(e => e.ev?.t === 'final-answer')).toContainEqual(expect.objectContaining({ ev: expect.objectContaining({ requestId: 'request-control', text: 'fixed' }) }));
        expect(turnsSent).toHaveLength(1);
    }, 60_000);

    it('removes a continuation when Stop arrives immediately after enqueue', async () => {
        script = [{ outcome: 'overloaded' }];
        let queued = false;
        await run(async () => {
            const queue = queues[0]!;
            const unshift = queue.unshiftIsolated.bind(queue);
            vi.spyOn(queue, 'unshiftIsolated').mockImplementation((...args) => {
                unshift(...args);
                queued = true;
                void rpc.get('abort')?.({});
                setTimeout(closeQueue, 150);
            });
            queue.pushIsolated('fix the bug', { permissionMode: 'default' } as never);
        });
        expect(queued).toBe(true);
        expect(continuations()).toHaveLength(0);
    }, 60_000);

    it('does not dispatch a continuation stopped after dequeue', async () => {
        script = [{ outcome: 'overloaded' }];
        let collected = false;
        await run(async () => {
            const queue = queues[0]!;
            const collect = queue.waitForMessagesAndGetAsString.bind(queue);
            vi.spyOn(queue, 'waitForMessagesAndGetAsString').mockImplementation(async (...args) => {
                const batch = await collect(...args);
                if (batch?.message === CODEX_CAPACITY_CONTINUE_PROMPT) {
                    collected = true;
                    await rpc.get('abort')?.({});
                    setTimeout(closeQueue, 150);
                }
                return batch;
            });
            queue.pushIsolated('fix the bug', { permissionMode: 'default' } as never);
        });
        expect(collected).toBe(true);
        expect(continuations()).toHaveLength(0);
    }, 60_000);

    it('lets accepted user input replace an already dequeued continuation', async () => {
        script = [{ outcome: 'overloaded' }, { outcome: 'ok', after: closeQueue }];
        let collected = false;
        await run(async () => {
            const queue = queues[0]!;
            const collect = queue.waitForMessagesAndGetAsString.bind(queue);
            vi.spyOn(queue, 'waitForMessagesAndGetAsString').mockImplementation(async (...args) => {
                const batch = await collect(...args);
                if (batch?.message === CODEX_CAPACITY_CONTINUE_PROMPT) {
                    collected = true;
                    await onUserMessage!({ content: { type: 'text', text: 'try another approach' } });
                }
                return batch;
            });
            queue.pushIsolated('fix the bug', { permissionMode: 'default' } as never);
        });
        expect(collected).toBe(true);
        expect(turnsSent).toHaveLength(2);
        expect(turnsSent[1]).toContain('try another approach');
        expect(continuations()).toHaveLength(0);
    }, 60_000);

    describe('in an automation run-once session', () => {
        // The daemon's automation marker: the session exits after its turn instead of waiting for input.
        const runOnce = () => run(async () => {});
        beforeEach(() => {
            vi.stubEnv('HAPPY_AUTOMATION_RUN_ONCE', '1');
            vi.stubEnv('HAPPY_INITIAL_PROMPT', 'review the pull request');
        });

        // aplus-dev-studio specs/session-source-metadata — same contract as runClaude: recorded
        // once, and gone from this process's env so the session's own shell does not inherit it.
        it('records the daemon-supplied session source and removes it from the environment', async () => {
            vi.stubEnv('HAPPY_CREATED_BY_SOURCE', 'schedule');
            script = [{ outcome: 'ok' }];
            await runOnce();

            expect(getOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
                metadata: expect.objectContaining({ source: 'schedule' }),
            }));
            expect(process.env.HAPPY_CREATED_BY_SOURCE).toBeUndefined();
        }, 60_000);

        it('continues a turn that ended at capacity before exiting', async () => {
            script = [{ outcome: 'overloaded' }, { outcome: 'ok' }];
            await runOnce();

            expect(turnsSent).toHaveLength(2);
            expect(turnsSent[0]).toContain('review the pull request');
            expect(turnsSent[1]).toContain(CODEX_CAPACITY_CONTINUE_PROMPT);
            expect(notices()).toHaveLength(1);
        }, 60_000);

        it('exits once the retry budget is spent, telling the AgentTask server it can retry', async () => {
            script = [{ outcome: 'overloaded' }, { outcome: 'overloaded' }, { outcome: 'overloaded' }];
            await runOnce();

            expect(turnsSent).toHaveLength(3);
            expect(continuations()).toHaveLength(2);
            expect(reportCapacityFailure).toHaveBeenCalledTimes(1);
        }, 60_000);

        it('does not report a failure for a run that recovered', async () => {
            script = [{ outcome: 'overloaded' }, { outcome: 'ok' }];
            await run(async () => {});

            expect(reportCapacityFailure).not.toHaveBeenCalled();
        }, 60_000);

        it('exits without continuing when stopped while the continuation waits', async () => {
            script = [{ outcome: 'overloaded', after: () => { setTimeout(() => { void rpc.get('abort')?.({}); }, 0); } }];
            await runOnce();

            expect(notices()).toHaveLength(1);
            expect(continuations()).toHaveLength(0);
            expect(turnsSent).toHaveLength(1);
        }, 60_000);

        it('exits instead of idling when input that starts no turn replaces the continuation', async () => {
            // `/clear` cancels the continuation like any input, but resets the thread without a turn.
            script = [{ outcome: 'overloaded', after: () => { setTimeout(() => { void onUserMessage!({ content: { type: 'text', text: '/clear' } }); }, 0); } }];
            await runOnce();

            expect(notices()).toHaveLength(1);
            expect(continuations()).toHaveLength(0);
            expect(turnsSent).toHaveLength(1);
            expect(sessionEvents.some(e => e.message === 'Context was reset')).toBe(true);
        }, 60_000);

        it('exits without continuing when stopped after the continuation was dequeued', async () => {
            script = [{ outcome: 'overloaded' }];
            let collected = false;
            await run(async () => {
                const queue = queues[0]!;
                const collect = queue.waitForMessagesAndGetAsString.bind(queue);
                vi.spyOn(queue, 'waitForMessagesAndGetAsString').mockImplementation(async (...args) => {
                    const batch = await collect(...args);
                    if (batch?.message === CODEX_CAPACITY_CONTINUE_PROMPT) {
                        collected = true;
                        await rpc.get('abort')?.({});
                    }
                    return batch;
                });
            });

            expect(collected).toBe(true);
            expect(continuations()).toHaveLength(0);
        }, 60_000);

        it('exits when the continuation is skipped because late work reopened the turn', async () => {
            // Work Codex reports after turn/completed reopens the lifecycle while the continuation waits.
            script = [{
                outcome: 'overloaded',
                after: () => {
                    setTimeout(() => {
                        eventHandler?.({ type: 'task_started', turn_id: 'turn-1' });
                        setTimeout(() => { eventHandler?.({ type: 'task_complete', status: 'completed', turn_id: 'turn-1' }); }, 100);
                    }, 5);
                },
            }];
            const exited = runOnce().then(() => true);
            const settled = await Promise.race([exited, sleep(3_000).then(() => false)]);
            if (!settled) { closeQueue(); await exited; }

            expect(settled).toBe(true);
            expect(notices()).toHaveLength(1);
            expect(continuations()).toHaveLength(0);
            expect(turnsSent).toHaveLength(1);
        }, 60_000);
    });
});
