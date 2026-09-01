import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from './checkpointStore';
import { CheckpointTurnWorkspace } from './checkpointTurnWorkspace';

const execFileAsync = promisify(execFile);

describe('CheckpointTurnWorkspace', () => {
    let fixtureRoot: string;
    let checkpointRoot: string;
    let projectPath: string;

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-turn-workspace-'));
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        projectPath = join(fixtureRoot, 'project');
        await mkdir(join(projectPath, '.git'), { recursive: true });
        await writeFile(join(projectPath, 'source.txt'), 'captured');
        await writeFile(join(projectPath, '.env.secret'), 'do-not-copy');
        await writeFile(join(projectPath, '.git', 'HEAD'), 'original-git');
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    it('materializes only the checkpoint tree outside the original project', async () => {
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
        };
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
            excludedPatterns: ['**/.env*'],
        });

        const workspace = await new CheckpointTurnWorkspace(checkpointRoot).prepare({
            ...binding,
            operationId: 'turn-1',
            checkpointId: snapshot.checkpointId,
        });
        const canonicalProjectPath = await realpath(projectPath);
        const workspaceRelativeToProject = relative(canonicalProjectPath, workspace.path);

        expect(workspaceRelativeToProject === '..' || workspaceRelativeToProject.startsWith(`..${sep}`))
            .toBe(true);
        expect(isAbsolute(workspace.path)).toBe(true);
        await expect(readFile(join(workspace.path, 'source.txt'), 'utf8')).resolves.toBe('captured');
        await expect(access(join(workspace.path, '.env.secret'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(access(join(workspace.path, '.git'))).resolves.toBeUndefined();
        await expect(execFileAsync('git', ['status', '--porcelain'], { cwd: workspace.path }))
            .resolves.toMatchObject({ stdout: '' });
        await writeFile(join(workspace.path, 'source.txt'), 'changed');
        await expect(execFileAsync('git', ['status', '--porcelain'], { cwd: workspace.path }))
            .resolves.toMatchObject({ stdout: ' M source.txt\n' });
        await expect(readFile(join(projectPath, '.git', 'HEAD'), 'utf8')).resolves.toBe('original-git');
    });
});
