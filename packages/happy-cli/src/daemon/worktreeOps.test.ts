/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary 4b-3 worktree — the daemon runs worktree
 * operations for a strict machine itself, from a ticket the server issued, and signs what it did.
 * Real git in temporary repositories.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    GIT_CREDENTIAL_SEAL_KEY_LABEL,
    WORKTREE_RESULT_ATTESTATION_KEY_LABEL,
    canonicalWorktreeJson,
    readWorktreeTicket,
    worktreeAttestationPayload,
    type WorktreeOp,
} from '@slopus/happy-wire';
import { deriveServerRpcKey } from '@/api/encryption';
import { sealForMachine } from '@/modules/common/machineSeal';
import { createWorktreeOpsHandlers, prepareGitCredential, WORKTREE_OPS_METHODS } from './worktreeOps';

const machineKey = new Uint8Array(32).fill(7);
const machine = { id: 'm1', encryptionKey: machineKey, encryptionVariant: 'dataKey' as 'dataKey' | 'legacy' };
const NOW = 1_790_000_000_000;

let root: string;
let home: string;
let repo: string;

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
    return {
        v: 1, opId: randomBytes(16).toString('base64'), op, projectId: 'p1', machineId: 'm1',
        issuedAt: NOW - 1000, expiresAt: NOW + 60_000, params, ...over,
    };
}

async function call(op: WorktreeOp, params: Record<string, unknown>, over: Record<string, unknown> = {}, set = handlers()) {
    return set[`worktree:${op}`]({ ticket: ticket(op, params, over) }) as Promise<any>;
}

function write(dir: string, file: string, content: string) {
    writeFileSync(join(dir, file), content);
}

function commitAll(dir: string, message: string) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '--quiet', '-m', message);
}

/** A bare `origin` with main pushed, and a second clone standing in for someone else online. */
function withOrigin(): { bare: string; other: string } {
    const bare = join(root, 'origin.git');
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '--quiet', 'origin', 'main');
    const other = join(root, 'other');
    execFileSync('git', ['clone', '--quiet', bare, other]);
    return { bare, other };
}

const create = (over: Record<string, unknown> = {}) => ({
    workspaceDir: repo, name: 'bright-fox', baseRef: null, baseSource: 'local',
    snapshotCurrent: false, copyOwnerRuntimeFiles: true, expectedRepoRoot: null, remoteUrl: null, ...over,
});

