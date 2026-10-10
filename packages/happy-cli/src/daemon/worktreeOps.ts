/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary 4b-3 worktree (worktree-strict-design.md) —
 * `worktree:*`, customer lane only.
 *
 * The server sends no command to a strict machine, so worktrees there are made, read, applied,
 * published and removed by this daemon, as are the default version's branch switches. The browser brings a ticket the server issued (the operation and its params); the
 * daemon checks it, runs git itself and signs the result, and the server records it only after
 * checking that signature. The server's shell scripts (`server/worktreeCommands.ts`) are the
 * reference for what each operation does; here git runs from an argument list, never a shell, with
 * repository hooks and fsmonitor off, and every path is judged by where it really lands.
 *
 * A remote is reached with the machine's own git login, or with a credential the server sealed
 * for this machine and this ticket (`GIT_CREDENTIAL_SEAL_KEY_LABEL`): it reaches git only through a
 * private askpass and its env, never the command line, a log line or an answer.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { appendFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
    GIT_CREDENTIAL_SEAL_KEY_LABEL,
    WORKTREE_OPS,
    WORKTREE_RESULT_ATTESTATION_KEY_LABEL,
    WORKTREE_TICKET_MAX_TTL_MS,
    canonicalWorktreeJson,
    isManagedWorktreePath,
    managedWorktreePath,
    readSealedGitCredential,
    readWorktreeTicket,
    resolveWorktreeRepoRoot,
    sanitizeWorktreeName,
    worktreeAttestationPayload,
    worktreeOpMethod,
    type WorktreeOp,
    type WorktreeOpParams,
    type WorktreeOpResult,
    type WorktreeTicket,
} from '@slopus/happy-wire';
import { deriveServerRpcKey } from '@/api/encryption';
import { RpcNonceGuard } from '@/api/rpc/rpcNonceGuard';
import { isWithinDirectory } from '@/modules/common/happyHomeGuard';
import { openSealedForMachine } from '@/modules/common/machineSeal';
import { logger } from '@/ui/logger';

export const WORKTREE_OPS_METHODS = WORKTREE_OPS.map((op) => worktreeOpMethod(op));
export type WorktreeOpsMethod = ReturnType<typeof worktreeOpMethod>;

/** How far the server's clock may run ahead of this machine's when it issues a ticket. */
const ISSUE_SKEW_MS = 60_000;
const GIT_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 5 * 60_000;
const CHECKOUT_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_CHARS = 4000;
const DEFAULT_WORKTREE_INCLUDE = ['.env', '.env.local'];
const PRIVATE_ENV_PATHS = ['.env', '.env.local', ':(glob)**/.env', ':(glob)**/.env.local'];
const STUDIO_AUTHOR = ['-c', 'user.name=A+ Studio', '-c', 'user.email=studio@aplus.local'];
const AUTH_FAILURE = /authentication failed|could not read (username|password)|terminal prompts disabled|permission denied|access denied|http.*(401|403)/i;
const NAME_CONFLICT = /already exists|already checked out|already registered/i;
const MERGE_CONFLICT = /conflict|automatic merge failed/i;
const NO_REMOTE_BRANCH = /couldn't find remote ref|remote ref does not exist/i;
const PRIVATE_ENV_EXCLUDES = [':(exclude).env', ':(exclude).env.local', ':(exclude,glob)**/.env', ':(exclude,glob)**/.env.local'];
const MAX_DIRTY_STATUS_CHARS = 64 * 1024;
/** The operations that reach a remote, and so may bring a sealed credential. */
const REMOTE_OPS: ReadonlySet<WorktreeOp> = new Set(['create', 'publish', 'reconcile', 'prepare-conversation']);

type MachineKeyView = { id: string; encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' };

export type WorktreeOpsDeps = {
    machine: () => MachineKeyView;
    allowedRoot: string;
    happyHomeDir: string;
    now?: () => number;
};

export type WorktreeOpAnswer =
    | { success: true; result: Record<string, unknown>; finishedAt: number; attestation: string }
    | { success: false; errorCode: string; error: string; [detail: string]: unknown };

type Failure = Extract<WorktreeOpAnswer, { success: false }>;

class OpFailure extends Error {
    constructor(readonly errorCode: string, message: string, readonly details: Record<string, unknown> = {}) {
        super(message);
    }
}

function refused(errorCode: string, error: string, details: Record<string, unknown> = {}): Failure {
    return { success: false, errorCode, error, ...details };
}

function attestationKey(machineKey: Uint8Array): Buffer {
    return createHmac('sha256', deriveServerRpcKey(machineKey)).update(WORKTREE_RESULT_ATTESTATION_KEY_LABEL).digest();
}

/** HMAC of the canonical payload; the server computes the same from the lane key it holds. */
export function attestWorktreeResult(machineKey: Uint8Array, ticket: WorktreeTicket, result: Record<string, unknown>, finishedAt: number): string {
    return createHmac('sha256', attestationKey(machineKey))
        .update(canonicalWorktreeJson(worktreeAttestationPayload(ticket, result, finishedAt)))
        .digest('base64');
}

// ── git without a shell ────────────────────────────────────────────────────────────────────────

type GitResult = { code: number; stdout: string; stderr: string };

function localGitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'LANG', 'TMPDIR', 'TEMP', 'TMP']) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
    }
    return { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
}

/** A fetch authenticates with the machine's own credential helper or ssh agent, which need its env. */
function networkGitEnv(): NodeJS.ProcessEnv {
    return { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
}

function terminateProcessTree(child: ChildProcess): void {
    if (!child.pid) return;
    if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).unref();
        return;
    }
    try {
        process.kill(-child.pid, 'SIGKILL');
    } catch {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }
}

/** A sealed credential, opened: a private askpass that answers git's prompts from its env. */
export type PreparedGitCredential = {
    /** Turns off the machine's helpers so the sealed credential is the one git uses. */
    config: string[];
    env: NodeJS.ProcessEnv;
    dispose(): Promise<void>;
};

