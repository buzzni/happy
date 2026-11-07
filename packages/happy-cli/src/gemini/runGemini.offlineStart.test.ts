/** A Gemini session started while the server was unreachable keeps answering the app after it reconnects. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getOrCreateSession: vi.fn(),
    sessionSyncClient: vi.fn(),
    startOfflineReconnection: vi.fn(),
    closeQueue: null as null | (() => void),
    backend: {
        prompts: [] as string[],
        cancelCalls: [] as string[],
        /** While set, the backend's session start waits for it, keeping the first turn in progress. */
        startGate: null as Promise<void> | null,
    },
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn(async () => ({
            getOrCreateMachine: vi.fn(async () => ({})),
            getVendorToken: vi.fn(async () => null),
            getOrCreateSession: mocks.getOrCreateSession,
            sessionSyncClient: mocks.sessionSyncClient,
            push: () => ({ sendSessionNotification: vi.fn() }),
        })),
    },
}));
vi.mock('@/persistence', async (original) => ({
    ...await original<typeof import('@/persistence')>(),
    readSettings: vi.fn(async () => ({ machineId: 'machine-1' })),
}));
vi.mock('@/daemon/run', () => ({ initialMachineMetadata: {} }));
vi.mock('@/daemon/controlClient', () => ({ notifyDaemonSessionStarted: vi.fn(async () => ({})) }));
vi.mock('@/utils/broadKillShims', () => ({ installBroadKillShims: vi.fn() }));
vi.mock('@/utils/serverConnectionErrors', () => ({
    connectionState: { setBackend: vi.fn() },
    startOfflineReconnection: mocks.startOfflineReconnection,
}));
vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: vi.fn(async () => ({ url: 'http://127.0.0.1:1', bridgeEnv: {}, stop: vi.fn() })),
}));
vi.mock('@/aplus/fetchAplusMcpServers', () => ({ fetchAplusMcpServers: vi.fn(async () => ({})) }));
vi.mock('@/orgRequirements/sessionGate', () => ({
    createSessionOrgRequirementsGate: vi.fn(() => null),
    createLiteRuntimeTurnGate: vi.fn(() => async () => ({ kind: 'run' })),
}));
vi.mock('@/gemini/utils/config', () => ({
    readGeminiLocalConfig: () => ({}),
    saveGeminiModelToConfig: vi.fn(),
    getInitialGeminiModel: () => undefined,
}));
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), debugLargeJson: vi.fn(), warn: vi.fn(), info: vi.fn(), getLogPath: () => '' },
}));
vi.mock('@/utils/MessageQueue2', async (original) => {
    const actual = await original<typeof import('@/utils/MessageQueue2')>();
    return { ...actual, MessageQueue2: class<T> extends actual.MessageQueue2<T> {
        constructor(hash: (mode: T) => string) { super(hash); mocks.closeQueue = () => this.close(); }
    } };
});
vi.mock('@/agent/factories/gemini', () => ({
    createGeminiBackend: vi.fn(() => ({
        backend: {
            onMessage: vi.fn(),
            startSession: async () => {
                await mocks.backend.startGate;
                return { sessionId: 'acp-session-1' };
            },
            sendPrompt: async (_sessionId: string, prompt: string) => { mocks.backend.prompts.push(prompt); },
            cancel: async (sessionId: string) => { mocks.backend.cancelCalls.push(sessionId); },
            dispose: async () => {},
        },
        model: 'gemini-test',
        modelSource: 'default',
    })),
}));

import { runGemini } from './runGemini';

/** The real session's surface the runner touches, keeping registrations so the test can deliver through it. */
function makeRealSession() {
    const rpc = new Map<string, (params?: unknown) => unknown>();
    let userMessage: ((message: unknown) => void) | null = null;
    return {
        sessionId: 'real-session',
        on: vi.fn(),
        onUserMessage: vi.fn((handler: (message: unknown) => void) => { userMessage = handler; }),
        onFileEvent: vi.fn(),
        configureInputQueue: vi.fn(),
        queueInput: vi.fn(() => undefined),
        getMetadata: vi.fn(() => null),
        hasTitle: vi.fn(() => true),
        keepAlive: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        sendSessionProtocolMessage: vi.fn(),
        updateAgentState: vi.fn(),
        updateMetadata: vi.fn(),
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        rpcHandlerManager: {
            registerHandler: vi.fn((method: string, handler: (params?: unknown) => unknown) => { rpc.set(method, handler); }),
        },
        deliver: (text: string) => userMessage?.({ role: 'user', content: { type: 'text', text } }),
        call: async (method: string) => rpc.get(method)?.(),
    };
}

