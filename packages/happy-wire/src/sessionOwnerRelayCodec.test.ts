import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import fixture from './fixtures/sessionOwnerRelay.v1.json';
import { verifyOwnership } from './sessionOwnership';
import { rotationBase64url, rotationDecodeBinary } from './sharedMachineRotation';
import { OwnerRelayRequestSchema, OwnerRelayReplySchema } from './sessionOwnerRelay';
import { signOwnerRelayRequest, signOwnerRelayReply, verifyOwnerRelayRequest, verifyOwnerRelayReply,
    ownerRelayRequestSigningBytes, ownerRelayReplySigningBytes, ownerRelayIntentDigest, encodeOwnerRelayRequest, decodeOwnerRelayRequest, encodeOwnerRelayReply, decodeOwnerRelayReply } from './sessionOwnerRelayCodec';
const host = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
const desktop = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(34));
const contact = { ...fixture.contact, callerPublicKey: rotationBase64url(host.publicKey), publicKey: rotationBase64url(desktop.publicKey) };
const now = fixture.contact.issuedAt;
async function pair(i = 2) {
    const request = await signOwnerRelayRequest(fixture.vectors[i].request, host.secretKey);
    const reply = signOwnerRelayReply({ ...fixture.vectors[i].reply, intentDigest: request.intentDigest }, desktop.secretKey);
    return { request, reply };
}
describe('owner relay signature and intent codec', async () => {
    it('round trips both signed directions', async () => {
        const { request, reply } = await pair();
        expect(await verifyOwnerRelayRequest(request, contact, now)).toBe(true);
        expect(await verifyOwnerRelayReply(reply, request, contact, now)).toBe(true);
        expect(decodeOwnerRelayRequest(encodeOwnerRelayRequest(request))).toEqual(request);
        expect(decodeOwnerRelayReply(encodeOwnerRelayReply(reply))).toEqual(reply);
    });
    for (const key of ['nonce', 'sourceHubSessionId', 'sourceRuntimeId', 'callerBindingId', 'hostEpoch', 'sourceAuthority', 'relayEpoch', 'operation', 'payload']) {
        it(`rejects request ${key} tampering`, async () => {
            const { request } = await pair();
            const v = { ...request, [key]: key === 'payload' ? { ...request.payload, text: 'changed' } : key === 'sourceAuthority' ? { kind: 'confirmed-owner', bindingId: 'other' } : key === 'nonce' ? rotationBase64url(new Uint8Array(32).fill(3)) : 'other' };
            expect(await verifyOwnerRelayRequest(v, contact, now)).toBe(false);
        });
    }
    for (const key of ['requestId', 'nonce', 'intentDigest', 'sourceHubSessionId', 'sourceRuntimeId', 'callerBindingId', 'hostEpoch', 'sourceAuthority', 'relayEpoch', 'operation', 'responderSubject']) {
        it(`rejects mismatched ${key} even when the desktop signed it`, async () => {
            const { request, reply } = await pair();
            const v = { ...reply, [key]: key === 'sourceAuthority' ? { kind: 'confirmed-owner', bindingId: 'other' } : key === 'responderSubject' ? { issuer: 'https://api.example.com', userId: 'other' } : key === 'intentDigest' ? 'f'.repeat(64) : key === 'nonce' ? rotationBase64url(new Uint8Array(32).fill(3)) : key === 'operation' ? 'lookup-readable-sessions' : 'other' };
            // Wrong-operation payload is structurally invalid before signing.
            if (key === 'operation') expect(() => signOwnerRelayReply(v, desktop.secretKey)).toThrow();
            else expect(await verifyOwnerRelayReply(signOwnerRelayReply(v, desktop.secretKey), request, contact, now)).toBe(false);
        });
    }
    it('covers nested permission data and normalizes object key order', async () => {
        const { request } = await pair(4);
        const reversed = Object.fromEntries(Object.entries(request).reverse());
        expect(await ownerRelayIntentDigest(reversed)).toEqual(request.intentDigest);
        const changed = structuredClone(request) as any;
        changed.payload.updatedInput.answers.q = '다른 답변';
        expect(await ownerRelayIntentDigest(changed)).not.toEqual(request.intentDigest);
        expect(await verifyOwnerRelayRequest(changed, contact, now)).toBe(false);
    });
    it('rejects stale contact, wrong host/desktop keys, changed result and foreign target receipts', async () => {
        const { request, reply } = await pair();
        expect(await verifyOwnerRelayRequest(request, contact, contact.expiresAt)).toBe(false);
        expect(await verifyOwnerRelayRequest(request, { ...contact, callerPublicKey: contact.publicKey }, now)).toBe(false);
        expect(await verifyOwnerRelayReply(reply, request, { ...contact, publicKey: contact.callerPublicKey }, now)).toBe(false);
        expect(await verifyOwnerRelayReply({ ...reply, checkedAt: now + 1 }, request, contact, now)).toBe(false);
        const bad = signOwnerRelayReply({ ...reply, storage: { ...(reply as any).storage, localId: 'wrong' } }, desktop.secretKey);
        expect(await verifyOwnerRelayReply(bad, request, contact, now)).toBe(false);
    });
    it('refuses duplicate-key and noncanonical wire JSON', async () => {
        const { request } = await pair();
        const encoded = encodeOwnerRelayRequest(request);
        expect(() => decodeOwnerRelayRequest(' ' + encoded)).toThrow();
        expect(() => decodeOwnerRelayRequest(encoded.replace('{', '{"v":1,'))).toThrow();
    });
});

