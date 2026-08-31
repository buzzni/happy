import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointLedger } from './checkpointLedger';
import {
    CheckpointRestoreExecutor,
    type CheckpointRestoreMutation,
} from './checkpointRestore';
import { checkpointRestoreJournalPath } from './checkpointRestoreJournal';
import { CheckpointRestorePlanner, type CheckpointRestorePlan } from './checkpointRestorePlan';
import { CheckpointStore, resolveCheckpointStoreLayout } from './checkpointStore';

const execFileAsync = promisify(execFile);

describe('CheckpointRestoreExecutor', () => {
    let fixtureRoot: string;
    let checkpointRoot: string;
    let projectPath: string;
    const binding = {
        sessionId: 'session-1',
        projectId: 'project-1',
        worktreeId: null,
    };

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-restore-'));
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        projectPath = join(fixtureRoot, 'project');
        await mkdir(projectPath);
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    async function createAgentModifiedPlan(): Promise<CheckpointRestorePlan> {
        await writeFile(join(projectPath, 'tracked.txt'), 'before\n');
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });
        await writeFile(join(projectPath, 'tracked.txt'), 'agent version\n');
        await new CheckpointLedger(checkpointRoot).recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-1',
            projectPath,
            path: 'tracked.txt',
            action: 'written',
        });
        return new CheckpointRestorePlanner(checkpointRoot).plan({
            ...binding,
            projectPath,
            checkpointId: snapshot.checkpointId,
        });
    }

    async function createTwoFileAgentModifiedPlan(): Promise<CheckpointRestorePlan> {
        await writeFile(join(projectPath, 'a.txt'), 'a before\n');
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });
        const ledger = new CheckpointLedger(checkpointRoot);
        await writeFile(join(projectPath, 'a.txt'), 'a agent\n');
        await ledger.recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-a',
            projectPath,
            path: 'a.txt',
            action: 'written',
        });
        await writeFile(join(projectPath, 'b.txt'), 'b agent-created\n');
        await ledger.recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-b',
            projectPath,
            path: 'b.txt',
            action: 'written',
        });
        return new CheckpointRestorePlanner(checkpointRoot).plan({
            ...binding,
            projectPath,
            checkpointId: snapshot.checkpointId,
        });
    }

    it('cancels before creating a safety checkpoint or mutating files', async () => {
        const plan = await createAgentModifiedPlan();

        const result = await new CheckpointRestoreExecutor(checkpointRoot).execute({
            ...binding,
            operationId: 'rewind-1',
            projectPath,
            plan,
            confirmed: false,
        });

        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: checkpointCount } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'rev-list',
            '--count',
            layout.refName,
        ]);
        expect(result).toEqual({ status: 'cancelled' });
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe('agent version\n');
        expect(checkpointCount.trim()).toBe('1');
    });

    it('creates a safety checkpoint before applying a confirmed restore', async () => {
        const plan = await createAgentModifiedPlan();

        const result = await new CheckpointRestoreExecutor(checkpointRoot).execute({
            ...binding,
            operationId: 'rewind-1',
            projectPath,
            plan,
            confirmed: true,
        });

        expect(result).toMatchObject({
            status: 'completed',
            safetyCheckpointId: expect.stringMatching(/^[a-f0-9]{40,64}$/),
            entries: [{ path: 'tracked.txt', action: 'restore', outcome: 'restored' }],
        });
        if (result.status !== 'completed') throw new Error('expected completed restore');
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: safetyContents } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'show',
            `${result.safetyCheckpointId}:tracked.txt`,
        ]);
        expect(safetyContents).toBe('agent version\n');
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe('before\n');
    });

    it('rejects a confirmed plan when files changed after preview', async () => {
        const plan = await createAgentModifiedPlan();
        await writeFile(join(projectPath, 'tracked.txt'), 'user edit after preview\n');

        const result = await new CheckpointRestoreExecutor(checkpointRoot).execute({
            ...binding,
            operationId: 'rewind-1',
            projectPath,
            plan,
            confirmed: true,
        });

        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: checkpointCount } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'rev-list',
            '--count',
            layout.refName,
        ]);
        expect(result).toEqual({ status: 'stale-plan' });
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe(
            'user edit after preview\n',
        );
        expect(checkpointCount.trim()).toBe('1');
    });

    it('journals partial failure and retries only failed entries with the same operation id', async () => {
        const plan = await createTwoFileAgentModifiedPlan();
        const attempts: string[] = [];
        let failAOnce = true;
        const executor = new CheckpointRestoreExecutor(checkpointRoot, {
            mutate: async (mutation: CheckpointRestoreMutation) => {
                attempts.push(mutation.entry.path);
                if (mutation.entry.path === 'a.txt' && failAOnce) {
                    failAOnce = false;
                    throw new Error('injected mutation failure');
                }
                await mutation.apply();
            },
        });
        const request = {
            ...binding,
            operationId: 'rewind-partial',
            projectPath,
            plan,
            confirmed: true,
        } as const;

        const first = await executor.execute(request);

        expect(first).toMatchObject({
            status: 'partial',
            safetyCheckpointId: expect.stringMatching(/^[a-f0-9]{40,64}$/),
            entries: [
                { path: 'a.txt', action: 'restore', outcome: 'failed' },
                { path: 'b.txt', action: 'delete', outcome: 'deleted' },
            ],
        });
        expect(await readFile(join(projectPath, 'a.txt'), 'utf8')).toBe('a agent\n');
        await expect(readFile(join(projectPath, 'b.txt'), 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
        await writeFile(join(projectPath, 'b.txt'), 'b user edit after partial restore\n');

        const retry = await new CheckpointRestoreExecutor(checkpointRoot, {
            mutate: async (mutation: CheckpointRestoreMutation) => {
                attempts.push(mutation.entry.path);
                await mutation.apply();
            },
        }).execute(request);

        expect(retry).toMatchObject({
            status: 'completed',
            safetyCheckpointId: first.status === 'partial' ? first.safetyCheckpointId : '',
            entries: [
                { path: 'a.txt', action: 'restore', outcome: 'restored' },
                { path: 'b.txt', action: 'delete', outcome: 'deleted' },
            ],
        });
        expect(attempts).toEqual(['a.txt', 'b.txt', 'a.txt']);
        expect(await readFile(join(projectPath, 'a.txt'), 'utf8')).toBe('a before\n');
        expect(await readFile(join(projectPath, 'b.txt'), 'utf8')).toBe(
            'b user edit after partial restore\n',
        );
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: checkpointCount } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'rev-list',
            '--count',
            layout.refName,
        ]);
        expect(checkpointCount.trim()).toBe('2');
    });

    it('fails closed when a durable journal contains an impossible action outcome', async () => {
        const plan = await createAgentModifiedPlan();
        const executor = new CheckpointRestoreExecutor(checkpointRoot);
        const request = {
            ...binding,
            operationId: 'rewind-corrupt',
            projectPath,
            plan,
            confirmed: true,
        } as const;
        await executor.execute(request);
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const journalFile = checkpointRestoreJournalPath(layout, request.operationId);
        const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
            entries: Array<{ action: string }>;
        };
        journal.entries[0].action = 'skip';
        await writeFile(journalFile, JSON.stringify(journal));

        await expect(executor.execute(request)).rejects.toThrow(
            'checkpoint restore journal is corrupt',
        );
    });

    it('fails closed when a durable journal no longer matches the approved plan', async () => {
        const plan = await createAgentModifiedPlan();
        const executor = new CheckpointRestoreExecutor(checkpointRoot);
        const request = {
            ...binding,
            operationId: 'rewind-journal-mismatch',
            projectPath,
            plan,
            confirmed: true,
        } as const;
        await executor.execute(request);
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const journalFile = checkpointRestoreJournalPath(layout, request.operationId);
        const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
            entries: Array<{ path: string }>;
        };
        journal.entries[0].path = 'different.txt';
        await writeFile(journalFile, JSON.stringify(journal));

        await expect(executor.execute(request)).rejects.toThrow(
            'checkpoint restore journal does not match plan',
        );
    });

    it('does not reapply a mutation left in an uncertain applying state after restart', async () => {
        const plan = await createAgentModifiedPlan();
        const request = {
            ...binding,
            operationId: 'rewind-interrupted',
            projectPath,
            plan,
            confirmed: true,
        } as const;
        await new CheckpointRestoreExecutor(checkpointRoot).execute(request);
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const journalFile = checkpointRestoreJournalPath(layout, request.operationId);
        const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
            entries: Array<{ outcome: string }>;
        };
        journal.entries[0].outcome = 'applying';
        await writeFile(journalFile, JSON.stringify(journal));
        await writeFile(join(projectPath, 'tracked.txt'), 'user edit after interruption\n');

        const retry = await new CheckpointRestoreExecutor(checkpointRoot).execute(request);

        expect(retry).toMatchObject({
            status: 'partial',
            entries: [{
                path: 'tracked.txt',
                action: 'restore',
                outcome: 'failed',
                failureCode: 'mutation-outcome-unknown',
            }],
        });
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe(
            'user edit after interruption\n',
        );
    });

    it('serializes different restore operations targeting the same project', async () => {
        const plan = await createAgentModifiedPlan();
        const attempts: string[] = [];
        let releaseFirstMutation!: () => void;
        const firstMutationRelease = new Promise<void>((resolvePromise) => {
            releaseFirstMutation = resolvePromise;
        });
        let notifySecondMutation!: () => void;
        const secondMutationStarted = new Promise<void>((resolvePromise) => {
            notifySecondMutation = resolvePromise;
        });
        const executor = new CheckpointRestoreExecutor(checkpointRoot, {
            mutate: async (mutation: CheckpointRestoreMutation) => {
                attempts.push(mutation.entry.path);
                if (attempts.length === 1) {
                    await firstMutationRelease;
                } else {
                    notifySecondMutation();
                }
                await mutation.apply();
            },
        });
        const first = executor.execute({
            ...binding,
            operationId: 'rewind-concurrent-1',
            projectPath,
            plan,
            confirmed: true,
        });
        while (attempts.length === 0) await new Promise(setImmediate);
        const second = executor.execute({
            ...binding,
            operationId: 'rewind-concurrent-2',
            projectPath,
            plan,
            confirmed: true,
        });
        await Promise.race([
            secondMutationStarted,
            new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100)),
        ]);
        releaseFirstMutation();

        const results = await Promise.all([first, second]);

        expect(results.map((result) => result.status)).toEqual(['completed', 'stale-plan']);
        expect(attempts).toEqual(['tracked.txt']);
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe('before\n');
    });
});
