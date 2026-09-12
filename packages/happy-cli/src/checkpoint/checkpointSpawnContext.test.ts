import { describe, expect, it } from 'vitest';
import {
    CHECKPOINT_SPAWN_CONTEXT_ENV_KEY,
    injectCheckpointSpawnContext,
    readCheckpointSpawnContext,
} from './checkpointSpawnContext';

describe('checkpoint spawn context', () => {
    it('removes caller-supplied context and injects only daemon-owned binding', () => {
        const result = injectCheckpointSpawnContext({
            SAFE: 'value',
            [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: JSON.stringify({
                schemaVersion: 1,
                projectId: 'attacker-project',
                worktreeId: null,
                checkpointRoot: '/tmp/attacker',
            }),
        }, {
            projectId: 'project-1',
            worktreeId: null,
            checkpointRoot: '/machine/happy/checkpoints',
        });

        expect(result.SAFE).toBe('value');
        expect(readCheckpointSpawnContext(result)).toEqual({
            schemaVersion: 1,
            projectId: 'project-1',
            worktreeId: null,
            checkpointRoot: '/machine/happy/checkpoints',
        });
    });

    it('leaves no context when the daemon has no authoritative project binding', () => {
        expect(injectCheckpointSpawnContext({
            [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: '{"projectId":"attacker"}',
        }, undefined)).toEqual({});
    });
});
