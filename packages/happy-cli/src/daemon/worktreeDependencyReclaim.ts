import { execFile } from 'node:child_process';
import { lstat, readdir, realpath, rm, stat, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const GiB = 1024 ** 3;
const DAY = 86400_000;
const commandOptions = { maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } };
export interface Storage { totalBytes: number; availableBytes: number }
export interface ReclaimResult {
    schemaVersion: 1;
    status: 'not-needed' | 'recovered' | 'exhausted' | 'failed';
    repositoryRoot: string | null;
    inspectedRepositories: number;
    deletedPaths: number;
    /** du size is diagnostic; shared APFS/pnpm blocks are not physical recovery. */
    removedDirectoryBytes: number;
    availableBytesBefore: number | null;
    availableBytesAfter: number | null;
    skips: Record<string, number>;
    errors: string[];
}
export interface ReclaimDependencies {
    storage?: (path: string) => Promise<Storage>;
    liveCwds?: () => Promise<string[]>;
    directoryBytes?: (path: string) => Promise<number>;
    remove?: (path: string) => Promise<void>;
}
interface Worktree { root: string; locked: boolean }
interface Candidate { root: string; target: string; activity: number }
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
export function emptyReclaimResult(): ReclaimResult {
    return { schemaVersion: 1, status: 'failed', repositoryRoot: null, inspectedRepositories: 0,
        deletedPaths: 0, removedDirectoryBytes: 0, availableBytesBefore: null, availableBytesAfter: null,
        skips: {}, errors: [] };
}
async function git(root: string, ...args: string[]) {
    return (await exec('git', ['-C', root, ...args], commandOptions)).stdout;
}
async function storage(path: string): Promise<Storage> {
    const s = await statfs(path);
    return { totalBytes: s.blocks * s.bsize, availableBytes: s.bavail * s.bsize };
}
function thresholds(s: Storage) {
    if (![s.totalBytes, s.availableBytes].every(Number.isSafeInteger)
        || s.totalBytes <= 0 || s.availableBytes < 0 || s.availableBytes > s.totalBytes) {
        throw new Error('invalid filesystem measurement');
    }
    return { trigger: Math.min(s.totalBytes * 0.1, 40 * GiB), recovery: Math.min(s.totalBytes * 0.15, 60 * GiB) };
}
export async function reclaimPressureNeeded(path: string, dependencies: ReclaimDependencies) {
    const value = await (dependencies.storage ?? storage)(path);
    return value.availableBytes < thresholds(value).trigger;
}
export async function validateReclaimPath(path: unknown, allowedRoot: string) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('invalid project path');
    const [allowed, canonical] = await Promise.all([realpath(allowedRoot), realpath(path)]);
    if (!inside(allowed, canonical)) throw new Error('project path outside allowed root');
    return canonical;
}
async function registered(root: string): Promise<Worktree[]> {
    const output = await git(root, 'worktree', 'list', '--porcelain', '-z');
    const entries: Worktree[] = [];
    let current: Worktree | undefined;
    for (const field of output.split('\0')) {
        if (field.startsWith('worktree ')) {
            current = { root: field.slice(9), locked: false };
            if (!isAbsolute(current.root)) throw new Error('invalid worktree registration');
            entries.push(current);
        } else if (field === 'locked' || field.startsWith('locked ')) {
            if (current) current.locked = true;
        } else if (field === 'bare') throw new Error('bare repositories are not reclaimable');
    }
    if (!entries.length || entries.length > 4096) throw new Error('invalid worktree inventory');
    return entries;
}
export async function canonicalReclaimRepository(path: string, allowedRoot: string) {
    const request = await validateReclaimPath(path, allowedRoot);
    const entries = await registered(request);
    return validateReclaimPath(entries[0].root, allowedRoot);
}
async function noSymlinks(root: string, target: string) {
    if (target === root || !inside(root, target)) return false;
    let path = root;
    for (const part of relative(root, target).split(sep)) {
        path = join(path, part);
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory()) return false;
    }
    return await realpath(target) === target;
}
async function activity(root: string) {
    const admin = (await git(root, 'rev-parse', '--absolute-git-dir')).trim();
    const paths = ['HEAD', 'index', 'ORIG_HEAD'].map(name => join(admin, name));
    paths.push(join(root, '.aplus/dependency-cache.v1.json'));
    let newest: number | null = null;
    for (const path of paths) {
        try {
            const info = await stat(path);
            newest = Math.max(newest ?? 0, info.mtimeMs);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
    return newest;
}
async function collectLiveCwds() {
    // Partial lsof output cannot prove a target idle. Never use stdout from a failed command.
    const { stdout } = await exec('lsof', ['-d', 'cwd', '-Fn'], commandOptions);
    const names = stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
    if (!names.length || names.some(name => !isAbsolute(name))) throw new Error('incomplete process cwd inventory');
    return names;
}
async function validCwds(read: () => Promise<string[]>) {
    const paths = await read();
    if (!paths.length || paths.some(path => typeof path !== 'string' || !isAbsolute(path))) {
        throw new Error('invalid process cwd inventory');
    }
    return paths;
}
async function discovered(root: string) {
    const paths: string[] = [];
    let visited = 0;
    async function walk(path: string, depth: number) {
        if (++visited > 10000) throw new Error('dependency discovery limit exceeded');
        for (const entry of await readdir(path, { withFileTypes: true })) {
            if (entry.name === '.git' || entry.name === '.aplus') continue;
            const child = join(path, entry.name);
            if (entry.name === 'node_modules' && (entry.isDirectory() || entry.isSymbolicLink())) paths.push(child);
            else if (entry.isDirectory() && !entry.isSymbolicLink() && depth < 4) await walk(child, depth + 1);
        }
    }
    await walk(root, 1);
    return paths;
}
async function targetProtection(root: string, target: string): Promise<string | null> {
    if (!await noSymlinks(root, target)) return 'symlink';
    const gitRoot = await realpath((await git(dirname(target), 'rev-parse', '--show-toplevel')).trim());
    if (!inside(root, gitRoot)) return 'outside-worktree';
    const pathspec = relative(gitRoot, target);
    try { await git(gitRoot, 'check-ignore', '-q', '--', pathspec); }
    catch (error) {
        if ((error as { code?: unknown }).code === 1) return 'not-ignored';
        throw error;
    }
    // check-ignore alone is insufficient when an ignored directory contains force-added files.
    if ((await git(gitRoot, 'ls-files', '-z', '--', pathspec)).length) return 'tracked-files';
    return null;
}
async function worktreeProtection(repo: string, entry: Worktree, minIdle: number, cwds: string[]) {
    const root = entry.root;
    if (root === repo || !inside(join(repo, '.aplus/worktrees'), root)) return 'outside-worktrees-root';
    if (entry.locked) return 'locked';
    if (!await noSymlinks(repo, root)) return 'symlink';
    const last = await activity(root);
    if (last === null) return 'unknown-activity';
    if (Date.now() - last < minIdle) return 'recently-active';
    if (cwds.some(path => inside(root, path))) return 'live-process';
    return null;
}
async function directoryBytes(path: string) {
    const { stdout } = await exec('du', ['-sk', path], commandOptions);
    const bytes = Number(stdout.trim().split(/\s+/)[0]) * 1024;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid directory measurement');
    return bytes;
}

/** Owns deletion of generated dependencies only; callers cannot expand targets or weaken idle guards. */
export async function reclaimWorktreeDependencies(
    path: string, allowedRoot: string, dependencies: ReclaimDependencies = {},
): Promise<ReclaimResult> {
    const result = emptyReclaimResult();
    const readStorage = dependencies.storage ?? storage;
    const readCwds = dependencies.liveCwds ?? collectLiveCwds;
    const measure = dependencies.directoryBytes ?? directoryBytes;
    const remove = dependencies.remove ?? (async (target: string) => { await rm(target, { recursive: true }); });
    const skip = (reason: string) => { result.skips[reason] = (result.skips[reason] ?? 0) + 1; };
    try {
        const request = await validateReclaimPath(path, allowedRoot);
        const initial = await readStorage(request);
        const limits = thresholds(initial);
        result.availableBytesBefore = result.availableBytesAfter = initial.availableBytes;
        if (initial.availableBytes >= limits.trigger) { result.status = 'not-needed'; return result; }
        const repo = await canonicalReclaimRepository(request, allowedRoot);
        result.repositoryRoot = repo;
        result.inspectedRepositories = 1;
        const candidates: Candidate[] = [];
        const cwds = await validCwds(readCwds);
        for (const entry of await registered(repo)) {
            if (entry.root === repo) continue;
            try {
                const reason = await worktreeProtection(repo, entry, DAY, cwds);
                if (reason) { skip(reason); continue; }
                const last = await activity(entry.root);
                if (last === null) { skip('unknown-activity'); continue; }
                for (const target of await discovered(entry.root)) candidates.push({ root: entry.root, target, activity: last });
            } catch (error) { result.errors.push(failure(error)); }
        }
        candidates.sort((a, b) => a.activity - b.activity || a.target.localeCompare(b.target));
        // Oldest-first ordering exhausts the >=7d phase before the 24h fallback.
        // Every candidate is rechecked after du, immediately before deletion.
        for (const candidate of candidates) {
            try {
                const now = await readStorage(repo);
                thresholds(now);
                result.availableBytesAfter = now.availableBytes;
                if (now.availableBytes >= limits.recovery) { result.status = 'recovered'; break; }
                const bytes = await measure(candidate.target);
                const entry = (await registered(repo)).find(w => w.root === candidate.root);
                if (!entry) { skip('unregistered'); continue; }
                const minimum = Date.now() - candidate.activity >= 7 * DAY ? 7 * DAY : DAY;
                const reason = await worktreeProtection(repo, entry, minimum, await validCwds(readCwds))
                    ?? await targetProtection(candidate.root, candidate.target);
                if (reason) { skip(reason); continue; }
                await remove(candidate.target);
                result.deletedPaths += 1;
                result.removedDirectoryBytes += bytes;
                // No source, branch, untracked local settings, or dependency-cache marker is modified.
            } catch (error) {
                // A measurement/process failure stops deletion, rather than trusting a partial inventory.
                result.errors.push(failure(error));
                break;
            }
        }
        const final = await readStorage(repo);
        thresholds(final);
        result.availableBytesAfter = final.availableBytes;
        result.status = result.errors.length ? 'failed'
            : final.availableBytes >= limits.recovery ? 'recovered' : 'exhausted';
    } catch (error) { result.errors.push(failure(error)); result.status = 'failed'; }
    // Keep RPC output bounded even with many unreadable worktrees.
    result.errors = result.errors.slice(0, 10);
    return result;
}
