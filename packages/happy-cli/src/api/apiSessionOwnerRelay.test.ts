/** owner-relay-v1 calls use this session's DEK and the existing RPC binding over rpc-call, once (T1c-b2 H2, p0a §4.5). */
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

    // p0a §4.5: the existing session-DEK RPC binding (method/scope/nonce), not the bare request (D1 wire alignment).
    it('wraps the request in the session-DEK RPC binding and returns only the reply bound to its nonce', async () => {
        const session = { ...makeSession(), encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey' as const };
        const client = new ApiSessionClient('fake-token', session);
        let sent: { rpcBinding: number; method: string; scope: string; issuedAt: number; nonce: string; params: unknown } | null = null;
        socket.emitWithAck.mockImplementation(async (event: string, data: { method: string; params: string }) => {
            expect(event).toBe('rpc-call');
            expect(data.method).toBe(method);
            expect(data.params).not.toContain('secret-request');
            sent = decrypt(session.encryptionKey, 'dataKey', decodeBase64(data.params)) as typeof sent;
            return { ok: true, result: encodeBase64(encrypt(session.encryptionKey, 'dataKey', { rpcBinding: 1, nonce: sent!.nonce, result: { reply: 1 } })) };
        });
        expect(await client.callOwnerRelay(method, { text: 'secret-request' }, new AbortController().signal)).toEqual({ reply: 1 });
        expect(sent).toMatchObject({ rpcBinding: 1, method, scope: session.id, params: { text: 'secret-request' } });
        expect(sent!.nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
        expect(Math.abs(sent!.issuedAt - Date.now())).toBeLessThan(5_000);
        expect(socket.timeout).toHaveBeenCalledWith(20_000);
        expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
    });
    it.each([
        ['another nonce', (nonce: string) => ({ rpcBinding: 1, nonce: nonce.replace(/^./, c => c === 'A' ? 'B' : 'A'), result: { reply: 1 } })],
        ['an unbound reply', () => ({ reply: 1 })],
    ])('refuses a reply bound to %s', async (_label, reply) => {
        const session = { ...makeSession(), encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey' as const };
        const client = new ApiSessionClient('fake-token', session);
        socket.emitWithAck.mockImplementation(async (_event: string, data: { params: string }) => {
            const opened = decrypt(session.encryptionKey, 'dataKey', decodeBase64(data.params)) as { nonce: string };
            return { ok: true, result: encodeBase64(encrypt(session.encryptionKey, 'dataKey', reply(opened.nonce))) };
        });
        await expect(client.callOwnerRelay(method, {}, new AbortController().signal)).rejects.toThrow('owner-relay-unavailable');
    });
    it('is unavailable for a session without a DEK and never sends under the legacy key', async () => {
        const client = new ApiSessionClient('fake-token', makeSession());
        await expect(client.callOwnerRelay(method, {}, new AbortController().signal)).rejects.toThrow('owner-relay-unavailable');
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });
    it('refuses another RPC method and never sends', async () => {
        const client = new ApiSessionClient('fake-token', { ...makeSession(), encryptionVariant: 'dataKey' as const });
        await expect(client.callOwnerRelay('test-session-id:bash', {}, new AbortController().signal)).rejects.toThrow();
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });
    it('reports a failed or undecryptable reply as unavailable without retry', async () => {
        const client = new ApiSessionClient('fake-token', { ...makeSession(), encryptionVariant: 'dataKey' as const });
        socket.emitWithAck.mockResolvedValueOnce({ ok: false, error: 'remote detail' }).mockResolvedValueOnce({ ok: true, result: 'garbage' });
        await expect(client.callOwnerRelay(method, {}, new AbortController().signal)).rejects.toThrow('owner-relay-unavailable');
        await expect(client.callOwnerRelay(method, {}, new AbortController().signal)).rejects.toThrow('owner-relay-unavailable');
        expect(socket.emitWithAck).toHaveBeenCalledTimes(2);
    });
    it('does not send after abort', async () => {
        const client = new ApiSessionClient('fake-token', { ...makeSession(), encryptionVariant: 'dataKey' as const });
        const controller = new AbortController(); controller.abort();
        await expect(client.callOwnerRelay(method, {}, controller.signal)).rejects.toThrow();
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });
});