const ASKPASS_SCRIPT = [
    '#!/bin/sh',
    'case "$1" in',
    '  *Username*|*username*) printf \'%s\\n\' "$APLUS_GIT_USERNAME" ;;',
    '  *) printf \'%s\\n\' "$APLUS_GIT_PASSWORD" ;;',
    'esac',
    '',
].join('\n');

/** The askpass holds no secret itself; git's env does, for this one process. Remove it with `dispose`. */
export async function prepareGitCredential(credential: { username: string; token: string }): Promise<PreparedGitCredential> {
    const dir = await mkdtemp(join(tmpdir(), 'happy-git-askpass-'));
    const askpass = join(dir, 'askpass.sh');
    await writeFile(askpass, ASKPASS_SCRIPT, { mode: 0o700 });
    return {
        config: ['-c', 'credential.helper='],
        env: {
            GIT_ASKPASS: askpass,
            SSH_ASKPASS: askpass,
            APLUS_GIT_USERNAME: credential.username,
            APLUS_GIT_PASSWORD: credential.token,
        },
        dispose: () => rm(dir, { recursive: true, force: true }),
    };
}

type GitOptions = {
    timeoutMs?: number;
    network?: boolean;
    /** A remote call with a sealed credential instead of the machine's own login. */
    credential?: PreparedGitCredential | null;
    /** A read: no optional index refresh, so a `git commit` running in the worktree never meets our lock. */
    readOnly?: boolean;
};

function runGit(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
    return new Promise((resolvePromise) => {
        const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...(options.credential?.config ?? []), ...args], {
            cwd,
            env: {
                ...(options.network ? networkGitEnv() : localGitEnv()),
                ...(options.readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
                ...(options.credential?.env ?? {}),
            },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            ...(process.platform === 'win32' ? {} : { detached: true }),
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let size = 0;
        let timedOut = false;
        const collect = (into: Buffer[]) => (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_OUTPUT_BYTES) into.push(chunk);
        };
        child.stdout?.on('data', collect(stdout));
        child.stderr?.on('data', collect(stderr));
        const timer = setTimeout(() => {
            timedOut = true;
            terminateProcessTree(child);
        }, options.timeoutMs ?? GIT_TIMEOUT_MS);
        timer.unref?.();
        child.on('error', (error) => {
            clearTimeout(timer);
            resolvePromise({ code: -1, stdout: '', stderr: error.message });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolvePromise({
                code: timedOut ? -1 : code ?? -1,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: timedOut ? 'git timed out' : Buffer.concat(stderr).toString('utf8'),
            });
        });
    });
}

function gitError(result: GitResult): string {
    return (result.stderr.trim() || result.stdout.trim() || `git exited with ${result.code}`).slice(-MAX_ERROR_CHARS);
}

/** Output of a git command that must succeed. */
async function gitOk(cwd: string, args: string[], errorCode: string, options?: GitOptions): Promise<string> {
    const result = await runGit(cwd, args, options);
    if (result.code !== 0) throw new OpFailure(errorCode, gitError(result));
    return result.stdout;
}

// ── Paths ──────────────────────────────────────────────────────────────────────────────────────

function inside(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** '/'-separated, as git prints paths and the server stores them. */
function slashed(path: string): string {
    return sep === '\\' ? path.replace(/\\/g, '/') : path;
}

type PathGuard = {
    /** The real directory, when it exists, is inside the allowed root and outside the happy home. */
    directory(path: string): Promise<string>;
};

function pathGuard(allowedRoot: string, happyHomeDir: string): PathGuard {
    let allowed: Promise<string> | null = null;
    return {
        async directory(path) {
            // A path only another platform calls absolute would resolve against the daemon's cwd.
            if (!isAbsolute(path)) throw new OpFailure('PATH_DENIED', 'Not an absolute path on this machine');
            allowed ??= realpath(allowedRoot);
            let real: string;
            try {
                real = await realpath(path);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new OpFailure('WORKSPACE_MISSING', 'The folder does not exist');
                throw new OpFailure('PATH_DENIED', 'The folder cannot be read');
            }
            if (!inside(await allowed, real) || isWithinDirectory(real, happyHomeDir)) {
                throw new OpFailure('PATH_DENIED', 'The folder is outside the allowed root');
            }
            if (!(await stat(real)).isDirectory()) throw new OpFailure('PATH_DENIED', 'Not a folder');
            return real;
        },
    };
}

/**
 * `.aplus/worktrees/<projectId>/<name>` below the repository, or a single-segment legacy name
 * (`.aplus/worktrees/<name>`, from before the project namespace).
 */
function ownsWorktreeName(parts: string[], projectId: string): boolean {
    if (parts[0] !== '.aplus' || parts[1] !== 'worktrees') return false;
    const sanitized = (name: string) => name !== '' && sanitizeWorktreeName(name) === name;
    if (parts[2] === projectId) return parts.length > 3 && sanitized(parts.slice(3).join('/'));
    return parts.length === 3 && sanitized(parts[2]!);
}

type WorktreeTarget = { repoRoot: string; path: string; registered: boolean; onDisk: boolean };

/** The worktrees git has registered for this repository, by real '/'-separated path. */
async function registeredWorktrees(repoRoot: string): Promise<Set<string>> {
    const listed = await gitOk(repoRoot, ['worktree', 'list', '--porcelain', '-z'], 'WORKTREE_LIST_FAILED', { readOnly: true });
    const paths = listed.split('\0').filter((field) => field.startsWith('worktree ')).map((field) => field.slice('worktree '.length));
    return new Set(await Promise.all(paths.map((path) => realpath(path).then(slashed, () => slashed(path)))));
}

/**
 * A worktree this project's ticket may touch: managed, in an allowed repository, landing where it
 * says. A folder git has not registered as a worktree counts as missing, as the server's
 * "not a working tree" does: git run inside it would read the repository around it.
 */
async function resolveWorktreeTarget(guard: PathGuard, path: string, projectId: string): Promise<WorktreeTarget> {
    const denied = new OpFailure('PATH_DENIED', 'Not a worktree of this project');
    const lexicalRoot = isManagedWorktreePath(path) ? resolveWorktreeRepoRoot(path) : null;
    if (!lexicalRoot || !ownsWorktreeName(relative(lexicalRoot, path).split(sep), projectId)) throw denied;
    const repoRoot = await guard.directory(lexicalRoot).catch(() => { throw denied; });
    let real: string;
    try {
        real = await realpath(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            // A dangling link is not a missing worktree.
            const linked = await lstat(path).then(() => true, () => false);
            if (linked) throw denied;
            return { repoRoot, path, registered: false, onDisk: false };
        }
        throw denied;
    }
    if (!inside(repoRoot, real) || !ownsWorktreeName(relative(repoRoot, real).split(sep), projectId)) throw denied;
    return { repoRoot, path: real, registered: (await registeredWorktrees(repoRoot)).has(slashed(real)), onDisk: true };
}

// ── Serialization ──────────────────────────────────────────────────────────────────────────────

const repositoryQueues = new Map<string, Promise<unknown>>();

/** One operation at a time per repository, so git's own locks never race. Keyed '/'-separated, as git prints the root. */
async function serialized<T>(path: string, run: () => Promise<T>): Promise<T> {
    const key = slashed(path);
    const previous = repositoryQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    repositoryQueues.set(key, next);
    try {
        return await next;
    } finally {
        if (repositoryQueues.get(key) === next) repositoryQueues.delete(key);
    }
}

async function repositoryRoot(dir: string): Promise<string | null> {
    const result = await runGit(dir, ['rev-parse', '--show-toplevel']);
    return result.code === 0 ? result.stdout.trim() : null;
}

// ── Operations ─────────────────────────────────────────────────────────────────────────────────

async function readCapability(dir: string): Promise<WorktreeOpResult<'capability'>> {
    const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree'], { readOnly: true });
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { capable: false, reason: 'not-git', branch: null, branches: [] };
    const [head, refs, list] = await Promise.all([
        runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { readOnly: true }),
        runGit(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { readOnly: true }),
        runGit(dir, ['worktree', 'list', '--porcelain'], { readOnly: true }),
    ]);
    const branch = head.code === 0 ? head.stdout.trim() || null : null;
    const branches = Array.from(new Set(refs.stdout.split('\n').map((line) => line.trim()).filter(Boolean)));
    if (branch && !branches.includes(branch)) branches.push(branch);
    return list.code === 0
        ? { capable: true, reason: 'ready', branch, branches }
        : { capable: false, reason: 'unavailable', branch, branches };
}

