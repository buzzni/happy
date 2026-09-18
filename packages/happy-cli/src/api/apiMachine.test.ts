import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOMATION_PROTOCOL_VERSION } from '@slopus/happy-wire';
import { ApiMachineClient } from './apiMachine';
import { RECONNECT_DIAL_TIMEOUT_MS, RECONNECT_MAX_DELAY_MS, RECONNECT_NOT_READY_POLL_MS } from './reconnectCadence';
import { logger } from '@/ui/logger';
import type { Machine } from './types';

const {
    mockIo,
    mockShouldReconnect
} = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockShouldReconnect: vi.fn(() => true)
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'http://127.0.0.1:3005',
        currentCliVersion: 'test',
        happyHomeDir: '/tmp/happy-api-machine-test',
    }
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn()
}));

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
        registerHandler = vi.fn();
        unregisterHandler = vi.fn();
        hasHandler = vi.fn(() => false);
    }
}));

vi.mock('@/utils/detectCLI', () => ({
    detectCLIAvailability: vi.fn(() => ({
        claude: false,
        codex: false,
        gemini: false,
        openclaw: false
    }))
}));

vi.mock('@/resume/localHappyAgentAuth', () => ({
    detectResumeSupport: vi.fn(() => ({
        rpcAvailable: false,
        requiresSameMachine: false,
        requiresHappyAgentAuth: false,
        happyAgentAuthenticated: false
    }))
}));

vi.mock('@/utils/lidState', () => ({
    shouldReconnect: mockShouldReconnect
}));

type SocketHandler = (...args: any[]) => void;
type SocketHandlers = Record<string, SocketHandler[]>;

function makeMachine(): Machine {
    return {
        id: 'test-machine-id',
        metadata: {
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: 'test',
            homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib'
        },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy'
    };
}

