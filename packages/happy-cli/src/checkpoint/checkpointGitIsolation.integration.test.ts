import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointLedger } from './checkpointLedger';
import { CheckpointStore } from './checkpointStore';

const execFileAsync = promisify(execFile);

describe('checkpoint Git isolation', () => {
    let fixtureRoot: string;
    let checkpointRoot: string;
    let projectPath: string;
    let globalConfigPath: string;
    let originalGlobalConfig: string | undefined;

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-git-isolation-'));
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        projectPath = join(fixtureRoot, 'project');
        globalConfigPath = join(fixtureRoot, 'user.gitconfig');
        await mkdir(projectPath);
        await execGit(['init'], projectPath);
        await execGit(['config', 'user.name', 'Fixture User'], projectPath);
        await execGit(['config', 'user.email', 'fixture@example.com'], projectPath);
        await writeFile(join(projectPath, 'tracked.txt'), 'committed\n');
        await execGit(['add', 'tracked.txt'], projectPath);
        await execGit(['commit', '--no-gpg-sign', '-m', 'fixture'], projectPath);
        await execGit(['config', 'commit.gpgsign', 'true'], projectPath);
        await writeFile(join(projectPath, 'tracked.txt'), 'user dirty change\n');
        await writeFile(join(projectPath, 'untracked.txt'), 'user untracked\n');
        const hookPath = join(projectPath, '.git', 'hooks', 'pre-commit');
        await writeFile(hookPath, `#!/bin/sh\nprintf invoked > ${shellQuote(join(fixtureRoot, 'hook-ran'))}\n`);
        await chmod(hookPath, 0o755);
        await writeFile(globalConfigPath, '[user]\n\tname = Global Fixture\n[commit]\n\tgpgsign = true\n');
        originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
        process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
    });

    afterEach(async () => {
        if (originalGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    it('leaves the project repository, hooks, and global config untouched', async () => {
        const beforeStatus = (await execGit(['status', '--porcelain=v1'], projectPath)).stdout;
        const beforeGit = await hashDirectory(join(projectPath, '.git'));
        const beforeGlobalConfig = await readFile(globalConfigPath, 'utf8');
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        };

        await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
        });
        await writeFile(join(projectPath, 'tracked.txt'), 'agent version\n');
        await new CheckpointLedger(checkpointRoot).recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-1',
            path: 'tracked.txt',
            action: 'written',
        });

        expect(await hashDirectory(join(projectPath, '.git'))).toEqual(beforeGit);
        expect(await readFile(globalConfigPath, 'utf8')).toBe(beforeGlobalConfig);
        await expect(readFile(join(fixtureRoot, 'hook-ran'), 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
        expect((await execGit(['status', '--porcelain=v1'], projectPath)).stdout).toBe(beforeStatus);
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe('agent version\n');
        expect(await readFile(join(projectPath, 'untracked.txt'), 'utf8')).toBe('user untracked\n');
    });
});

async function execGit(args: string[], cwd: string) {
    return execFileAsync('git', args, { cwd, env: process.env });
}

async function hashDirectory(root: string): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    const pending = [root];
    while (pending.length > 0) {
        const directory = pending.pop()!;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                pending.push(path);
            } else {
                hashes[relative(root, path)] = createHash('sha256')
                    .update(await readFile(path))
                    .digest('hex');
            }
        }
    }
    return hashes;
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
