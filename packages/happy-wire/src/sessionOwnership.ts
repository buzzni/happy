import { z } from 'zod';
import nacl from 'tweetnacl';
import { canonicalOrgSetupTokenJson } from './orgSetupTokenApproval';
import { RotationOriginSchema, rotationBase64url, rotationDecodeBinary, rotationSha256 } from './sharedMachineRotation';

// T4o v1. Flat signed documents; no execution-ticket domain or metadata authority.
// eslint-disable-next-line no-control-regex -- reject control characters in identifiers
export const ownershipId = z.string().min(1).max(128).regex(/^[^\s\u0000-\u001f\u007f-\u009f]+$/);
export const ownershipHash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).refine(v => !Object.is(v, -0));
const binary = (size: number) => z.string().refine(v => {
    try { rotationDecodeBinary(v, size); return true; } catch { return false; }
});
export const OwnershipSubjectSchema = z.object({ issuer: RotationOriginSchema, userId: ownershipId }).strict();
export type OwnershipSubject = z.infer<typeof OwnershipSubjectSchema>;
const signed = { version: z.literal(1), issuer: RotationOriginSchema, audience: RotationOriginSchema,
    keyId: ownershipHash, issuedAt: time, expiresAt: time, signature: binary(64) };
const bounded = (max: number) => (v: { issuedAt: number; expiresAt: number }) =>
    v.expiresAt > v.issuedAt && v.expiresAt - v.issuedAt <= max;
export const OwnershipIntentRequestSchema = z.object({
    operationId: ownershipId, creationRequestId: ownershipId,
    ownershipPolicy: z.enum(['prefer-owned', 'require-owned']), machineId: ownershipId,
    projectId: ownershipId.nullable(), parentHubSessionId: ownershipId.nullable(),
    normalizedSpawnDigest: ownershipHash,
}).strict();
export type OwnershipIntentRequest = z.infer<typeof OwnershipIntentRequestSchema>;
const scope = { intentId: ownershipId, operationId: ownershipId, creationRequestId: ownershipId,
    ownershipPolicy: z.enum(['prefer-owned', 'require-owned']), subject: OwnershipSubjectSchema,
    companyId: ownershipId.nullable(), projectId: ownershipId.nullable(), machineId: ownershipId,
    machineAccountId: ownershipId, sessionAccountId: ownershipId, parentHubSessionId: ownershipId.nullable(),
    spawnDigest: ownershipHash };
export const SessionOwnershipIntentSchema = z.object({
    ...signed, type: z.literal('saycode-session-ownership-intent'), ...scope,
}).strict().refine(bounded(120000));
export const SessionOwnershipProofSchema = z.object({
    ...signed, type: z.literal('saycode-session-ownership'), ...scope,
    nonce: binary(32), tagHash: ownershipHash, createBodyHash: ownershipHash,
}).strict().refine(bounded(60000));
export type SessionOwnershipIntent = z.infer<typeof SessionOwnershipIntentSchema>;
export type SessionOwnershipProof = z.infer<typeof SessionOwnershipProofSchema>;
export const OwnershipPrepareReceiptSchema = z.object({
    preparationId: ownershipId, operationId: ownershipId, intentDigest: ownershipHash,
    sessionCreateBodyHash: ownershipHash, sessionTagHash: ownershipHash,
}).strict();
export const OwnershipConfirmRequestSchema = z.object({
    requestId: ownershipId, intentId: ownershipId, bindingId: ownershipId, createDigest: ownershipHash,
}).strict();
export const OwnershipConfirmAssertionSchema = z.object({
    ...signed, type: z.literal('saycode-session-ownership-confirm'), requestId: ownershipId,
    sessionId: ownershipId, bindingId: ownershipId, operationId: ownershipId,
    sessionAccountId: ownershipId, subject: OwnershipSubjectSchema, createDigest: ownershipHash,
}).strict().refine(bounded(60000));
export type OwnershipConfirmAssertion = z.infer<typeof OwnershipConfirmAssertionSchema>;
export const OwnershipConfirmedReceiptSchema = z.object({
    ...signed, type: z.literal('saycode-session-ownership-receipt'), requestId: ownershipId,
    operationId: ownershipId, creationRequestId: ownershipId, ownershipPolicy: z.enum(['prefer-owned', 'require-owned']),
    preparationId: ownershipId, sessionId: ownershipId, bindingId: ownershipId, subject: OwnershipSubjectSchema,
    createDigest: ownershipHash, parentHubSessionId: ownershipId.nullable(), spawnDigest: ownershipHash,
    state: z.literal('confirmed'),
}).strict().refine(bounded(60000));
export const OwnershipLookupAssertionSchema = z.object({
    ...signed, type: z.literal('saycode-session-ownership-lookup'), subject: OwnershipSubjectSchema,
    sessions: z.array(z.object({ sessionId: ownershipId, sessionAccountId: ownershipId }).strict()).min(1).max(100),
}).strict().refine(bounded(60000));
export const OwnershipMachineAssertionSchema = z.object({
    ...signed, type: z.literal('saycode-session-ownership-machine'), machineId: ownershipId,
    machineAccountId: ownershipId,
}).strict().refine(bounded(60000));
export const OwnershipLookupRequestSchema = z.object({ sessionIds: z.array(ownershipId).min(1).max(100) }).strict();
export const OwnershipViewSchema = z.object({
    sessionId: ownershipId, bindingId: ownershipId.nullable(), ownerSubject: OwnershipSubjectSchema.nullable(),
    state: z.enum(['unknown', 'pending', 'confirmed', 'unavailable']), checkedAt: time, reason: z.string().nullable(),
}).strict().refine(v => v.state === 'confirmed'
    ? v.bindingId !== null && v.ownerSubject !== null
    : v.ownerSubject === null && (v.state !== 'pending' || v.bindingId !== null));
