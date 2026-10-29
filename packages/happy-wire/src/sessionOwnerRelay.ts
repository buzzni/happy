import { z } from 'zod';
import { ownerRelayJsonWithin, OWNER_RELAY_REQUEST_BYTES, OWNER_RELAY_REPLY_BYTES } from './sessionOwnerRelayJson';
import { ownershipId as id, ownershipHash, OwnershipSourceAuthoritySchema, OwnershipSubjectSchema } from './sessionOwnership';
import { rotationDecodeBinary } from './sharedMachineRotation';
import { relayCount, relayLocalId, persistedId, OwnerRelayPromptPayloadSchema, OwnerRelayPermissionPayloadSchema,
    OwnerRelaySnapshotSchema, OwnerRelayReadEventSchema, OwnerRelaySpawnOptionsSchema, OwnerRelayChildReferenceSchema } from './sessionOwnerRelayPayloads';
const jsonRequest = z.unknown().refine(v => ownerRelayJsonWithin(v, OWNER_RELAY_REQUEST_BYTES), 'Invalid or oversized relay JSON');
const jsonReply = z.unknown().refine(v => ownerRelayJsonWithin(v, OWNER_RELAY_REPLY_BYTES), 'Invalid or oversized relay JSON');
const binary = (size: number) => z.string().refine(v => { try { rotationDecodeBinary(v, size); return true; } catch { return false; } });
const operations = [
    { operation: z.literal('lookup-readable-sessions'), payload: z.object({ sessionIds: z.array(id).max(100) }).strict() },
    { operation: z.literal('read-session'), targetSessionId: id,
        payload: z.object({ cursor: z.string().nullable(), limit: relayCount.min(1).max(50), waitMs: relayCount.max(15000) }).strict() },
    { operation: z.literal('prompt-own-session'), targetSessionId: id, localId: relayLocalId, payload: OwnerRelayPromptPayloadSchema },
    { operation: z.literal('resume-own-session'), targetSessionId: id,
        payload: z.object({ sessionId: id, expectedMachineId: persistedId, runtimeId: persistedId.nullable() }).strict() }, // copied from a read (H1-R-03)
    { operation: z.literal('reply-own-permission'), targetSessionId: id, payload: OwnerRelayPermissionPayloadSchema },
    { operation: z.literal('abort-own-turn'), targetSessionId: id, payload: z.object({ sessionId: id, runtimeId: persistedId }).strict() },
    { operation: z.literal('spawn-owned-child'), payload: OwnerRelayChildReferenceSchema.extend({ childAgentId: id, spawnOptions: OwnerRelaySpawnOptionsSchema }).strict() },
    { operation: z.literal('owned-child-status'), payload: OwnerRelayChildReferenceSchema },
] as const;
const local = { v: z.literal(1), entry: z.enum(['agent', 'chat']) };
const binding = { v: z.literal(1), requestId: id, nonce: binary(32), sourceHubSessionId: id, sourceRuntimeId: id,
    callerBindingId: id, hostEpoch: id, sourceAuthority: OwnershipSourceAuthoritySchema, relayEpoch: id, intentDigest: ownershipHash };
function targetsMatch(v: { operation: string; targetSessionId?: string; payload: unknown }): boolean {
    const p = v.payload as { sessionId?: string; hubPrompt?: { targetSessionId: string } };
    return (!p.sessionId || p.sessionId === v.targetSessionId) && (!p.hubPrompt || p.hubPrompt.targetSessionId === v.targetSessionId);
}
function requests<T extends z.ZodRawShape>(base: T) {
    return [
        z.object({ ...base, ...operations[0] }).strict(),
        z.object({ ...base, ...operations[1] }).strict(),
        z.object({ ...base, ...operations[2] }).strict(),
        z.object({ ...base, ...operations[3] }).strict(),
        z.object({ ...base, ...operations[4] }).strict(),
        z.object({ ...base, ...operations[5] }).strict(),
        z.object({ ...base, ...operations[6] }).strict(),
        z.object({ ...base, ...operations[7] }).strict(),
    ] as const;
}
export const OwnerContactRequestSchema = jsonRequest.pipe(z.discriminatedUnion('operation', requests(local)).refine(targetsMatch));
export const OwnerRelayRequestSchema = jsonRequest.pipe(z.discriminatedUnion('operation', requests({ ...local, ...binding, callerSignature: binary(64) }))
    .refine(targetsMatch).refine(v => !['spawn-owned-child', 'owned-child-status'].includes(v.operation)
        || v.sourceAuthority.kind === 'confirmed-owner', 'Owned child requires a confirmed source binding'));
