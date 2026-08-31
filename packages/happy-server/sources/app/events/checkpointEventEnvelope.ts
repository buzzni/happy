import { z } from 'zod';

const identifierSchema = z.string().min(1).max(128).refine(
    (value) => value.trim() === value && !/[\u0000-\u001F\u007F]/.test(value),
    'identifier must not contain surrounding whitespace or control characters',
);

export const checkpointEventEnvelopeSchema = z.object({
    schemaVersion: z.literal(1),
    operationId: identifierSchema,
    checkpointId: identifierSchema,
    state: z.enum(['created', 'completed', 'partial', 'failed']),
    actor: z.enum(['agent', 'user']),
    timestamp: z.number().int().nonnegative(),
}).strict();

export type CheckpointEventEnvelope = z.infer<typeof checkpointEventEnvelopeSchema>;
