/** owner-relay-v1 calls use this session's DEK over the existing rpc-call protocol, once (T1c-b2 H2). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from './types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
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

describe('ApiSessionClient owner relay call', () => {
    let socket: any;
    beforeEach(() => {
        vi.clearAllMocks();
        socket = { connected: true, connect: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn(),
            timeout: vi.fn(function (this: unknown) { return this; }), emitWithAck: vi.fn(), volatile: { emit: vi.fn() }, close: vi.fn() };
        mockIo.mockReturnValue(socket);
    });
    afterEach(() => { vi.useRealTimers(); });
    const method = 'owner-relay-v1:' + 'a'.repeat(22);

    it.each(['legacy', 'dataKey'] as const)('encrypts the request and decrypts the reply with the session key (%s)', async encryptionVariant => {
        const session = { ...makeSession(), encryptionKey: new Uint8Array(32).fill(7), encryptionVariant };
        const client = new ApiSessionClient('fake-token', session);
        socket.emitWithAck.mockImplementation(async (event: string, data: { method: string; params: string }) => {
            expect(event).toBe('rpc-call');
            expect(data.method).toBe(method);
            expect(data.params).not.toContain('secret-request');
            expect(decrypt(session.encryptionKey, encryptionVariant, decodeBase64(data.params))).toEqual({ text: 'secret-request' });
            return { ok: true, result: encodeBase64(encrypt(session.encryptionKey, encryptionVariant, { reply: 1 })) };
        });
        expect(await client.callOwnerRelay(method, { text: 'secret-request' }, new AbortController().signal)).toEqual({ reply: 1 });
        expect(socket.timeout).toHaveBeenCalledWith(20_000);
        expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
    });
    it('refuses another RPC method and never sends', async () => {
        const client = new ApiSessionClient('fake-token', makeSession());
        await expect(client.callOwnerRelay('test-session-id:bash', {}, new AbortController().signal)).rejects.toThrow();
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });
    it('reports a failed or undecryptable reply as unavailable without retry', async () => {
        const client = new ApiSessionClient('fake-token', makeSession());
        socket.emitWithAck.mockResolvedValueOnce({ ok: false, error: 'remote detail' }).mockResolvedValueOnce({ ok: true, result: 'garbage' });
        await expect(client.callOwnerRelay(method, {}, new AbortController().signal)).rejects.toThrow('owner-relay-unavailable');
        await expect(client.callOwnerRelay(method, {}, new AbortController().signal)).rejects.toThrow('owner-relay-unavailable');
        expect(socket.emitWithAck).toHaveBeenCalledTimes(2);
    });
    it('does not send after abort', async () => {
        const client = new ApiSessionClient('fake-token', makeSession());
        const controller = new AbortController(); controller.abort();
        await expect(client.callOwnerRelay(method, {}, controller.signal)).rejects.toThrow();
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });
});
