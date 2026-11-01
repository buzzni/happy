/**
 * aplus-dev-studio workspace-sync-strict-design.md §4-2 — `workspace:sync-remote` (the code save)
 * against real repositories. The cases follow the server's script tests
 * (`buildOwnerSyncBashScript.spec.ts`) with the same outcomes. An https address reaches a local bare
 * repository through a global `insteadOf`, which only remote calls read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeOpMethod } from '@slopus/happy-wire';
import { createWorktreeOpsHandlers } from './worktreeOps';

const machine = { id: 'm1', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey' as const };
const NOW = 1_790_000_000_000;
const ONLINE = 'https://github.com/acme/app.git';
const DEPLOY = 'https://github.com/acme/app-deploy.git';

let root: string;
let home: string;
let ws: string;
let bare: string;
let deployBare: string;
let other: string;
let previousGlobalConfig: string | undefined;

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

function write(dir: string, file: string, content: string) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
}

function commitAll(dir: string, message: string) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '--quiet', '-m', message);
}

function onlineFiles(repository = bare, branch = 'main'): string[] {
    return git(repository, 'ls-tree', '-r', '--name-only', branch).split('\n').filter(Boolean);
}

/** Someone else's change, pushed online. */
function pushOnline(file: string, content: string) {
    git(other, 'pull', '--quiet', '--ff-only', 'origin', 'main');
    write(other, file, content);
    commitAll(other, file);
    git(other, 'push', '--quiet', 'origin', 'main');
}

function pins(): unknown {
    const file = join(home, 'workspace-remotes.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

function savePins(workspaces: Record<string, Record<string, string>>) {
    writeFileSync(join(home, 'workspace-remotes.json'), JSON.stringify({ v: 1, workspaces }));
}

const sync = (over: Record<string, unknown> = {}) => ({
    workspaceDir: ws, kind: 'workspace', remoteUrl: ONLINE, branch: 'main',
    commitMessage: 'sync from owner workspace (trigger: owner-manual, actor: u1)', authorName: 'aplus-sync', authorEmail: 'aplus-sync@buzzni.com',
    sizeCapBytes: 50 * 1024 * 1024, confirmFirstRemote: false, dryRun: false, ...over,
});

async function call(params: Record<string, unknown>) {
    const handlers = createWorktreeOpsHandlers({ machine: () => machine, allowedRoot: root, happyHomeDir: home, now: () => NOW });
    const ticket = {
        v: 1, opId: randomBytes(16).toString('base64'), op: 'sync-remote', projectId: 'p1', machineId: 'm1',
        issuedAt: NOW - 1000, expiresAt: NOW + 60_000, params,
    };
    return (handlers as Record<string, (request: unknown) => Promise<any>>)[worktreeOpMethod('sync-remote')]!({ ticket });
}

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-sync-remote-')));
    home = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-sync-remote-home-')));
    bare = join(root, 'origin.git');
    deployBare = join(root, 'deploy.git');
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', deployBare]);
    // The workspace as a first save leaves it: a repository whose HEAD is the online commit.
    ws = join(root, 'ws');
    mkdirSync(ws);
    git(ws, 'init', '--quiet', '--initial-branch=main');
    write(ws, 'README.md', 'hello\n');
    write(ws, '.gitignore', '.env\n.env.*\n');
    commitAll(ws, 'init');
    git(ws, 'remote', 'add', 'origin', ONLINE);
    git(ws, 'push', '--quiet', bare, 'main');
    other = join(root, 'other');
    execFileSync('git', ['clone', '--quiet', bare, other]);
    const config = join(root, 'gitconfig');
    writeFileSync(config, `[url "${bare}"]\n\tinsteadOf = ${ONLINE}\n[url "${deployBare}"]\n\tinsteadOf = ${DEPLOY}\n`);
    previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
});

afterEach(() => {
    if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
});

