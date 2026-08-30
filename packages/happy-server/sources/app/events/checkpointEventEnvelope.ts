import { z } from 'zod';

export const checkpointEventEnvelopeSchema = z.object({
    schemaVersion: z.literal(1),
    operationId: z.string().min(1).max(128),
    checkpointId: z.string().min(1).max(128),
    state: z.enum(['created', 'completed', 'partial', 'failed']),
    actor: z.enum(['agent', 'user']),
    timestamp: z.number().int().nonnegative(),
}).strict();

export type CheckpointEventEnvelope = z.infer<typeof checkpointEventEnvelopeSchema>;