describe('ApiMachineClient socket reconnection', () => {
    let socketHandlers: SocketHandlers;
    let mockSocket: any;

    const emitSocketEvent = (event: string, ...args: any[]) => {
        const handlers = socketHandlers[event] || [];
        handlers.forEach((handler) => handler(...args));
    };

    /** Supervisor lines saying a reconnect should have been running and was not. */
    const repairLogs = () => vi.mocked(logger.debug).mock.calls
        .filter(([message]) => typeof message === 'string' && message.includes('nothing retrying'));

    beforeEach(() => {
        vi.clearAllMocks();
        mockShouldReconnect.mockReturnValue(true);
        // specs/machine-socket-duplicate-registration/ — the dial cadence is
        // jittered. Pinning the source to its top of range makes each delay
        // exactly its nominal value, so these tests can assert on the clock.
        vi.spyOn(Math, 'random').mockReturnValue(1);
        socketHandlers = {};
        mockSocket = {
            connected: false,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: SocketHandler) => {
                if (!socketHandlers[event]) {
                    socketHandlers[event] = [];
                }
                socketHandlers[event].push(handler);
            }),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            close: vi.fn(),
            io: {
                on: vi.fn()
            }
        };

        mockIo.mockReturnValue(mockSocket);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('refuses terminal-open-fwd with TERMINAL_DISABLED under the trial lockdown policy', async () => {
        const previous = process.env.HAPPY_REMOTE_TERMINAL_POLICY;
        process.env.HAPPY_REMOTE_TERMINAL_POLICY = 'disabled';
        try {
            const client = new ApiMachineClient('fake-token', makeMachine());
            client.connect();
            const ack = vi.fn();
            emitSocketEvent('terminal-open-fwd', { sessionId: 'term-1', params: null }, ack);
            await vi.waitFor(() => expect(ack).toHaveBeenCalled());
            expect(ack).toHaveBeenCalledWith({ ok: false, error: 'TERMINAL_DISABLED' });
        } finally {
            if (previous === undefined) delete process.env.HAPPY_REMOTE_TERMINAL_POLICY;
            else process.env.HAPPY_REMOTE_TERMINAL_POLICY = previous;
        }
    });

    it('registers dependency reclaim on the authenticated machine RPC surface', () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        expect((client as any).rpcHandlerManager.registerHandler).toHaveBeenCalledWith(
            'worktree-dependencies:reclaim', expect.any(Function),
        );
    });

    it('registers the machine-scoped Claude session transfer RPC', () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const manager = (client as any).rpcHandlerManager;

        expect(manager.registerHandler).toHaveBeenCalledWith(
            'claude-session-transfer',
            expect.any(Function),
        );
    });

    it('registers the machine-scoped Codex thread transfer RPC', () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const manager = (client as any).rpcHandlerManager;

        expect(manager.registerHandler).toHaveBeenCalledWith(
            'codex-thread-transfer',
            expect.any(Function),
        );
    });

    it('registers the checkpoint daemon RPC surface', () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const manager = (client as any).rpcHandlerManager;
        const checkpoint = {
            status: vi.fn(),
            list: vi.fn(),
            preview: vi.fn(),
            execute: vi.fn(),
            cancel: vi.fn(),
            retry: vi.fn(),
            decision: vi.fn(),
            restart: vi.fn(),
        };

        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(() => ({ stopped: true as const })),
            requestShutdown: vi.fn(),
            portRegistry: {} as any,
            aiCredentialRuntime: {} as any,
            checkpoint,
        });

        for (const method of Object.keys(checkpoint) as Array<keyof typeof checkpoint>) {
            expect(manager.registerHandler).toHaveBeenCalledWith(
                `checkpoint:${method}`,
                checkpoint[method],
            );
        }
    });

    it('validates and forwards additional directories through the spawn RPC result', async () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const manager = (client as any).rpcHandlerManager;
        const spawnSession = vi.fn(async () => ({
            type: 'success' as const,
            sessionId: 'session-1',
            additionalDirectories: {
                version: 1 as const,
                accepted: ['/home/user/frontend'],
                skipped: { missing: 1 },
            },
        }));
        client.setRPCHandlers({
            spawnSession,
            stopSession: vi.fn(() => ({ stopped: true as const })),
            requestShutdown: vi.fn(),
            portRegistry: {} as any,
            aiCredentialRuntime: {
                capture: vi.fn(), apply: vi.fn(), status: vi.fn(), rotation: vi.fn(),
            } as any,
        });
        const spawnHandler = manager.registerHandler.mock.calls
            .find(([method]: [string]) => method === 'spawn-happy-session')?.[1];

        await expect(spawnHandler({
            directory: '/home/user/primary',
            agent: 'claude',
            additionalDirectories: ['/home/user/frontend'],
        })).resolves.toEqual({
            type: 'success',
            sessionId: 'session-1',
            additionalDirectories: {
                version: 1,
                accepted: ['/home/user/frontend'],
                skipped: { missing: 1 },
            },
        });
        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            additionalDirectories: ['/home/user/frontend'],
        }));
    });

    it('rejects malformed additional directories before spawning', async () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const manager = (client as any).rpcHandlerManager;
        const spawnSession = vi.fn();
        client.setRPCHandlers({
            spawnSession,
            stopSession: vi.fn(() => ({ stopped: true as const })),
            requestShutdown: vi.fn(),
            portRegistry: {} as any,
            aiCredentialRuntime: {
                capture: vi.fn(), apply: vi.fn(), status: vi.fn(), rotation: vi.fn(),
            } as any,
        });
        const spawnHandler = manager.registerHandler.mock.calls
            .find(([method]: [string]) => method === 'spawn-happy-session')?.[1];

        await expect(spawnHandler({
            directory: '/home/user/primary',
            agent: 'claude',
            additionalDirectories: ['relative/path'],
        })).rejects.toThrow('Additional directories')
        expect(spawnSession).not.toHaveBeenCalled();
    });

    it('retries after initial socket connection error', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        expect(mockIo).toHaveBeenCalledWith('ws://127.0.0.1:3005', expect.objectContaining({
            reconnection: false
        }));
        expect(mockSocket.connect).not.toHaveBeenCalled();

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

        await vi.advanceTimersByTimeAsync(1000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        /*
         * specs/machine-socket-duplicate-registration/ AC1 — that dial has not
         * come back yet, and the next tick must not stack a second one on top
         * of it. Overlapping dials are what left the server holding several
         * live sockets for one daemon.
         */
        await vi.advanceTimersByTimeAsync(2000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        // Once the dial resolves, the cadence carries on at its next tick.
        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));
        await vi.advanceTimersByTimeAsync(2000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(2);

        client.shutdown();
    });

    /*
     * The guard must not become a new way to never reconnect: socket.io
     * normally resolves a dial with `connect` or `connect_error`, but a
     * handshake that hangs fires neither. AC2.
     */
    it('dials again when a dial goes unanswered past its budget', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));
        await vi.advanceTimersByTimeAsync(1000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        // No connect, no connect_error — nothing at all comes back.
        await vi.advanceTimersByTimeAsync(RECONNECT_DIAL_TIMEOUT_MS + RECONNECT_MAX_DELAY_MS);
        expect(mockSocket.connect.mock.calls.length).toBeGreaterThan(1);

        client.shutdown();
    });

    /*
     * A machine that says it is not ready to dial — a closed lid, a laptop that
     * has not finished waking — is not a failed dial, so `reconnectAttempts`
     * never moves and the backoff cannot pace that branch. Rescheduling from
     * the backoff there re-asks `shouldReconnect()` every base delay for as
     * long as the machine stays shut, and the predicate is not free: on macOS
     * it shells out synchronously on the daemon's only thread.
     */
    it('polls the not-ready check on its own clock rather than at the base delay', async () => {
        vi.useFakeTimers();
        mockShouldReconnect.mockReturnValue(false);

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));
        mockShouldReconnect.mockClear();

        const window = 60_000;
        await vi.advanceTimersByTimeAsync(window);

        // Jitter is pinned to its top of range in beforeEach, so every delay is
        // its nominal value: one window at RECONNECT_NOT_READY_POLL_MS is ~20
        // looks, against ~60 if this branch reused reconnectDelayMs(0).
        const looks = mockShouldReconnect.mock.calls.length;
        const expected = window / RECONNECT_NOT_READY_POLL_MS;
        expect(looks).toBeLessThanOrEqual(expected + 1);
        // Not-ready must not end the cadence either — it still has to notice
        // the moment the machine becomes ready.
        expect(looks).toBeGreaterThanOrEqual(expected - 1);
        // And nothing was dialled while the machine said it was not ready.
        expect(mockSocket.connect).not.toHaveBeenCalled();

        client.shutdown();
    });

    /*
     * The reconnect paths above are edge-triggered: they only run because
     * `connect_error` or `disconnect` fired. A missed edge therefore leaves a
     * daemon that is alive, heartbeating to its local state file, and holding
     * no socket at all — with nothing anywhere that ever notices. That is the
     * shape of the incident these tests exist for, so they drive the socket
     * down without emitting any edge event and assert recovery anyway.
     */
    it('reconnects a socket that never came up, with no edge event to trigger it', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        // Deliberately no connect_error and no disconnect: nothing is
        // retrying, and before the supervisor's first look nothing can be.
        await vi.advanceTimersByTimeAsync(29_000);
        expect(mockSocket.connect).not.toHaveBeenCalled();

        // The tick lands and starts the ordinary cadence with its 1s first dial.
        await vi.advanceTimersByTimeAsync(2_000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        // Still single-flight: the recovered cadence is the same cadence.
        await vi.advanceTimersByTimeAsync(3_000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));
        await vi.advanceTimersByTimeAsync(2_000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(2);

        client.shutdown();
    });

    it('reports how long the machine socket has been down', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        await vi.advanceTimersByTimeAsync(90_000);

        expect(client.getConnectionHealth()).toEqual({
            connected: false,
            reconnecting: true,
            disconnectedForMs: 90_000
        });

        client.shutdown();
    });

    it('leaves a healthy socket alone', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();
        mockSocket.connected = true;

        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(mockSocket.connect).not.toHaveBeenCalled();
        expect(client.getConnectionHealth()).toEqual({
            connected: true,
            reconnecting: false,
            disconnectedForMs: null
        });

        client.shutdown();
    });

    /*
     * The supervisor's log line is the only evidence that an edge was missed,
     * so it has to stay rare enough to read as a defect. A server that is
     * simply down produces a retry cadence and no such line.
     */
    it('stays quiet while a retry is already in flight', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();
        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(repairLogs()).toHaveLength(0);

        client.shutdown();
    });

    it('reports the missed edge once, not on every tick', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        await vi.advanceTimersByTimeAsync(5 * 60_000);

        // Repaired on the first tick; every tick after it finds a live
        // retry cadence and says nothing.
        expect(repairLogs()).toHaveLength(1);

        client.shutdown();
    });

    it('stops supervising once the managed credential is gone', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();
        client.stopForExpiredCredential();

        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(mockSocket.connect).not.toHaveBeenCalled();
        // And it stops calling itself broken. A client that is deliberately
        // finished must go quiet, or its log drowns the machines that are
        // genuinely stuck.
        expect(repairLogs()).toHaveLength(0);
    });

    it('stops supervising after shutdown', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();
        client.shutdown();

        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(mockSocket.connect).not.toHaveBeenCalled();
    });

    it('publishes runtime activity on the encrypted daemon heartbeat', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'machine-update-state') {
                return { result: 'success', version: 1, daemonState: data.daemonState };
            }
            if (event === 'machine-update-metadata') {
                return { result: 'success', version: 1, metadata: data.metadata };
            }
            return { result: 'success' };
        });
        const machine = makeMachine();
        const client = new ApiMachineClient('fake-token', machine);
        client.setRuntimeActivityProvider(() => ({
            activeSessionCount: 2,
            activeAutomationCount: 1,
        }));
        client.connect();

        socketHandlers.connect![0]!();
        await vi.advanceTimersByTimeAsync(20_000);

        expect(machine.daemonState?.activity).toEqual({
            activeSessionCount: 2,
            activeAutomationCount: 1,
            reportedAt: 20_000,
        });
        client.shutdown();
    });

    it('publishes autonomous quality-gate capability on the first connection', async () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'machine-update-metadata') {
                return { result: 'success', version: 1, metadata: data.metadata };
            }
            if (event === 'machine-update-state') {
                return { result: 'success', version: 1, daemonState: data.daemonState };
            }
            return { result: 'success' };
        });
        const machine = makeMachine();
        const client = new ApiMachineClient('fake-token', machine);
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
            portRegistry: {} as any,
            aiCredentialRuntime: {} as any,
            autonomousQualityGate: {
                start: vi.fn(), status: vi.fn(), control: vi.fn(),
            },
        });
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(machine.metadata?.autonomousQualityGateSupport).toEqual({
            apiVersion: 1,
            rpcAvailable: true,
        }));

        client.shutdown();
    });

    it('clears stale autonomous quality-gate capability when RPC handlers are unavailable', async () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'machine-update-metadata') {
                return { result: 'success', version: 1, metadata: data.metadata };
            }
            if (event === 'machine-update-state') {
                return { result: 'success', version: 1, daemonState: data.daemonState };
            }
            return { result: 'success' };
        });
        const machine = makeMachine();
        machine.metadata = {
            ...machine.metadata,
            autonomousQualityGateSupport: { apiVersion: 1, rpcAvailable: true },
        };
        const client = new ApiMachineClient('fake-token', machine);
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(machine.metadata?.autonomousQualityGateSupport).toEqual({
            apiVersion: 1,
            rpcAvailable: false,
        }));

        client.shutdown();
    });

    it.each([undefined, 5])('registers the persistent automation key with the verified protocol %s', async (protocolVersion) => {
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'automation-key-register') return { ok: true, value: { keyVersion: 4 } };
            if (event === 'machine-update-metadata') {
                return { result: 'success', version: 1, metadata: data.metadata };
            }
            return { result: 'success' };
        });
        const client = new ApiMachineClient('fake-token', makeMachine());
        expect(client.shouldRunLegacyAutomationScheduler()).toBe(false);
        const persistVersion = vi.fn();
        (client as any).setAutomationKey({
            version: 1,
            publicKey: new Uint8Array(32).fill(7),
            secretKey: new Uint8Array(32).fill(8),
            registeredKeyVersion: 3,
        }, persistVersion, protocolVersion);
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(persistVersion).toHaveBeenCalledWith(4));
        expect(client.shouldRunLegacyAutomationScheduler()).toBe(false);
        expect(mockSocket.emitWithAck).toHaveBeenCalledWith('automation-key-register', {
            expectedKeyVersion: 3,
            publicKey: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
            protocolVersion: protocolVersion ?? AUTOMATION_PROTOCOL_VERSION,
        });
        expect(mockSocket.emitWithAck).toHaveBeenCalledWith('machine-update-metadata', expect.any(Object));
        client.shutdown();
    });

    it('opens the legacy scheduler only after an explicit feature-disabled response', async () => {
        mockSocket.emitWithAck.mockImplementation(async (event: string) => {
            if (event === 'automation-key-register') return { ok: false, error: 'feature-disabled' };
            return { result: 'success' };
        });
        const client = new ApiMachineClient('fake-token', makeMachine());
        (client as any).setAutomationKey({
            version: 1,
            publicKey: new Uint8Array(32).fill(7),
            secretKey: new Uint8Array(32).fill(8),
            registeredKeyVersion: 0,
        }, vi.fn());
        expect(client.shouldRunLegacyAutomationScheduler()).toBe(false);
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(client.shouldRunLegacyAutomationScheduler()).toBe(true));
        client.shutdown();
    });

    it('keeps legacy automation fail-closed for transient registration failures', async () => {
        mockSocket.emitWithAck.mockImplementation(async (event: string) => {
            if (event === 'automation-key-register') return { ok: false, error: 'temporary-unavailable' };
            return { result: 'success' };
        });
        const client = new ApiMachineClient('fake-token', makeMachine());
        (client as any).setAutomationKey({
            version: 1,
            publicKey: new Uint8Array(32).fill(7),
            secretKey: new Uint8Array(32).fill(8),
            registeredKeyVersion: 0,
        }, vi.fn());
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(mockSocket.emitWithAck).toHaveBeenCalledWith('automation-key-register', expect.any(Object)));
        expect(client.shouldRunLegacyAutomationScheduler()).toBe(false);
        client.shutdown();
    });

    it('syncs encrypted automation deltas after key registration and acknowledges only after cache apply', async () => {
        let cursor = 0n;
        const cache = {
            read: vi.fn(() => ({ cursor, serverTime: 0, automations: [], pendingAcknowledgements: [] })),
            applySync: vi.fn(() => {
                cursor = 1n;
                return { nextSeq: 1n, acknowledgements: [{ automationId: 'automation-1', revision: 1 }] };
            }),
            markAcknowledged: vi.fn(),
        };
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'automation-key-register') return { ok: true, value: { keyVersion: 1 } };
            if (event === 'automation-sync') return { ok: true, value: {
                serverTime: 10, nextSeq: '1', changes: [{ seq: '1' }],
            } };
            if (event === 'automation-sync-ack') return { ok: true, value: { acknowledged: 1 } };
            if (event === 'automation-claim') return { ok: true, value: { runId: 'run-1', claimToken: 'token' } };
            if (event === 'machine-update-metadata') return { result: 'success', version: 1, metadata: data.metadata };
            return { result: 'success' };
        });
        const client = new ApiMachineClient('fake-token', makeMachine());
        (client as any).setAutomationKey({
            version: 1,
            publicKey: new Uint8Array(32).fill(7),
            secretKey: new Uint8Array(32).fill(8),
            registeredKeyVersion: 1,
        }, vi.fn());
        (client as any).setServerAutomationCache(cache);
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(cache.markAcknowledged).toHaveBeenCalled());
        expect(mockSocket.emitWithAck).toHaveBeenCalledWith('automation-sync', { afterSeq: '0', limit: 500 });
        expect(cache.applySync.mock.invocationCallOrder[0]).toBeLessThan(cache.markAcknowledged.mock.invocationCallOrder[0]!);
        expect(mockSocket.emitWithAck).toHaveBeenCalledWith('automation-sync-ack', {
            items: [{ automationId: 'automation-1', revision: 1 }],
        });
        await expect((client as any).serverAutomationTransport().claim({
            automationId: 'automation-1', generation: 2, scheduledFor: 10,
        })).resolves.toEqual({ ok: true, value: { runId: 'run-1', claimToken: 'token' } });
        expect(mockSocket.emitWithAck).toHaveBeenCalledWith('automation-claim', {
            automationId: 'automation-1', generation: 2, scheduledFor: 10,
        });
        client.shutdown();
    });
});