async function worktree(name = 'bright-fox'): Promise<string> {
    const answer = await call('create', create({ name }));
    if (!answer.success) throw new Error(answer.error);
    return answer.result.path;
}

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

    it('remembers used tickets across handler sets, as a reconnect makes a new one', async () => {
        const once = ticket('capability', { workspaceDir: repo });
        expect(await handlers()['worktree:capability']({ ticket: once })).toMatchObject({ success: true });
        expect(await handlers()['worktree:capability']({ ticket: once })).toMatchObject({ success: false, errorCode: 'TICKET_REPLAYED' });
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

    it.skipIf(process.platform === 'win32')('refuses a path another platform would call absolute', async () => {
        expect(await call('capability', { workspaceDir: 'C:/repo' })).toMatchObject({ success: false, errorCode: 'PATH_DENIED' });
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

    it('copies nothing read through a link that leaves the repository', async () => {
        const outside = join(root, 'outside');
        mkdirSync(outside);
        writeFileSync(join(outside, 'secret.txt'), 'no');
        symlinkSync(outside, join(repo, 'linked'));
        writeFileSync(join(repo, '.worktreeinclude'), 'linked/secret.txt\n');
        const answer = await call('create', create());
        expect(answer.success).toBe(true);
        expect(existsSync(join(answer.result.path, 'linked/secret.txt'))).toBe(false);
    });

    it('writes nothing through a link in the new worktree that leaves it', async () => {
        const outside = join(root, 'outside');
        mkdirSync(outside);
        symlinkSync(outside, join(repo, 'cfg'));
        git(repo, 'add', '-A');
        git(repo, 'commit', '--quiet', '-m', 'link');
        // The owner's checkout has a real folder where the committed tree has the link.
        rmSync(join(repo, 'cfg'));
        mkdirSync(join(repo, 'cfg'));
        writeFileSync(join(repo, 'cfg/local.json'), '{}');
        writeFileSync(join(repo, '.worktreeinclude'), 'cfg/local.json\n');
        const answer = await call('create', create());
        expect(answer.success).toBe(true);
        expect(existsSync(join(outside, 'local.json'))).toBe(false);
    });

    it('creates nothing through a linked .aplus or project folder', async () => {
        const outside = join(root, 'outside');
        mkdirSync(outside);
        symlinkSync(outside, join(repo, '.aplus'));
        expect(await call('create', create())).toMatchObject({ success: false, errorCode: 'PATH_DENIED' });
        expect(existsSync(join(outside, 'worktrees'))).toBe(false);
        rmSync(join(repo, '.aplus'));
        mkdirSync(join(repo, '.aplus/worktrees'), { recursive: true });
        const elsewhere = join(repo, 'elsewhere');
        mkdirSync(elsewhere);
        symlinkSync(elsewhere, join(repo, '.aplus/worktrees/p1'));
        expect(await call('create', create())).toMatchObject({ success: false, errorCode: 'PATH_DENIED' });
        expect(existsSync(join(elsewhere, 'bright-fox'))).toBe(false);
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

    it('treats a folder git does not know as a worktree as missing, never reading the repository around it', async () => {
        const stray = join(repo, '.aplus/worktrees/p1/stray');
        mkdirSync(stray, { recursive: true });
        writeFileSync(join(repo, 'dirty.txt'), 'x');
        expect(await call('status', { worktreePath: stray, branch: 'stray', baseBranch: 'main' }))
            .toMatchObject({ success: false, errorCode: 'WORKTREE_PATH_MISSING' });
        expect((await call('remove', { worktreePath: stray, branch: 'stray', force: false, dryRun: false })).result).toEqual({ outcome: 'missing' });
        expect(existsSync(stray)).toBe(true);
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

describe('worktree:apply', () => {
    const apply = (path: string, over: Record<string, unknown> = {}) => ({ worktreePath: path, branch: 'bright-fox', baseBranch: 'main', ...over });

    it('saves the worktree\'s work and merges it into the default version', async () => {
        const path = await worktree();
        write(path, 'feature.txt', 'f');
        commitAll(path, 'feature');
        write(path, 'unsaved.txt', 'u');
        expect((await call('apply', apply(path))).result).toEqual({ appliedToBranch: 'main' });
        expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('f');
        expect(readFileSync(join(repo, 'unsaved.txt'), 'utf8')).toBe('u');
    });

    it('applies nothing, and saves nothing, when the default version moved to another branch', async () => {
        const path = await worktree();
        git(repo, 'switch', '--quiet', '-c', 'other');
        write(repo, 'wip.txt', 'w');
        const head = git(repo, 'rev-parse', 'HEAD');
        expect(await call('apply', apply(path))).toMatchObject({ success: false, errorCode: 'WORKTREE_BASE_BRANCH_MISMATCH', currentBranch: 'other' });
        expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
        expect(git(repo, 'status', '--porcelain')).toBe('?? wip.txt');
    });

    it('leaves both sides as they were on a conflict', async () => {
        const path = await worktree();
        write(path, 'README.md', 'worktree\n');
        commitAll(path, 'w');
        write(repo, 'README.md', 'main\n');
        commitAll(repo, 'm');
        expect(await call('apply', apply(path))).toMatchObject({ success: false, errorCode: 'WORKTREE_APPLY_CONFLICT' });
        expect(existsSync(join(repo, '.git/MERGE_HEAD'))).toBe(false);
        expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('main\n');
    });
});

describe('worktree:update', () => {
    const update = (path: string, over: Record<string, unknown> = {}) => ({
        worktreePath: path, branch: 'bright-fox', baseBranch: 'main', conflictChoice: null, ...over,
    });

    it('merges the base branch into the worktree', async () => {
        const path = await worktree();
        write(repo, 'new.txt', 'n');
        commitAll(repo, 'n');
        const answer = await call('update', update(path));
        expect(answer.result).toEqual({ head: git(path, 'rev-parse', 'HEAD') });
        expect(existsSync(join(path, 'new.txt'))).toBe(true);
    });

    it('reports conflicts and keeps the worktree as it was, or settles them one way when asked', async () => {
        const path = await worktree();
        write(path, 'README.md', 'mine\n');
        commitAll(path, 'w');
        write(repo, 'README.md', 'base\n');
        commitAll(repo, 'm');
        expect(await call('update', update(path))).toMatchObject({ success: false, errorCode: 'WORKTREE_UPDATE_CONFLICT', conflicts: ['README.md'] });
        expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('mine\n');
        expect((await call('update', update(path, { conflictChoice: 'base' }))).success).toBe(true);
        expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('base\n');
    });

    it('saves nothing in the default version when it moved to another branch', async () => {
        const path = await worktree();
        git(repo, 'switch', '--quiet', '-c', 'other');
        write(repo, 'wip.txt', 'w');
        const head = git(repo, 'rev-parse', 'HEAD');
        expect(await call('update', update(path))).toMatchObject({
            success: false, errorCode: 'WORKTREE_BASE_BRANCH_MISMATCH', baseBranch: 'main', currentBranch: 'other',
        });
        expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
        expect(git(repo, 'status', '--porcelain')).toBe('?? wip.txt');
    });

    it('refuses when the worktree is on another branch', async () => {
        const path = await worktree();
        git(path, 'switch', '--quiet', '-c', 'elsewhere');
        expect(await call('update', update(path))).toMatchObject({ success: false, errorCode: 'WORKTREE_BRANCH_MISMATCH' });
    });
});

describe('worktree:recover', () => {
    it('adds a worktree back on its branch after its folder was lost', async () => {
        const path = await worktree();
        rmSync(path, { recursive: true, force: true });
        expect((await call('recover', { worktreePath: path, branch: 'bright-fox' })).result).toEqual({ recovered: true });
        expect(git(path, 'branch', '--show-current')).toBe('bright-fox');
        expect((await call('recover', { worktreePath: path, branch: 'bright-fox' })).result).toEqual({ recovered: false });
    });

    it('adds nothing back through a linked project folder', async () => {
        const path = await worktree();
        rmSync(path, { recursive: true, force: true });
        git(repo, 'worktree', 'prune');
        const outside = join(root, 'outside');
        mkdirSync(outside);
        rmSync(join(repo, '.aplus/worktrees/p1'), { recursive: true, force: true });
        symlinkSync(outside, join(repo, '.aplus/worktrees/p1'));
        expect(await call('recover', { worktreePath: path, branch: 'bright-fox' })).toMatchObject({ success: false, errorCode: 'PATH_DENIED' });
        expect(existsSync(join(outside, 'bright-fox'))).toBe(false);
    });

    it('refuses a missing branch or a path taken by something else', async () => {
        expect(await call('recover', { worktreePath: `${repo}/.aplus/worktrees/p1/gone`, branch: 'gone' }))
            .toMatchObject({ success: false, errorCode: 'WORKTREE_RECOVERY_BRANCH_MISSING' });
        const taken = join(repo, '.aplus/worktrees/p1/taken');
        mkdirSync(taken, { recursive: true });
        git(repo, 'branch', 'taken');
        expect(await call('recover', { worktreePath: taken, branch: 'taken' }))
            .toMatchObject({ success: false, errorCode: 'WORKTREE_RECOVERY_PATH_OCCUPIED' });
    });
});

describe('worktree:adopt-check', () => {
    it('confirms a registered worktree of this repository with its branch', async () => {
        const path = await worktree();
        expect((await call('adopt-check', { workspaceDir: repo, worktreePath: path, expectedRepoRoot: null })).result)
            .toEqual({ path, branch: 'bright-fox', repoRoot: repo });
    });

    it('refuses a folder git does not know as a worktree', async () => {
        const stray = join(repo, '.aplus/worktrees/p1/stray');
        mkdirSync(stray, { recursive: true });
        expect(await call('adopt-check', { workspaceDir: repo, worktreePath: stray, expectedRepoRoot: null }))
            .toMatchObject({ success: false, errorCode: 'WORKTREE_NOT_REGISTERED' });
    });
});

describe('worktree:create-branch', () => {
    it('creates and switches to a new branch in the default version', async () => {
        expect((await call('create-branch', { workspaceDir: repo, branchName: 'feature/a' })).result).toEqual({ branch: 'feature/a' });
        expect(git(repo, 'branch', '--show-current')).toBe('feature/a');
    });

    it('refuses a name git rejects or one already used', async () => {
        expect(await call('create-branch', { workspaceDir: repo, branchName: 'a..b' })).toMatchObject({ errorCode: 'WORKSPACE_BRANCH_INVALID' });
        expect(await call('create-branch', { workspaceDir: repo, branchName: 'main' })).toMatchObject({ errorCode: 'WORKSPACE_BRANCH_EXISTS' });
    });

    it('starts a repository first when the folder is not one', async () => {
        const plain = join(root, 'plain');
        mkdirSync(plain);
        expect((await call('create-branch', { workspaceDir: plain, branchName: 'start' })).result).toEqual({ branch: 'start' });
    });
});

describe('worktree:prepare-conversation', () => {
    const prepare = (over: Record<string, unknown> = {}) => ({
        workspaceDir: repo, baseBranch: 'main', source: 'local', allowCurrentBranchDirty: true, remoteUrl: null,
        statusPathspecs: ['.', ':(exclude,glob)**/.env*'], ...over,
    });

    it('switches to a local branch when the work is saved', async () => {
        git(repo, 'branch', 'develop');
        expect((await call('prepare-conversation', prepare({ baseBranch: 'develop' }))).result).toEqual({ branch: 'develop' });
        expect(git(repo, 'branch', '--show-current')).toBe('develop');
    });

    it('stays on the current branch with unsaved work only when allowed, and ignores excluded paths', async () => {
        write(repo, 'wip.txt', 'w');
        expect((await call('prepare-conversation', prepare())).result).toEqual({ branch: 'main' });
        expect(await call('prepare-conversation', prepare({ allowCurrentBranchDirty: false }))).toMatchObject({
            success: false, errorCode: 'WORKSPACE_DIRTY', currentBranch: 'main', dirtyStatus: expect.stringContaining('wip.txt'),
        });
        rmSync(join(repo, 'wip.txt'));
        write(repo, '.env', 'A=1');
        git(repo, 'branch', 'develop');
        expect((await call('prepare-conversation', prepare({ baseBranch: 'develop', allowCurrentBranchDirty: false }))).result).toEqual({ branch: 'develop' });
    });

    it('brings the default version up to the online branch, creating it locally when needed', async () => {
        const { other } = withOrigin();
        write(other, 'online.txt', 'o');
        commitAll(other, 'online');
        git(other, 'push', '--quiet', 'origin', 'main');
        git(other, 'switch', '--quiet', '-c', 'release');
        git(other, 'push', '--quiet', 'origin', 'release');
        expect((await call('prepare-conversation', prepare({ source: 'origin' }))).result).toEqual({ branch: 'main' });
        expect(existsSync(join(repo, 'online.txt'))).toBe(true);
        expect((await call('prepare-conversation', prepare({ source: 'origin', baseBranch: 'release' }))).result).toEqual({ branch: 'release' });
        expect(git(repo, 'rev-parse', '--abbrev-ref', 'release@{upstream}')).toBe('origin/release');
    });

    it('refuses a local branch that went its own way from the online one', async () => {
        const { other } = withOrigin();
        write(other, 'online.txt', 'o');
        commitAll(other, 'online');
        git(other, 'push', '--quiet', 'origin', 'main');
        write(repo, 'local.txt', 'l');
        commitAll(repo, 'local');
        expect(await call('prepare-conversation', prepare({ source: 'origin' }))).toMatchObject({ success: false, errorCode: 'WORKSPACE_BASE_DIVERGED' });
    });
});

describe('worktree:publish', () => {
    const publish = (path: string, over: Record<string, unknown> = {}) => ({ worktreePath: path, branch: 'bright-fox', remoteUrl: null, ...over });

    it('saves and pushes the worktree branch, merging what is already online first', async () => {
        const { bare, other } = withOrigin();
        const path = await worktree();
        write(path, 'a.txt', 'a');
        commitAll(path, 'a');
        expect((await call('publish', publish(path))).success).toBe(true);
        git(other, 'fetch', '--quiet', 'origin');
        git(other, 'switch', '--quiet', 'bright-fox');
        write(other, 'b.txt', 'b');
        commitAll(other, 'b');
        git(other, 'push', '--quiet', 'origin', 'bright-fox');
        write(path, 'unsaved.txt', 'u');
        const answer = await call('publish', publish(path));
        expect(answer.result).toEqual({ commit: git(path, 'rev-parse', 'HEAD') });
        expect(execFileSync('git', ['--git-dir', bare, 'rev-parse', 'bright-fox'], { encoding: 'utf8' }).trim()).toBe(answer.result.commit);
        expect(existsSync(join(path, 'b.txt'))).toBe(true);
    });

    it('refuses without a remote', async () => {
        const path = await worktree();
        expect(await call('publish', publish(path))).toMatchObject({ success: false, errorCode: 'WORKTREE_PUBLISH_NO_REMOTE' });
    });
});

describe('worktree:reconcile', () => {
    async function mergedOnline() {
        const { other } = withOrigin();
        const path = await worktree();
        write(path, 'reviewed.txt', 'r');
        commitAll(path, 'reviewed');
        git(path, 'push', '--quiet', 'origin', 'bright-fox');
        git(other, 'fetch', '--quiet', 'origin');
        git(other, 'merge', '--quiet', '--no-ff', '-m', 'merge review', 'origin/bright-fox');
        git(other, 'push', '--quiet', 'origin', 'main');
        return { path, head: git(path, 'rev-parse', 'HEAD') };
    }
    const reconcile = (path: string, head: string) => ({ worktreePath: path, branch: 'bright-fox', baseBranch: 'main', expectedHead: head });

    it('merges the reviewed and merged base into the default version', async () => {
        const { path, head } = await mergedOnline();
        expect((await call('reconcile', reconcile(path, head))).result).toEqual({ appliedToBranch: 'main' });
        expect(existsSync(join(repo, 'reviewed.txt'))).toBe(true);
    });

    it('keeps everything when the worktree changed after the review', async () => {
        const { path, head } = await mergedOnline();
        write(path, 'later.txt', 'l');
        expect(await call('reconcile', reconcile(path, head))).toMatchObject({ success: false, errorCode: 'WORKTREE_REVIEW_OUTDATED' });
        rmSync(join(path, 'later.txt'));
        expect(await call('reconcile', reconcile(path, 'f'.repeat(40)))).toMatchObject({ success: false, errorCode: 'WORKTREE_REVIEW_OUTDATED' });
        expect(existsSync(join(repo, 'reviewed.txt'))).toBe(false);
    });
});

describe('sealed git credentials', () => {
    const seal = (over: Record<string, unknown>) => sealForMachine(deriveServerRpcKey(machineKey), GIT_CREDENTIAL_SEAL_KEY_LABEL, {
        v: 1, purpose: 'git-credential', machineId: 'm1', username: 'x-access-token', token: 'ghs_secret_value', ...over,
    });

    it('uses a credential sealed for this ticket and never returns it', async () => {
        withOrigin();
        const path = await worktree();
        const sent = ticket('publish', { worktreePath: path, branch: 'bright-fox', remoteUrl: null });
        const answer = await handlers()['worktree:publish']({ ticket: sent, sealedCredential: seal({ opId: sent.opId }) });
        expect(answer.success).toBe(true);
        expect(JSON.stringify(answer)).not.toContain('ghs_secret_value');
    });

    it('refuses a credential sealed for another ticket, or one for an operation without a remote', async () => {
        const path = await worktree();
        const sent = ticket('publish', { worktreePath: path, branch: 'bright-fox', remoteUrl: null });
        expect(await handlers()['worktree:publish']({ ticket: sent, sealedCredential: seal({ opId: randomBytes(16).toString('base64') }) }))
            .toMatchObject({ success: false, errorCode: 'GIT_CREDENTIAL_INVALID' });
        const status = ticket('status', { worktreePath: path, branch: 'bright-fox', baseBranch: 'main' });
        expect(await handlers()['worktree:status']({ ticket: status, sealedCredential: seal({ opId: status.opId }) }))
            .toMatchObject({ success: false, errorCode: 'GIT_CREDENTIAL_UNEXPECTED' });
    });

    it.skipIf(process.platform === 'win32')('answers git\'s prompts from a private askpass and removes it afterwards', async () => {
        const prepared = await prepareGitCredential({ username: 'x-access-token', token: 'ghs_secret_value' });
        const askpass = prepared.env.GIT_ASKPASS!;
        expect(statSync(askpass).mode & 0o777).toBe(0o700);
        const ask = (prompt: string) => execFileSync(askpass, [prompt], { env: { ...process.env, ...prepared.env }, encoding: 'utf8' }).trim();
        expect(ask("Username for 'https://github.com': ")).toBe('x-access-token');
        expect(ask("Password for 'https://x-access-token@github.com': ")).toBe('ghs_secret_value');
        expect(prepared.config).toEqual(['-c', 'credential.helper=']);
        expect(readFileSync(askpass, 'utf8')).not.toContain('ghs_secret_value');
        await prepared.dispose();
        expect(existsSync(askpass)).toBe(false);
    });
});

describe.skipIf(process.platform === 'win32')('git before 2.36 (no worktree list -z)', () => {
    let savedPath: string | undefined;
    beforeEach(() => {
        const bin = join(root, 'old-git-bin');
        mkdirSync(bin);
        const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
        writeFileSync(join(bin, 'git'), [
            '#!/bin/sh',
            'for arg in "$@"; do if [ "$arg" = "-z" ]; then echo "error: unknown switch \\`z\'" >&2; exit 129; fi; done',
            `exec ${realGit} "$@"`,
            '',
        ].join('\n'), { mode: 0o755 });
        savedPath = process.env.PATH;
        process.env.PATH = `${bin}:${savedPath}`;
    });
    afterEach(() => {
        process.env.PATH = savedPath;
    });

    it('still finds registered worktrees for status and remove', async () => {
        const path = await worktree();
        expect((await call('status', { worktreePath: path, branch: 'bright-fox', baseBranch: 'main' })).result)
            .toEqual({ dirty: false, behind: 0, ahead: 0 });
        expect((await call('remove', { worktreePath: path, branch: 'bright-fox', force: false, dryRun: false })).result)
            .toEqual({ outcome: 'removed' });
    });

    it('matches a repository path with non-ASCII characters', async () => {
        const named = join(root, '저장소');
        mkdirSync(named);
        git(named, 'init', '--quiet', '--initial-branch=main');
        write(named, 'README.md', 'x');
        commitAll(named, 'init');
        const created = await call('create', create({ workspaceDir: named }));
        expect(created.success).toBe(true);
        expect((await call('status', { worktreePath: created.result.path, branch: 'bright-fox', baseBranch: 'main' })).result)
            .toEqual({ dirty: false, behind: 0, ahead: 0 });
    });
});
