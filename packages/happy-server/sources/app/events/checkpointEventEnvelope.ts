import { z } from 'zod';

const operationIdSchema = z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const checkpointIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/);

export const checkpointEventEnvelopeSchema = z.object({
    schemaVersion: z.literal(1),
    operationId: operationIdSchema,
    checkpointId: checkpointIdSchema,
    state: z.enum(['created', 'completed', 'partial', 'failed']),
    actor: z.enum(['agent', 'user']),
    timestamp: z.number().int().nonnegative(),
}).strict();

export type CheckpointEventEnvelope = z.infer<typeof checkpointEventEnvelopeSchema>;
