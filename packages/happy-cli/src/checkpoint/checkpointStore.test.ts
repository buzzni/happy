import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    checkpointOperationRefPrefix,
    CheckpointStore,
    resolveCheckpointStoreLayout,
    validateCheckpointProjectPath,
} from './checkpointStore';

const execFileAsync = promisify(execFile);

describe('resolveCheckpointStoreLayout', () => {
    const checkpointRoot = join(tmpdir(), 'happy-checkpoint-layout');

    it('shares objects while isolating project and worktree state', () => {
        const main = resolveCheckpointStoreLayout({
            checkpointRoot,
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
        });
        const worktree = resolveCheckpointStoreLayout({
            checkpointRoot,
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
        });
        const otherProject = resolveCheckpointStoreLayout({
            checkpointRoot,
            sessionId: 'session-1',
            projectId: 'project-2',
            worktreeId: null,
        });
        const otherSession = resolveCheckpointStoreLayout({
            checkpointRoot,
            sessionId: 'session-2',
            projectId: 'project-1',
            worktreeId: null,
        });

        expect(new Set([
            main.gitDirectory,
            worktree.gitDirectory,
            otherProject.gitDirectory,
            otherSession.gitDirectory,
        ])).toHaveLength(1);
        expect(new Set([
            main.refName,
            worktree.refName,
            otherProject.refName,
            otherSession.refName,
        ])).toHaveLength(4);
        expect(new Set([
            main.indexFile,
            worktree.indexFile,
            otherProject.indexFile,
            otherSession.indexFile,
        ])).toHaveLength(4);
        expect(new Set([
            main.metadataFile,
            worktree.metadataFile,
            otherProject.metadataFile,
            otherSession.metadataFile,
        ])).toHaveLength(4);
        expect(new Set([
            main.ledgerFile,
            worktree.ledgerFile,
            otherProject.ledgerFile,
            otherSession.ledgerFile,
        ])).toHaveLength(4);
    });

    it('keeps opaque binding identifiers inside the machine-local root', () => {
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot,
            sessionId: '../session',
            projectId: '../../project',
            worktreeId: '../worktree',
        });

        for (const path of [layout.gitDirectory, layout.indexFile, layout.metadataFile]) {
            expect(relative(checkpointRoot, path)).not.toMatch(/^\.\.(?:[/\\]|$)/);
        }
        expect(layout.refName).toMatch(/^refs\/saycode-checkpoints\/[a-f0-9]+$/);
        expect(JSON.stringify(layout)).not.toContain('../');
    });

    it('rejects broad projects and a shadow store inside the project', () => {
        expect(() => validateCheckpointProjectPath({
            projectPath: parse(checkpointRoot).root,
            checkpointRoot,
            userHomePath: homedir(),
        })).toThrow('checkpoint project path is too broad');
        expect(() => validateCheckpointProjectPath({
            projectPath: homedir(),
            checkpointRoot,
            userHomePath: homedir(),
        })).toThrow('checkpoint project path is too broad');
        expect(() => validateCheckpointProjectPath({
            projectPath: checkpointRoot,
            checkpointRoot: join(checkpointRoot, '.checkpoints'),
            userHomePath: homedir(),
        })).toThrow('checkpoint store overlaps project path');
    });
});