export type OwnershipView = z.infer<typeof OwnershipViewSchema>;
export const MachineAgentIdentitySchema = z.object({
    ...signed, type: z.literal('saycode-machine-agent-identity'), descriptorId: ownershipId,
    machineId: ownershipId, happyAccountId: ownershipId, ownerSubject: OwnershipSubjectSchema.nullable(),
    registrationType: z.enum(['personal', 'company']), accountKind: z.enum(['personal', 'company']),
    registrationRevision: ownershipHash, observedAt: time,
}).strict().refine(bounded(60000)).refine(v =>
    (v.registrationType === 'personal' && v.accountKind === 'personal') === (v.ownerSubject !== null));
export type MachineAgentIdentity = z.infer<typeof MachineAgentIdentitySchema>;
export const OwnershipSourceAuthoritySchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('confirmed-owner'), bindingId: ownershipId }).strict(),
    z.object({ kind: z.literal('personal-account'), descriptorId: ownershipId, registrationRevision: ownershipHash }).strict(),
]);
export const OwnershipCallerBindingSchema = z.object({
    callerBindingId: ownershipId, sessionId: ownershipId, runtimeId: ownershipId,
    machineId: ownershipId, happyAccountId: ownershipId, scope: z.string().min(1).max(4096),
    depth: z.number().int().min(0).max(128), hostEpoch: ownershipId, callerPublicKey: binary(32),
}).strict();
export const OwnershipRelayRegistrationSchema = z.object({
    sourceAuthority: OwnershipSourceAuthoritySchema, caller: OwnershipCallerBindingSchema,
    descriptor: MachineAgentIdentitySchema.optional(), desktopInstanceId: ownershipId,
    publicKey: binary(32), method: z.string().regex(/^owner-relay-v1:[A-Za-z0-9_-]{16,128}$/),
    epoch: ownershipId,
}).strict();
export const OwnershipRelayContactSchema = z.object({
    ...signed, type: z.literal('saycode-owner-relay-contact'), hubId: ownershipId,
    sourceAuthority: OwnershipSourceAuthoritySchema, callerBindingId: ownershipId,
    sourceRuntimeId: ownershipId, hostEpoch: ownershipId, callerPublicKey: binary(32),
    machineId: ownershipId, happyAccountId: ownershipId, scope: z.string().min(1).max(4096),
    depth: z.number().int().min(0).max(128), ownerSubject: OwnershipSubjectSchema,
    desktopInstanceId: ownershipId, publicKey: binary(32),
    method: z.string().regex(/^owner-relay-v1:[A-Za-z0-9_-]{16,128}$/), epoch: ownershipId,
}).strict().refine(bounded(60000));
export type OwnershipRelayContact = z.infer<typeof OwnershipRelayContactSchema>;

export function ownershipSigningBytes(value: { type: string; signature?: string }): Uint8Array {
    const body = { ...value };
    delete body.signature;
    return new TextEncoder().encode('saycode-session-ownership/v1\0' + body.type + '\0' + canonicalOrgSetupTokenJson(body));
}
export function signOwnership<T extends { type: string }>(body: T, secretKey: Uint8Array): T & { signature: string } {
    return { ...body, signature: rotationBase64url(nacl.sign.detached(ownershipSigningBytes(body), secretKey)) };
}
export function verifyOwnership(value: { type: string; signature: string }, publicKey: Uint8Array): boolean {
    try { return nacl.sign.detached.verify(ownershipSigningBytes(value), rotationDecodeBinary(value.signature, 64), publicKey); }
    catch { return false; }
}
export function ownershipFresh(value: { issuedAt: number; expiresAt: number }, now = Date.now()): boolean {
    // Match rotation documents: bounded future clock skew, never extended expiry.
    return value.issuedAt <= now + 60000 && now < value.expiresAt;
}
export const ownershipDigest = (value: unknown) => rotationSha256(new TextEncoder().encode(canonicalOrgSetupTokenJson(value)));
