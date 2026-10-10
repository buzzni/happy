/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary 4b-3 worktree — the daemon runs worktree
 * operations for a strict machine itself, from a ticket the server issued, and signs what it did.
 * Real git in temporary repositories.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    WORKTREE_RESULT_ATTESTATION_KEY_LABEL,
    canonicalWorktreeJson,
    readWorktreeTicket,
    worktreeAttestationPayload,
    type WorktreeOp,
} from '@slopus/happy-wire';
import { deriveServerRpcKey } from '@/api/encryption';
import { createWorktreeOpsHandlers, WORKTREE_OPS_METHODS } from './worktreeOps';

const machineKey = new Uint8Array(32).fill(7);
const machine = { id: 'm1', encryptionKey: machineKey, encryptionVariant: 'dataKey' as 'dataKey' | 'legacy' };
const NOW = 1_790_000_000_000;

let root: string;
let home: string;
let repo: string;
let seq = 0;

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

function handlers(overrides: { allowedRoot?: string; machine?: typeof machine } = {}) {
    return createWorktreeOpsHandlers({
        machine: () => overrides.machine ?? machine,
        allowedRoot: overrides.allowedRoot ?? root,
        happyHomeDir: home,
        now: () => NOW,
    });
}

function ticket(op: WorktreeOp, params: Record<string, unknown>, over: Record<string, unknown> = {}) {
    seq += 1;
    return {
        v: 1, opId: Buffer.alloc(16, seq).toString('base64'), op, projectId: 'p1', machineId: 'm1',
        issuedAt: NOW - 1000, expiresAt: NOW + 60_000, params, ...over,
    };
}

async function call(op: WorktreeOp, params: Record<string, unknown>, over: Record<string, unknown> = {}, set = handlers()) {
    return set[`worktree:${op}`]({ ticket: ticket(op, params, over) }) as Promise<any>;
}

const create = (over: Record<string, unknown> = {}) => ({
    workspaceDir: repo, name: 'bright-fox', baseRef: null, baseSource: 'local',
    snapshotCurrent: false, copyOwnerRuntimeFiles: true, expectedRepoRoot: null, ...over,
});

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-ops-')));
    home = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-ops-home-')));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'init');
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
});

describe('worktree ops tickets', () => {
    it('registers one method per operation', () => {
        expect(Object.keys(handlers()).sort()).toEqual([...WORKTREE_OPS_METHODS].sort());
    });

    it('refuses a missing or malformed ticket', async () => {
        expect(await handlers()['worktree:capability']({})).toMatchObject({ success: false, errorCode: 'TICKET_INVALID' });
        expect(await call('capability', { workspaceDir: 'relative' })).toMatchObject({ success: false, errorCode: 'TICKET_INVALID' });
    });

    it('refuses a ticket for another operation, another machine, or outside its time', async () => {
        const set = handlers();
        expect(await set['worktree:status']({ ticket: ticket('capability', { workspaceDir: repo }) }))
            .toMatchObject({ errorCode: 'TICKET_WRONG_OPERATION' });
        expect(await call('capability', { workspaceDir: repo }, { machineId: 'm2' })).toMatchObject({ errorCode: 'TICKET_WRONG_MACHINE' });
        expect(await call('capability', { workspaceDir: repo }, { issuedAt: NOW - 120_000, expiresAt: NOW - 1 }))
            .toMatchObject({ errorCode: 'TICKET_EXPIRED' });
        expect(await call('capability', { workspaceDir: repo }, { issuedAt: NOW + 120_000, expiresAt: NOW + 180_000 }))
            .toMatchObject({ errorCode: 'TICKET_EXPIRED' });
    });

    it('runs each ticket once', async () => {
        const set = handlers();
        const once = ticket('capability', { workspaceDir: repo });
        expect(await set['worktree:capability']({ ticket: once })).toMatchObject({ success: true });
        expect(await set['worktree:capability']({ ticket: once })).toMatchObject({ success: false, errorCode: 'TICKET_REPLAYED' });
    });

    it('needs a machine key to sign with', async () => {
        expect(await call('capability', { workspaceDir: repo }, {}, handlers({ machine: { ...machine, encryptionVariant: 'legacy' } })))
            .toMatchObject({ success: false, errorCode: 'WORKTREE_OPS_UNSUPPORTED' });
    });

    it('signs the ticket and the result with the attestation key derived from the lane key', async () => {
        const sent = ticket('capability', { workspaceDir: repo });
        const answer = await handlers()['worktree:capability']({ ticket: sent }) as any;
        const read = readWorktreeTicket(sent);
        if (!read.ok) throw new Error('ticket');
        const key = createHmac('sha256', deriveServerRpcKey(machineKey)).update(WORKTREE_RESULT_ATTESTATION_KEY_LABEL).digest();
        const expected = createHmac('sha256', key)
            .update(canonicalWorktreeJson(worktreeAttestationPayload(read.ticket, answer.result, answer.finishedAt)))
            .digest('base64');
        expect(answer).toMatchObject({ success: true, finishedAt: NOW, attestation: expected });
    });
});

