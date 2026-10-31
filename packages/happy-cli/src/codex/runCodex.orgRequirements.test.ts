/**
 * Organization requirements at the Codex turn boundary (aplus-dev-studio-desktop
 * specs/codexcli-org-requirements R10.2, R10.9) — driven through the real consumer loop, with the
 * harness of runCodex.channelClear.test.ts. Only the network (the mcp-config answer), the process and
 * the provider are faked.
 *
 * (Original harness notes:) Channel input is never read as Codex session control — driven through the real consumer loop.
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
import { logger } from '@/ui/logger';
import { buildReconnectSessionEnvironment, RECONNECT_FRESH_LAUNCH_ENV } from '@/daemon/reconnectSessionEnv';
import type { Metadata } from '@/api/types';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '@/configuration';

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
vi.mock('@/memory/codexRecallHost', () => ({ prepareCodexRecallHost: vi.fn(async () => null) }));
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

/** The off-turn title runs a provider query of its own: which model it was handed. */
const titleRuns: { model?: string }[] = [];
vi.mock('./codexOffTurnTitle', async (importOriginal) => ({
    ...await importOriginal<typeof import('./codexOffTurnTitle')>(),
    isOffTurnTitleEligible: () => true,
    createCodexExecTitleRunner: () => async (input: { model?: string }) => { titleRuns.push({ model: input.model }); return null; },
}));
let titled = true;

/** What the fake app-server client did, so a scenario can assert on real effects. */
const clientLog: string[] = [];
let threadId: string | null = 'thread-before';
let onConnect: (() => Promise<void>) | null = null;
let turnsSent: { text: string; options?: Record<string, unknown> }[] = [];

