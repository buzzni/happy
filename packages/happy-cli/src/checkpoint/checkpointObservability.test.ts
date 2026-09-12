import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CheckpointGarbageCollector } from './checkpointGarbageCollector';
import { observeCheckpointOperation, type CheckpointOperationObservation } from './checkpointObservability';
import { CheckpointRestoreExecutor } from './checkpointRestore';
import { CheckpointRestorePlanner } from './checkpointRestorePlan';
import { CheckpointStore } from './checkpointStore';

describe('checkpoint operation observability', () => {
    it('records a path-free success metric with latency and bounded counters', async () => {
        const observations: CheckpointOperationObservation[] = [];
        const now = vi.fn()
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(125);

        const result = await observeCheckpointOperation(
            'plan',
            async () => ({ entries: 4 }),
            () => ({ files: 4, restore: 1, delete: 1, skip: 1, conflict: 1 }),
            { observer: (event) => observations.push(event), now },
        );

        expect(result).toEqual({ entries: 4 });
        expect(observations).toEqual([{
            schemaVersion: 1,
            operation: 'plan',
            outcome: 'success',
            durationMs: 25,
            files: 4,
            restore: 1,
            delete: 1,
            skip: 1,
            conflict: 1,
        }]);
        expect(JSON.stringify(observations)).not.toContain('projectPath');
    });

    it('records failure without serializing the error and never breaks the operation on log failure', async () => {
        const observations: CheckpointOperationObservation[] = [];
        const secretError = new Error('/private/project/.env token=secret');

        await expect(observeCheckpointOperation(
            'snapshot',
            async () => { throw secretError; },
            () => ({ created: true }),
            { observer: (event) => observations.push(event), now: () => 10 },
        )).rejects.toBe(secretError);
        expect(observations).toEqual([{
            schemaVersion: 1,
            operation: 'snapshot',
            outcome: 'failure',
            durationMs: 0,
        }]);

        await expect(observeCheckpointOperation(
            'gc',
            async () => ({ prunedCheckpoints: 0, retainedActive: 0, storeBytes: 0 }),
            (value) => value,
            { observer: () => { throw new Error('logger unavailable'); }, now: () => 10 },
        )).resolves.toEqual({ prunedCheckpoints: 0, retainedActive: 0, storeBytes: 0 });
    });

    it('instruments snapshot, plan, restore, and GC production boundaries', async () => {
        const fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-observability-'));
        const checkpointRoot = join(fixtureRoot, 'checkpoints');
        const projectPath = join(fixtureRoot, 'project');
        const observations: CheckpointOperationObservation[] = [];
        const observer = (event: CheckpointOperationObservation) => observations.push(event);
        const binding = { sessionId: 'session-1', projectId: 'project-1', worktreeId: null };
        try {
            await mkdir(projectPath);
            await writeFile(join(projectPath, 'tracked.txt'), 'before\n');
            const snapshot = await new CheckpointStore(checkpointRoot, { observer }).snapshotTurn({
                ...binding,
                projectPath,
                operationId: 'turn-1',
            });
            await new CheckpointRestorePlanner(checkpointRoot, { observer }).plan({
                ...binding,
                projectPath,
                checkpointId: snapshot.checkpointId,
            });
            await new CheckpointRestoreExecutor(checkpointRoot, { observer }).execute({
                ...binding,
                projectPath,
                operationId: '00000000-0000-4000-8000-000000000001',
                plan: { checkpointId: snapshot.checkpointId, entries: [] },
                confirmed: false,
            });
            await new CheckpointGarbageCollector(checkpointRoot, { observer }).collect({
                maxCheckpointsPerBinding: 1,
            });

            expect(observations.map((event) => [event.operation, event.outcome])).toEqual([
                ['snapshot', 'success'],
                ['plan', 'success'],
                ['restore', 'success'],
                ['gc', 'success'],
            ]);
        } finally {
            await rm(fixtureRoot, { recursive: true, force: true });
        }
    });
});