describe('workspace:sync-remote (code save)', () => {
    it('pushes the filtered workspace as one commit and lines the workspace git up with it', async () => {
        write(ws, 'src/app.ts', 'export {}\n');
        write(ws, '.env', 'SECRET=1');
        write(ws, 'apps/web/.env.production', 'SECRET=2');
        write(ws, 'node_modules/x/index.js', 'x');
        write(ws, 'dist/app.js', 'built');
        write(ws, '.aplus/worktrees/p1/bright-fox/a.ts', 'wip');
        write(ws, '.aplus/agent/settings.json', '{}');

        const answer = await call(sync());

        expect(answer).toMatchObject({ success: true, attestation: expect.any(String) });
        const head = git(bare, 'rev-parse', 'main');
        expect(answer.result).toEqual({
            status: 'pushed', commitSha: head, filesChanged: 2, sizeBytes: expect.any(Number),
            // What the save left out stays on the machine, unsaved: dependencies, build output, local worktrees.
            origin: 'github.com/acme/app', pinned: 'github.com/acme/app', dirtyCount: 3,
        });
        expect(onlineFiles()).toEqual(['.aplus/agent/settings.json', '.gitignore', 'README.md', 'src/app.ts']);
        expect(git(bare, 'log', '-1', '--format=%an <%ae>|%s', 'main')).toBe('aplus-sync <aplus-sync@buzzni.com>|sync from owner workspace (trigger: owner-manual, actor: u1)');
        // The user's files stay; only HEAD and the index moved.
        expect(git(ws, 'rev-parse', 'HEAD')).toBe(head);
        expect(readFileSync(join(ws, '.env'), 'utf8')).toBe('SECRET=1');
        expect(pins()).toEqual({ v: 1, workspaces: { [ws]: { workspace: 'github.com/acme/app' } } });
    });

    it('answers noop when online already has exactly this snapshot', async () => {
        const answer = await call(sync());
        expect(answer.result).toMatchObject({ status: 'noop-up-to-date', commitSha: git(bare, 'rev-parse', 'main'), filesChanged: 0 });
        expect(git(bare, 'rev-list', '--count', 'main')).toBe('1');
    });

    it('moves a clean workspace up to online first, so the save keeps the other change', async () => {
        pushOnline('online.txt', 'o');
        write(ws, 'mine.txt', 'm');
        // Untracked only: tracked files are clean, as the server's pre-sync pull requires.
        const answer = await call(sync());
        expect(answer.result).toMatchObject({ status: 'pushed' });
        expect(onlineFiles()).toEqual(['.gitignore', 'README.md', 'mine.txt', 'online.txt']);
    });

    it('stops when the workspace is behind online and could not move up (remote-ahead)', async () => {
        pushOnline('online.txt', 'o');
        write(ws, 'README.md', 'edited\n');
        const before = git(bare, 'rev-parse', 'main');
        const answer = await call(sync());
        expect(answer).toMatchObject({
            success: false, errorCode: 'WORKSPACE_REMOTE_AHEAD', workspaceSha: git(ws, 'rev-parse', 'HEAD'), remoteSha: before,
        });
        expect(git(bare, 'rev-parse', 'main')).toBe(before);
        expect(readFileSync(join(ws, 'README.md'), 'utf8')).toBe('edited\n');
    });

    it('refuses a snapshot over the size cap', async () => {
        write(ws, 'big.bin', 'x'.repeat(4096));
        const answer = await call(sync({ sizeCapBytes: 1024 }));
        expect(answer).toMatchObject({ success: false, errorCode: 'WORKSPACE_SNAPSHOT_TOO_LARGE', capBytes: 1024, sizeBytes: expect.any(Number) });
        expect(answer.sizeBytes).toBeGreaterThan(1024);
        expect(onlineFiles()).toEqual(['.gitignore', 'README.md']);
    });

    it('refuses to turn a filtered file that still exists into a deletion online', async () => {
        pushOnline('dist/app.js', 'built');
        git(ws, 'pull', '--quiet', bare, 'main');
        const answer = await call(sync());
        expect(answer).toMatchObject({ success: false, errorCode: 'WORKSPACE_SNAPSHOT_FILTERED_TRACKED_FILES', files: ['dist/app.js'], count: 1 });
        expect(onlineFiles()).toContain('dist/app.js');
    });

    it('refuses unresolved conflict markers', async () => {
        write(ws, 'src/a.ts', '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n');
        const answer = await call(sync());
        expect(answer).toMatchObject({ success: false, errorCode: 'WORKSPACE_CONFLICT_MARKERS', files: ['src/a.ts'] });
        expect(onlineFiles()).not.toContain('src/a.ts');
    });

    it('refuses a workspace with no source files', async () => {
        rmSync(join(ws, 'README.md'));
        write(ws, '.env', 'SECRET=1');
        const answer = await call(sync());
        expect(answer).toMatchObject({ success: false, errorCode: 'WORKSPACE_EMPTY' });
        expect(onlineFiles()).toEqual(['.gitignore', 'README.md']);
    });

    it('copies a link as a link, never what it points to', async () => {
        write(root, 'outside.txt', 'not yours');
        symlinkSync(join(root, 'outside.txt'), join(ws, 'linked.txt'));
        expect((await call(sync())).result).toMatchObject({ status: 'pushed' });
        expect(git(bare, 'cat-file', '-p', 'main:linked.txt')).toBe(join(root, 'outside.txt'));
        expect(git(bare, 'ls-tree', 'main', 'linked.txt')).toMatch(/^120000 /);
    });
});

