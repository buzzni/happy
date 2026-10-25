/** Verify runtime-account snapshots cross the existing encrypted stream without credential fields. */
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

describe('ApiSessionClient runtime account display stream', () => {
    let handlers: Record<string, Array<(...args: any[]) => void>>;
    let socket: any;
    let session: ReturnType<typeof makeSession>;
    const fire = (event: string, ...args: any[]) => (handlers[event] ?? []).forEach((handler) => handler(...args));

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


    it.each(['legacy', 'dataKey'] as const)('encrypts the actual binding snapshot and resends after reconnect (%s)', async encryptionVariant => {
        const client = new ApiSessionClient('fake-token', { ...session, encryptionVariant });
        const binding = JSON.stringify({ version: 1, managedAccountId: '11111111-1111-4111-8111-111111111111', credentialGeneration: 3, groupScope: 'org', companyId: 'org', userId: 'user', machineId: 'pc', keyId: 'a'.repeat(64), nonce: '22222222-2222-4222-8222-222222222222', issuedAt: 100, tokenProof: 'b'.repeat(64) });
        client.setClaudeRuntimeAccount(binding);
        const frames = () => socket.volatile.emit.mock.calls.filter(([event]: [string]) => event === 'session-stream')
            .map(([, payload]: [string, { sid: string; data: string }]) => {
                expect(payload.sid).toBe(session.id);
                expect(payload.data).not.toContain('managedAccountId');
                return decrypt(session.encryptionKey, encryptionVariant, decodeBase64(payload.data)) as Record<string, unknown>;
            }).filter((frame: Record<string, unknown>) => frame?.type === 'runtime-account');
        expect(frames()).toHaveLength(1);
        expect(frames()[0]).toMatchObject({ kind: 'organization', sessionId: session.id, managedAccountId: '11111111-1111-4111-8111-111111111111', credentialGeneration: 3 });
        expect(Object.keys(frames()[0]).sort()).toEqual(['companyId','credentialGeneration','epoch','kind','machineId','managedAccountId','observedAt','provider','seq','sessionId','type','version'].sort());
        fire('connect'); expect(frames()).toHaveLength(2); expect(frames()[1].seq).toBe(1);
        await client.close();
        const count = frames().length; client.setClaudeRuntimeAccount(binding); expect(frames()).toHaveLength(count);
    });
});