vi.mock('@/codex/codexAppServerClient', () => ({
    CodexAppServerClient: class {
        setCuaShadow = () => {};
        setEventHandler = vi.fn();
        setApprovalHandler = vi.fn();
        setUserInputHandler = vi.fn();
        supportsGoalActions = () => false;
        get threadId() { return threadId; }
        hasActiveThread = () => threadId !== null;
        readThread = vi.fn(async () => ({ thread: { id: threadId ?? 'thread-x', turns: [] } }));
        async connect() { await onConnect?.(); }
        async resumeThread() { clientLog.push('resumeThread'); return { threadId, model: 'test-model' }; }
        async startThread() { threadId = 'thread-after'; clientLog.push('startThread'); return { threadId, model: 'test-model' }; }
        clearThreadState = vi.fn(() => { clientLog.push('clearThreadState'); threadId = null; });
        async sendTurnAndWait(input: unknown, options?: { beforeDispatch?: () => void; onDispatched?: () => void; onCompletionObservationSettled?: () => void }) {
            try {
                options?.beforeDispatch?.();
                options?.onDispatched?.();
                const text = typeof input === 'object' && input !== null && 'text' in input
                    ? String((input as { text: unknown }).text) : String(input);
                turnsSent.push({ text, options: options as Record<string, unknown> });
                clientLog.push('sendTurnAndWait');
                return { ok: true };
            } finally { options?.onCompletionObservationSettled?.(); }
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
        configureInputQueue: vi.fn(), setInputSteerAvailable: vi.fn(), setPendingInputEvidence: vi.fn(),
        queueInput: vi.fn(() => ({ ref: { kind: 'unidentified', runtimeInputId: 'test-input' } })),
        inputEvidence: { attempt: vi.fn(() => ({ settle: vi.fn() })), commitPending: vi.fn(() => true), cancelPendingDispatch: vi.fn(), cancelContinuation: vi.fn(), continuePending: vi.fn(), takeContinuation: vi.fn() },
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
        hasTitle: vi.fn(() => titled),
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

describe('the real Codex consumer loop under organization requirements', () => {
    beforeEach(() => {
        queues.length = 0; clientLog.length = 0; protocolMessages.length = 0; sessionEvents.length = 0;
        turnsSent = []; rpc.clear(); threadId = 'thread-before'; onConnect = null; titleRuns.length = 0; titled = true;
        sessionMetadata = { path: '/workspace/project', codexThreadId: 'thread-before' };
        vi.mocked(logger.warn).mockClear();
        // Each scenario starts with no last known good: they share the session id that maps to it.
        rmSync(join(configuration.happyHomeDir, 'org-requirements'), { recursive: true, force: true });
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
        expect(vi.mocked(logger.warn).mock.calls.filter(([message]) => message === 'Error in codex session:')
            .map(([, error]) => error instanceof Error ? error.stack : error)).toEqual([]);
        return { stub };
    }


    /** `null`: a Studio that does not serve requirements (no `requirementsStatus` in its answer). */
    function stubRequirements(items: Record<string, unknown> | null) {
        vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', 'http://studio.test/api/me/mcp-config');
        const realFetch = globalThis.fetch;
        const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
            // Only the config lookup is faked; anything else (a WebAssembly module load) is real.
            if (!String(url).startsWith('http://studio.test/')) return realFetch(url as never, init);
            return new Response(JSON.stringify(items === null ? { mcpServers: {} } : {
                mcpServers: {},
                requirementsStatus: 'ok',
                requirements: { schemaVersion: 1, companyId: 'c1', revision: 3, modelPolicyUpdatedAt: null, issuedAt: 1, items },
            }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }
    afterEach(() => { vi.unstubAllGlobals(); });

    const events = () => protocolMessages.map((m) => (m as { ev?: { t?: string; text?: string; status?: string } }).ev);

    it('refuses a turn on a model outside the set as a failed turn and runs the next one clipped to the ceiling', async () => {
        const fetchMock = stubRequirements({
            'permissions.mode': { kind: 'ceiling', max: 'default' },
            'ai.models': { kind: 'allowedSet', values: ['codex:gpt-6.1-sol'], default: 'codex:gpt-6.1-sol', source: 'organization' },
        });
        const { stub } = await run(async () => {
            const queue = queues[0]!;
            queue.pushIsolated('denied model', { permissionMode: 'yolo', model: 'gpt-5.5', orgModelOrigin: 'explicit' } as never);
            queue.pushIsolated('allowed model', { permissionMode: 'yolo', model: 'gpt-6.1-sol', orgModelOrigin: 'explicit' } as never);
            queue.close();
        });
        // The lookup asked for requirements on the response the session already fetches.
        const configCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith('http://studio.test/'));
        expect((configCall?.[1] as RequestInit).headers).toMatchObject({ 'x-aplus-requirements-version': '1' });
        expect(turnsSent.map((turn) => turn.text)).toEqual([expect.stringContaining('allowed model')]);
        // Clipped from yolo to default: Codex asks for untrusted commands.
        expect(turnsSent[0].options).toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'workspace-write', model: 'gpt-6.1-sol' });
        const refusal = events().findIndex((ev) => ev?.t === 'text' && ev.text?.includes('조직 정책이 허용하지 않는 모델'));
        expect(events().slice(refusal - 1, refusal + 2).map((ev) => ev?.t)).toEqual(['turn-start', 'text', 'turn-end']);
        expect(events()[refusal + 1]).toMatchObject({ t: 'turn-end', status: 'failed' });
        // Desktop learns what happened.
        const states = stub.updateAgentState.mock.calls.map(([update]) => (update as (state: Record<string, unknown>) => Record<string, unknown>)({}));
        expect(states.some((state) => (state.orgRequirements as { lastEnforcement?: { reason?: string } } | undefined)?.lastEnforcement?.reason === 'requirement_model_denied')).toBe(true);
    }, 60_000);

    it('runs an unchosen model on the allowed one and keeps a ceiling-free mode', async () => {
        stubRequirements({ 'ai.models': { kind: 'allowedSet', values: ['codex:gpt-6.1-sol'], default: null, source: 'organization' } });
        await run(async () => {
            const queue = queues[0]!;
            queue.pushIsolated('no model', { permissionMode: 'yolo' } as never);
            queue.close();
        });
        expect(turnsSent).toHaveLength(1);
        expect(turnsSent[0].options).toMatchObject({ model: 'gpt-6.1-sol', approvalPolicy: 'never' });
    }, 60_000);

    it('titles a new chat only on the model its checked turn runs, never on a refused or unchosen one', async () => {
        stubRequirements({ 'ai.models': { kind: 'allowedSet', values: ['codex:gpt-6.1-sol'], default: null, source: 'organization' } });
        titled = false;
        await run(async () => {
            const queue = queues[0]!;
            queue.pushIsolated('denied model', { permissionMode: 'yolo', model: 'gpt-5.5', orgModelOrigin: 'explicit' } as never);
            queue.pushIsolated('no model', { permissionMode: 'yolo' } as never);
            queue.close();
        });
        expect(turnsSent).toHaveLength(1);
        expect(titleRuns).toEqual([{ model: 'gpt-6.1-sol' }]);
    }, 60_000);

    it('runs a model the router picked outside the set on the allowed one instead of refusing the turn (R10.2a Auto)', async () => {
        stubRequirements({ 'ai.models': { kind: 'allowedSet', values: ['codex:gpt-6.1-sol'], default: null, source: 'organization' } });
        await run(async () => {
            const queue = queues[0]!;
            queue.pushIsolated('routed', { permissionMode: 'yolo', model: 'gpt-5.5', orgModelOrigin: 'auto' } as never);
            queue.close();
        });
        expect(turnsSent).toHaveLength(1);
        expect(turnsSent[0].options).toMatchObject({ model: 'gpt-6.1-sol' });
        expect(events().some((ev) => ev?.t === 'turn-end' && ev.status === 'failed')).toBe(false);
    }, 60_000);

    it('behaves exactly as before against a Studio that serves no requirements', async () => {
        stubRequirements(null);
        const { stub } = await run(async () => {
            const queue = queues[0]!;
            queue.pushIsolated('hello', { permissionMode: 'yolo', model: 'gpt-5.5' } as never);
            queue.close();
        });
        expect(turnsSent).toHaveLength(1);
        expect(turnsSent[0].options).toMatchObject({ model: 'gpt-5.5', approvalPolicy: 'never', sandbox: 'danger-full-access' });
        expect(events().some((ev) => ev?.t === 'turn-end' && ev.status === 'failed')).toBe(false);
        // R16: never received, so `unknown` (Desktop shows nothing for it) and nothing enforced.
        const states = stub.updateAgentState.mock.calls.map(([update]) => (update as (state: Record<string, unknown>) => Record<string, unknown>)({}));
        expect(states.filter((state) => 'orgRequirements' in state).map((state) => state.orgRequirements)).toEqual([{ state: 'unknown' }]);
    }, 60_000);

    it('behaves exactly as before when the organization releases everything', async () => {
        stubRequirements({});
        await run(async () => {
            const queue = queues[0]!;
            queue.pushIsolated('hello', { permissionMode: 'yolo', model: 'gpt-5.5' } as never);
            queue.close();
        });
        expect(turnsSent).toHaveLength(1);
        expect(turnsSent[0].options).toMatchObject({ model: 'gpt-5.5', approvalPolicy: 'never', sandbox: 'danger-full-access' });
        expect(events().some((ev) => ev?.t === 'turn-end' && ev.status === 'failed')).toBe(false);
    }, 60_000);
});