describe('runGemini offline start', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.backend.prompts = [];
        mocks.backend.cancelCalls = [];
        mocks.backend.startGate = null;
        mocks.closeQueue = null;
        mocks.startOfflineReconnection.mockReturnValue({ cancel: vi.fn(), getSession: () => null, isReconnected: () => false });
    });

    it('answers app messages, abort and kill on the real session after reconnecting', async () => {
        const realSession = makeRealSession();
        mocks.getOrCreateSession.mockResolvedValueOnce(null).mockResolvedValue({ id: 'real-session' });
        mocks.sessionSyncClient.mockReturnValue(realSession);
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        const { logger } = await import('@/ui/logger');

        const running = runGemini({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } } });
        await vi.waitFor(() => expect(vi.mocked(logger.debug).mock.calls.some(([line]) => String(line).includes('waiting for messages'))).toBe(true));
        expect(realSession.onUserMessage).not.toHaveBeenCalled();

        const { onReconnected } = mocks.startOfflineReconnection.mock.calls[0][0];
        await onReconnected();
        // The swap still re-attaches the input queue and the archive listener (R4-d).
        expect(realSession.configureInputQueue).toHaveBeenCalledWith(expect.anything(), 'remote', false);
        expect(realSession.on).toHaveBeenCalledWith('archived', expect.any(Function));

        realSession.deliver('After reconnect');
        await vi.waitFor(() => expect(mocks.backend.prompts.some((prompt) => prompt.includes('After reconnect'))).toBe(true));

        await realSession.call('abort');
        expect(mocks.backend.cancelCalls).toEqual(['acp-session-1']);

        await realSession.call('killSession');
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
        expect(realSession.sendSessionDeath).toHaveBeenCalled();
        // process.exit is stubbed, so let the loop end on its own.
        mocks.closeQueue?.();
        await running;
        exit.mockRestore();
    }, 20_000);

    it('takes a message that arrives while the swap waits for the running turn, and sends it next', async () => {
        const realSession = makeRealSession();
        mocks.getOrCreateSession.mockResolvedValueOnce(null).mockResolvedValue({ id: 'real-session' });
        mocks.sessionSyncClient.mockReturnValue(realSession);
        let releaseStart!: () => void;
        mocks.backend.startGate = new Promise((resolve) => { releaseStart = resolve; });
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'Offline first');
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        const { createGeminiBackend } = await import('@/agent/factories/gemini');

        const running = runGemini({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } } });
        await vi.waitFor(() => expect(createGeminiBackend).toHaveBeenCalled());
        const { onReconnected } = mocks.startOfflineReconnection.mock.calls[0][0];
        await onReconnected();
        // Gemini defers the swap until the turn ends, so the runner still holds the stub here.
        expect(realSession.configureInputQueue).not.toHaveBeenCalled();

        expect(() => realSession.deliver('Arrived mid-turn')).not.toThrow();
        releaseStart();
        await vi.waitFor(() => expect(mocks.backend.prompts.some((prompt) => prompt.includes('Arrived mid-turn'))).toBe(true));
        expect(realSession.configureInputQueue).toHaveBeenCalledWith(expect.anything(), 'remote', false);

        await realSession.call('killSession');
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
        mocks.closeQueue?.();
        await running;
        exit.mockRestore();
        vi.unstubAllEnvs();
    }, 20_000);

    it('records a kill that arrives while the swap waits for the running turn on the real session', async () => {
        const realSession = makeRealSession();
        mocks.getOrCreateSession.mockResolvedValueOnce(null).mockResolvedValue({ id: 'real-session' });
        mocks.sessionSyncClient.mockReturnValue(realSession);
        let releaseStart!: () => void;
        mocks.backend.startGate = new Promise((resolve) => { releaseStart = resolve; });
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'Offline first');
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        const { createGeminiBackend } = await import('@/agent/factories/gemini');

        const running = runGemini({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } } });
        await vi.waitFor(() => expect(createGeminiBackend).toHaveBeenCalled());
        const { onReconnected } = mocks.startOfflineReconnection.mock.calls[0][0];
        await onReconnected();

        await realSession.call('killSession');
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
        expect(realSession.updateMetadata).toHaveBeenCalled();
        expect(realSession.sendSessionDeath).toHaveBeenCalled();
        expect(realSession.close).toHaveBeenCalled();

        releaseStart();
        mocks.closeQueue?.();
        await running;
        exit.mockRestore();
        vi.unstubAllEnvs();
    }, 20_000);
});