describe('worktree:capability and worktree:prepare', () => {
    it('reports a repository with its branches', async () => {
        git(repo, 'branch', 'feature-x');
        expect((await call('capability', { workspaceDir: repo })).result)
            .toEqual({ capable: true, reason: 'ready', branch: 'main', branches: ['feature-x', 'main'] });
    });

    it('reports a folder that is not a repository', async () => {
        const plain = join(root, 'plain');
        mkdirSync(plain);
        expect((await call('capability', { workspaceDir: plain })).result)
            .toEqual({ capable: false, reason: 'not-git', branch: null, branches: [] });
    });

    it('starts a repository on main when the folder is not one', async () => {
        const plain = join(root, 'plain');
        mkdirSync(plain);
        expect((await call('prepare', { workspaceDir: plain })).result)
            // The current branch is listed before its first commit, as the server lists it.
            .toEqual({ capable: true, reason: 'ready', branch: 'main', branches: ['main'] });
        expect(existsSync(join(plain, '.git'))).toBe(true);
    });

    it('refuses a folder outside the allowed root or in the happy home', async () => {
        expect(await call('capability', { workspaceDir: home })).toMatchObject({ success: false, errorCode: 'PATH_DENIED' });
        expect(await call('prepare', { workspaceDir: tmpdir() })).toMatchObject({ success: false, errorCode: 'PATH_DENIED' });
        expect(await call('capability', { workspaceDir: join(root, 'missing') })).toMatchObject({ success: false, errorCode: 'WORKSPACE_MISSING' });
    });
});

describe('worktree:create', () => {
    it('adds the worktree under the project namespace on a branch of its name and copies local env files', async () => {
        writeFileSync(join(repo, '.env'), 'A=1\n');
        const answer = await call('create', create());
        const path = `${repo}/.aplus/worktrees/p1/bright-fox`;
        expect(answer).toMatchObject({ success: true });
        expect(answer.result).toEqual({
            path, branch: 'bright-fox', baseBranch: 'HEAD', baseRevision: null, repoRelativeDir: '', repoRoot: repo,
        });
        expect(git(path, 'branch', '--show-current')).toBe('bright-fox');
        expect(readFileSync(join(path, '.env'), 'utf8')).toBe('A=1\n');
        expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8')).toContain('/.aplus/worktrees/');
    });

    it('starts from a chosen local branch', async () => {
        git(repo, 'switch', '--quiet', '-c', 'develop');
        writeFileSync(join(repo, 'dev.txt'), 'dev\n');
        git(repo, 'add', '-A');
        git(repo, 'commit', '--quiet', '-m', 'dev');
        git(repo, 'switch', '--quiet', 'main');
        const answer = await call('create', create({ baseRef: 'develop' }));
        expect(answer.result.baseBranch).toBe('develop');
        expect(existsSync(join(answer.result.path, 'dev.txt'))).toBe(true);
    });

    it('saves the current work first and starts from it, keeping env files out of the commit', async () => {
        writeFileSync(join(repo, 'wip.txt'), 'wip\n');
        writeFileSync(join(repo, '.env'), 'SECRET=1\n');
        const answer = await call('create', create({ snapshotCurrent: true }));
        const head = git(repo, 'rev-parse', 'HEAD');
        expect(answer.result).toMatchObject({ baseBranch: 'main', baseRevision: head });
        expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual(['wip.txt']);
        expect(existsSync(join(answer.result.path, 'wip.txt'))).toBe(true);
    });

    it('refuses a workspace that is not the repository root unless the server confirmed that root', async () => {
        const app = join(repo, 'app');
        mkdirSync(app);
        writeFileSync(join(app, '.env'), 'APP=1\n');
        expect(await call('create', create({ workspaceDir: app }))).toMatchObject({
            success: false, errorCode: 'WORKTREE_NOT_REPO_ROOT',
            subdir: { repoRoot: repo, workspaceDir: app, repoRelativeDir: 'app' },
        });
        const answer = await call('create', create({ workspaceDir: app, expectedRepoRoot: repo }));
        expect(answer.result).toMatchObject({ repoRelativeDir: 'app', repoRoot: repo });
        expect(readFileSync(join(answer.result.path, 'app/.env'), 'utf8')).toBe('APP=1\n');
    });

    it('refuses a repository root outside the allowed root', async () => {
        const app = join(repo, 'app');
        mkdirSync(app);
        expect(await call('create', create({ workspaceDir: app, expectedRepoRoot: repo }), {}, handlers({ allowedRoot: app })))
            .toMatchObject({ success: false, errorCode: 'PATH_DENIED' });
    });

    it('copies .worktreeinclude entries only from inside the repository', async () => {
        mkdirSync(join(repo, 'config'));
        writeFileSync(join(repo, 'config/local.json'), '{}');
        writeFileSync(join(root, 'outside.txt'), 'no');
        writeFileSync(join(repo, '.worktreeinclude'), '# local\nconfig/local.json\n../outside.txt\n/etc/hosts\n');
        const answer = await call('create', create());
        expect(readFileSync(join(answer.result.path, 'config/local.json'), 'utf8')).toBe('{}');
        expect(existsSync(join(answer.result.path, '../outside.txt'))).toBe(false);
    });

    it('reports a name already taken', async () => {
        git(repo, 'branch', 'bright-fox');
        expect(await call('create', create())).toMatchObject({ success: false, errorCode: 'WORKTREE_NAME_CONFLICT' });
    });

    it('creates two worktrees of one repository at the same time', async () => {
        const set = handlers();
        const [a, b] = await Promise.all([
            call('create', create({ name: 'a' }), {}, set),
            call('create', create({ name: 'b' }), {}, set),
        ]);
        expect([a.success, b.success]).toEqual([true, true]);
    });
});

