import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointLedger } from './checkpointLedger';
import { CheckpointStore, resolveCheckpointStoreLayout } from './checkpointStore';
import { CheckpointTurnApplier } from './checkpointTurnApply';
import {
    checkpointTurnApplyJournalPath,
    readCheckpointTurnApplyJournal,
    writeCheckpointTurnApplyJournal,
} from './checkpointTurnApplyJournal';
import { CheckpointTurnWorkspace } from './checkpointTurnWorkspace';

describe('CheckpointTurnApplier', () => {
    let fixtureRoot: string;
    let checkpointRoot: string;
    let projectPath: string;

    const binding = {
        sessionId: 'session-1',
        projectId: 'project-1',
        worktreeId: null,
    };

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-turn-apply-'));
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        projectPath = join(fixtureRoot, 'project');
        await mkdir(projectPath);
        await writeFile(join(projectPath, 'source.txt'), 'before');
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    it('keeps a same-turn user edit out of the apply plan and agent ledger', async () => {
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });
        const workspace = await new CheckpointTurnWorkspace(checkpointRoot).prepare({
            ...binding,
            operationId: 'turn-1',
            checkpointId: snapshot.checkpointId,
        });
        await writeFile(join(workspace.path, 'source.txt'), 'agent');
        await writeFile(join(projectPath, 'source.txt'), 'user');

        const plan = await new CheckpointTurnApplier(checkpointRoot).plan({
            ...binding,
            operationId: 'turn-1',
            checkpointId: snapshot.checkpointId,
            projectPath,
            workspacePath: workspace.path,
        });

        expect(plan.entries).toEqual([
            { path: 'source.txt', action: 'conflict', reason: 'user-modified' },
        ]);
        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('user');
        await expect(new CheckpointLedger(checkpointRoot).readRecords({
            ...binding,
            projectPath,
        })).resolves.toEqual([]);
    });

    it('applies quiescent workspace writes and records their resulting hashes', async () => {
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-2',
            projectPath,
        });
        const workspace = await new CheckpointTurnWorkspace(checkpointRoot).prepare({
            ...binding,
            operationId: 'turn-2',
            checkpointId: snapshot.checkpointId,
        });
        await writeFile(join(workspace.path, 'source.txt'), 'agent-modified');
        await writeFile(join(workspace.path, 'created.txt'), 'agent-created');

        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const journalFile = checkpointTurnApplyJournalPath(layout, 'turn-2');
        const observedApplying: string[] = [];
        const result = await new CheckpointTurnApplier(checkpointRoot, {
            mutate: async (mutation) => {
                const journal = await readCheckpointTurnApplyJournal(journalFile);
                expect(journal?.entries.find(({ path }) => path === mutation.entry.path)?.outcome)
                    .toBe('applying');
                observedApplying.push(mutation.entry.path);
                await mutation.apply();
            },
        }).execute({
            ...binding,
            operationId: 'turn-2',
            checkpointId: snapshot.checkpointId,
            projectPath,
            workspacePath: workspace.path,
        });

        expect(result).toMatchObject({
            status: 'completed',
            entries: [
                { path: 'created.txt', action: 'write', outcome: 'written' },
                { path: 'source.txt', action: 'write', outcome: 'written' },
            ],
        });
        expect(observedApplying).toEqual(['created.txt', 'source.txt']);
        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('agent-modified');
        await expect(readFile(join(projectPath, 'created.txt'), 'utf8')).resolves.toBe('agent-created');
        const records = await new CheckpointLedger(checkpointRoot).readRecords({
            ...binding,
            projectPath,
        });
        expect(records.map(({ path, action }) => ({ path, action }))).toEqual([
            { path: 'created.txt', action: 'written' },
            { path: 'source.txt', action: 'written' },
        ]);
    });

    it('does not reapply a mutation whose crash outcome is unknown', async () => {
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-3',
            projectPath,
        });
        const workspace = await new CheckpointTurnWorkspace(checkpointRoot).prepare({
            ...binding,
            operationId: 'turn-3',
            checkpointId: snapshot.checkpointId,
        });
        await writeFile(join(workspace.path, 'source.txt'), 'agent');
        const request = {
            ...binding,
            operationId: 'turn-3',
            checkpointId: snapshot.checkpointId,
            projectPath,
            workspacePath: workspace.path,
        };
        await new CheckpointTurnApplier(checkpointRoot).execute(request);

        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const journalFile = checkpointTurnApplyJournalPath(layout, 'turn-3');
        const journal = await readCheckpointTurnApplyJournal(journalFile);
        if (!journal) throw new Error('expected turn apply journal');
        journal.entries[0].outcome = 'applying';
        await writeCheckpointTurnApplyJournal(journalFile, journal);
        await writeFile(join(projectPath, 'source.txt'), 'user-after-crash');
        const mutate = vi.fn();

        const retry = await new CheckpointTurnApplier(checkpointRoot, { mutate }).execute(request);

        expect(retry).toMatchObject({
            status: 'partial',
            entries: [{
                path: 'source.txt',
                action: 'write',
                outcome: 'failed',
                failureCode: 'mutation-outcome-unknown',
            }],
        });
        expect(mutate).not.toHaveBeenCalled();
        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('user-after-crash');
    });

    it('rejects a checkpoint owned by a different session binding', async () => {
        const store = new CheckpointStore(checkpointRoot);
        const ownSnapshot = await store.snapshotTurn({
            ...binding,
            operationId: 'turn-own',
            projectPath,
        });
        const foreignSnapshot = await store.snapshotTurn({
            ...binding,
            sessionId: 'session-2',
            operationId: 'turn-foreign',
            projectPath,
        });
        const workspace = await new CheckpointTurnWorkspace(checkpointRoot).prepare({
            ...binding,
            operationId: 'turn-own',
            checkpointId: ownSnapshot.checkpointId,
        });
        await writeFile(join(workspace.path, 'source.txt'), 'agent');

        await expect(new CheckpointTurnApplier(checkpointRoot).plan({
            ...binding,
            operationId: 'turn-own',
            checkpointId: foreignSnapshot.checkpointId,
            projectPath,
            workspacePath: workspace.path,
        })).rejects.toThrow('does not belong to binding');
        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('before');
    });

    it('applies an agent deletion and records it in the ledger', async () => {
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-delete',
            projectPath,
        });
        const workspace = await new CheckpointTurnWorkspace(checkpointRoot).prepare({
            ...binding,
            operationId: 'turn-delete',
            checkpointId: snapshot.checkpointId,
        });
        await unlink(join(workspace.path, 'source.txt'));

        const result = await new CheckpointTurnApplier(checkpointRoot).execute({
            ...binding,
            operationId: 'turn-delete',
            checkpointId: snapshot.checkpointId,
            projectPath,
            workspacePath: workspace.path,
        });

        expect(result.entries).toEqual([
            { path: 'source.txt', action: 'delete', outcome: 'deleted' },
        ]);
        await expect(access(join(projectPath, 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(new CheckpointLedger(checkpointRoot).readRecords({
            ...binding,
            projectPath,
        })).resolves.toEqual([
            expect.objectContaining({ path: 'source.txt', action: 'deleted' }),
        ]);
    });

    it('does not apply an excluded path even if a writer bypasses the sandbox', async () => {
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-excluded',
            projectPath,
            excludedPatterns: ['**/.env*'],
        });
        const workspace = await new CheckpointTurnWorkspace(checkpointRoot).prepare({
            ...binding,
            operationId: 'turn-excluded',
            checkpointId: snapshot.checkpointId,
        });
        await writeFile(join(workspace.path, '.env.future'), 'secret');

        const result = await new CheckpointTurnApplier(checkpointRoot).execute({
            ...binding,
            operationId: 'turn-excluded',
            checkpointId: snapshot.checkpointId,
            projectPath,
            workspacePath: workspace.path,
            excludedPaths: [],
            excludedPatterns: ['**/.env*'],
        });

        expect(result.entries).toEqual([
            { path: '.env.future', action: 'conflict', outcome: 'conflict' },
        ]);
        await expect(access(join(projectPath, '.env.future'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
