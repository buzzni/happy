import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOMATION_PROTOCOL_VERSION } from '@slopus/happy-wire';
import { ApiMachineClient } from './apiMachine';
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

    beforeEach(() => {
        vi.clearAllMocks();
        mockShouldReconnect.mockReturnValue(true);
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

        await vi.advanceTimersByTimeAsync(3000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(2);

        client.shutdown();
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

    it('registers the persistent automation public key on connect and persists the acknowledged version', async () => {
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
        }, persistVersion);
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(persistVersion).toHaveBeenCalledWith(4));
        expect(client.shouldRunLegacyAutomationScheduler()).toBe(false);
        expect(mockSocket.emitWithAck).toHaveBeenCalledWith('automation-key-register', {
            expectedKeyVersion: 3,
            publicKey: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
            protocolVersion: AUTOMATION_PROTOCOL_VERSION,
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
