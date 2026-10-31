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
        lookup: async query => { lookups++; expect(query).toEqual({ sessionId: 'source', machineId: 'machine', happyAccountId: 'account',
            callerBindingId: binding.callerBindingId, hostEpoch: binding.hostEpoch }); return [contact]; },
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
/** Several Desktop instances; every exchange is recorded and then times out, as an unconfirmed send would. */
function desktops(initial: string[]) {
    const registry = createAgentCallerBindings({ identity: () => ({ machineId: 'machine', happyAccountId: 'account', epoch: 'registration' }), live: () => true });
    const binding = registry.prepare({ sessionId: 'source', runtimeId: 'actual-runtime', scope: '/project', depth: 0 });
    const server = nacl.sign.keyPair(), now = Date.now();
    const sign = (desktopInstanceId: string) => signOwnership({ ...fixture.contact, hubId: binding.sessionId, sourceRuntimeId: binding.runtimeId,
        callerBindingId: binding.callerBindingId, hostEpoch: binding.hostEpoch, callerPublicKey: binding.callerPublicKey,
        machineId: binding.machineId, happyAccountId: binding.happyAccountId, scope: binding.scope, depth: binding.depth, desktopInstanceId,
        publicKey: Buffer.from(nacl.sign.keyPair().publicKey).toString('base64url'), issuedAt: now, expiresAt: now + 60000 }, server.secretKey);
    const contacts = new Map(initial.map(id => [id, sign(id)])), revoked = new Set<string>(), stale = new Set<string>(), sent: string[] = [];
    const port = createSessionOwnerContact({ enabled: true, binding, registry, now: () => now,
        trust: { issuer: fixture.contact.issuer, audience: fixture.contact.audience, publicKey: () => server.publicKey },
        lookup: async () => [...contacts.values()].filter(c => !revoked.has(c.desktopInstanceId)),
        currentContact: async c => !revoked.has(c.desktopInstanceId) && !stale.has(c.desktopInstanceId),
        exchange: async (contact, relay) => { sent.push(`${relay.operation}@${contact.desktopInstanceId}`); throw new Error('timeout'); },
    });
    return { port, sent, add: (id: string) => { contacts.set(id, sign(id)); },
        revoke: (id: string) => { revoked.add(id); }, restore: (id: string) => { revoked.delete(id); stale.delete(id); },
        /** Still listed by lookup but no longer current: chosen, then dropped before any send. */
        stale: (id: string) => { stale.add(id); } };
}
const vector = (operation: string) => {
    const { entry, operation: op, targetSessionId, localId, payload } = fixture.vectors.map(v => v.request as Record<string, unknown>)
        .find(r => r.operation === operation)!;
    return JSON.parse(JSON.stringify({ v: 1, entry, operation: op, targetSessionId, localId, payload }));
};
const spawn = vector('spawn-owned-child'), status = vector('owned-child-status'), prompt = vector('prompt-own-session');
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
    // Desktop P0a §4.5 / D4-R3-02: an operation stays on the instance chosen when it was first sent.
    it('keeps an owned child status on the Desktop that received its spawn', async () => {
        const d = desktops(['desktop-z']);
        await expect(d.port.call(spawn)).rejects.toThrow();
        d.add('desktop-a');
        await expect(d.port.call(status)).rejects.toThrow();
        await expect(d.port.call(spawn)).rejects.toThrow();
        expect(d.sent).toEqual(['spawn-owned-child@desktop-z', 'owned-child-status@desktop-z', 'spawn-owned-child@desktop-z']);
    });
    it('fails closed instead of moving a pinned operation to another Desktop', async () => {
        const d = desktops(['desktop-z']);
        await expect(d.port.call(spawn)).rejects.toThrow();
        d.add('desktop-a'); d.revoke('desktop-z');
        await expect(d.port.call(status)).rejects.toThrow('owner-contact-unavailable');
        expect(d.sent).toEqual(['spawn-owned-child@desktop-z']);
        d.restore('desktop-z');
        await expect(d.port.call(status)).rejects.toThrow();
        expect(d.sent.at(-1)).toBe('owned-child-status@desktop-z');
    });
    it('retries a prompt with the same localId on the same Desktop only', async () => {
        const d = desktops(['desktop-z']);
        await expect(d.port.call(prompt)).rejects.toThrow();
        d.add('desktop-a');
        await expect(d.port.call(prompt)).rejects.toThrow();
        await expect(d.port.call({ ...prompt, localId: 'local-2' })).rejects.toThrow();
        expect(d.sent).toEqual(['prompt-own-session@desktop-z', 'prompt-own-session@desktop-z', 'prompt-own-session@desktop-a']);
    });
    it('leaves other operations and other operation ids on the current selection', async () => {
        const d = desktops(['desktop-z']);
        await expect(d.port.call(spawn)).rejects.toThrow();
        d.add('desktop-a');
        await expect(d.port.call(request)).rejects.toThrow();
        await expect(d.port.call({ ...status, payload: { ...status.payload, operationId: 'operation-2' } })).rejects.toThrow();
        expect(d.sent.slice(1)).toEqual(['lookup-readable-sessions@desktop-a', 'owned-child-status@desktop-a']);
    });
    it('does not pin an operation that was never sent', async () => {
        const d = desktops(['desktop-z']); d.stale('desktop-z');
        await expect(d.port.call(spawn)).rejects.toThrow();
        d.add('desktop-a');
        await expect(d.port.call(spawn)).rejects.toThrow();
        expect(d.sent).toEqual(['spawn-owned-child@desktop-a']);
    });
    it('rejects source injection and excessive lookup', async () => {
        const h = harness();
        await expect(h.port.call({ ...request, sourceHubSessionId: 'other' })).rejects.toThrow();
        await expect(h.port.call({ ...request, payload: { sessionIds: Array.from({ length: 101 }, (_, i) => `${i}`) } })).rejects.toThrow();
        expect(h.counts().lookups).toBe(0);
    });
});