describe('stop-session verifyExit contract', () => {
    const handlers = (overrides: Record<string, unknown> = {}) => ({
        spawnSession: vi.fn(),
        stopSession: vi.fn(() => ({ stopped: true as const })),
        requestShutdown: vi.fn(),
        portRegistry: {} as any,
        aiCredentialRuntime: {} as any,
        ...overrides,
    });

    const stopHandler = (client: ApiMachineClient) => (client as any).rpcHandlerManager
        .registerHandler.mock.calls.find(([method]: [string]) => method === 'stop-session')?.[1];

    it('answers a legacy request exactly as before, with no verification field', async () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const stopSessionWithExitVerification = vi.fn();
        client.setRPCHandlers(handlers({ stopSessionWithExitVerification }) as any);

        await expect(stopHandler(client)({ sessionId: 'session-1', source: 'project-delete' }))
            .resolves.toEqual({ message: 'Session stopped', stopped: true });
        expect(stopSessionWithExitVerification).not.toHaveBeenCalled();
    });

    it('returns the verified exit alongside the legacy fields for verifyExit: true', async () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const stopSession = vi.fn(() => ({ stopped: true as const }));
        const stopSessionWithExitVerification = vi.fn(async () => ({
            result: { stopped: true as const },
            exitVerification: {
                status: 'exited' as const,
                scope: 'session-process-tree-snapshot' as const,
                observedProcessCount: 3,
            },
        }));
        client.setRPCHandlers(handlers({ stopSession, stopSessionWithExitVerification }) as any);

        await expect(stopHandler(client)({
            sessionId: 'session-1',
            source: 'project-delete',
            reason: 'deletion',
            mode: 'force',
            verifyExit: true,
        })).resolves.toEqual({
            message: 'Session stopped',
            stopped: true,
            exitVerification: {
                status: 'exited',
                scope: 'session-process-tree-snapshot',
                observedProcessCount: 3,
            },
        });
        expect(stopSessionWithExitVerification).toHaveBeenCalledWith('session-1', {
            source: 'project-delete',
            reason: 'deletion',
            mode: 'force',
        });
        // The verifier owns the stop; the legacy path must not fire a second one.
        expect(stopSession).not.toHaveBeenCalled();
    });

    it('returns an untracked acknowledgement, never an exited claim', async () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers(handlers({
            stopSessionWithExitVerification: vi.fn(async () => ({
                result: { stopped: false as const, reason: 'not-found' as const },
                exitVerification: {
                    status: 'not-tracked' as const,
                    scope: 'session-process-tree-snapshot' as const,
                    detail: 'session-not-tracked' as const,
                },
            })),
        }) as any);

        await expect(stopHandler(client)({ sessionId: 'session-1', verifyExit: true })).resolves.toEqual({
            message: 'Session not tracked',
            stopped: false,
            reason: 'not-found',
            exitVerification: {
                status: 'not-tracked',
                scope: 'session-process-tree-snapshot',
                detail: 'session-not-tracked',
            },
        });
    });

    it('falls back to the legacy stop marked unavailable when the daemon cannot verify', async () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const stopSession = vi.fn(() => ({ stopped: true as const }));
        client.setRPCHandlers(handlers({ stopSession }) as any);

        await expect(stopHandler(client)({ sessionId: 'session-1', verifyExit: true })).resolves.toEqual({
            message: 'Session stopped',
            stopped: true,
            exitVerification: {
                status: 'unavailable',
                scope: 'session-process-tree-snapshot',
                detail: 'verification-unsupported',
            },
        });
        expect(stopSession).toHaveBeenCalledTimes(1);
    });
});
