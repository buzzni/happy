/**
 * aplus-dev-studio workspace-sync-strict-design.md (F6) — `workspace:remote-status`,
 * `workspace:pull-remote` and `workspace:clone` against real repositories. An https address reaches a
 * local bare repository through a global `insteadOf`, which only remote calls read (as a machine's
 * own git config would be read there).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeOpMethod, type WorktreeOp } from '@slopus/happy-wire';
import { createWorktreeOpsHandlers } from './worktreeOps';

const machine = { id: 'm1', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey' as const };
const NOW = 1_790_000_000_000;
const ONLINE = 'https://github.com/acme/app.git';

let root: string;
let home: string;
let repo: string;
let bare: string;
let other: string;
let previousGlobalConfig: string | undefined;

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

function write(dir: string, file: string, content: string) {
    writeFileSync(join(dir, file), content);
}

function commitAll(dir: string, message: string) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '--quiet', '-m', message);
}

async function call(op: WorktreeOp, params: Record<string, unknown>) {
    const handlers = createWorktreeOpsHandlers({ machine: () => machine, allowedRoot: root, happyHomeDir: home, now: () => NOW });
    const ticket = {
        v: 1, opId: randomBytes(16).toString('base64'), op, projectId: 'p1', machineId: 'm1',
        issuedAt: NOW - 1000, expiresAt: NOW + 60_000, params,
    };
    return (handlers as Record<string, (request: unknown) => Promise<any>>)[worktreeOpMethod(op)]!({ ticket });
}

function pins(): unknown {
    const file = join(home, 'workspace-remotes.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** Someone else's change, pushed to `branch` online. */
function pushOnline(file: string, content: string, branch = 'main') {
    git(other, 'switch', '--quiet', branch);
    git(other, 'pull', '--quiet', '--ff-only', 'origin', branch);
    write(other, file, content);
    commitAll(other, file);
    git(other, 'push', '--quiet', 'origin', branch);
}

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-sync-')));
    home = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-sync-home-')));
    bare = join(root, 'origin.git');
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
    repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '--quiet', '--initial-branch=main');
    write(repo, 'README.md', 'hello\n');
    commitAll(repo, 'init');
    git(repo, 'remote', 'add', 'origin', ONLINE);
    git(repo, 'push', '--quiet', bare, 'main');
    other = join(root, 'other');
    execFileSync('git', ['clone', '--quiet', bare, other]);
    const config = join(root, 'gitconfig');
    writeFileSync(config, `[url "${bare}"]\n\tinsteadOf = ${ONLINE}\n`);
    previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
});

afterEach(() => {
    if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
});

describe('workspace:remote-status', () => {
    const status = (over: Record<string, unknown> = {}) => ({ workspaceDir: repo, remoteUrl: ONLINE, branch: 'main', baseBranch: null, ...over });

    it('tells how far the workspace is from online, and pins its origin', async () => {
        pushOnline('online.txt', 'o');
        write(repo, 'draft.txt', 'd');
        write(repo, '.env', 'SECRET=1');
        const answer = await call('remote-status', status());
        expect(answer).toMatchObject({ success: true });
        expect(answer.result).toEqual({
            isRepo: true, head: git(repo, 'rev-parse', 'HEAD'), branch: 'main', dirtyCount: 1, ahead: 0, behind: 1, baseBehind: null,
        });
        expect(pins()).toEqual({ v: 1, workspaces: { [repo]: { workspace: 'github.com/acme/app' } } });
    });

    it('answers a folder that is not a repository of its own without touching it', async () => {
        const plain = join(repo, 'sub');
        mkdirSync(plain);
        expect((await call('remote-status', status({ workspaceDir: plain }))).result).toEqual({
            isRepo: false, head: null, branch: null, dirtyCount: 0, ahead: null, behind: null, baseBehind: null,
        });
    });

    it('refuses an address that is not the repository origin names', async () => {
        expect(await call('remote-status', status({ remoteUrl: 'https://github.com/acme/other.git' })))
            .toMatchObject({ success: false, errorCode: 'WORKTREE_REMOTE_MISMATCH' });
    });

    it('refuses a workspace without origin', async () => {
        git(repo, 'remote', 'remove', 'origin');
        expect(await call('remote-status', status())).toMatchObject({ success: false, errorCode: 'WORKSPACE_NO_REMOTE' });
    });

    it('refuses once origin no longer names the repository first connected here', async () => {
        writeFileSync(join(home, 'workspace-remotes.json'), JSON.stringify({ v: 1, workspaces: { [repo]: { workspace: 'github.com/acme/first' } } }));
        expect(await call('remote-status', status())).toMatchObject({ success: false, errorCode: 'WORKSPACE_REMOTE_NOT_PINNED', pinned: 'github.com/acme/first' });
    });
});

