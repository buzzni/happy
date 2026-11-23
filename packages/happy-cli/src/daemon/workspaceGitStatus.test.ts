/**
 * aplus-dev-studio specs/work-machine-migration — the git status Studio's
 * repository panel shows, read with a fixed git invocation instead of a
 * caller-supplied `bash` command, so a work machine can classify it as a read.
 */
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFileWithoutShell } from './machineMetadataMethods';
import { createWorkspaceGitStatusHandler, type WorkspaceGitStatusDeps } from './workspaceGitStatus';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
});

function setup(overrides: Partial<WorkspaceGitStatusDeps> = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-status-')));
    const happyHome = join(root, '.happy');
    const workspace = join(root, 'workspace', 'project');
    mkdirSync(happyHome, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const runFile = vi.fn<WorkspaceGitStatusDeps['runFile']>(runFileWithoutShell);
    const deps: WorkspaceGitStatusDeps = {
        allowedRoot: root,
        approvedRoots: () => [],
        isGuardedPath: (path) => path.startsWith(happyHome),
        runFile,
        now: () => 1_700_000_000_000,
        ...overrides,
    };
    return { root, happyHome, workspace, runFile, handler: createWorkspaceGitStatusHandler(deps) };
}

function repository(workspace: string, root: string) {
    const remote = join(root, 'remote.git');
    git(root, 'init', '--bare', '-q', '-b', 'main', remote);
    git(workspace, 'init', '-q', '-b', 'main');
    writeFileSync(join(workspace, 'kept.txt'), 'one\n');
    writeFileSync(join(workspace, 'moved.txt'), 'move me\n');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-q', '-m', 'first');
    git(workspace, 'remote', 'add', 'origin', remote);
    git(workspace, 'push', '-q', '-u', 'origin', 'main');
    git(workspace, 'branch', 'feature/x');
    writeFileSync(join(workspace, 'ahead.txt'), 'ahead\n');
    git(workspace, 'add', 'ahead.txt');
    git(workspace, 'commit', '-q', '-m', 'ahead');
    writeFileSync(join(workspace, 'kept.txt'), 'two\n');
    renameSync(join(workspace, 'moved.txt'), join(workspace, 'renamed.txt'));
    git(workspace, 'add', '-A', 'moved.txt', 'renamed.txt');
    writeFileSync(join(workspace, 'new file.txt'), 'untracked\n');
}

describe('workspace-git-status', () => {
    it('answers branch, upstream and base counts, changed files with status codes and untracked files', async () => {
        const { handler, workspace, root } = setup();
        repository(workspace, root);

        const result = await handler({ workspaceRoot: workspace, path: workspace, base: 'origin/feature/x' });

        expect(result).toEqual({
            success: true,
            status: {
                isGit: true,
                root: workspace,
                common: join(workspace, '.git'),
                branch: 'main',
                files: expect.arrayContaining([
                    { path: 'kept.txt', index: ' ', worktree: 'M' },
                    { path: 'renamed.txt', previousPath: 'moved.txt', index: 'R', worktree: ' ' },
                    { path: 'new file.txt', index: '?', worktree: '?' },
                ]),
                branches: [{ name: 'feature/x', checkedOut: false }, { name: 'main', checkedOut: true }],
                remotes: ['origin'],
                upstream: { branch: 'origin/main', ahead: 1, behind: 0 },
                base: { branch: 'feature/x', ahead: 1, behind: 0 },
                checkedAt: 1_700_000_000_000,
            },
        });
        expect((result.status as { files: unknown[] }).files).toHaveLength(3);
    });

    it('answers a branch without upstream or base', async () => {
        const { handler, workspace } = setup();
        git(workspace, 'init', '-q', '-b', 'solo');

        expect(await handler({ workspaceRoot: workspace, path: workspace })).toMatchObject({
            success: true,
            status: { isGit: true, branch: 'solo', files: [], branches: [], remotes: [], upstream: null, base: null },
        });
    });

    it('answers a folder that is not a repository', async () => {
        const { handler, workspace } = setup();

        expect(await handler({ workspaceRoot: workspace, path: workspace })).toEqual({
            success: true,
            status: { isGit: false, branch: null, files: [], branches: [], upstream: null, remotes: [], base: null, checkedAt: 1_700_000_000_000 },
        });
    });

    it('runs only git, without repository-started helpers or prompts, whatever else the caller sends', async () => {
        const { handler, workspace, runFile } = setup();
        git(workspace, 'init', '-q', '-b', 'main');

        await handler({ workspaceRoot: workspace, path: workspace, command: 'touch /tmp/pwned' });

        expect(runFile).toHaveBeenCalled();
        for (const [command, args, options] of runFile.mock.calls) {
            expect(command).toBe('git');
            expect(args).toEqual(expect.arrayContaining(['-c', 'core.fsmonitor=false']));
            expect(args.join(' ')).not.toContain('pwned');
            expect(options.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
            expect(Object.keys(options.env).some((key) => key.startsWith('HAPPY_') || key === 'GIT_DIR')).toBe(false);
        }
    });

    it('refuses a path outside the workspace, inside the happy home, or missing', async () => {
        const { handler, workspace, happyHome, root } = setup();

        expect(await handler({ workspaceRoot: workspace, path: root })).toMatchObject({ success: false, errorCode: 'WORKSPACE_PATH_DENIED' });
        expect(await handler({ workspaceRoot: happyHome, path: happyHome })).toMatchObject({ success: false, errorCode: 'WORKSPACE_PATH_DENIED' });
        expect(await handler({ workspaceRoot: '/', path: '/' })).toMatchObject({ success: false, errorCode: 'WORKSPACE_PATH_DENIED' });
        expect(await handler({ workspaceRoot: workspace, path: join(workspace, 'gone') })).toMatchObject({ success: false, errorCode: 'TARGET_MISSING' });
        expect(await handler({ workspaceRoot: workspace })).toMatchObject({ success: false, errorCode: 'INVALID_PARAMS' });
    });

    it('reads a workspace in a folder the machine owner approved', async () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), 'git-status-approved-')));
        const { handler } = setup({ approvedRoots: () => [outside] });
        git(outside, 'init', '-q', '-b', 'main');

        expect(await handler({ workspaceRoot: outside, path: outside })).toMatchObject({ success: true, status: { isGit: true, branch: 'main' } });
    });

    it('reports git missing and a git that does not finish', async () => {
        const missing = setup({ runFile: async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); } });
        expect(await missing.handler({ workspaceRoot: missing.workspace, path: missing.workspace }))
            .toMatchObject({ success: false, errorCode: 'GIT_UNAVAILABLE' });
        const stuck = setup({ runFile: async () => ({ code: null, stdout: '', stderr: '' }) });
        expect(await stuck.handler({ workspaceRoot: stuck.workspace, path: stuck.workspace }))
            .toMatchObject({ success: false, errorCode: 'GIT_TIMEOUT' });
    });
});
