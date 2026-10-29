import { describe, expect, it } from 'vitest';
import { createAgentCallerBindings } from './agentCallerBinding';
import { createSessionOwnerContact } from './sessionOwnerContact';
import { ownerRelayV1Fixture as fixture, signOwnership, signOwnerRelayReply } from '@slopus/happy-wire';
import nacl from 'tweetnacl';

function harness(enabled = true) {
    let epoch = 'registration', live = true, lookups = 0, sends = 0, tamper = false, race = false;
    const registry = createAgentCallerBindings({ identity: () => ({ machineId: 'machine', happyAccountId: 'account', epoch }), live: () => live });
    const binding = registry.prepare({ sessionId: 'source', runtimeId: 'actual-runtime', scope: '/project', depth: 0 });
    const server = nacl.sign.keyPair(), desktop = nacl.sign.keyPair();
    const now = Date.now();
    let contact = signOwnership({ ...fixture.contact, hubId: binding.sessionId, sourceRuntimeId: binding.runtimeId,
        callerBindingId: binding.callerBindingId, hostEpoch: binding.hostEpoch, callerPublicKey: binding.callerPublicKey,
        machineId: binding.machineId, happyAccountId: binding.happyAccountId, scope: binding.scope, depth: binding.depth,
        publicKey: Buffer.from(desktop.publicKey).toString('base64url'), issuedAt: now, expiresAt: now + 60000 }, server.secretKey);
    const port = createSessionOwnerContact({ enabled, binding, registry, now: () => now,
        trust: { issuer: contact.issuer, audience: contact.audience, publicKey: id => id === contact.keyId ? server.publicKey : null },
        lookup: async query => { lookups++; expect(query).toEqual({ sessionId: 'source', machineId: 'machine', happyAccountId: 'account' }); return [contact]; },
        currentContact: async () => true,
        exchange: async (_contact, request) => {
            sends++;
            if (request.operation !== 'lookup-readable-sessions') throw new Error('unexpected operation');
            const { entry, payload, callerSignature, ...bound } = request;
            if (race) epoch = 'changed';
            const reply = signOwnerRelayReply({ ...bound, responderSubject: contact.ownerSubject, checkedAt: now,
                result: 'allowed', owners: [] }, desktop.secretKey);
            return tamper ? { ...reply, nonce: 'invalid' } : reply;
        },
    });
    return { port, registry, binding, counts: () => ({ lookups, sends }), switch: () => { epoch = 'changed'; },
        tamper: () => { tamper = true; }, race: () => { race = true; }, stop: () => { live = false; }, corrupt: () => { contact = { ...contact, signature: Buffer.alloc(64).toString('base64url') }; } };
}
const request = { v: 1, entry: 'agent', operation: 'lookup-readable-sessions', payload: { sessionIds: ['target'] } } as const;
describe('host owner contact', () => {
    it('signs a fixed actual runtime and returns a verified typed response without key material', async () => {
        const h = harness();
        expect(h.binding.runtimeId).toBe('actual-runtime');
        expect((await h.port.call(request)).result).toBe('allowed');
        expect(JSON.stringify(h.port)).not.toMatch(/secretKey|token|bearer/);
        expect(h.counts()).toEqual({ lookups: 1, sends: 1 });
    });
    it('is default off and performs no lookup', async () => {
        const h = harness(false); await expect(h.port.call(request)).rejects.toThrow('owner-contact-disabled');
        expect(h.counts()).toEqual({ lookups: 0, sends: 0 });
    });
    it.each(['switch', 'stop', 'corrupt'] as const)('rejects %s before transport', async action => {
        const h = harness(); h[action](); await expect(h.port.call(request)).rejects.toThrow();
        expect(h.counts().sends).toBe(0);
    });
    it('rejects resumed old binding', async () => {
        const h = harness(); h.registry.prepare({ sessionId: 'source', runtimeId: 'resumed', scope: '/project', depth: 0 });
        await expect(h.port.call(request)).rejects.toThrow(); expect(h.counts().sends).toBe(0);
    });
    it.each(['tamper', 'race'] as const)('discards %s response', async action => {
        const h = harness(); h[action](); await expect(h.port.call(request)).rejects.toThrow();
        expect(h.counts().sends).toBe(1);
    });
    it('closing an obsolete contact does not revoke a resumed host', async () => {
        const h = harness();
        const resumed = h.registry.prepare({ sessionId: 'source', runtimeId: 'new-runtime', scope: '/project', depth: 0 });
        h.port.close();
        expect((await h.registry.query({ sessionId: 'source', nonce: 'n'.repeat(32) })).caller).toEqual(resumed);
    });
    it('rejects source injection and excessive lookup', async () => {
        const h = harness();
        await expect(h.port.call({ ...request, sourceHubSessionId: 'other' })).rejects.toThrow();
        await expect(h.port.call({ ...request, payload: { sessionIds: Array.from({ length: 101 }, (_, i) => `${i}`) } })).rejects.toThrow();
        expect(h.counts().lookups).toBe(0);
    });
});
