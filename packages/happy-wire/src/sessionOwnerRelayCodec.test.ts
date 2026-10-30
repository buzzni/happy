import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import fixture from './fixtures/sessionOwnerRelay.v1.json';
import { verifyOwnership } from './sessionOwnership';
import { SessionMessageSchema } from './messages';
import { canonicalOwnerRelayJson } from './sessionOwnerRelayJson';
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

// H1-R-01: reads preserve persisted envelope IDs; prompt IDs are a separate contract.
describe('H1-R-01 persisted message localId compatibility', () => {
    it.each([
        ['Unicode', '기존메시지'],
        ['spaces', 'existing message'],
        ['Unicode and spaces', '기존 메시지'],
        ['over 128 characters', 'x'.repeat(129)],
        ['null', null],
        ['omitted', undefined],
        ['empty string', ''],
        ['prompt-compatible', 'uuid'],
    ] as const)('read signing and codec preserve %s', async (_label, localId) => {
        const stored = SessionMessageSchema.parse({
            id: 'legacy-message', seq: 1, createdAt: 1, updatedAt: 1,
            ...(localId === undefined ? {} : { localId }),
            content: { t: 'encrypted', c: 'stored-ciphertext' },
        });
        const event = { ...stored, content: { role: 'user', content: { type: 'text', text: '기존 내용' } } };
        const { request, reply } = await pair(1);
        if (reply.result !== 'allowed' || reply.operation !== 'read-session') throw new Error('Expected read fixture');
        const signed = signOwnerRelayReply({ ...reply, sessionView: { ...reply.sessionView, events: [event] } }, desktop.secretKey);
        const decoded = decodeOwnerRelayReply(encodeOwnerRelayReply(signed));
        expect(decoded).toEqual(signed);
        if (decoded.result !== 'allowed' || decoded.operation !== 'read-session') throw new Error('Expected read reply');
        expect(decoded.sessionView.events).toEqual([event]);
        expect(await verifyOwnerRelayReply(decoded, request, fixture.personalContact, now)).toBe(true);
        decoded.sessionView.events[0].localId = 'unsigned-change';
        expect(await verifyOwnerRelayReply(decoded, request, fixture.personalContact, now)).toBe(false);
    });
    // H1-R-02: every persisted identifier a read carries keeps its producer's string contract, not ownershipId.
    it.each(['legacy id with spaces', 'x'.repeat(129)])('read preserves persisted message, permission, activity and runtime IDs (%s)', async persisted => {
        const { request, reply } = await pair(1);
        if (reply.result !== 'allowed' || reply.operation !== 'read-session') throw new Error('Expected read fixture');
        const snapshot = { ...reply.sessionView.snapshot, runtimeId: persisted, machineId: persisted,
            pendingPermissionRequests: [{ ...reply.sessionView.snapshot.pendingPermissionRequests![0]!, requestId: persisted }],
            activity: { state: 'known' as const, title: 't', inProgress: [], text: null, source: 'plan' as const, sourceMessageId: persisted, sourceSeq: 1, reason: null, observedAt: 1 } };
        const event = { id: persisted, seq: 1, localId: null, createdAt: 1, updatedAt: 1, content: { role: 'user', content: { type: 'text', text: '기존 내용' } } };
        const signed = signOwnerRelayReply({ ...reply, sessionView: { ...reply.sessionView, snapshot, events: [event] } }, desktop.secretKey);
        const decoded = decodeOwnerRelayReply(encodeOwnerRelayReply(signed));
        expect(decoded).toEqual(signed);
        expect(await verifyOwnerRelayReply(decoded, request, fixture.personalContact, now)).toBe(true);
    });
    it.each(['legacy id with spaces', 'x'.repeat(129)])('reply-own-permission addresses a persisted permission ID (%s)', persisted => {
        const vector = fixture.vectors.find((v: { request: { operation: string } }) => v.request.operation === 'reply-own-permission')!;
        expect(OwnerRelayRequestSchema.safeParse({ ...vector.request, payload: { ...vector.request.payload, permissionId: persisted } }).success).toBe(true);
    });
    // H1-R-03/04: IDs a caller copies from a read (machine, runtime) or from existing spawn options keep their producers' contract.
    const vectorFor = (operation: string) => fixture.vectors.find((v: { request: { operation: string } }) => v.request.operation === operation)!;
    it.each(['legacy id with spaces', 'x'.repeat(129)])('control requests address persisted machine and runtime IDs (%s)', persisted => {
        const resume = vectorFor('resume-own-session'), abort = vectorFor('abort-own-turn'), permission = vectorFor('reply-own-permission');
        expect(OwnerRelayRequestSchema.safeParse({ ...resume.request, payload: { ...resume.request.payload, expectedMachineId: persisted, runtimeId: persisted } }).success).toBe(true);
        expect(OwnerRelayRequestSchema.safeParse({ ...abort.request, payload: { ...abort.request.payload, runtimeId: persisted } }).success).toBe(true);
        expect(OwnerRelayRequestSchema.safeParse({ ...permission.request, payload: { ...permission.request.payload, runtimeId: persisted } }).success).toBe(true);
        for (const vector of [resume, abort, permission]) expect(OwnerRelayReplySchema.safeParse({ ...vector.reply, control: { ...vector.reply.control, runtimeId: persisted } }).success).toBe(true);
    });
    it.each(['기존 메시지', 'x'.repeat(129)])('spawn options carry an existing initialPromptLocalId (%s)', initialPromptLocalId => {
        const spawn = vectorFor('spawn-owned-child');
        const spawnOptions = { ...spawn.request.payload.spawnOptions, initialPromptLocalId };
        expect(OwnerRelayRequestSchema.safeParse({ ...spawn.request, payload: { ...spawn.request.payload, spawnOptions } }).success).toBe(true);
    });
    // H1-R-05: the wire refuses what the daemon would refuse (sessionEnv.ts MANAGED_ACCOUNT_ID / GROUP_SCOPE).
    it.each([
        ['a valid selection', '0f8fad5b-d9cb-469f-a165-70867728950e', 'company_1', true],
        ['a non-UUID managed account', 'not-uuid', 'company_1', false],
        ['an upper-case UUID', '0F8FAD5B-D9CB-469F-A165-70867728950E', 'company_1', false],
        ['a Unicode group scope', '0f8fad5b-d9cb-469f-a165-70867728950e', '조직', false],
    ] as const)('aiAuthSelection claude-setup-token accepts only daemon-valid IDs: %s', (_label, managedAccountId, groupScope, ok) => {
        const spawn = vectorFor('spawn-owned-child');
        const aiAuthSelection = { kind: 'claude-setup-token', managedAccountId, groupScope, credentialGeneration: 1, bindingGrant: 'abc.def' };
        const spawnOptions = { ...spawn.request.payload.spawnOptions, aiAuthSelection };
        expect(OwnerRelayRequestSchema.safeParse({ ...spawn.request, payload: { ...spawn.request.payload, spawnOptions } }).success).toBe(ok);
    });
    // H1-R-06/07: the prompt receipt carries the stored row's own ID, and only a body-verified receipt is a success.
    it.each(['legacy message id', 'x'.repeat(129)])('prompt storage carries the stored row ID (%s)', messageId => {
        const prompt = vectorFor('prompt-own-session');
        expect(OwnerRelayReplySchema.safeParse({ ...prompt.reply, storage: { ...prompt.reply.storage, messageId } }).success).toBe(true);
    });
    it('read snapshot keeps an empty machine observation from the existing session list', async () => {
        const { reply } = await pair(1);
        if (reply.result !== 'allowed' || reply.operation !== 'read-session') throw new Error('Expected read fixture');
        expect(OwnerRelayReplySchema.safeParse({ ...reply, sessionView: { ...reply.sessionView, snapshot: { ...reply.sessionView.snapshot, machineId: '' } } }).success).toBe(true);
    });
    it('refuses a correctly signed prompt reply whose body was not verified', async () => {
        const { request, reply } = await pair(2);
        if (reply.result !== 'allowed' || reply.operation !== 'prompt-own-session') throw new Error('Expected prompt fixture');
        const { signature: _, ...body } = { ...reply, storage: { ...reply.storage, bodyVerified: false } };
        expect(OwnerRelayReplySchema.safeParse({ ...body, signature: reply.signature }).success).toBe(false);
        // Signed over the same domain-separated canonical bytes, bypassing schema checks, so only the success rule can refuse it.
        const bytes = new TextEncoder().encode('saycode-owner-relay/v1\u0000reply\u0000' + canonicalOwnerRelayJson(body));
        const signed = { ...body, signature: rotationBase64url(nacl.sign.detached(bytes, desktop.secretKey)) };
        expect(await verifyOwnerRelayReply(signed, request, contact, now)).toBe(false);
        // Positive control: the same bytes with bodyVerified:true verify.
        const good = { ...body, storage: { ...body.storage, bodyVerified: true } };
        const goodBytes = new TextEncoder().encode('saycode-owner-relay/v1\u0000reply\u0000' + canonicalOwnerRelayJson(good));
        expect(await verifyOwnerRelayReply({ ...good, signature: rotationBase64url(nacl.sign.detached(goodBytes, desktop.secretKey)) }, request, contact, now)).toBe(true);
    });
    // H1-R-08: a stored receipt needs a positive seq, as the existing receipt producer requires.
    it.each([[0, false], [1, true]] as const)('prompt storage seq %s is a success only when positive', async (seq, ok) => {
        const { request, reply } = await pair(2);
        if (reply.result !== 'allowed' || reply.operation !== 'prompt-own-session') throw new Error('Expected prompt fixture');
        const { signature: _, ...body } = { ...reply, storage: { ...reply.storage, seq } };
        const bytes = new TextEncoder().encode('saycode-owner-relay/v1\u0000reply\u0000' + canonicalOwnerRelayJson(body));
        expect(await verifyOwnerRelayReply({ ...body, signature: rotationBase64url(nacl.sign.detached(bytes, desktop.secretKey)) }, request, contact, now)).toBe(ok);
    });
    // H1-R-09: a read carries the existing producer's empty permission key; acting on it is still refused.
    it('read snapshot carries an empty pending permission requestId, while a permission reply cannot target it', async () => {
        const { reply } = await pair(1);
        if (reply.result !== 'allowed' || reply.operation !== 'read-session') throw new Error('Expected read fixture');
        const snapshot = { ...reply.sessionView.snapshot, pendingPermissionRequests: [{ ...reply.sessionView.snapshot.pendingPermissionRequests![0]!, requestId: '' }] };
        expect(OwnerRelayReplySchema.safeParse({ ...reply, sessionView: { ...reply.sessionView, snapshot } }).success).toBe(true);
        const permission = vectorFor('reply-own-permission');
        expect(OwnerRelayRequestSchema.safeParse({ ...permission.request, payload: { ...permission.request.payload, permissionId: '' } }).success).toBe(false);
    });
    // H1-R-10: observed times keep the producers' positive finite numbers (pendingPermission.timestampValue, agentActivity).
    it('read snapshot carries fractional observed times from the existing producers', async () => {
        const { request, reply } = await pair(1);
        if (reply.result !== 'allowed' || reply.operation !== 'read-session') throw new Error('Expected read fixture');
        const snapshot = { ...reply.sessionView.snapshot,
            pendingPermissionRequests: [{ ...reply.sessionView.snapshot.pendingPermissionRequests![0]!, createdAt: 1.5, expiresAt: 2.5 }],
            activity: { state: 'known' as const, title: 't', inProgress: [], text: null, source: 'plan' as const, sourceMessageId: 'm', sourceSeq: 1, reason: null, observedAt: 1.25 } };
        const signed = signOwnerRelayReply({ ...reply, sessionView: { ...reply.sessionView, snapshot } }, desktop.secretKey);
        const decoded = decodeOwnerRelayReply(encodeOwnerRelayReply(signed));
        expect(decoded).toEqual(signed);
        expect(await verifyOwnerRelayReply(decoded, request, fixture.personalContact, now)).toBe(true);
        for (const bad of [0, -1, Number.NaN]) expect(OwnerRelayReplySchema.safeParse({ ...reply, sessionView: { ...reply.sessionView,
            snapshot: { ...snapshot, pendingPermissionRequests: [{ ...snapshot.pendingPermissionRequests[0]!, createdAt: bad }] } } }).success).toBe(false);
    });
    // The read event as a whole is the existing SessionMessage envelope: its numbers keep that schema too.
    it('read event keeps the existing envelope numbers', async () => {
        const { request, reply } = await pair(1);
        if (reply.result !== 'allowed' || reply.operation !== 'read-session') throw new Error('Expected read fixture');
        const stored = SessionMessageSchema.parse({ id: 'm', seq: 0, createdAt: 1.5, updatedAt: 2.5, content: { t: 'encrypted', c: 'x' } });
        const event = { ...stored, content: { role: 'user', content: { type: 'text', text: 't' } } };
        const signed = signOwnerRelayReply({ ...reply, sessionView: { ...reply.sessionView, events: [event] } }, desktop.secretKey);
        expect(await verifyOwnerRelayReply(decodeOwnerRelayReply(encodeOwnerRelayReply(signed)), request, fixture.personalContact, now)).toBe(true);
    });
    // H1-R-11: an accepted control names the runtime it ran on; an unconfirmed one is unknown, not accepted.
    it.each(['resume-own-session', 'reply-own-permission', 'abort-own-turn'])('%s accepted needs a confirmed runtime', operation => {
        const vector = vectorFor(operation);
        const withControl = (patch: Record<string, unknown>) => ({ ...vector.reply, control: { ...vector.reply.control, ...patch } });
        expect(OwnerRelayReplySchema.safeParse(withControl({ state: 'accepted', runtimeId: null })).success).toBe(false);
        expect(OwnerRelayReplySchema.safeParse(withControl({ state: 'accepted', runtimeId: vector.reply.control?.runtimeId ?? 'target-runtime' })).success).toBe(true);
        expect(OwnerRelayReplySchema.safeParse(withControl({ state: 'unknown', runtimeId: null })).success).toBe(true);
        expect(OwnerRelayReplySchema.safeParse(withControl({ state: 'rejected', runtimeId: null })).success).toBe(true);
    });
    it.each(['기존 메시지', 'existing message', 'x'.repeat(129)])('keeps prompt and storage ID restrictions for %s', localId => {
        expect(OwnerRelayRequestSchema.safeParse({ ...fixture.vectors[2].request, localId }).success).toBe(false);
        const reply = fixture.vectors[2].reply;
        expect(OwnerRelayReplySchema.safeParse({ ...reply, storage: { ...reply.storage, localId } }).success).toBe(false);
    });
});
