import { CheckpointRestoreExecutor } from './checkpointRestore';
import { CheckpointRestorePlanner } from './checkpointRestorePlan';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointRetention, HISTORY_RETENTION, WORKTREE_HISTORY_GRACE_MS } from './checkpointRetention';
import { CheckpointStore, resolveCheckpointStoreLayout } from './checkpointStore';
import { withCheckpointPin } from './checkpointGarbageCollector';
import { withCheckpointStaging } from './checkpointStoreLock';
const git = promisify(execFile);
describe('daemon local history retention', () => {
    let root: string;
    let checkpointRoot: string;
    let projectPath: string;
    const binding = { sessionId: 'session', projectId: 'project', worktreeId: 'worktree' };
    const request = () => ({ schemaVersion: 1, projectId: binding.projectId, worktreePath: projectPath, immediate: false, action: 'retire' });
    const layout = () => resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
    const snapshot = async () => {
        await writeFile(join(projectPath, 'file.txt'), 'version');
        return (await new CheckpointStore(checkpointRoot).snapshotTurn({ ...binding, projectPath, operationId: 'turn' })).checkpointId;
    };
    beforeEach(async () => {
        root = await realpath(await mkdtemp(join(tmpdir(), 'history-retention-')));
        checkpointRoot = join(root, 'checkpoints');
        projectPath = join(root, 'repo', '.aplus', 'worktrees', 'project', 'worktree');
        await mkdir(projectPath, { recursive: true });
        await git('git', ['init', join(root, 'repo')]);
    });
    afterEach(async () => { await rm(root, { recursive: true, force: true }); });
    it('persists seven-day grace across restarts, retaining old records during grace', async () => {
        expect(HISTORY_RETENTION).toMatchObject({ maxCheckpointsPerBinding: 200, maxAgeMs: 30 * 86400_000, maxStoreBytes: 5 * 1024 ** 3 });
        const id = await snapshot();
        await rm(projectPath, { recursive: true });
        const now = Date.now() + 40 * 86400_000;
        await new CheckpointRetention(checkpointRoot).collect(now);
        expect(await readFile(layout().metadataFile, 'utf8')).toContain('session');
        expect((await new CheckpointRetention(checkpointRoot).collect(now + WORKTREE_HISTORY_GRACE_MS - 1)).prunedCheckpoints).toBe(0);
        expect((await new CheckpointRetention(checkpointRoot).collect(now + WORKTREE_HISTORY_GRACE_MS)).prunedCheckpoints).toBe(1);
        await expect(readFile(layout().metadataFile)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(git('git', [`--git-dir=${layout().gitDirectory}`, 'cat-file', '-e', id])).rejects.toThrow();
    });
    it('resets the grace period when a worktree reappears', async () => {
        await snapshot();
        await rm(projectPath, { recursive: true });
        const now = Date.now();
        await new CheckpointRetention(checkpointRoot).collect(now);
        await mkdir(projectPath);
        await new CheckpointRetention(checkpointRoot).collect(now + WORKTREE_HISTORY_GRACE_MS);
        await rm(projectPath, { recursive: true });
        await new CheckpointRetention(checkpointRoot).collect(now + WORKTREE_HISTORY_GRACE_MS);
        expect((await new CheckpointRetention(checkpointRoot).collect(now + 2 * WORKTREE_HISTORY_GRACE_MS - 1)).prunedCheckpoints).toBe(0);
        expect((await new CheckpointRetention(checkpointRoot).collect(now + 2 * WORKTREE_HISTORY_GRACE_MS)).prunedCheckpoints).toBe(1);
    });
    it('fails closed when a missing worktree has no trustworthy repository anchor', async () => {
        await snapshot();
        await rm(projectPath, { recursive: true });
        await rm(join(root, 'repo', '.git'), { recursive: true });
        expect((await new CheckpointRetention(checkpointRoot).collect(Date.now() + 40 * 86400_000)).prunedCheckpoints).toBe(0);
    });
    it('preserves a legacy safety checkpoint identified by its restore journal', async () => {
        const target = await snapshot();
        await writeFile(join(projectPath, 'file.txt'), 'before restore');
        const plan = await new CheckpointRestorePlanner(checkpointRoot).plan({ ...binding, projectPath, checkpointId: target });
        const restored = await new CheckpointRestoreExecutor(checkpointRoot).execute({ ...binding, projectPath,
            operationId: 'legacy-safety', confirmed: true, plan });
        if (restored.status !== 'completed') throw new Error(restored.status);
        await writeFile(join(projectPath, 'file.txt'), 'new baseline');
        await new CheckpointStore(checkpointRoot).snapshotTurn({ ...binding, projectPath, operationId: 'later' });
        await new CheckpointRetention(checkpointRoot).collect(Date.now() + 40 * 86400_000);
        await expect(git('git', [`--git-dir=${layout().gitDirectory}`, 'cat-file', '-e', restored.safetyCheckpointId])).resolves.toBeDefined();
    });

    it('rejects foreign metadata/path and refuses retirement while the worktree exists', async () => {
        await snapshot();
        const retention = new CheckpointRetention(checkpointRoot);
        await expect(retention.retireWorktree(request())).rejects.toThrow('still exists');
        await expect(retention.retireWorktree({ ...request(), action: 'inspect', projectId: 'foreign' })).rejects.toThrow('binding');
        await expect(retention.retireWorktree({ ...request(), worktreePath: root })).rejects.toThrow('managed');
        await expect(retention.retireWorktree({ ...request(), immediate: true, confirmed: false })).rejects.toThrow();
    });
    it('deletes only matching history and defers pins or staging', async () => {
        const id = await snapshot();
        const otherPath = join(root, 'other');
        await mkdir(otherPath);
        await writeFile(join(otherPath, 'file.txt'), 'other');
        const otherBinding = { ...binding, sessionId: 'other', worktreeId: null };
        await new CheckpointStore(checkpointRoot).snapshotTurn({ ...otherBinding, projectPath: otherPath, operationId: 'other' });
        await rm(projectPath, { recursive: true });
        const retention = new CheckpointRetention(checkpointRoot);
        await withCheckpointPin(checkpointRoot, { ...binding, checkpointId: id, operationId: 'restore' }, async () => {
            expect((await retention.retireWorktree({ ...request(), immediate: true, confirmed: true })).status).toBe('deferred');
            expect(await readFile(layout().metadataFile, 'utf8')).toContain('session');
        });
        await withCheckpointStaging(checkpointRoot, async () => {
            expect((await retention.collect()).prunedCheckpoints).toBe(0);
        });
        expect((await retention.collect()).prunedCheckpoints).toBe(1);
        expect(await readFile(resolveCheckpointStoreLayout({ checkpointRoot, ...otherBinding }).metadataFile, 'utf8')).toContain('other');
    });
});