async function prepare(dir: string): Promise<WorktreeOpResult<'prepare'>> {
    const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
        await gitOk(dir, ['init', '--quiet', '--initial-branch=main'], 'WORKTREE_PREPARE_FAILED');
    }
    const capability = await readCapability(dir);
    if (!capability.capable) throw new OpFailure('WORKTREE_PREPARE_FAILED', '이 환경에서는 작업 트리를 준비할 수 없습니다.');
    return capability;
}

async function excludeFile(repo: string): Promise<string> {
    return resolve(repo, (await gitOk(repo, ['rev-parse', '--git-path', 'info/exclude'], 'WORKTREE_ADD_FAILED')).trim());
}

async function excludeLines(repo: string, lines: string[]): Promise<void> {
    const file = await excludeFile(repo);
    await mkdir(dirname(file), { recursive: true });
    const current = (await readFile(file, 'utf8').catch(() => '')).split(/\r?\n/);
    const missing = lines.filter((line) => !current.includes(line));
    if (missing.length === 0) return;
    const separator = current.length > 0 && current[current.length - 1] !== '' ? '\n' : '';
    await appendFile(file, `${separator}${missing.join('\n')}\n`);
}

/** Stages everything but private env files, keeping managed worktrees and `.next` out (the server's hygiene). */
async function stageNonPrivate(dir: string, errorCode: string): Promise<void> {
    await excludeLines(dir, ['/.aplus/worktrees/', '.next/']);
    await runGit(dir, ['rm', '-r', '-f', '--cached', '--ignore-unmatch', '--', ':(glob)**/.next/**']);
    await gitOk(dir, ['add', '-A'], errorCode);
    await runGit(dir, ['reset', '--quiet', '--', ...PRIVATE_ENV_PATHS]);
}

/** The server's snapshot: everything but private env files, committed so the new worktree starts from it. */
async function snapshotCurrent(dir: string): Promise<{ revision: string; branch: string | null }> {
    const repo = await repositoryRoot(dir);
    if (!repo) throw new OpFailure('WORKTREE_SNAPSHOT_FAILED', 'git repository root not found');
    await stageNonPrivate(dir, 'WORKTREE_SNAPSHOT_FAILED');
    const unchanged = (await runGit(dir, ['diff', '--cached', '--quiet'])).code === 0;
    const hasHead = (await runGit(dir, ['rev-parse', '--verify', 'HEAD'])).code === 0;
    if (!unchanged || !hasHead) {
        await gitOk(dir, [...STUDIO_AUTHOR, 'commit', '--allow-empty', '-m', 'A+ Studio: 새 작업 버전 시작 전 저장'], 'WORKTREE_SNAPSHOT_FAILED');
    }
    const revision = (await gitOk(dir, ['rev-parse', 'HEAD'], 'WORKTREE_SNAPSHOT_FAILED')).trim();
    const head = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return { revision, branch: head.code === 0 ? head.stdout.trim() || null : null };
}

/** The nearest existing folder at or above `path`, by its real path, is inside `root`. */
async function landsInside(root: string, path: string): Promise<boolean> {
    for (let current = path; ; current = dirname(current)) {
        try {
            return inside(root, await realpath(current));
        } catch {
            if (dirname(current) === current) return false;
        }
    }
}

/**
 * `.env` files and `.worktreeinclude` entries. Read only from inside the repository and written
 * only inside the new worktree, judged by real paths: a link on either side (an untracked one in
 * the owner's checkout, a committed one in the worktree) must not carry a copy out.
 */
