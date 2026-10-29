import nacl from 'tweetnacl';
import { OwnerRelayRequestSchema, OwnerRelayReplySchema, type OwnerRelayRequest, type OwnerRelayReply } from './sessionOwnerRelay';
import { OwnershipRelayContactSchema, ownershipFresh, type OwnershipRelayContact } from './sessionOwnership';
import { rotationBase64url, rotationDecodeBinary, rotationSha256 } from './sharedMachineRotation';
import { canonicalOwnerRelayJson as canonical, OWNER_RELAY_REQUEST_BYTES, OWNER_RELAY_REPLY_BYTES } from './sessionOwnerRelayJson';
const encoder = new TextEncoder();
const zeroSignature = rotationBase64url(new Uint8Array(64));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const requestDomain = 'saycode-owner-relay/v1\0request\0';
const replyDomain = 'saycode-owner-relay/v1\0reply\0';
const intentDomain = 'saycode-owner-relay/v1\0intent\0';
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected relay object');
    return JSON.parse(canonical(value)) as Record<string, unknown>;
}
/** No default filling, coercion or trimming. Transport retry nonce/requestId/relayEpoch are not
 * logical intent; the fixed source binding, entry, target, localId and complete payload are. */
export async function ownerRelayIntentDigest(value: unknown): Promise<string> {
    const r = OwnerRelayRequestSchema.parse({ ...object(value), intentDigest: '0'.repeat(64), callerSignature: zeroSignature });
    const { requestId, nonce, relayEpoch, intentDigest, callerSignature, ...intent } = r;
    return rotationSha256(encoder.encode(intentDomain + canonical(intent, OWNER_RELAY_REQUEST_BYTES)));
}
export function ownerRelayRequestSigningBytes(value: unknown): Uint8Array {
    const { callerSignature, ...body } = OwnerRelayRequestSchema.parse(value);
    return encoder.encode(requestDomain + canonical(body, OWNER_RELAY_REQUEST_BYTES));
}
export function ownerRelayReplySigningBytes(value: unknown): Uint8Array {
    const { signature, ...body } = OwnerRelayReplySchema.parse(value);
    return encoder.encode(replyDomain + canonical(body));
}
export async function signOwnerRelayRequest(value: unknown, secretKey: Uint8Array): Promise<OwnerRelayRequest> {
    const snapshot = object(value);
    const body = OwnerRelayRequestSchema.parse({ ...snapshot, intentDigest: await ownerRelayIntentDigest(snapshot), callerSignature: zeroSignature });
    return OwnerRelayRequestSchema.parse({ ...body, callerSignature: rotationBase64url(nacl.sign.detached(ownerRelayRequestSigningBytes(body), secretKey)) });
}
export function signOwnerRelayReply(value: unknown, secretKey: Uint8Array): OwnerRelayReply {
    const body = OwnerRelayReplySchema.parse({ ...object(value), signature: zeroSignature });
    return OwnerRelayReplySchema.parse({ ...body, signature: rotationBase64url(nacl.sign.detached(ownerRelayReplySigningBytes(body), secretKey)) });
}
function contactMatches(r: OwnerRelayRequest, c: OwnershipRelayContact, now: number): boolean {
    return Number.isFinite(now) && ownershipFresh(c, now) && r.sourceHubSessionId === c.hubId
        && r.sourceRuntimeId === c.sourceRuntimeId && r.callerBindingId === c.callerBindingId
        && r.hostEpoch === c.hostEpoch && r.relayEpoch === c.epoch && same(r.sourceAuthority, c.sourceAuthority);
}
/** verifiedContact MUST already have a trusted issuer/audience/server signature and current
 * registration verified by the caller. This function does not grant ACLs or consume replay nonces. */
