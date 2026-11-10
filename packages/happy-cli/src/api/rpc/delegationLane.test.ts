/**
 * aplus-dev-studio specs/cross-machine-agent-delegation (happy spec R6, R7, R14) — the delegation lane.
 *
 * Exercised through the real `handleRequest` with real encryption, so a lane that only changes an
 * in-memory shape does not pass.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { bindRpcRequest } from '@slopus/happy-wire';
import { RpcHandlerManager } from './RpcHandlerManager';
import { DELEGATION_LANE_METHODS, machineDelegationLane } from './delegationLane';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';

const MACHINE_KEY = new Uint8Array(randomBytes(32));
const SERVER_KEY = new Uint8Array(randomBytes(32));
const PEER_KEY = new Uint8Array(randomBytes(32));
const OTHER_PEER_KEY = new Uint8Array(randomBytes(32));
const nonce = (fill: number) => Buffer.alloc(16, fill).toString('base64');

function makeManager(options: { links?: Array<{ peer: string; key: Uint8Array }>; admit?: (method: string, params: unknown, peer: string) => { error: string; code: string } | null } = {}) {
    let links = options.links ?? [{ peer: 'machine-a', key: PEER_KEY }];
    const manager = new RpcHandlerManager({
        scopePrefix: 'machine-b',
        encryptionKey: MACHINE_KEY,
        encryptionVariant: 'dataKey',
        logger: () => {},
        serverLane: { encryptionKey: SERVER_KEY, allows: (method) => method === 'stop-session' },
        delegationLane: machineDelegationLane({ links: () => links, admit: options.admit }),
    });
    const calls: Array<[string, unknown, unknown]> = [];
    const record = (method: string) => async (params: unknown, context?: unknown) => {
        calls.push([method, params, context]);
        return { ran: method };
    };
    for (const method of ['agent-delegation:spawn', 'agent-delegation:session-key', 'stop-session', 'bash', 'agent-delegation:targets', 'spawn-happy-session']) {
        manager.registerHandler(method, record(method));
    }
    return { manager, calls, setLinks: (next: Array<{ peer: string; key: Uint8Array }>) => { links = next; } };
}

async function send(manager: RpcHandlerManager, method: string, plaintext: unknown, key: Uint8Array) {
    const response = await manager.handleRequest({
        method: `machine-b:${method}`,
        params: encodeBase64(encrypt(key, 'dataKey', plaintext as object)),
    } as never);
    return response as string;
}

const bound = (method: string, params: unknown, options: { fill?: number; issuedAt?: number; scope?: string } = {}) => bindRpcRequest({
    method, scope: options.scope ?? 'machine-b', params, issuedAt: options.issuedAt ?? Date.now(), nonce: nonce(options.fill ?? 1),
});
const open = (response: string, key: Uint8Array) => decrypt(key, 'dataKey', decodeBase64(response)) as Record<string, any> | null;

describe('delegation lane', () => {
    it('runs an allowed method for a link key, tells the handler the peer, and answers with that key bound to the nonce', async () => {
        const { manager, calls } = makeManager();
        const response = await send(manager, 'agent-delegation:spawn', bound('agent-delegation:spawn', { directory: '/w' }), PEER_KEY);
        expect(open(response, PEER_KEY)).toEqual({ rpcBinding: 1, nonce: nonce(1), result: { ran: 'agent-delegation:spawn' } });
        expect(open(response, MACHINE_KEY)).toBeNull();
        expect(calls).toEqual([['agent-delegation:spawn', { directory: '/w' }, { lane: 'delegation', peer: 'machine-a' }]]);
    });

    it('refuses every method outside the allowlist without running it', async () => {
        const { manager, calls } = makeManager();
        for (const method of ['bash', 'agent-delegation:targets', 'spawn-happy-session']) {
            const response = await send(manager, method, bound(method, {}, { fill: method.length }), PEER_KEY);
            expect(open(response, PEER_KEY)?.result).toMatchObject({ code: 'DELEGATION_LANE_METHOD_NOT_ALLOWED' });
        }
        expect(calls).toEqual([]);
    });

    it('lists exactly the reviewed methods', () => {
        expect([...DELEGATION_LANE_METHODS].sort()).toEqual([
            'agent-delegation:relay-prompt',
            'agent-delegation:relay-read',
            'agent-delegation:relay-sessions',
            'agent-delegation:session-key',
            'agent-delegation:spawn',
            'ai-credential:capabilities',
            'ai-credential:status',
            'stop-session',
        ]);
    });

    it('refuses an unbound request: a captured ciphertext must not start a second agent', async () => {
        const { manager, calls } = makeManager();
        const response = await send(manager, 'agent-delegation:spawn', { directory: '/w' }, PEER_KEY);
        expect(open(response, PEER_KEY)).toMatchObject({ code: 'RPC_UNBOUND_REQUEST' });
        expect(calls).toEqual([]);
    });

    it('refuses a replayed request and a stale one', async () => {
        const { manager, calls } = makeManager();
        await send(manager, 'agent-delegation:spawn', bound('agent-delegation:spawn', {}), PEER_KEY);
        const replay = await send(manager, 'agent-delegation:spawn', bound('agent-delegation:spawn', {}), PEER_KEY);
        expect(open(replay, PEER_KEY)?.result).toMatchObject({ code: 'RPC_REQUEST_REPLAYED' });
        const stale = await send(manager, 'agent-delegation:spawn', bound('agent-delegation:spawn', {}, { fill: 2, issuedAt: Date.now() - 60 * 60_000 }), PEER_KEY);
        expect(open(stale, PEER_KEY)?.result).toMatchObject({ code: 'RPC_REQUEST_STALE' });
        expect(calls).toHaveLength(1);
    });

    it('refuses a request bound to another machine', async () => {
        const { manager, calls } = makeManager();
        const response = await send(manager, 'agent-delegation:spawn', bound('agent-delegation:spawn', {}, { scope: 'machine-c' }), PEER_KEY);
        expect(open(response, PEER_KEY)?.result).toMatchObject({ code: 'RPC_SCOPE_MISMATCH' });
        expect(calls).toEqual([]);
    });

    it('cannot be opened once the link is revoked', async () => {
        const { manager, calls, setLinks } = makeManager();
        setLinks([]);
        const response = await send(manager, 'agent-delegation:spawn', bound('agent-delegation:spawn', {}), PEER_KEY);
        expect(open(response, PEER_KEY)).toBeNull();
        expect(open(response, MACHINE_KEY)).toMatchObject({ code: 'RPC_DECRYPT_FAILED' });
        expect(calls).toEqual([]);
    });

    it('names the peer whose key opened the request', async () => {
        const { manager, calls } = makeManager({ links: [{ peer: 'machine-a', key: PEER_KEY }, { peer: 'machine-c', key: OTHER_PEER_KEY }] });
        await send(manager, 'stop-session', bound('stop-session', { sessionId: 's' }), OTHER_PEER_KEY);
        expect(calls[0][2]).toEqual({ lane: 'delegation', peer: 'machine-c' });
    });

    it('lets the lane refuse a call by its params before the handler runs', async () => {
        const { manager, calls } = makeManager({
            admit: (method, params, peer) => method === 'stop-session' && (params as { sessionId?: string }).sessionId !== `${peer}-child`
                ? { error: 'not found', code: 'session_not_found' } : null,
        });
        const refused = await send(manager, 'stop-session', bound('stop-session', { sessionId: 'someone-else' }), PEER_KEY);
        expect(open(refused, PEER_KEY)?.result).toEqual({ error: 'not found', code: 'session_not_found' });
        await send(manager, 'stop-session', bound('stop-session', { sessionId: 'machine-a-child' }, { fill: 3 }), PEER_KEY);
        expect(calls.map(([method, params]) => [method, params])).toEqual([['stop-session', { sessionId: 'machine-a-child' }]]);
    });

    it('keeps the customer and server lanes first and unchanged', async () => {
        const { manager, calls } = makeManager();
        const customer = await send(manager, 'bash', {}, MACHINE_KEY);
        expect(open(customer, MACHINE_KEY)).toEqual({ ran: 'bash' });
        const server = await send(manager, 'stop-session', {}, SERVER_KEY);
        expect(open(server, SERVER_KEY)).toEqual({ ran: 'stop-session' });
        // Neither lane tells the handler anything new.
        expect(calls.map(([, , context]) => context)).toEqual([undefined, undefined]);
    });

    it('costs nothing and changes nothing without links', async () => {
        const manager = new RpcHandlerManager({
            scopePrefix: 'machine-b', encryptionKey: MACHINE_KEY, encryptionVariant: 'dataKey', logger: () => {},
            delegationLane: machineDelegationLane({ links: () => [] }),
        });
        manager.registerHandler('bash', async () => ({ ok: true }));
        expect(open(await send(manager, 'bash', {}, MACHINE_KEY), MACHINE_KEY)).toEqual({ ok: true });
    });
});