async function copyIncludes(repo: string, worktree: string, prefix: string): Promise<void> {
    const [realRepo, realWorktree] = await Promise.all([realpath(repo), realpath(worktree)]);
    const from = join(repo, prefix);
    const listed = await readFile(join(from, '.worktreeinclude'), 'utf8').catch(() => '');
    const entries = [
        ...DEFAULT_WORKTREE_INCLUDE,
        ...listed.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line !== '' && !line.startsWith('#')),
    ];
    for (const entry of entries) {
        if (isAbsolute(entry) || entry.split(/[\\/]/).some((part) => part === '..')) continue;
        const source = join(from, entry);
        const target = join(worktree, prefix, entry);
        if (!inside(repo, source) || !inside(worktree, target)) continue;
        try {
            if (!inside(realRepo, await realpath(source))) continue;
        } catch {
            continue;
        }
        try {
            if (!await landsInside(realWorktree, dirname(target))) continue;
            await mkdir(dirname(target), { recursive: true });
            if (!inside(realWorktree, await realpath(dirname(target)))) continue;
            if ((await lstat(target).catch(() => null))?.isSymbolicLink()) continue;
            await cp(source, target, { recursive: true, force: true, verbatimSymlinks: true });
        } catch (error) {
            logger.debug('[worktree-ops] include not copied', { entry, error: error instanceof Error ? error.message : String(error) });
        }
    }
}

async function createWorktree(guard: PathGuard, ticket: WorktreeTicket & { op: 'create' }, credential: PreparedGitCredential | null): Promise<WorktreeOpResult<'create'>> {
    const params: WorktreeOpParams<'create'> = ticket.params;
    const workspace = await guard.directory(params.workspaceDir);
    const repo = await repositoryRoot(workspace);
    if (!repo) throw new OpFailure('WORKTREE_REPO_NOT_FOUND', 'git repository root not found');
    return serialized(repo, async () => {
        for (const ref of [params.name, ...(params.baseSource === 'origin' ? [params.baseRef!] : [])]) {
            await gitOk(workspace, ['check-ref-format', '--branch', ref], 'WORKTREE_INVALID_REF');
        }
        // A workspace inside someone else's repository must not get a worktree there unless the
        // server confirmed that repository root with the user (the 2026-07-19 incident).
        if (repo !== slashed(workspace) && repo !== params.expectedRepoRoot) {
            throw new OpFailure('WORKTREE_NOT_REPO_ROOT', `workspace dir is not the repository root: ${workspace} (repository: ${repo})`, {
                subdir: { repoRoot: repo, workspaceDir: slashed(workspace), repoRelativeDir: slashed(relative(repo, workspace)) },
            });
        }
        await guard.directory(repo);
        const repoRelativeDir = slashed(relative(repo, workspace));

        const snapshot = params.snapshotCurrent ? await snapshotCurrent(workspace) : null;
        const baseRef = snapshot?.revision ?? params.baseRef;
        const originBase = params.baseSource === 'origin' ? params.baseRef : null;
        let base: string;
        let baseRevision: string;
        if (originBase) {
            base = `refs/remotes/origin/${originBase}`;
            const fetchRef = `refs/aplus/fetch/${process.pid}-${Date.now()}`;
            try {
                const fetched = await runGit(repo, [
                    'fetch', params.remoteUrl ?? 'origin', `+refs/heads/${originBase}:refs/remotes/origin/${originBase}`, `refs/heads/${originBase}:${fetchRef}`,
                ], { network: true, credential, timeoutMs: NETWORK_TIMEOUT_MS });
                if (fetched.code !== 0) {
                    const error = gitError(fetched);
                    throw new OpFailure(AUTH_FAILURE.test(error) ? 'WORKTREE_AUTH_REQUIRED' : 'WORKTREE_FETCH_FAILED', error);
                }
                baseRevision = (await gitOk(repo, ['rev-parse', '--verify', `${fetchRef}^{commit}`], 'WORKTREE_FETCH_FAILED')).trim();
            } finally {
                await runGit(repo, ['update-ref', '-d', fetchRef]);
            }
        } else {
            if (baseRef) {
                base = baseRef;
            } else {
                const originHead = await runGit(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
                base = originHead.code === 0 && originHead.stdout.trim() ? originHead.stdout.trim() : 'HEAD';
            }
            baseRevision = base;
            await runGit(repo, ['fetch', 'origin', '--quiet'], { network: true, timeoutMs: NETWORK_TIMEOUT_MS });
        }

        await excludeLines(repo, ['/.aplus/worktrees/']);
        const path = managedWorktreePath(repo, ticket.projectId, params.name);
        const added = await runGit(repo, ['worktree', 'add', '-b', params.name, '--', path, baseRevision], { timeoutMs: CHECKOUT_TIMEOUT_MS });
        if (added.code !== 0) {
            const error = gitError(added);
            throw new OpFailure(NAME_CONFLICT.test(error) ? 'WORKTREE_NAME_CONFLICT' : 'WORKTREE_ADD_FAILED', error);
        }
        if (params.copyOwnerRuntimeFiles) {
            await copyIncludes(repo, path, '');
            if (repoRelativeDir) await copyIncludes(repo, path, repoRelativeDir);
        }
        return {
            path,
            branch: params.name,
            baseBranch: snapshot ? snapshot.branch ?? snapshot.revision : params.baseRef ?? base,
            baseRevision: snapshot?.revision ?? null,
            repoRelativeDir,
            repoRoot: repo,
        };
    });
}

async function worktreeStatus(guard: PathGuard, ticket: WorktreeTicket & { op: 'status' }): Promise<WorktreeOpResult<'status'>> {
    const params: WorktreeOpParams<'status'> = ticket.params;
    const target = await resolveWorktreeTarget(guard, params.worktreePath, ticket.projectId);
    if (!target.registered) throw new OpFailure('WORKTREE_PATH_MISSING', '작업 환경 경로를 찾을 수 없습니다.');
    const status = await gitOk(target.path, ['status', '--porcelain'], 'WORKTREE_STATUS_FAILED', { readOnly: true });
    const counts = (await gitOk(target.path, ['rev-list', '--left-right', '--count', `${params.baseBranch ?? 'HEAD'}...${params.branch}`], 'WORKTREE_STATUS_FAILED', { readOnly: true }))
        .trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
    const count = (value: number | undefined) => (Number.isFinite(value) && value! >= 0 ? value! : 0);
    return { dirty: status.trim() !== '', behind: count(counts[0]), ahead: count(counts[1]) };
}

async function removeWorktree(guard: PathGuard, ticket: WorktreeTicket & { op: 'remove' }): Promise<WorktreeOpResult<'remove'>> {
    const params: WorktreeOpParams<'remove'> = ticket.params;
    const target = await resolveWorktreeTarget(guard, params.worktreePath, ticket.projectId);
    if (!target.registered) return { outcome: 'missing' };
    return serialized(target.repoRoot, async () => {
        // Checked before anything is stopped or removed: a refusal leaves everything as it was.
        const status = await runGit(target.path, ['status', '--porcelain'], { readOnly: true });
        if (!params.force) {
            if (status.code !== 0) throw new OpFailure('WORKTREE_REMOVE_FAILED', gitError(status));
            if (status.stdout.trim()) throw new OpFailure('WORKTREE_DIRTY', 'contains modified or untracked files');
            if (params.branch && (await runGit(target.repoRoot, ['merge-base', '--is-ancestor', params.branch, 'HEAD'], { readOnly: true })).code !== 0) {
                throw new OpFailure('WORKTREE_DIRTY', 'contains changes not applied to the default version');
            }
        }
        if (params.dryRun) return { outcome: 'removable' as const };
        const removed = await runGit(target.repoRoot, ['worktree', 'remove', ...(params.force ? ['--force'] : []), '--', target.path]);
        if (removed.code !== 0) {
            const error = gitError(removed);
            throw new OpFailure(!params.force && /contains modified or untracked files/i.test(error) ? 'WORKTREE_DIRTY' : 'WORKTREE_REMOVE_FAILED', error);
        }
        await runGit(target.repoRoot, ['worktree', 'prune']);
        // A non-forced `-d` keeps a branch whose commits are not merged.
        if (params.branch) await runGit(target.repoRoot, ['branch', params.force ? '-D' : '-d', params.branch]);
        return { outcome: 'removed' as const };
    });
}

// ── Changing, publishing and switching work ────────────────────────────────────────────────────

/** A worktree git has registered, or WORKTREE_PATH_MISSING. */
async function registeredTarget(guard: PathGuard, path: string, projectId: string): Promise<WorktreeTarget> {
    const target = await resolveWorktreeTarget(guard, path, projectId);
    if (!target.registered) throw new OpFailure('WORKTREE_PATH_MISSING', '작업 환경 경로를 찾을 수 없습니다.');
    return target;
}

async function currentBranch(dir: string): Promise<string | null> {
    const head = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { readOnly: true });
    return head.code === 0 ? head.stdout.trim() || null : null;
}