describe('cross-repository golden vectors (independent Node crypto producer)', () => {
    for (const vector of fixture.vectors) {
        it(`matches bytes, digest and signatures for ${vector.request.operation}`, async () => {
            const request = await signOwnerRelayRequest(vector.request, host.secretKey);
            const reply = signOwnerRelayReply(vector.reply, desktop.secretKey);
            expect(new TextDecoder().decode(ownerRelayRequestSigningBytes(request))).toBe(vector.requestSigningInput);
            expect(new TextDecoder().decode(ownerRelayReplySigningBytes(reply))).toBe(vector.replySigningInput);
            expect(request).toEqual(vector.request);
            expect(reply).toEqual(vector.reply);
            expect(encodeOwnerRelayRequest(request)).toEqual(vector.requestWire);
            expect(encodeOwnerRelayReply(reply)).toEqual(vector.replyWire);
            const c = vector.request.sourceAuthority.kind === 'personal-account' ? fixture.personalContact : fixture.contact;
            expect(verifyOwnership(c, rotationDecodeBinary(fixture.keys.issuerPublicKey, 32))).toBe(true);
            expect(await verifyOwnerRelayRequest(request, c, now)).toBe(true);
            expect(await verifyOwnerRelayReply(reply, request, c, now)).toBe(true);
        });
    }
});

describe('codec snapshots across async digest', () => {
    it('signs one immutable input snapshot even if caller mutates nested permission data', async () => {
        const input: any = structuredClone(fixture.vectors[4].request);
        const original = structuredClone(input);
        const pending = signOwnerRelayRequest(input, host.secretKey);
        input.payload.updatedInput.answers.q = 'changed while hashing';
        const signed = await pending;
        expect(signed.payload).toEqual(original.payload);
        expect(await verifyOwnerRelayRequest(signed, contact, now)).toBe(true);
    });
    it('verifies the original received bytes across the async hash boundary', async () => {
        const { request } = await pair(4);
        const pending = verifyOwnerRelayRequest(request, contact, now);
        (request.payload as any).updatedInput.answers.q = 'changed while checking';
        expect(await pending).toBe(true);
    });
    it('does not invoke non-JSON accessors', () => {
        let calls = 0;
        const value = Object.defineProperty({}, 'payload', { enumerable: true, get() { calls++; return {}; } });
        expect(() => signOwnerRelayReply(value, desktop.secretKey)).toThrow();
        expect(calls).toBe(0);
    });
});

it.each([3, 4, 5])('accepts an unknown control observation with unavailable runtime (%i)', async i => {
    const { request, reply } = await pair(i);
    const changed = signOwnerRelayReply({ ...reply, control: { ...(reply as any).control, runtimeId: null, state: 'unknown' } }, desktop.secretKey);
    expect(await verifyOwnerRelayReply(changed, request, contact, now)).toBe(true);
});
it.each([0, 1, 3, 4, 5, 6, 7])('rejects a correctly signed receipt for another target/child (%i)', async i => {
    const { request, reply } = await pair(i);
    const changed: any = structuredClone(reply);
    if (i === 0) changed.owners[0].sessionId = 'another';
    else if (i === 1) changed.sessionView.sessionId = 'another';
    else if (i < 6) changed.control.sessionId = 'another';
    else changed.childSpawn.parentSessionId = 'another';
    const c = i === 1 ? fixture.personalContact : contact;
    expect(await verifyOwnerRelayReply(signOwnerRelayReply(changed, desktop.secretKey), request, c, now)).toBe(false);
});
