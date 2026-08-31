import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCheckpointRuntime } from './checkpointRuntime';
import { resolveCheckpointStoreLayout } from './checkpointStore';

const execFileAsync = promisify(execFile);

describe('createCheckpointRuntime', () => {
    let fixtureRoot: string;
    let projectPath: string;
    let checkpointRoot: string;
    const protection = {
        secretPatterns: ['.env*'],
        maxFileBytes: 8,
        maxFiles: 100,
        maxTotalBytes: 4096,
    };
    const binding = {
        sessionId: 'session-1',
        projectId: 'project-1',
        worktreeId: null,
    };

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-runtime-'));
        projectPath = join(fixtureRoot, 'project');
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        await mkdir(projectPath);
        await writeFile(join(projectPath, 'source.txt'), 'before');
        await writeFile(join(projectPath, '.env.local'), 'SECRET=value');
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    it('stays disabled without an explicit checkpoint protection block', async () => {
        expect(await createCheckpointRuntime({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            checkpointRoot,
            binding,
            protection: undefined,
        })).toEqual({ status: 'disabled' });
    });

    it('reports unsupported platforms without creating a protected runtime', async () => {
        expect(await createCheckpointRuntime({
            provider: 'codex',
            platform: 'linux',
            projectPath,
            checkpointRoot,
            binding,
            protection,
        })).toEqual({ status: 'unavailable', reason: 'unsupported-platform' });
    });

    it('fixes sandbox deny before the first snapshot and excludes secret content from Git', async () => {
        const result = await createCheckpointRuntime({
            provider: 'claude-remote',
            platform: 'darwin',
            projectPath,
            checkpointRoot,
            binding,
            protection,
        });
        expect(result.status).toBe('protected');
        if (result.status !== 'protected') throw new Error('expected protected runtime');
        expect(result.denyWritePaths).toContain(join(await realpath(projectPath), '**', '.env*'));

        const first = await result.beforeTurn('turn-1');
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: files } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'ls-tree',
            '-r',
            '--name-only',
            first.checkpointId,
        ]);
        expect(files.split('\n')).toContain('source.txt');
        expect(files.split('\n')).not.toContain('.env.local');
    });

    it('blocks a later turn on policy drift before creating its snapshot', async () => {
        const result = await createCheckpointRuntime({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            checkpointRoot,
            binding,
            protection,
        });
        if (result.status !== 'protected') throw new Error('expected protected runtime');
        await result.beforeTurn('turn-1');
        await writeFile(join(projectPath, '.env.production'), 'new secret');

        await expect(result.beforeTurn('turn-2')).rejects.toMatchObject({
            name: 'CheckpointPolicyDriftError',
            action: 'restart-sandbox-or-disable-protection',
        });
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: count } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'rev-list',
            '--count',
            layout.refName,
        ]);
        expect(count.trim()).toBe('1');
    });
});