export type OwnerContactRequest = z.infer<typeof OwnerContactRequestSchema>;
export type OwnerRelayRequest = z.infer<typeof OwnerRelayRequestSchema>;
const child = z.object({ ...OwnerRelayChildReferenceSchema.shape, state: z.enum(['pending', 'parked', 'started', 'failed']),
    stage: z.enum(['intent', 'prepared', 'sealed', 'created', 'confirmed', 'provider-started']),
    sessionId: id.nullable(), ownershipBindingId: id.nullable(), ownerSubject: OwnershipSubjectSchema,
    parentSessionId: id, providerRuntimeId: id.nullable(), reason: z.string().optional(),
}).strict().refine(v => v.state !== 'started' || (v.sessionId !== null && v.ownershipBindingId !== null
    && v.providerRuntimeId !== null && v.stage === 'provider-started'));
const control = { sessionId: id, runtimeId: persistedId.nullable(), state: z.enum(['accepted', 'rejected', 'unknown']), reason: z.string().optional() };
const results = [
    { operation: z.literal('lookup-readable-sessions'), owners: z.array(z.object({ sessionId: id,
        proof: OwnershipSourceAuthoritySchema.nullable(), ownerSubject: OwnershipSubjectSchema.nullable(),
        relation: z.enum(['self', 'descendant', 'own-sibling', 'other', 'unknown']), reason: z.string().optional() }).strict()).max(100) },
    { operation: z.literal('read-session'), sessionView: z.object({ sessionId: id, cursor: z.string().nullable(),
        snapshot: OwnerRelaySnapshotSchema, events: z.array(OwnerRelayReadEventSchema).max(50), truncated: z.boolean() }).strict() },
    { operation: z.literal('prompt-own-session'), storage: z.object({ messageId: id, seq: relayCount,
        localId: relayLocalId, bodyVerified: z.boolean() }).strict() },
    { operation: z.literal('resume-own-session'), control: z.object(control).strict() },
    { operation: z.literal('reply-own-permission'), control: z.object({ ...control, permissionId: persistedId }).strict() },
    { operation: z.literal('abort-own-turn'), control: z.object(control).strict() },
    { operation: z.literal('spawn-owned-child'), childSpawn: child },
    { operation: z.literal('owned-child-status'), childSpawn: child },
] as const;
const reply = { ...binding, responderSubject: OwnershipSubjectSchema, checkedAt: relayCount,
    reason: z.string().optional(), signature: binary(64) };
const allowed = z.discriminatedUnion('operation', [
    z.object({ ...reply, result: z.literal('allowed'), ...results[0] }).strict(),
    z.object({ ...reply, result: z.literal('allowed'), ...results[1] }).strict(),
    z.object({ ...reply, result: z.literal('allowed'), ...results[2] }).strict(),
    z.object({ ...reply, result: z.literal('allowed'), ...results[3] }).strict(),
    z.object({ ...reply, result: z.literal('allowed'), ...results[4] }).strict(),
    z.object({ ...reply, result: z.literal('allowed'), ...results[5] }).strict(),
    z.object({ ...reply, result: z.literal('allowed'), ...results[6] }).strict(),
    z.object({ ...reply, result: z.literal('allowed'), ...results[7] }).strict(),
]);
export const OwnerRelayReplySchema = jsonReply.pipe(z.union([allowed, z.object({ ...reply,
    operation: z.enum(operations.map(op => op.operation.value)), result: z.enum(['not_owned', 'unavailable', 'unknown']) }).strict()]));
export type OwnerRelayReply = z.infer<typeof OwnerRelayReplySchema>;