describe('worktree:status', () => {
    it('reports dirty, ahead and behind against the base branch', async () => {
        const { result } = await call('create', create());
        writeFileSync(join(result.path, 'new.txt'), 'x');
        git(result.path, 'add', '-A');
        git(result.path, 'commit', '--quiet', '-m', 'work');
        writeFileSync(join(result.path, 'dirty.txt'), 'x');
        expect((await call('status', { worktreePath: result.path, branch: 'bright-fox', baseBranch: 'main' })).result)
            .toEqual({ dirty: true, behind: 0, ahead: 1 });
    });

    it('reports a missing worktree path', async () => {
        expect(await call('status', { worktreePath: `${repo}/.aplus/worktrees/p1/gone`, branch: 'gone', baseBranch: 'main' }))
            .toMatchObject({ success: false, errorCode: 'WORKTREE_PATH_MISSING' });
    });
});

describe('worktree:remove', () => {
    const remove = (path: string, over: Record<string, unknown> = {}) => ({ worktreePath: path, branch: 'bright-fox', force: false, dryRun: false, ...over });

    it('answers a dry run without removing, then removes the worktree and its branch', async () => {
        const { result } = await call('create', create());
        expect((await call('remove', remove(result.path, { dryRun: true }))).result).toEqual({ outcome: 'removable' });
        expect(existsSync(result.path)).toBe(true);
        expect((await call('remove', remove(result.path))).result).toEqual({ outcome: 'removed' });
        expect(existsSync(result.path)).toBe(false);
        expect(git(repo, 'branch', '--list', 'bright-fox')).toBe('');
    });

    it('keeps a worktree with uncommitted or unapplied work unless forced', async () => {
        const { result } = await call('create', create());
        writeFileSync(join(result.path, 'dirty.txt'), 'x');
        expect(await call('remove', remove(result.path))).toMatchObject({ success: false, errorCode: 'WORKTREE_DIRTY' });
        git(result.path, 'add', '-A');
        git(result.path, 'commit', '--quiet', '-m', 'work');
        expect(await call('remove', remove(result.path))).toMatchObject({ success: false, errorCode: 'WORKTREE_DIRTY' });
        expect(existsSync(result.path)).toBe(true);
        expect((await call('remove', remove(result.path, { force: true }))).result).toEqual({ outcome: 'removed' });
        expect(existsSync(result.path)).toBe(false);
    });

    it('reports a worktree already gone', async () => {
        expect((await call('remove', remove(`${repo}/.aplus/worktrees/p1/gone`))).result).toEqual({ outcome: 'missing' });
    });

    it('refuses a path outside this project\'s managed worktrees', async () => {
        const other = join(repo, '.aplus/worktrees/p2/x');
        mkdirSync(other, { recursive: true });
        expect(await call('remove', remove(other))).toMatchObject({ success: false, errorCode: 'PATH_DENIED' });
        expect(await call('remove', remove(repo))).toMatchObject({ success: false, errorCode: 'PATH_DENIED' });
        const outside = join(root, 'elsewhere');
        mkdirSync(outside);
        mkdirSync(join(repo, '.aplus/worktrees/p1'), { recursive: true });
        symlinkSync(outside, join(repo, '.aplus/worktrees/p1/linked'));
        expect(await call('remove', remove(`${repo}/.aplus/worktrees/p1/linked`, { force: true })))
            .toMatchObject({ success: false, errorCode: 'PATH_DENIED' });
        expect(existsSync(outside)).toBe(true);
    });
});