async function requireBranch(dir: string, branch: string): Promise<void> {
    if (await currentBranch(dir) !== branch) throw new OpFailure('WORKTREE_BRANCH_MISMATCH', '작업 트리 브랜치가 변경되었습니다.');
}

/** The server's checkpoint: everything but private env files, committed when anything is staged. */
async function checkpoint(dir: string, message: string): Promise<void> {
    await stageNonPrivate(dir, 'WORKTREE_CHECKPOINT_FAILED');
    if ((await runGit(dir, ['diff', '--cached', '--quiet'])).code !== 0) {
        await gitOk(dir, [...STUDIO_AUTHOR, 'commit', '-m', message], 'WORKTREE_CHECKPOINT_FAILED');
    }
}

/** Leaves a failed merge as if it was never started. */
async function abortMerge(dir: string): Promise<void> {
    await runGit(dir, ['merge', '--abort']);
}

async function unmergedPaths(dir: string): Promise<string[]> {
    const listed = await runGit(dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U', '-z'], { readOnly: true });
    return listed.stdout.split('\0').filter(Boolean);
}

/** `branch` fetched from `remote` (also updating `origin/<branch>`), or null when the remote has no such branch. */
async function fetchBranch(dir: string, remote: string, branch: string, credential: PreparedGitCredential | null, allowMissing: boolean): Promise<string | null> {
    const fetchRef = `refs/aplus/fetch/${process.pid}-${Date.now()}`;
    try {
        const fetched = await runGit(dir, [
            'fetch', remote, `+refs/heads/${branch}:refs/remotes/origin/${branch}`, `refs/heads/${branch}:${fetchRef}`,
        ], { network: true, credential, timeoutMs: NETWORK_TIMEOUT_MS });
        if (fetched.code !== 0) {
            const error = gitError(fetched);
            if (allowMissing && NO_REMOTE_BRANCH.test(error)) return null;
            throw new OpFailure(AUTH_FAILURE.test(error) ? 'WORKTREE_AUTH_REQUIRED' : 'WORKTREE_FETCH_FAILED', error);
        }
        return (await gitOk(dir, ['rev-parse', '--verify', `${fetchRef}^{commit}`], 'WORKTREE_FETCH_FAILED')).trim();
    } finally {
        await runGit(dir, ['update-ref', '-d', fetchRef]);
    }
}

/** Points `origin` at the address the server chose, as its scripts do before fetching. */
async function setOrigin(dir: string, remoteUrl: string | null): Promise<void> {
    if (!remoteUrl) return;
    const existing = await runGit(dir, ['remote', 'get-url', 'origin'], { readOnly: true });
    await gitOk(dir, existing.code === 0 ? ['remote', 'set-url', 'origin', remoteUrl] : ['remote', 'add', 'origin', remoteUrl], 'WORKTREE_REMOTE_FAILED');
}

async function applyWorktree(guard: PathGuard, ticket: WorktreeTicket & { op: 'apply' }): Promise<WorktreeOpResult<'apply'>> {
    const params: WorktreeOpParams<'apply'> = ticket.params;
    const target = await registeredTarget(guard, params.worktreePath, ticket.projectId);
    return serialized(target.repoRoot, async () => {
        const saved = await snapshotCurrent(target.repoRoot);
        if (params.baseBranch && saved.branch !== params.baseBranch) {
            throw new OpFailure('WORKTREE_BASE_BRANCH_MISMATCH', `이 작업 트리는 ${params.baseBranch} 브랜치에서 시작되었습니다.`, { currentBranch: saved.branch });
        }
        await checkpoint(target.path, 'A+ Studio: 별도 작업 버전 저장');
        const merged = await runGit(target.repoRoot, [...STUDIO_AUTHOR, 'merge', '--no-ff', '--no-edit', params.branch]);
        if (merged.code !== 0) {
            await abortMerge(target.repoRoot);
            const error = gitError(merged);
            throw new OpFailure(MERGE_CONFLICT.test(error) ? 'WORKTREE_APPLY_CONFLICT' : 'WORKTREE_APPLY_FAILED', error);
        }
        return { appliedToBranch: saved.branch };
    });
}

async function updateWorktree(guard: PathGuard, ticket: WorktreeTicket & { op: 'update' }): Promise<WorktreeOpResult<'update'>> {
    const params: WorktreeOpParams<'update'> = ticket.params;
    const target = await registeredTarget(guard, params.worktreePath, ticket.projectId);
    return serialized(target.repoRoot, async () => {
        const saved = await snapshotCurrent(target.repoRoot);
        if (saved.branch !== params.baseBranch) {
            throw new OpFailure('WORKTREE_BASE_BRANCH_MISMATCH', `이 작업 트리는 ${params.baseBranch} 브랜치에서 시작되었습니다.`, {
                baseBranch: params.baseBranch, currentBranch: saved.branch,
            });
        }
        await requireBranch(target.path, params.branch);
        await checkpoint(target.path, 'A+ Studio: 최신 내용 반영 전 저장');
        let merged = await runGit(target.path, [...STUDIO_AUTHOR, 'merge', '--no-edit', params.baseBranch]);
        if (merged.code !== 0 && params.conflictChoice) {
            // Every conflict one way: a side that deleted the file wins as a deletion.
            const stage = params.conflictChoice === 'current' ? '2' : '3';
            for (const conflict of await unmergedPaths(target.path)) {
                if ((await runGit(target.path, ['cat-file', '-e', `:${stage}:${conflict}`])).code === 0) {
                    await runGit(target.path, ['checkout', params.conflictChoice === 'current' ? '--ours' : '--theirs', '--', conflict]);
                    await runGit(target.path, ['add', '--', conflict]);
                } else {
                    await runGit(target.path, ['rm', '-f', '--ignore-unmatch', '--', conflict]);
                }
            }
            if ((await unmergedPaths(target.path)).length === 0) {
                merged = await runGit(target.path, [...STUDIO_AUTHOR, 'commit', '--no-edit']);
            }
        }
        if (merged.code !== 0) {
            const conflicts = await unmergedPaths(target.path);
            await abortMerge(target.path);
            if (conflicts.length > 0) throw new OpFailure('WORKTREE_UPDATE_CONFLICT', gitError(merged), { conflicts });
            throw new OpFailure('WORKTREE_UPDATE_FAILED', gitError(merged));
        }
        return { head: (await gitOk(target.path, ['rev-parse', 'HEAD'], 'WORKTREE_UPDATE_FAILED')).trim() };
    });
}

async function recoverWorktree(guard: PathGuard, ticket: WorktreeTicket & { op: 'recover' }): Promise<WorktreeOpResult<'recover'>> {
    const params: WorktreeOpParams<'recover'> = ticket.params;
    const target = await resolveWorktreeTarget(guard, params.worktreePath, ticket.projectId);
    return serialized(target.repoRoot, async () => {
        if (target.onDisk) {
            if (target.registered && await currentBranch(target.path) === params.branch) return { recovered: false };
            throw new OpFailure('WORKTREE_RECOVERY_PATH_OCCUPIED', '작업 환경 경로에 다른 파일이 있어 자동으로 복구할 수 없습니다.');
        }
        if ((await runGit(target.repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${params.branch}`], { readOnly: true })).code !== 0) {
            throw new OpFailure('WORKTREE_RECOVERY_BRANCH_MISSING', '복구할 작업 브랜치를 찾을 수 없습니다.');
        }
        await runGit(target.repoRoot, ['worktree', 'prune']);
        await gitOk(target.repoRoot, ['worktree', 'add', '--', target.path, params.branch], 'WORKTREE_RECOVERY_FAILED', { timeoutMs: CHECKOUT_TIMEOUT_MS });
        return { recovered: true };
    });
}

async function adoptCheck(guard: PathGuard, ticket: WorktreeTicket & { op: 'adopt-check' }): Promise<WorktreeOpResult<'adopt-check'>> {
    const params: WorktreeOpParams<'adopt-check'> = ticket.params;
    const workspace = await guard.directory(params.workspaceDir);
    const repo = await repositoryRoot(workspace);
    if (!repo) throw new OpFailure('WORKTREE_REPO_NOT_FOUND', 'git repository root not found');
    if (repo !== slashed(workspace) && repo !== params.expectedRepoRoot) {
        throw new OpFailure('WORKTREE_NOT_REPO_ROOT', `workspace dir is not the repository root: ${workspace} (repository: ${repo})`);
    }
    const target = await resolveWorktreeTarget(guard, params.worktreePath, ticket.projectId);
    if (slashed(target.repoRoot) !== slashed(await realpath(repo))) throw new OpFailure('PATH_DENIED', 'path is outside this repository managed worktree directory');
    if (!target.registered) throw new OpFailure('WORKTREE_NOT_REGISTERED', 'not a registered worktree');
    return { path: slashed(target.path), branch: await currentBranch(target.path), repoRoot: repo };
}

async function publishWorktree(guard: PathGuard, ticket: WorktreeTicket & { op: 'publish' }, credential: PreparedGitCredential | null): Promise<WorktreeOpResult<'publish'>> {
    const params: WorktreeOpParams<'publish'> = ticket.params;
    const target = await registeredTarget(guard, params.worktreePath, ticket.projectId);
    return serialized(target.repoRoot, async () => {
        await requireBranch(target.path, params.branch);
        await setOrigin(target.path, params.remoteUrl);
        if ((await runGit(target.path, ['remote', 'get-url', 'origin'], { readOnly: true })).code !== 0) {
            throw new OpFailure('WORKTREE_PUBLISH_NO_REMOTE', '연결된 온라인 저장소가 없습니다.');
        }
        await checkpoint(target.path, 'A+ Studio: 온라인 저장 전 저장');
        const online = await fetchBranch(target.path, 'origin', params.branch, credential, true);
        if (online) {
            const merged = await runGit(target.path, [...STUDIO_AUTHOR, 'merge', '--no-edit', online]);
            if (merged.code !== 0) {
                await abortMerge(target.path);
                throw new OpFailure('WORKTREE_PUBLISH_REMOTE_CONFLICT', gitError(merged));
            }
        }
        const pushed = await runGit(target.path, ['push', '--set-upstream', 'origin', `refs/heads/${params.branch}:refs/heads/${params.branch}`], {
            network: true, credential, timeoutMs: NETWORK_TIMEOUT_MS,
        });
        if (pushed.code !== 0) {
            const error = gitError(pushed);
            throw new OpFailure(AUTH_FAILURE.test(error) ? 'WORKTREE_AUTH_REQUIRED' : 'WORKTREE_PUSH_FAILED', error);
        }
        return { commit: (await gitOk(target.path, ['rev-parse', 'HEAD'], 'WORKTREE_PUSH_FAILED')).trim() };
    });
}

async function reconcileWorktree(guard: PathGuard, ticket: WorktreeTicket & { op: 'reconcile' }, credential: PreparedGitCredential | null): Promise<WorktreeOpResult<'reconcile'>> {
    const params: WorktreeOpParams<'reconcile'> = ticket.params;
    const target = await registeredTarget(guard, params.worktreePath, ticket.projectId);
    return serialized(target.repoRoot, async () => {
        await requireBranch(target.path, params.branch);
        // The review was of exactly this commit; anything since stays where it is.
        const status = await runGit(target.path, ['status', '--porcelain', '--', '.', ...PRIVATE_ENV_EXCLUDES], { readOnly: true });
        const head = (await runGit(target.path, ['rev-parse', 'HEAD'], { readOnly: true })).stdout.trim();
        if (status.code !== 0 || status.stdout.trim() || head !== params.expectedHead) {
            throw new OpFailure('WORKTREE_REVIEW_OUTDATED', '온라인 반영 후 새 변경이 있어 현재 작업을 그대로 보관했습니다.');
        }
        if (await currentBranch(target.repoRoot) !== params.baseBranch) {
            throw new OpFailure('WORKTREE_BASE_BRANCH_MISMATCH', `기본 버전이 ${params.baseBranch} 브랜치가 아닙니다.`);
        }
        const online = (await fetchBranch(target.repoRoot, 'origin', params.baseBranch, credential, false))!;
        await checkpoint(target.repoRoot, 'A+ Studio: 온라인 반영 동기화 전 저장');
        const merged = await runGit(target.repoRoot, [...STUDIO_AUTHOR, 'merge', '--no-edit', online]);
        if (merged.code !== 0) {
            await abortMerge(target.repoRoot);
            const error = gitError(merged);
            throw new OpFailure(MERGE_CONFLICT.test(error) ? 'WORKTREE_RECONCILE_CONFLICT' : 'WORKTREE_RECONCILE_FAILED', error);
        }
        return { appliedToBranch: params.baseBranch };
    });
}

async function createBranch(guard: PathGuard, ticket: WorktreeTicket & { op: 'create-branch' }): Promise<WorktreeOpResult<'create-branch'>> {
    const params: WorktreeOpParams<'create-branch'> = ticket.params;
    const dir = await guard.directory(params.workspaceDir);
    return serialized(dir, async () => {
        await gitOk(dir, ['check-ref-format', '--branch', params.branchName], 'WORKSPACE_BRANCH_INVALID');
        const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree'], { readOnly: true });
        if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
            await gitOk(dir, ['init', '--quiet', '--initial-branch=main'], 'WORKSPACE_BRANCH_FAILED');
        }
        const exists = (await runGit(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${params.branchName}`], { readOnly: true })).code === 0;
        if (exists || await currentBranch(dir) === params.branchName) {
            throw new OpFailure('WORKSPACE_BRANCH_EXISTS', '이미 있는 branch와 다른 이름을 입력해 주세요.');
        }
        await gitOk(dir, ['checkout', '-b', params.branchName], 'WORKSPACE_BRANCH_FAILED');
        if (await currentBranch(dir) !== params.branchName) throw new OpFailure('WORKSPACE_BRANCH_FAILED', 'branch verification failed');
        return { branch: params.branchName };
    });
}

async function prepareConversation(
    guard: PathGuard,
    ticket: WorktreeTicket & { op: 'prepare-conversation' },
    credential: PreparedGitCredential | null,
): Promise<WorktreeOpResult<'prepare-conversation'>> {
    const params: WorktreeOpParams<'prepare-conversation'> = ticket.params;
    const dir = await guard.directory(params.workspaceDir);
    return serialized(dir, async () => {
        const base = params.baseBranch;
        await gitOk(dir, ['check-ref-format', '--branch', base], 'WORKSPACE_CHECKOUT_FAILED');
        const current = await currentBranch(dir);
        if (params.source === 'local' && params.allowCurrentBranchDirty && current === base) return { branch: base };
        const status = await gitOk(dir, ['status', '--porcelain=v2', '--untracked-files=all', '--', ...params.statusPathspecs], 'WORKSPACE_STATUS_FAILED', { readOnly: true });
        if (status.trim()) {
            throw new OpFailure('WORKSPACE_DIRTY', '현재 branch에 저장되지 않은 변경이 있습니다.', {
                currentBranch: current, dirtyStatus: status.slice(0, MAX_DIRTY_STATUS_CHARS),
            });
        }
        const localExists = (await runGit(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${base}`], { readOnly: true })).code === 0;
        if (params.source === 'local') {
            if (!localExists) throw new OpFailure('WORKSPACE_CHECKOUT_FAILED', `local branch ${base} not found`);
            await gitOk(dir, ['checkout', base], 'WORKSPACE_CHECKOUT_FAILED');
            if (await currentBranch(dir) !== base) throw new OpFailure('WORKSPACE_CHECKOUT_FAILED', 'branch verification failed');
            return { branch: base };
        }
        // Without a sealed credential the machine's own login is used: helpers stay on (local OAuth).
        await setOrigin(dir, params.remoteUrl);
        const online = (await fetchBranch(dir, 'origin', base, credential, false))!;
        if (localExists) {
            await gitOk(dir, ['checkout', base], 'WORKSPACE_CHECKOUT_FAILED');
        } else {
            await gitOk(dir, ['checkout', '-b', base, online], 'WORKSPACE_CHECKOUT_FAILED');
            await gitOk(dir, ['branch', `--set-upstream-to=origin/${base}`, base], 'WORKSPACE_CHECKOUT_FAILED');
        }
        const forwarded = await runGit(dir, ['merge', '--ff-only', online]);
        if (forwarded.code !== 0) throw new OpFailure('WORKSPACE_BASE_DIVERGED', gitError(forwarded));
        const head = (await runGit(dir, ['rev-parse', 'HEAD'], { readOnly: true })).stdout.trim();
        if (await currentBranch(dir) !== base || head !== online) throw new OpFailure('WORKSPACE_BASE_DIVERGED', 'the local branch is not the online branch');
        return { branch: base };
    });
}

// ── Handlers ───────────────────────────────────────────────────────────────────────────────────

// Process-wide: a daemon that reconnects builds new handlers, and a used ticket must stay used.
const usedTickets = new RpcNonceGuard({ windowMs: WORKTREE_TICKET_MAX_TTL_MS + ISSUE_SKEW_MS, maxEntries: 10_000, whenFull: 'refuse' });

export function createWorktreeOpsHandlers(deps: WorktreeOpsDeps): Record<WorktreeOpsMethod, (request: unknown) => Promise<WorktreeOpAnswer>> {
    const now = deps.now ?? Date.now;
    const guard = pathGuard(deps.allowedRoot, deps.happyHomeDir);

    const run = (ticket: WorktreeTicket, credential: PreparedGitCredential | null): Promise<Record<string, unknown>> => {
        switch (ticket.op) {
            case 'capability': return guard.directory(ticket.params.workspaceDir).then(readCapability);
            case 'prepare': return guard.directory(ticket.params.workspaceDir).then((dir) => serialized(dir, () => prepare(dir)));
            case 'create': return createWorktree(guard, ticket, credential);
            case 'status': return worktreeStatus(guard, ticket);
            case 'remove': return removeWorktree(guard, ticket);
            case 'apply': return applyWorktree(guard, ticket);
            case 'update': return updateWorktree(guard, ticket);
            case 'recover': return recoverWorktree(guard, ticket);
            case 'adopt-check': return adoptCheck(guard, ticket);
            case 'publish': return publishWorktree(guard, ticket, credential);
            case 'reconcile': return reconcileWorktree(guard, ticket, credential);
            case 'create-branch': return createBranch(guard, ticket);
            case 'prepare-conversation': return prepareConversation(guard, ticket, credential);
        }
    };

    const handler = (op: WorktreeOp) => async (request: unknown): Promise<WorktreeOpAnswer> => {
        const read = readWorktreeTicket(request && typeof request === 'object' ? (request as { ticket?: unknown }).ticket : undefined);
        if (!read.ok) return refused('TICKET_INVALID', read.error);
        const ticket = read.ticket;
        if (ticket.op !== op) return refused('TICKET_WRONG_OPERATION', `This ticket is for worktree:${ticket.op}`);
        const machine = deps.machine();
        if (machine.encryptionVariant !== 'dataKey') return refused('WORKTREE_OPS_UNSUPPORTED', 'This machine has no machine key to sign results with');
        if (ticket.machineId !== machine.id) return refused('TICKET_WRONG_MACHINE', 'This ticket is for another machine');
        const at = now();
        if (at > ticket.expiresAt || ticket.issuedAt > at + ISSUE_SKEW_MS) return refused('TICKET_EXPIRED', 'This ticket is not valid now');
        const sealed = request && typeof request === 'object' ? (request as { sealedCredential?: unknown }).sealedCredential : undefined;
        let credential: { username: string; token: string } | null = null;
        if (sealed !== undefined && sealed !== null) {
            if (!REMOTE_OPS.has(op)) return refused('GIT_CREDENTIAL_UNEXPECTED', `worktree:${op} does not reach a remote`);
            const opened = typeof sealed === 'string' ? openSealedForMachine(machine.encryptionKey, GIT_CREDENTIAL_SEAL_KEY_LABEL, sealed) : null;
            const read = readSealedGitCredential(opened, { machineId: machine.id, opId: ticket.opId });
            if (!read.ok) return refused('GIT_CREDENTIAL_INVALID', 'The credential was not sealed for this machine and ticket');
            credential = { username: read.username, token: read.token };
        }
        const admission = usedTickets.admit(ticket.opId, ticket.issuedAt, at);
        if (admission === 'replayed') return refused('TICKET_REPLAYED', 'This ticket was already used');
        if (admission === 'full') return refused('TICKET_BUSY', 'Too many worktree operations in the window');

        const prepared = credential ? await prepareGitCredential(credential) : null;
        try {
            const result = await run(ticket, prepared);
            const finishedAt = now();
            logger.debug('[worktree-ops] done', { op, opId: ticket.opId });
            return { success: true, result, finishedAt, attestation: attestWorktreeResult(machine.encryptionKey, ticket, result, finishedAt) };
        } catch (error) {
            if (error instanceof OpFailure) return refused(error.errorCode, error.message, error.details);
            logger.debug('[worktree-ops] failed', { op, error: error instanceof Error ? error.message : String(error) });
            return refused('WORKTREE_OP_FAILED', error instanceof Error ? error.message : 'Worktree operation failed');
        } finally {
            await prepared?.dispose();
        }
    };

    return Object.fromEntries(WORKTREE_OPS.map((op) => [worktreeOpMethod(op), handler(op)])) as Record<WorktreeOpsMethod, (request: unknown) => Promise<WorktreeOpAnswer>>;
}
