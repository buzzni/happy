import { z } from 'zod';

const identifierSchema = z.string().min(1).max(128);

const projectRelativePathSchema = z.string().min(1).refine((value) => {
    if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value)) return false;
    return !value.split(/[\\/]+/).includes('..');
}, 'path must be project-relative');

export const checkpointMutationGateRequestSchema = z.object({
    schemaVersion: z.literal(1),
    operationId: identifierSchema,
    sessionId: identifierSchema,
    projectId: identifierSchema,
    worktreeId: identifierSchema.nullable(),
    projectPath: z.string().min(1),
}).strict();

export type CheckpointMutationGateRequest = z.infer<typeof checkpointMutationGateRequestSchema>;

export const checkpointProtectionStateSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('protected') }).strict(),
    z.object({
        status: z.literal('unavailable'),
        reason: z.enum([
            'snapshot-failed',
            'excluded-path',
            'unsupported-provider',
            'invalid-project-binding',
        ]),
    }).strict(),
    z.object({ status: z.literal('legacy') }).strict(),
]);

export type CheckpointProtectionState = z.infer<typeof checkpointProtectionStateSchema>;

const checkpointFileSummarySchema = z.object({
    path: projectRelativePathSchema,
    action: z.enum(['created', 'modified', 'deleted', 'skipped', 'conflict']),
}).strict();

const checkpointExcludedSummarySchema = z.object({
    path: projectRelativePathSchema,
    reason: z.enum(['secret', 'ignored', 'too-large', 'file-limit', 'total-size-limit']),
}).strict();

export const checkpointEventDetailSchema = z.object({
    schemaVersion: z.literal(1),
    checkpointId: identifierSchema,
    state: z.enum(['created', 'completed', 'partial', 'failed']),
    actor: z.enum(['agent', 'user']),
    timestamp: z.number().int().nonnegative(),
    summary: z.object({
        files: z.array(checkpointFileSummarySchema),
        excluded: z.array(checkpointExcludedSummarySchema),
    }).strict(),
}).strict();

export type CheckpointEventDetail = z.infer<typeof checkpointEventDetailSchema>;
