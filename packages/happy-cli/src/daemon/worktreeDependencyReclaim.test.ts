import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, utimes, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reclaimWorktreeDependencies, type ReclaimDependencies } from './worktreeDependencyReclaim';
import { createWorktreeReclaimHandler } from './worktreeDependencyReclaimRpc';

const exec = promisify(execFile);
const garbage: string[] = [];
const GiB = 1024 ** 3;
const low = () => Promise.resolve({ totalBytes: 1000 * GiB, availableBytes: 10 * GiB });
const deps = (): ReclaimDependencies => ({ storage: low, liveCwds: async () => ['/'] });
async function git(root: string, ...args: string[]) {
    return (await exec('git', ['-C', root, ...args], { env: { ...process.env,
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })).stdout.trim();
}
async function fixture() {
    const allowed = await realpath(await mkdtemp(join(tmpdir(), 'reclaim-test-')));
    garbage.push(allowed);
    const root = join(allowed, 'repo');
    await mkdir(root);
    await git(root, 'init', '-b', 'main');
    await writeFile(join(root, '.gitignore'), 'node_modules/\n.aplus/\n');
    await git(root, 'add', '.gitignore');
    await git(root, 'commit', '-m', 'fixture');
    const worktree = join(root, '.aplus/worktrees/old');
    await git(root, 'worktree', 'add', '-b', 'old', worktree);
    await mkdir(join(worktree, 'node_modules'));
    await writeFile(join(worktree, 'node_modules/generated'), 'rebuildable');
    await age(worktree, 8);
    return { allowed, root, worktree };
}
async function age(worktree: string, days: number) {
    const admin = await git(worktree, 'rev-parse', '--absolute-git-dir');
    const time = new Date(Date.now() - days * 86400_000);
    for (const name of ['HEAD', 'index', 'ORIG_HEAD']) await utimes(join(admin, name), time, time).catch(() => {});
}
async function exists(path: string) { return access(path).then(() => true, () => false); }
afterEach(async () => { for (const root of garbage.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('worktree dependency reclaim', () => {
    it('does no git traversal or process scan when storage is healthy', async () => {
        const { allowed } = await fixture();
        const liveCwds = vi.fn();
        const result = await reclaimWorktreeDependencies(allowed, allowed, {
            storage: async () => ({ totalBytes: 1000 * GiB, availableBytes: 100 * GiB }), liveCwds,
        });
        expect(result.status).toBe('not-needed');
        expect(result.inspectedRepositories).toBe(0);
        expect(liveCwds).not.toHaveBeenCalled();
    });
    it('RPC healthy fast path accepts a non-Git directory without scanning it', async () => {
        const { allowed } = await fixture();
        const liveCwds = vi.fn();
        const handler = createWorktreeReclaimHandler(allowed, {
            storage: async () => ({ totalBytes: 1000 * GiB, availableBytes: 100 * GiB }), liveCwds,
        });
        expect((await handler({ path: allowed })).status).toBe('not-needed');
        expect(liveCwds).not.toHaveBeenCalled();
    });
    it('reclaims ignored dependencies but preserves dirty source and the branch', async () => {
        const { allowed, root, worktree } = await fixture();
        await writeFile(join(worktree, 'unique.txt'), 'unique work');
        const result = await reclaimWorktreeDependencies(root, allowed, deps());
        expect(result.deletedPaths).toBe(1);
        expect(result.status).toBe('exhausted');
        expect(await exists(join(worktree, 'node_modules'))).toBe(false);
        expect(await readFile(join(worktree, 'unique.txt'), 'utf8')).toBe('unique work');
        expect(await git(root, 'branch', '--list', 'old')).toContain('old');
    });
    it('resolves a linked worktree subdirectory to the primary repository', async () => {
        const { allowed, worktree, root } = await fixture();
        await mkdir(join(worktree, 'src'));
        const result = await reclaimWorktreeDependencies(join(worktree, 'src'), allowed, deps());
        expect(result.repositoryRoot).toBe(root);
        expect(result.deletedPaths).toBe(1);
    });
    it.each(['locked', 'live-process', 'recently-active', 'tracked-files', 'symlink'])('protects %s', async (reason) => {
        const { allowed, root, worktree } = await fixture();
        const options = deps();
        if (reason === 'locked') await git(root, 'worktree', 'lock', worktree);
        if (reason === 'live-process') options.liveCwds = async () => [join(worktree, 'src')];
        if (reason === 'recently-active') await age(worktree, 0.1);
        if (reason === 'tracked-files') {
            await git(worktree, 'add', '-f', 'node_modules/generated');
            await age(worktree, 8);
        }
        if (reason === 'symlink') {
            await rm(join(worktree, 'node_modules'), { recursive: true });
            await symlink(allowed, join(worktree, 'node_modules'));
        }
        const result = await reclaimWorktreeDependencies(root, allowed, options);
        expect(result.deletedPaths).toBe(0);
        expect(await exists(join(worktree, 'node_modules'))).toBe(true);
    });
    it('fails closed on process inspection failure', async () => {
        const { allowed, root, worktree } = await fixture();
        const result = await reclaimWorktreeDependencies(root, allowed, {
            ...deps(), liveCwds: async () => { throw new Error('cannot inspect processes'); },
        });
        expect(result.status).toBe('failed');
        expect(result.deletedPaths).toBe(0);
        expect(await exists(join(worktree, 'node_modules'))).toBe(true);
    });
    it('rechecks a worktree lock after measuring the candidate', async () => {
        const { allowed, root, worktree } = await fixture();
        const result = await reclaimWorktreeDependencies(root, allowed, {
            ...deps(), directoryBytes: async () => { await git(root, 'worktree', 'lock', worktree); return 100; },
        });
        expect(result.deletedPaths).toBe(0);
        expect(result.skips.locked).toBeGreaterThan(0);
    });
    it('uses the 24h fallback only after older dependencies and stops at recovery', async () => {
        const { allowed, root, worktree } = await fixture();
        const recent = join(root, '.aplus/worktrees/recent');
        await git(root, 'worktree', 'add', '-b', 'recent', recent);
        await mkdir(join(recent, 'node_modules'));
        await writeFile(join(recent, 'node_modules/generated'), 'generated');
        await age(recent, 2);
        const removed: string[] = [];
        const result = await reclaimWorktreeDependencies(root, allowed, {
            ...deps(), storage: async () => ({ totalBytes: 1000 * GiB,
                availableBytes: removed.length ? 65 * GiB : 10 * GiB }),
            remove: async (path) => { removed.push(path); await rm(path, { recursive: true }); },
        });
        expect(result.status).toBe('recovered');
        expect(removed).toEqual([join(worktree, 'node_modules')]);
        expect(await exists(join(recent, 'node_modules'))).toBe(true);
    });
    it('does reach the 24h fallback if the old stage cannot recover', async () => {
        const { allowed, root, worktree } = await fixture();
        await age(worktree, 2);
        expect((await reclaimWorktreeDependencies(root, allowed, deps())).deletedPaths).toBe(1);
    });
    it('uses nested submodule ignore rules', async () => {
        const { allowed, root, worktree } = await fixture();
        const source = join(allowed, 'submodule-source');
        await mkdir(source);
        await git(source, 'init', '-b', 'main');
        await writeFile(join(source, '.gitignore'), 'node_modules/\n');
        await git(source, 'add', '.gitignore');
        await git(source, 'commit', '-m', 'nested');
        await git(worktree, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'vendor/lib');
        const nested = join(worktree, 'vendor/lib');
        await mkdir(join(nested, 'node_modules'));
        await writeFile(join(nested, 'node_modules/generated'), 'nested generated');
        await age(worktree, 8);
        const result = await reclaimWorktreeDependencies(root, allowed, deps());
        expect(result.deletedPaths).toBe(2);
        expect(await exists(join(nested, '.git'))).toBe(true);
    });
    it('preserves deletion accounting if the final filesystem measurement fails', async () => {
        const { allowed, root } = await fixture();
        let removed = false;
        const result = await reclaimWorktreeDependencies(root, allowed, {
            ...deps(), storage: async () => {
                if (removed) throw new Error('measurement unavailable');
                return low();
            }, remove: async (path) => { await rm(path, { recursive: true }); removed = true; },
        });
        expect(result.status).toBe('failed');
        expect(result.deletedPaths).toBe(1);
        expect(result.removedDirectoryBytes).toBeGreaterThan(0);
    });
    it('rejects outside-root and malformed RPC input', async () => {
        const { allowed } = await fixture();
        const handler = createWorktreeReclaimHandler(allowed, deps());
        for (const input of [null, {}, { path: '/' }, { path: '../' }, { path: 9 }]) {
            expect((await handler(input)).status).toBe('failed');
        }
    });
    it('coalesces equivalent repository requests', async () => {
        const { allowed, root, worktree } = await fixture();
        let finish!: () => void;
        const held = new Promise<void>((resolve) => { finish = resolve; });
        let calls = 0;
        const handler = createWorktreeReclaimHandler(allowed, deps(), async () => {
            calls += 1;
            await held;
            return reclaimWorktreeDependencies(root, allowed, { ...deps(), storage: async () => ({ totalBytes: GiB, availableBytes: GiB }) });
        });
        const first = handler({ path: root });
        const second = handler({ path: worktree });
        await new Promise(resolve => setTimeout(resolve, 100));
        finish();
        await Promise.all([first, second]);
        expect(calls).toBe(1);
    });
    it('serializes different repositories across handler instances', async () => {
        const one = await fixture();
        const two = await fixture();
        let active = 0;
        let peak = 0;
        const run = async (path: string, allowed: string) => {
            active += 1; peak = Math.max(peak, active);
            await new Promise(resolve => setTimeout(resolve, 30));
            active -= 1;
            return reclaimWorktreeDependencies(path, allowed, {
                storage: async () => ({ totalBytes: GiB, availableBytes: GiB }),
            });
        };
        await Promise.all([
            createWorktreeReclaimHandler(one.allowed, deps(), run)({ path: one.root }),
            createWorktreeReclaimHandler(two.allowed, deps(), run)({ path: two.root }),
        ]);
        expect(peak).toBe(1);
    });

});