export async function verifyOwnerRelayRequest(value: unknown, verifiedContact: unknown, now: number): Promise<boolean> {
    try {
        const r = OwnerRelayRequestSchema.parse(object(value)), c = OwnershipRelayContactSchema.parse(object(verifiedContact));
        return contactMatches(r, c, now) && r.intentDigest === await ownerRelayIntentDigest(r)
            && nacl.sign.detached.verify(ownerRelayRequestSigningBytes(r), rotationDecodeBinary(r.callerSignature, 64), rotationDecodeBinary(c.callerPublicKey, 32));
    } catch { return false; }
}
function resultMatches(r: OwnerRelayReply, q: OwnerRelayRequest): boolean {
    if (r.result !== 'allowed') return true;
    switch (r.operation) {
        case 'lookup-readable-sessions': return q.operation === r.operation && r.owners.every(row => q.payload.sessionIds.includes(row.sessionId));
        case 'read-session': return q.operation === r.operation && r.sessionView.sessionId === q.targetSessionId && r.sessionView.events.length <= q.payload.limit;
        case 'prompt-own-session': return q.operation === r.operation && r.storage.localId === q.localId;
        case 'resume-own-session': case 'abort-own-turn': return q.operation === r.operation && r.control.sessionId === q.targetSessionId
            && (q.operation !== 'abort-own-turn' || r.control.runtimeId === null || r.control.runtimeId === q.payload.runtimeId);
        case 'reply-own-permission': return q.operation === r.operation && r.control.sessionId === q.targetSessionId
            && (r.control.runtimeId === null || r.control.runtimeId === q.payload.runtimeId) && r.control.permissionId === q.payload.permissionId;
        case 'spawn-owned-child': case 'owned-child-status': return q.operation === r.operation
            && r.childSpawn.parentSessionId === q.sourceHubSessionId && r.childSpawn.operationId === q.payload.operationId
            && r.childSpawn.spawnId === q.payload.spawnId && r.childSpawn.spawnDigest === q.payload.spawnDigest
            && same(r.childSpawn.ownerSubject, r.responderSubject);
    }
}
export async function verifyOwnerRelayReply(value: unknown, request: unknown, verifiedContact: unknown, now: number): Promise<boolean> {
    try {
        const r = OwnerRelayReplySchema.parse(object(value)), q = OwnerRelayRequestSchema.parse(object(request)), c = OwnershipRelayContactSchema.parse(object(verifiedContact));
        const keys = ['v', 'requestId', 'nonce', 'intentDigest', 'sourceHubSessionId', 'sourceRuntimeId', 'callerBindingId',
            'hostEpoch', 'sourceAuthority', 'relayEpoch', 'operation'] as const;
        return await verifyOwnerRelayRequest(q, c, now) && keys.every(k => same(r[k], q[k]))
            && same(r.responderSubject, c.ownerSubject) && resultMatches(r, q)
            && nacl.sign.detached.verify(ownerRelayReplySigningBytes(r), rotationDecodeBinary(r.signature, 64), rotationDecodeBinary(c.publicKey, 32));
    } catch { return false; }
}
export const encodeOwnerRelayRequest = (v: unknown): string => canonical(OwnerRelayRequestSchema.parse(v), OWNER_RELAY_REQUEST_BYTES);
export const encodeOwnerRelayReply = (v: unknown): string => canonical(OwnerRelayReplySchema.parse(v));
function decode(text: string, maxBytes: number): unknown {
    if (typeof text !== 'string' || encoder.encode(text).length > maxBytes) throw new Error('Invalid relay wire size');
    const value: unknown = JSON.parse(text);
    // Requiring canonical transport bytes also rejects duplicate keys/escaped aliases, before
    // schema parsing could collapse them. Object transports use schemas and signing bytes directly.
    if (canonical(value, maxBytes) !== text) throw new Error('Noncanonical relay JSON');
    return value;
}
export const decodeOwnerRelayRequest = (text: string): OwnerRelayRequest => OwnerRelayRequestSchema.parse(decode(text, OWNER_RELAY_REQUEST_BYTES));
export const decodeOwnerRelayReply = (text: string): OwnerRelayReply => OwnerRelayReplySchema.parse(decode(text, OWNER_RELAY_REPLY_BYTES));
