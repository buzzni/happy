import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLegacyDispatchAdmission, createSubprocessWriteAdmission, createWorkspaceTurnAdmission } from '@/utils/workspaceTurnAdmission';
import { runAutonomousQualityGatePhase } from './autonomousQualityGateRunner';
import { restoreMissingManagedWorktree } from './missingWorktreeRestore';
import { ensureAgentTaskReviewObjects } from './automations/agentTaskReviewObjects';
import { prepareGithubTriggerWorktree, removeGithubTriggerWorktree } from './automations/githubTriggerWorktree';

let home: string;
let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
const automatic = () => createWorkspaceTurnAdmission({ home, roots: [repo], kind: 'automation', sessionId: 'automatic-producer-test' });
const ports = () => ({ admitSubprocess: createSubprocessWriteAdmission({ home }), reserveLegacyDispatch: createLegacyDispatchAdmission({ home }) });

beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'host-process-admission-')));
    repo = join(home, 'project'); await mkdir(repo);
    git('init', '--quiet', '--initial-branch=main');
    await writeFile(join(repo, 'file.txt'), 'fixture');
    git('add', '.'); git('commit', '--quiet', '-m', 'fixture');
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

test('quality commands cannot start behind automatic ownership and remain tracked after their process exits', async () => {
    const owner = automatic(); expect(await owner.tryAcquire()).toEqual({ acquired: true });
    const options = { cwd: repo, ...ports() };
    const run = () => runAutonomousQualityGatePhase({ name: 'test', command: 'printf saved > result.txt', timeoutMs: 5000 }, options);
    await expect(run()).rejects.toThrow('WORKSPACE_BUSY');
    await expect(readFile(join(repo, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await owner.release(true)).toBe(true);
    expect(await run()).toMatchObject({ status: 'passed' });
    expect(await readFile(join(repo, 'result.txt'), 'utf8')).toBe('saved');
    expect(await owner.tryAcquire()).toMatchObject({ acquired: false, reason: 'workspace-owner-unconfirmed' });
});

test('cancelling a quality command during admission leaves no process or permanent unknown writer', async () => {
    const controller = new AbortController();
    const host = ports();
    const options = { cwd: repo, signal: controller.signal, admitSubprocess: host.admitSubprocess,
        reserveLegacyDispatch: async (roots: readonly string[]) => { const result = await host.reserveLegacyDispatch(roots); controller.abort(); return result; } };
    expect(await runAutonomousQualityGatePhase({ name: 'test', command: 'printf saved > result.txt', timeoutMs: 5000 }, options))
        .toMatchObject({ status: 'aborted' });
    await expect(readFile(join(repo, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await automatic().tryAcquire()).toEqual({ acquired: true });
});

test('missing worktree restoration refuses an automatic owner before pruning or recreating and tracks its later writer', async () => {
    const path = join(repo, '.aplus', 'worktrees', 'project', 'fixture');
    git('worktree', 'add', '-b', 'fixture', path); git('worktree', 'remove', path);
    const owner = automatic(); expect(await owner.tryAcquire()).toEqual({ acquired: true });
    const input = { cwd: path, readBranchHint: async () => 'fixture', admitSubprocess: ports().admitSubprocess };
    expect(await restoreMissingManagedWorktree(input)).toMatchObject({ kind: 'failed', reason: 'WORKSPACE_BUSY' });
    await expect(readFile(join(path, 'file.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await owner.release(true)).toBe(true);
    expect(await restoreMissingManagedWorktree(input)).toMatchObject({ kind: 'recreated' });
    expect(await owner.tryAcquire()).toMatchObject({ acquired: false, reason: 'workspace-owner-unconfirmed' });
});

test('review object preparation does not fetch behind an automatic owner and tracks only a missing-object fetch', async () => {
    const owner = automatic(); expect(await owner.tryAcquire()).toEqual({ acquired: true });
    const runCommand = vi.fn(async () => ({ ok: true as const, stdout: '' }));
    const input = { directory: repo, shas: ['a'.repeat(40)], has: async () => false, runCommand, admitSubprocess: ports().admitSubprocess };
    expect(await ensureAgentTaskReviewObjects(input)).toMatchObject({ ok: false, error: 'WORKSPACE_BUSY' });
    expect(runCommand).not.toHaveBeenCalled();
    expect(await owner.release(true)).toBe(true);
    expect(await ensureAgentTaskReviewObjects({ ...input, has: async () => true })).toEqual({ ok: true, fetched: [] });
    const check = automatic(); expect(await check.tryAcquire()).toEqual({ acquired: true }); await check.release(true);
    expect(await ensureAgentTaskReviewObjects(input)).toMatchObject({ ok: true, fetched: ['a'.repeat(40)] });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(await owner.tryAcquire()).toMatchObject({ acquired: false, reason: 'workspace-owner-unconfirmed' });
});

test('GitHub worktree preparation stops before mutation behind automatic ownership and records its later checkout scope', async () => {
    const managedRoot = join(home, 'managed'); await mkdir(managedRoot);
    const runCommand = vi.fn(async (command: { args: string[] }) => ({ ok: true as const, stdout: command.args[0] === 'rev-parse' ? repo : '' }));
    const input = { runId: 'github-preparation', directory: repo, managedRoot, runCommand,
        ensureDirectory: async () => {}, pathExists: async () => true, resolveRealPath: async (path: string) => path,
        releaseSubmodulePointers: vi.fn(async () => ({ released: [] })), onPlanned: vi.fn(), admitSubprocess: ports().admitSubprocess };
    const owner = automatic(); expect(await owner.tryAcquire()).toEqual({ acquired: true });
    expect(await prepareGithubTriggerWorktree(input)).toMatchObject({ ok: false, cleaned: true, error: 'WORKSPACE_BUSY' });
    expect(runCommand.mock.calls.some(([command]) => command.args[0] === 'worktree')).toBe(false);
    expect(input.releaseSubmodulePointers).not.toHaveBeenCalled();
    expect(await owner.release(true)).toBe(true);
    expect(await prepareGithubTriggerWorktree(input)).toMatchObject({ ok: true });
    expect(await owner.tryAcquire()).toMatchObject({ acquired: false, reason: 'workspace-owner-unconfirmed' });
    expect(await createWorkspaceTurnAdmission({ home, roots: [managedRoot], kind: 'automation', sessionId: 'auto-checkout-scope' }).tryAcquire())
        .toMatchObject({ acquired: false, reason: 'workspace-owner-unconfirmed' });
});

test('GitHub cleanup inspects status without recording a writer and reserves before actual removal', async () => {
    const path = join(home, 'checkout'); await mkdir(path);
    const runCommand = vi.fn(async () => ({ ok: true as const, stdout: '' }));
    const input = { repositoryRoot: repo, worktreePath: path, runCommand, pathExists: async () => true,
        releaseSubmodulePointers: vi.fn(async () => ({ released: [] })), admitSubprocess: ports().admitSubprocess };
    const owner = automatic(); expect(await owner.tryAcquire()).toEqual({ acquired: true });
    expect(await removeGithubTriggerWorktree(input)).toMatchObject({ ok: false, dirty: false, error: 'WORKSPACE_BUSY' });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(input.releaseSubmodulePointers).not.toHaveBeenCalled();
    expect(await owner.release(true)).toBe(true);
    expect(await removeGithubTriggerWorktree(input)).toEqual({ ok: true });
    expect(await owner.tryAcquire()).toMatchObject({ acquired: false, reason: 'workspace-owner-unconfirmed' });
});
