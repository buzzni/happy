/**
 * aplus specs/org-llm-endpoints r2 — who can reach `ai-credential:capabilities` and `ai-credential:org-llm-endpoint-sync`.
 *
 * The browser relays both for an endpoint without a token, over its own end-to-end channel; the server sends both for a
 * token endpoint, over the only channel it holds. Production lanes and a real manager, handlers registered the way
 * `apiMachine` registers these two (no `customerBound`, see `apiMachine.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { bindRpcRequest } from '@slopus/happy-wire';
import { decodeBase64, decrypt, deriveServerRpcKey, encodeBase64, encrypt } from '@/api/encryption';
import { RpcHandlerManager } from './RpcHandlerManager';
import { machineServerLane } from './serverLane';
import { machineDelegationLane } from './delegationLane';

const SCOPE_KEY = new Uint8Array(randomBytes(32));
const LINK_KEY = new Uint8Array(randomBytes(32));
const SYNC = 'ai-credential:org-llm-endpoint-sync';
const CAPABILITIES = 'ai-credential:capabilities';
const nonce = () => randomBytes(16).toString('base64');

function machine(options: { variant: 'legacy' | 'dataKey'; strict: boolean }) {
    const manager = new RpcHandlerManager({
        scopePrefix: 'machine-1', encryptionKey: SCOPE_KEY, encryptionVariant: options.variant, logger: () => {},
        requireBoundRequests: options.strict,
        serverLane: machineServerLane({ encryptionKey: SCOPE_KEY, encryptionVariant: options.variant }),
        delegationLane: machineDelegationLane({ links: () => [{ peer: 'machine-2', key: LINK_KEY }] }),
    });
    manager.registerHandler(CAPABILITIES, async () => ({ orgLlmEndpointVersion: 1 }));
    manager.registerHandler(SYNC, async () => ({ ok: true, generation: 1 }));
    return manager;
}

type Caller = 'customer' | 'server' | 'delegation';
const callerKey = (caller: Caller, variant: 'legacy' | 'dataKey') => ({
    customer: { key: SCOPE_KEY, variant },
    server: { key: deriveServerRpcKey(SCOPE_KEY), variant: 'dataKey' as const },
    delegation: { key: LINK_KEY, variant: 'dataKey' as const },
})[caller];

async function call(manager: RpcHandlerManager, caller: Caller, method: string, options: { variant?: 'legacy' | 'dataKey'; bound?: boolean } = {}) {
    const variant = options.variant ?? 'dataKey';
    const { key, variant: sealedWith } = callerKey(caller, variant);
    const body = options.bound ? bindRpcRequest({ method, scope: 'machine-1', params: {}, issuedAt: Date.now(), nonce: nonce() }) : {};
    const response = await manager.handleRequest({ method: `machine-1:${method}`, params: encodeBase64(encrypt(key, sealedWith, body)) } as never);
    // A refusal before dispatch on the server lane is sealed with the scope key (the server cannot read why).
    const open = (openWith: Uint8Array, openVariant: 'legacy' | 'dataKey') => { try { return decrypt(openWith, openVariant, decodeBase64(response as string)) as Record<string, any>; } catch { return undefined; } };
    const reply = open(key, sealedWith) ?? open(SCOPE_KEY, variant);
    return (reply?.result ?? reply) as Record<string, unknown> | undefined;
}

describe('compat machine with a data key', () => {
  const manager = machine({ variant: 'dataKey', strict: false });
  it('lets a device holding the machine key reach both, bound or not', async () => {
    for (const bound of [false, true]) {
      expect(await call(manager, 'customer', CAPABILITIES, { bound })).toEqual({ orgLlmEndpointVersion: 1 });
      expect(await call(manager, 'customer', SYNC, { bound })).toEqual({ ok: true, generation: 1 });
    }
  });
  it('lets the server ask for capabilities but never deliver an endpoint', async () => {
    expect(await call(manager, 'server', CAPABILITIES)).toEqual({ orgLlmEndpointVersion: 1 });
    expect(await call(manager, 'server', SYNC)).toMatchObject({ code: 'SERVER_LANE_METHOD_NOT_ALLOWED' });
  });
  it('lets a linked machine ask for capabilities but never deliver an endpoint', async () => {
    expect(await call(manager, 'delegation', CAPABILITIES, { bound: true })).toEqual({ orgLlmEndpointVersion: 1 });
    expect(await call(manager, 'delegation', SYNC, { bound: true })).toMatchObject({ code: 'DELEGATION_LANE_METHOD_NOT_ALLOWED' });
  });
});

describe('strict machine (dataKey)', () => {
  const manager = machine({ variant: 'dataKey', strict: true });
  it('serves a device only when its request is bound', async () => {
    for (const method of [CAPABILITIES, SYNC]) {
      expect(await call(manager, 'customer', method)).toMatchObject({ code: 'RPC_UNBOUND_REQUEST' });
      expect(await call(manager, 'customer', method, { bound: true })).toBeDefined();
    }
    expect(await call(manager, 'customer', SYNC, { bound: true })).toEqual({ ok: true, generation: 1 });
  });
  it('still answers the server capabilities and still refuses it a delivery', async () => {
    expect(await call(manager, 'server', CAPABILITIES)).toEqual({ orgLlmEndpointVersion: 1 });
    expect(await call(manager, 'server', SYNC)).toMatchObject({ code: 'SERVER_LANE_METHOD_NOT_ALLOWED' });
  });
});

describe('legacy machine', () => {
  const manager = machine({ variant: 'legacy', strict: false });
  it('has no server lane: the server holds the account secret, which is the machine key, so it reaches both as the customer', async () => {
    expect(machineServerLane({ encryptionKey: SCOPE_KEY, encryptionVariant: 'legacy' })).toBeUndefined();
    expect(await call(manager, 'customer', CAPABILITIES, { variant: 'legacy' })).toEqual({ orgLlmEndpointVersion: 1 });
    expect(await call(manager, 'customer', SYNC, { variant: 'legacy' })).toEqual({ ok: true, generation: 1 });
  });
});
