import { describe, expect, it, vi } from 'vitest';
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
/** Several Desktop instances, each with its own creation journal. An exchange is recorded, then answers with
 * that Desktop's signed child state; a status it has no journal for is unknown (operation-not-found), and a
 * spawn it has none for times out as an unconfirmed send would. Stored prompts live on the server, shared. */
function desktops(initial: string[], pinLimit?: number) {
    const registry = createAgentCallerBindings({ identity: () => ({ machineId: 'machine', happyAccountId: 'account', epoch: 'registration' }), live: () => true });
    const binding = registry.prepare({ sessionId: 'source', runtimeId: 'actual-runtime', scope: '/project', depth: 0 });
    const server = nacl.sign.keyPair(), keys = new Map<string, nacl.SignKeyPair>();
    let now = Date.now(), hang = false;
    const sign = (desktopInstanceId: string) => {
        const key = keys.get(desktopInstanceId) ?? nacl.sign.keyPair(); keys.set(desktopInstanceId, key);
        return signOwnership({ ...fixture.contact, hubId: binding.sessionId, sourceRuntimeId: binding.runtimeId,
            callerBindingId: binding.callerBindingId, hostEpoch: binding.hostEpoch, callerPublicKey: binding.callerPublicKey,
            machineId: binding.machineId, happyAccountId: binding.happyAccountId, scope: binding.scope, depth: binding.depth, desktopInstanceId,
            publicKey: Buffer.from(key.publicKey).toString('base64url'), issuedAt: now, expiresAt: now + 60000 }, server.secretKey);
    };
    const contacts = new Map(initial.map(id => [id, sign(id)])), revoked = new Set<string>(), stale = new Set<string>(), sent: string[] = [];
    const journals = new Map<string, Map<string, 'pending' | 'started' | 'failed'>>(), stored = new Set<string>();
    const port = createSessionOwnerContact({ enabled: true, binding, registry, now: () => now, pinLimit,
        trust: { issuer: fixture.contact.issuer, audience: fixture.contact.audience, publicKey: () => server.publicKey },
        lookup: async () => [...contacts.values()].filter(c => !revoked.has(c.desktopInstanceId)),
        // A hung adapter ignores the AbortSignal, so only the outer deadline ends the call.
        currentContact: async c => hang ? new Promise<boolean>(() => {}) : !revoked.has(c.desktopInstanceId) && !stale.has(c.desktopInstanceId),
        exchange: async (contact, relay) => {
            sent.push(`${relay.operation}@${contact.desktopInstanceId}`);
            const desktopKey = keys.get(contact.desktopInstanceId)!.secretKey;
            if (relay.operation === 'prompt-own-session' && stored.has(relay.localId)) {
                const { entry, payload, callerSignature, targetSessionId, localId, ...bound } = relay;
                return signOwnerRelayReply({ ...bound, responderSubject: contact.ownerSubject, checkedAt: now, result: 'allowed',
                    storage: { messageId: `message-${localId}`, seq: 1, localId, bodyVerified: true } }, desktopKey);
            }
            if (relay.operation !== 'spawn-owned-child' && relay.operation !== 'owned-child-status') throw new Error('timeout');
            const state = journals.get(contact.desktopInstanceId)?.get(relay.payload.operationId);
            const { entry, payload, callerSignature, ...bound } = relay, started = state === 'started';
            if (!state && relay.operation === 'owned-child-status') return signOwnerRelayReply({ ...bound, responderSubject: contact.ownerSubject,
                checkedAt: now, result: 'unknown', reason: 'operation-not-found' }, desktopKey);
            if (!state) throw new Error('timeout');
            return signOwnerRelayReply({ ...bound, responderSubject: contact.ownerSubject, checkedAt: now, result: 'allowed',
                childSpawn: { operationId: payload.operationId, spawnId: payload.spawnId, spawnDigest: payload.spawnDigest, state,
                    stage: started ? 'provider-started' : 'intent', sessionId: started ? 'child' : null, ownershipBindingId: started ? 'child-binding' : null,
                    ownerSubject: contact.ownerSubject, parentSessionId: relay.sourceHubSessionId, providerRuntimeId: started ? 'child-runtime' : null } },
                desktopKey);
        },
    });
    const journal = (desktopInstanceId: string, operationId: string, state: 'pending' | 'started' | 'failed') => {
        journals.set(desktopInstanceId, (journals.get(desktopInstanceId) ?? new Map()).set(operationId, state));
    };
    return { port, sent, journal, stored, add: (id: string) => { contacts.set(id, sign(id)); },
        revoke: (id: string) => { revoked.add(id); }, restore: (id: string) => { revoked.delete(id); stale.delete(id); },
        /** Still listed by lookup but no longer current: chosen, then dropped before any send. */
        stale: (id: string) => { stale.add(id); }, hang: (on: boolean) => { hang = on; },
        advance: (ms: number) => { now += ms; for (const id of contacts.keys()) contacts.set(id, sign(id)); } };
}
/** A small table (the host default is 512) exercises the same capacity boundaries quickly. */
const LIMIT = 8;
const child = (call: Record<string, any>, operationId: string) => ({ ...call, payload: { ...call.payload, operationId } });
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
        await expect(d.port.call(status)).resolves.toMatchObject({ result: 'unknown' });
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
        await expect(d.port.call(status)).resolves.toMatchObject({ result: 'unknown' });
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
        await expect(d.port.call({ ...status, payload: { ...status.payload, operationId: 'operation-2' } })).resolves.toMatchObject({ result: 'unknown' });
        expect(d.sent.slice(1)).toEqual(['lookup-readable-sessions@desktop-a', 'owned-child-status@desktop-a']);
    });
    it('does not pin an operation that was never sent', async () => {
        const d = desktops(['desktop-z']); d.stale('desktop-z');
        await expect(d.port.call(spawn)).rejects.toThrow();
        d.add('desktop-a');
        await expect(d.port.call(spawn)).rejects.toThrow();
        expect(d.sent).toEqual(['spawn-owned-child@desktop-a']);
    });
    // PIN-R1-01: only an observed terminal state frees a sent pin for cleanup.
    it('keeps a sent, unfinished operation pinned through a full table of other operations', async () => {
        const d = desktops(['desktop-z'], LIMIT); d.journal('desktop-z', 'operation-1', 'pending');
        expect((await d.port.call(spawn)).result).toBe('allowed');
        d.add('desktop-a');
        for (let i = 0; i < 2 * LIMIT; i++) {
            d.stored.add(`other-${i}`);
            expect((await d.port.call({ ...prompt, localId: `other-${i}` })).result).toBe('allowed');
        }
        await expect(d.port.call(status)).resolves.toBeDefined();
        expect(d.sent.at(-1)).toBe('owned-child-status@desktop-z');
    });
    it('keeps a timed-out operation pinned after a day of other operations', async () => {
        const d = desktops(['desktop-z']);
        await expect(d.port.call(spawn)).rejects.toThrow();
        d.add('desktop-a'); d.advance(25 * 60 * 60 * 1000);
        d.journal('desktop-a', 'other', 'failed');
        await d.port.call(child(status, 'other'));
        await expect(d.port.call(status)).resolves.toMatchObject({ result: 'unknown' });
        expect(d.sent).toEqual(['spawn-owned-child@desktop-z', 'owned-child-status@desktop-a', 'owned-child-status@desktop-z']);
    });
    // PIN-R2-01: a verified started/failed may never have reached the CLI or its lineage record, and only the
    // original Desktop's journal can answer the status that recovers it (--resume-op).
    it('keeps an owned child pinned after its terminal state, so a lost receipt is recovered from its Desktop', async () => {
        const d = desktops(['desktop-z'], LIMIT); d.journal('desktop-z', 'operation-1', 'started');
        const first = await d.port.call(spawn);
        expect(first.result === 'allowed' && first.operation === 'spawn-owned-child' && first.childSpawn.state).toBe('started');
        d.add('desktop-a'); d.advance(25 * 60 * 60 * 1000);
        for (let i = 0; i < 2 * LIMIT; i++) { d.stored.add(`other-${i}`); await d.port.call({ ...prompt, localId: `other-${i}` }); }
        const again = await d.port.call(status);
        expect(d.sent.at(-1)).toBe('owned-child-status@desktop-z');
        expect(again.result === 'allowed' && again.operation === 'owned-child-status' && again.childSpawn.state).toBe('started');
    });
    it('treats a stored prompt receipt as the end of that localId', async () => {
        const d = desktops(['desktop-z'], LIMIT); d.stored.add('local-1');
        await d.port.call(prompt);
        d.add('desktop-a');
        for (let i = 0; i < LIMIT; i++) { d.stored.add(`other-${i}`); await d.port.call({ ...prompt, localId: `other-${i}` }); }
        // The row is found by localId on the server, so any valid Desktop returns the same receipt; nothing is re-posted.
        const again = await d.port.call(prompt);
        expect(d.sent.at(-1)).toBe('prompt-own-session@desktop-a');
        expect(again.result === 'allowed' && again.operation === 'prompt-own-session' && again.storage.messageId).toBe('message-local-1');
    });
    // PIN-R1-02: a full table refuses only new operations; it never grows or evicts an unfinished one.
    it('refuses a new operation when every slot holds an unfinished one', async () => {
        const d = desktops(['desktop-z'], LIMIT);
        for (let i = 0; i < LIMIT; i++) await expect(d.port.call(child(spawn, `operation-${i}`))).rejects.toThrow();
        d.add('desktop-a');
        await expect(d.port.call(child(spawn, 'operation-new'))).rejects.toThrow('owner-contact-unavailable');
        expect(d.sent).toHaveLength(LIMIT);
        await expect(d.port.call(child(status, 'operation-0'))).resolves.toMatchObject({ result: 'unknown' });
        expect(d.sent.at(-1)).toBe('owned-child-status@desktop-z');
    });
    it('releases an unsent choice on the outer deadline even when the adapter ignores abort', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const d = desktops(['desktop-z']); d.hang(true);
            const hung = d.port.call(spawn).catch((error: Error) => error.message);
            await vi.advanceTimersByTimeAsync(20000);
            expect(await hung).toBe('owner-contact-unavailable');
            d.hang(false); d.add('desktop-a');
            await expect(d.port.call(spawn)).rejects.toThrow();
            expect(d.sent).toEqual(['spawn-owned-child@desktop-a']);
        } finally { vi.useRealTimers(); }
    });
    it('rejects source injection and excessive lookup', async () => {
        const h = harness();
        await expect(h.port.call({ ...request, sourceHubSessionId: 'other' })).rejects.toThrow();
        await expect(h.port.call({ ...request, payload: { sessionIds: Array.from({ length: 101 }, (_, i) => `${i}`) } })).rejects.toThrow();
        expect(h.counts().lookups).toBe(0);
    });
});