describe('workspace:pull-remote', () => {
    const pull = (over: Record<string, unknown> = {}) => ({
        workspaceDir: repo, remoteUrl: ONLINE, branch: 'main', baseBranch: null, mode: 'ff-only',
        expectedHead: git(repo, 'rev-parse', 'HEAD'), push: false, ...over,
    });

    it('moves a clean workspace forward', async () => {
        pushOnline('online.txt', 'o');
        const answer = await call('pull-remote', pull());
        expect(answer.result).toEqual({ status: 'fast-forwarded', head: git(bare, 'rev-parse', 'main'), conflictCount: 0 });
        expect(readFileSync(join(repo, 'online.txt'), 'utf8')).toBe('o');
    });

    it('brings a collaboration branch up to the merged base and pushes it', async () => {
        git(repo, 'push', '--quiet', bare, 'main:collab-x');
        git(repo, 'switch', '--quiet', '-c', 'collab-x');
        pushOnline('merged.txt', 'm');
        const answer = await call('pull-remote', pull({ branch: 'collab-x', baseBranch: 'main', push: true }));
        expect(answer.result).toMatchObject({ status: 'fast-forwarded', head: git(bare, 'rev-parse', 'main') });
        expect(git(bare, 'rev-parse', 'collab-x')).toBe(git(bare, 'rev-parse', 'main'));
    });

    it('does nothing when the workspace moved since the user saw it', async () => {
        pushOnline('online.txt', 'o');
        const answer = await call('pull-remote', pull({ expectedHead: 'b'.repeat(40) }));
        expect(answer.result).toEqual({ status: 'head-moved', head: git(repo, 'rev-parse', 'HEAD'), conflictCount: 0 });
        expect(existsSync(join(repo, 'online.txt'))).toBe(false);
    });

    it('keeps unsaved work instead of fast-forwarding over it', async () => {
        pushOnline('online.txt', 'o');
        write(repo, 'README.md', 'mine\n');
        expect((await call('pull-remote', pull())).result).toMatchObject({ status: 'dirty' });
        expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('mine\n');
    });

    it('keeps local commits that online does not have', async () => {
        pushOnline('online.txt', 'o');
        write(repo, 'local.txt', 'l');
        commitAll(repo, 'local');
        const head = git(repo, 'rev-parse', 'HEAD');
        expect((await call('pull-remote', pull())).result).toEqual({ status: 'diverged', head, conflictCount: 0 });
    });

    it('saves the current files and merges the online code in', async () => {
        pushOnline('online.txt', 'o');
        write(repo, 'draft.txt', 'd');
        expect((await call('pull-remote', pull({ mode: 'merge' }))).result).toMatchObject({ status: 'merged', conflictCount: 0 });
        expect(readFileSync(join(repo, 'online.txt'), 'utf8')).toBe('o');
        expect(readFileSync(join(repo, 'draft.txt'), 'utf8')).toBe('d');
        expect(git(repo, 'status', '--porcelain')).toBe('');
    });

    it('leaves a conflict for the user to resolve', async () => {
        pushOnline('README.md', 'theirs\n');
        write(repo, 'README.md', 'mine\n');
        expect((await call('pull-remote', pull({ mode: 'merge' }))).result).toMatchObject({ status: 'conflict', conflictCount: 1 });
        expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('<<<<<<<');
    });

    it('answers a folder that is not a repository of its own', async () => {
        const plain = join(repo, 'sub');
        mkdirSync(plain);
        expect((await call('pull-remote', pull({ workspaceDir: plain, expectedHead: null }))).result)
            .toEqual({ status: 'not-a-repo', head: null, conflictCount: 0 });
    });
});

describe('workspace:clone', () => {
    const folder = () => join(root, 'aplus-dev-studio-workspace', 'u2', 'p1');
    const clone = (over: Record<string, unknown> = {}) => ({ workspaceDir: folder(), remoteUrl: ONLINE, branch: 'collab-x', ...over });

    beforeEach(() => {
        git(repo, 'push', '--quiet', bare, 'main:collab-x');
    });

    it('clones the collaboration branch into the project folder and pins its repository', async () => {
        const answer = await call('clone', clone());
        expect(answer.result).toEqual({ changed: true, head: git(bare, 'rev-parse', 'collab-x'), branch: 'collab-x' });
        expect(git(folder(), 'config', '--get', 'remote.origin.url')).toBe(ONLINE);
        expect(pins()).toEqual({ v: 1, workspaces: { [folder()]: { workspace: 'github.com/acme/app' } } });
    });

    it('answers a retry after the clone landed without cloning again', async () => {
        await call('clone', clone());
        expect((await call('clone', clone())).result).toEqual({ changed: false, head: git(bare, 'rev-parse', 'collab-x'), branch: 'collab-x' });
    });

    it('refuses a folder that is not this project\'s managed folder', async () => {
        expect(await call('clone', clone({ workspaceDir: join(root, 'elsewhere', 'p1') }))).toMatchObject({ success: false, errorCode: 'PATH_DENIED' });
        expect(await call('clone', clone({ workspaceDir: join(root, 'aplus-dev-studio-workspace', 'u2', 'p2') })))
            .toMatchObject({ success: false, errorCode: 'PATH_DENIED' });
    });

    it('refuses a folder that already holds other files, and leaves them', async () => {
        mkdirSync(folder(), { recursive: true });
        write(folder(), 'mine.txt', 'keep');
        expect(await call('clone', clone())).toMatchObject({ success: false, errorCode: 'WORKSPACE_NOT_EMPTY' });
        expect(readdirSync(folder())).toEqual(['mine.txt']);
    });

    it('refuses a folder reached through a link', async () => {
        const target = join(root, 'target');
        mkdirSync(target);
        symlinkSync(target, join(root, 'aplus-dev-studio-workspace'));
        expect(await call('clone', clone())).toMatchObject({ success: false, errorCode: 'PATH_DENIED' });
        expect(readdirSync(target)).toEqual([]);
    });

    it('tells a missing branch apart and leaves the folder empty for a retry', async () => {
        expect(await call('clone', clone({ branch: 'collab-missing' }))).toMatchObject({ success: false, errorCode: 'WORKSPACE_CLONE_BRANCH_MISSING' });
        expect(readdirSync(folder())).toEqual([]);
    });
});
