import { z } from 'zod';

// Agent broker personal sibling relation v1: `POST /v1/session-ownership/relation`.
// Happy Server answers it and happy-cli reads it; both use these schemas so the contract cannot drift.
// v1 `own` permanently means personal Saycode account + registered personal machine + same Happy account.
// Company ownership will be a new proof value, which v1 readers reject.
export const SESSION_OWNERSHIP_RELATION_MAX_TARGETS = 100;
const relationId = z.string().min(1).max(128);

export const SessionOwnershipRelationRequestSchema = z.object({
    v: z.literal(1), callerSessionId: relationId, machineId: relationId,
    sessionIds: z.array(relationId).min(1).max(SESSION_OWNERSHIP_RELATION_MAX_TARGETS),
}).strict();
export type SessionOwnershipRelationRequest = z.infer<typeof SessionOwnershipRelationRequestSchema>;

export const SessionOwnershipRelationResponseSchema = z.union([
    z.object({ v: z.literal(1), callerAccountId: z.string().min(1), proof: z.null(), unavailable: z.literal(true) }).strict(),
    z.object({ v: z.literal(1), callerAccountId: z.string().min(1), proof: z.literal('personal-same-account').nullable(),
        relations: z.record(z.string(), z.enum(['own', 'not-own'])) }).strict(),
]);
export type SessionOwnershipRelationResponse = z.infer<typeof SessionOwnershipRelationResponseSchema>;