describe('workspace:sync-remote — the repository it pushes to', () => {
    it('dry run reads what the confirmation needs and changes nothing', async () => {
        write(ws, 'draft.txt', 'd');
        const answer = await call(sync({ dryRun: true }));
        expect(answer.result).toEqual({ status: 'checked', commitSha: null, filesChanged: 0, sizeBytes: 0, origin: 'github.com/acme/app', pinned: null, dirtyCount: 1 });
        expect(pins()).toBeNull();
        expect(onlineFiles()).toEqual(['.gitignore', 'README.md']);
    });

    it('a folder never connected needs the user\'s confirmation before anything is sent', async () => {
        const fresh = join(root, 'fresh');
        write(fresh, 'index.html', '<p>hi</p>');
        expect((await call(sync({ workspaceDir: fresh, dryRun: true }))).result).toMatchObject({ origin: null, pinned: null, dirtyCount: 0 });

        expect(await call(sync({ workspaceDir: fresh }))).toMatchObject({ success: false, errorCode: 'WORKSPACE_REMOTE_CONFIRM_REQUIRED' });
        expect(existsSync(join(fresh, '.git'))).toBe(false);
        expect(pins()).toBeNull();

        const answer = await call(sync({ workspaceDir: fresh, confirmFirstRemote: true }));
        expect(answer.result).toMatchObject({ status: 'pushed', origin: 'github.com/acme/app', pinned: 'github.com/acme/app' });
        // As the server's save: the secret filter is added to the workspace's .gitignore and saved with it.
        expect(onlineFiles()).toEqual(['.gitignore', 'index.html']);
        expect(git(fresh, 'config', '--get', 'remote.origin.url')).toBe(ONLINE);
        expect(git(fresh, 'rev-parse', 'HEAD')).toBe(git(bare, 'rev-parse', 'main'));
        expect(pins()).toEqual({ v: 1, workspaces: { [fresh]: { workspace: 'github.com/acme/app' } } });
    });

    it('refuses a repository other than the one first connected here', async () => {
        savePins({ [ws]: { workspace: 'github.com/acme/first' } });
        write(ws, 'src/app.ts', 'x');
        expect(await call(sync({ confirmFirstRemote: true }))).toMatchObject({ success: false, errorCode: 'WORKSPACE_REMOTE_NOT_PINNED', pinned: 'github.com/acme/first' });
        expect(onlineFiles()).toEqual(['.gitignore', 'README.md']);
    });

    it('refuses a repository other than the one origin names', async () => {
        expect(await call(sync({ remoteUrl: DEPLOY, confirmFirstRemote: true }))).toMatchObject({ success: false, errorCode: 'WORKTREE_REMOTE_MISMATCH' });
        expect(git(deployBare, 'for-each-ref')).toBe('');
    });
});

describe('workspace:sync-remote — deploy repository', () => {
    const deploy = (over: Record<string, unknown> = {}) => sync({ kind: 'deploy', remoteUrl: DEPLOY, ...over });

    it('pushes a pruned snapshot and leaves the workspace git alone', async () => {
        write(ws, 'src/app.ts', 'x');
        write(ws, 'dist/app.js', 'built');
        const gitState = () => [git(ws, 'rev-parse', 'HEAD'), git(ws, 'status', '--porcelain'), git(ws, 'config', '--get-regexp', '^remote\\.'), readFileSync(join(ws, '.gitignore'), 'utf8')];
        const before = gitState();

        expect(await call(deploy())).toMatchObject({ success: false, errorCode: 'WORKSPACE_REMOTE_CONFIRM_REQUIRED' });
        const answer = await call(deploy({ confirmFirstRemote: true }));

        expect(answer.result).toMatchObject({ status: 'pushed', origin: null, pinned: 'github.com/acme/app-deploy' });
        expect(onlineFiles(deployBare)).toEqual(['.gitignore', 'README.md', 'src/app.ts']);
        expect(gitState()).toEqual(before);
        expect(onlineFiles()).toEqual(['.gitignore', 'README.md']);
        expect(pins()).toEqual({ v: 1, workspaces: { [ws]: { deploy: 'github.com/acme/app-deploy' } } });
    });

    it('drops a filtered file the deploy repository still has, and keeps its start script', async () => {
        const seed = join(root, 'seed');
        execFileSync('git', ['clone', '--quiet', deployBare, seed]);
        write(seed, 'dist/old.js', 'old');
        write(seed, '.aplus/runtime-start.sh', '#!/bin/sh\n');
        git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
        commitAll(seed, 'seed');
        git(seed, 'push', '--quiet', 'origin', 'main');
        savePins({ [ws]: { deploy: 'github.com/acme/app-deploy' } });

        expect((await call(deploy())).result).toMatchObject({ status: 'pushed' });
        expect(onlineFiles(deployBare)).toEqual(['.aplus/runtime-start.sh', '.gitignore', 'README.md']);
    });
});
