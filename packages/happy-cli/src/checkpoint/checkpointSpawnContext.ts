import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const CHECKPOINT_SPAWN_CONTEXT_ENV_KEY = 'HAPPY_CHECKPOINT_SPAWN_CONTEXT';

const identifierSchema = z.string().min(1).max(128).refine(
    (value) => value.trim() === value && !/[\u0000-\u001F\u007F]/.test(value),
);

const checkpointSpawnContextSchema = z.object({
    schemaVersion: z.literal(1),
    projectId: identifierSchema,
    worktreeId: identifierSchema.nullable(),
    checkpointRoot: z.string().min(1).refine((value) => isAbsolute(value)),
}).strict();

export type CheckpointSpawnContext = z.infer<typeof checkpointSpawnContextSchema>;
export type CheckpointSpawnContextInput = Omit<CheckpointSpawnContext, 'schemaVersion'>;

export function injectCheckpointSpawnContext(
    environment: Record<string, string>,
    context: CheckpointSpawnContextInput | undefined,
): Record<string, string> {
    const sanitized = Object.fromEntries(
        Object.entries(environment).filter(([key]) => !key.startsWith('HAPPY_CHECKPOINT_')),
    );
    if (context) {
        sanitized[CHECKPOINT_SPAWN_CONTEXT_ENV_KEY] = JSON.stringify(
            checkpointSpawnContextSchema.parse({ schemaVersion: 1, ...context }),
        );
    }
    return sanitized;
}

export function readCheckpointSpawnContext(
    environment: Record<string, string | undefined>,
): CheckpointSpawnContext | null {
    const encoded = environment[CHECKPOINT_SPAWN_CONTEXT_ENV_KEY];
    if (!encoded) return null;
    try {
        return checkpointSpawnContextSchema.parse(JSON.parse(encoded));
    } catch {
        return null;
    }
}