describe('CheckpointStore', () => {
    let fixtureRoot: string;
    let checkpointRoot: string;
    let projectPath: string;

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-store-'));
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        projectPath = join(fixtureRoot, 'project');
        await mkdir(projectPath);
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    it('creates at most one snapshot per operation and captures the next turn separately', async () => {
        const store = new CheckpointStore(checkpointRoot);
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        };
        await writeFile(join(projectPath, 'message.txt'), 'before\n');

        const first = await store.snapshotTurn({ ...binding, operationId: 'turn-1' });
        await writeFile(join(projectPath, 'message.txt'), 'after\n');
        const duplicate = await store.snapshotTurn({ ...binding, operationId: 'turn-1' });
        const second = await store.snapshotTurn({ ...binding, operationId: 'turn-2' });

        expect(duplicate.checkpointId).toBe(first.checkpointId);
        expect(second.checkpointId).not.toBe(first.checkpointId);

        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: count } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'for-each-ref',
            '--format=%(objectname)',
            checkpointOperationRefPrefix(layout),
        ]);
        const [{ stdout: before }, { stdout: after }] = await Promise.all([
            execFileAsync('git', [
                `--git-dir=${layout.gitDirectory}`,
                'show',
                `${first.checkpointId}:message.txt`,
            ]),
            execFileAsync('git', [
                `--git-dir=${layout.gitDirectory}`,
                'show',
                `${second.checkpointId}:message.txt`,
            ]),
        ]);

        expect(count.trim().split('\n').filter(Boolean)).toHaveLength(2);
        expect(before).toBe('before\n');
        expect(after).toBe('after\n');
    });

    it('reuses the durable operation checkpoint after a daemon restart', async () => {
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        };
        await writeFile(join(projectPath, 'message.txt'), 'before\n');
        const first = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-retried-after-restart',
        });
        await writeFile(join(projectPath, 'message.txt'), 'changed after checkpoint\n');

        const retried = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-retried-after-restart',
        });

        expect(retried).toEqual({ checkpointId: first.checkpointId, created: false });
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: count } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'for-each-ref',
            '--format=%(objectname)',
            checkpointOperationRefPrefix(layout),
        ]);
        expect(count.trim().split('\n').filter(Boolean)).toHaveLength(1);
    });

    it('converges concurrent daemon instances on one durable operation checkpoint', async () => {
        const request = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
            operationId: 'turn-overlapping-daemons',
        } as const;
        await writeFile(join(projectPath, 'message.txt'), 'before\n');
        await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...request,
            operationId: 'turn-bootstrap-store',
        });
        await writeFile(join(projectPath, 'message.txt'), 'overlapping daemon version\n');

        const results = await Promise.all([
            new CheckpointStore(checkpointRoot).snapshotTurn(request),
            new CheckpointStore(checkpointRoot).snapshotTurn(request),
        ]);

        expect(new Set(results.map(({ checkpointId }) => checkpointId))).toHaveLength(1);
        expect(results.filter(({ created }) => created)).toHaveLength(1);
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...request });
        const { stdout } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'for-each-ref',
            '--format=%(objectname)',
            checkpointOperationRefPrefix(layout),
        ]);
        expect(stdout.trim().split('\n').filter(Boolean)).toHaveLength(2);
    });

    it('rejects rebinding the same identity to another project path', async () => {
        const otherProjectPath = join(fixtureRoot, 'other-project');
        await mkdir(otherProjectPath);
        await writeFile(join(projectPath, 'message.txt'), 'first project\n');
        await writeFile(join(otherProjectPath, 'message.txt'), 'other project\n');
        await new CheckpointStore(checkpointRoot).snapshotTurn({
            sessionId: 'bootstrap-session',
            projectId: 'bootstrap-project',
            worktreeId: null,
            operationId: 'turn-bootstrap-binding-race',
            projectPath,
        });
        const store = new CheckpointStore(checkpointRoot);
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
        };

        await store.snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });

        await expect(store.snapshotTurn({
            ...binding,
            operationId: 'turn-2',
            projectPath: otherProjectPath,
        })).rejects.toThrow('checkpoint binding path mismatch');

        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: count } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'for-each-ref',
            '--format=%(objectname)',
            checkpointOperationRefPrefix(layout),
        ]);
        expect(count.trim().split('\n').filter(Boolean)).toHaveLength(1);
    });

    it('atomically binds one project when different paths race on first snapshot', async () => {
        const otherProjectPath = join(fixtureRoot, 'other-project');
        await mkdir(otherProjectPath);
        await writeFile(join(projectPath, 'message.txt'), 'first project\n');
        await writeFile(join(otherProjectPath, 'message.txt'), 'other project\n');
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
        } as const;
        const results = await Promise.allSettled([
            new CheckpointStore(checkpointRoot).snapshotTurn({
                ...binding,
                operationId: 'turn-first-project',
                projectPath,
            }),
            new CheckpointStore(checkpointRoot).snapshotTurn({
                ...binding,
                operationId: 'turn-other-project',
                projectPath: otherProjectPath,
            }),
        ]);

        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
        const winningIndex = results.findIndex(({ status }) => status === 'fulfilled');
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const metadata = JSON.parse(await readFile(layout.metadataFile, 'utf8')) as { projectPath: string };
        expect(metadata.projectPath).toBe(await realpath(
            winningIndex === 0 ? projectPath : otherProjectPath,
        ));
    });

    it('excludes secret globs even when an exact manifest path was not supplied', async () => {
        await writeFile(join(projectPath, 'source.txt'), 'safe\n');
        await writeFile(join(projectPath, '.env.raced'), 'SECRET=value\n');
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        };

        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            excludedPatterns: ['**/.env*'],
        });
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'ls-tree',
            '-r',
            '--name-only',
            snapshot.checkpointId,
        ]);

        expect(stdout.split('\n')).toContain('source.txt');
        expect(stdout.split('\n')).not.toContain('.env.raced');
    });
});
