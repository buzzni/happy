/**
 * aplus-dev-studio specs/cross-machine-agent-delegation (happy spec R6–R10, R14) — the wiring inside
 * ApiMachineClient: a link opens the lane end to end, and without the host nothing changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindRpcRequest } from '@slopus/happy-wire';
import { createAgentDelegationStore, type AgentDelegationStore } from '@/daemon/agentDelegationStore';

const PEER_KEY = new Uint8Array(Buffer.alloc(32, 5));

function rpcHandlers(overrides: Record<string, unknown> = {}) {
    return {
        spawnSession: vi.fn(async () => ({ type: 'success', sessionId: 'child-1' })),
        stopSession: vi.fn(() => ({ type: 'success' })),
        requestShutdown: vi.fn(),
        portRegistry: { allocate: () => undefined, get: () => undefined, release: () => undefined, list: () => [], sweep: () => undefined },
        ...overrides,
    } as any;
}

describe('ApiMachineClient agent delegation', () => {
    let dir: string;
    let store: AgentDelegationStore;
    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'api-machine-delegation-'));
        store = createAgentDelegationStore({ path: join(dir, 'agent-delegation.json') });
        await store.installTarget({ sourceMachineId: 'machine-a', keyId: 'k1', key: Buffer.from(PEER_KEY).toString('base64'), createdBy: { accountId: 'linker' } });
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const client = async (withHost: boolean, overrides: Record<string, unknown> = {}) => {
        const { ApiMachineClient } = await import('./apiMachine');
        const machine = { id: 'machine-b', encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' } as any;
        const instance = new ApiMachineClient('token', machine) as any;
        const handlers = rpcHandlers(overrides);
        instance.setRPCHandlers({
            ...handlers,
            ...(withHost ? { agentDelegation: { store, isSessionLive: () => false, readSessionVariant: () => null, concurrencyLimit: 4, directoryExists: async () => true } } : {}),
        });
        return { instance, handlers };
    };
    const sendAsPeer = async (instance: any, method: string, params: unknown, nonceFill = 1) => {
        const { decodeBase64, decrypt, encodeBase64, encrypt } = await import('./encryption');
        const response = await instance.rpcHandlerManager.handleRequest({
            method: `machine-b:${method}`,
            params: encodeBase64(encrypt(PEER_KEY, 'dataKey', bindRpcRequest({ method, scope: 'machine-b', params, issuedAt: Date.now(), nonce: Buffer.alloc(16, nonceFill).toString('base64') }))),
        });
        return decrypt(PEER_KEY, 'dataKey', decodeBase64(response)) as any;
    };

    it('starts a delegated child through the same spawn path the machine uses', async () => {
        const { instance, handlers } = await client(true);
        const reply = await sendAsPeer(instance, 'agent-delegation:spawn', {
            requestId: 'request-0001', parentSessionId: 'parent-1', directory: '/work/app', initialPrompt: 'go', agentGrant: { depth: 1, maxSpawn: 2, agentId: 'a1' },
        });
        expect(reply.result).toEqual({ type: 'success', sessionId: 'child-1' });
        expect(handlers.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ delegatedFrom: { machineId: 'machine-a', sessionId: 'parent-1' }, createdByAccountId: 'linker' }));
    });

    it('stops only a child the peer started', async () => {
        const { instance, handlers } = await client(true);
        expect((await sendAsPeer(instance, 'stop-session', { sessionId: 'not-mine' })).result).toMatchObject({ code: 'session_not_found' });
        expect(handlers.stopSession).not.toHaveBeenCalled();
        await store.recordChild({ sessionId: 'child-9', peer: 'machine-a', parentSessionId: 'p' });
        await sendAsPeer(instance, 'stop-session', { sessionId: 'child-9' }, 2);
        expect(handlers.stopSession).toHaveBeenCalledWith('child-9', expect.anything());
    });

    it('never reaches spawn-happy-session or file RPCs through a link key', async () => {
        const { instance, handlers } = await client(true);
        for (const [index, method] of ['spawn-happy-session', 'readFile', 'bash', 'agent-delegation:targets', 'agent-delegation:install-target'].entries()) {
            expect((await sendAsPeer(instance, method, {}, index + 10)).result).toMatchObject({ code: 'DELEGATION_LANE_METHOD_NOT_ALLOWED' });
        }
        expect(handlers.spawnSession).not.toHaveBeenCalled();
    });

    it('registers nothing and opens no lane without the host', async () => {
        const { instance } = await client(false);
        expect(instance.rpcHandlerManager.hasHandler('agent-delegation:spawn')).toBe(false);
        expect(instance.rpcHandlerManager.hasHandler('agent-delegation:install-target')).toBe(false);
        const { encodeBase64, encrypt, decodeBase64, decrypt } = await import('./encryption');
        const response = await instance.rpcHandlerManager.handleRequest({
            method: 'machine-b:stop-session',
            params: encodeBase64(encrypt(PEER_KEY, 'dataKey', {})),
        });
        expect(decrypt(PEER_KEY, 'dataKey', decodeBase64(response))).toBeNull();
    });
});
