/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary 4b-3 worktree (worktree-strict-design.md) —
 * `worktree:*`, customer lane only.
 *
 * The server sends no command to a strict machine, so worktrees there are made, read and removed
 * by this daemon. The browser brings a ticket the server issued (the operation and its params); the
 * daemon checks it, runs git itself and signs the result, and the server records it only after
 * checking that signature. The server's shell scripts (`server/worktreeCommands.ts`) are the
 * reference for what each operation does; here git runs from an argument list, never a shell, with
 * repository hooks and fsmonitor off, and every path is judged by where it really lands.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { appendFile, cp, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
    WORKTREE_OPS,
    WORKTREE_RESULT_ATTESTATION_KEY_LABEL,
    WORKTREE_TICKET_MAX_TTL_MS,
    canonicalWorktreeJson,
    isManagedWorktreePath,
    managedWorktreePath,
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

function runGit(cwd: string, args: string[], options: { timeoutMs?: number; network?: boolean } = {}): Promise<GitResult> {
    return new Promise((resolvePromise) => {
        const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
            cwd,
            env: options.network ? networkGitEnv() : localGitEnv(),
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
async function gitOk(cwd: string, args: string[], errorCode: string, options?: { timeoutMs?: number; network?: boolean }): Promise<string> {
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

type WorktreeTarget = { repoRoot: string; path: string; exists: boolean };

/** A worktree this project's ticket may touch: managed, in an allowed repository, landing where it says. */
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
            return { repoRoot, path, exists: false };
        }
        throw denied;
    }
    if (!inside(repoRoot, real) || !ownsWorktreeName(relative(repoRoot, real).split(sep), projectId)) throw denied;
    return { repoRoot, path: real, exists: true };
}

// ── Serialization ──────────────────────────────────────────────────────────────────────────────

const repositoryQueues = new Map<string, Promise<unknown>>();

/** One operation at a time per repository, so git's own locks never race. */
async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
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
    const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { capable: false, reason: 'not-git', branch: null, branches: [] };
    const [head, refs, list] = await Promise.all([
        runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        runGit(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
        runGit(dir, ['worktree', 'list', '--porcelain']),
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

/** The server's snapshot: everything but private env files, committed so the new worktree starts from it. */
async function snapshotCurrent(dir: string): Promise<{ revision: string; branch: string | null }> {
    const repo = await repositoryRoot(dir);
    if (!repo) throw new OpFailure('WORKTREE_SNAPSHOT_FAILED', 'git repository root not found');
    await excludeLines(repo, ['/.aplus/worktrees/', '.next/']);
    await runGit(dir, ['rm', '-r', '-f', '--cached', '--ignore-unmatch', '--', ':(glob)**/.next/**']);
    await gitOk(dir, ['add', '-A'], 'WORKTREE_SNAPSHOT_FAILED');
    await runGit(dir, ['reset', '--quiet', '--', ...PRIVATE_ENV_PATHS]);
    const unchanged = (await runGit(dir, ['diff', '--cached', '--quiet'])).code === 0;
    const hasHead = (await runGit(dir, ['rev-parse', '--verify', 'HEAD'])).code === 0;
    if (!unchanged || !hasHead) {
        await gitOk(dir, [...STUDIO_AUTHOR, 'commit', '--allow-empty', '-m', 'A+ Studio: 새 작업 버전 시작 전 저장'], 'WORKTREE_SNAPSHOT_FAILED');
    }
    const revision = (await gitOk(dir, ['rev-parse', 'HEAD'], 'WORKTREE_SNAPSHOT_FAILED')).trim();
    const head = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return { revision, branch: head.code === 0 ? head.stdout.trim() || null : null };
}

/** `.env` files and `.worktreeinclude` entries, copied only from inside the repository. */
async function copyIncludes(repo: string, worktree: string, prefix: string): Promise<void> {
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
            await lstat(source);
        } catch {
            continue;
        }
        try {
            await mkdir(dirname(target), { recursive: true });
            await cp(source, target, { recursive: true, force: true, verbatimSymlinks: true });
        } catch (error) {
            logger.debug('[worktree-ops] include not copied', { entry, error: error instanceof Error ? error.message : String(error) });
        }
    }
}

async function createWorktree(guard: PathGuard, ticket: WorktreeTicket & { op: 'create' }): Promise<WorktreeOpResult<'create'>> {
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
                    'fetch', 'origin', `+refs/heads/${originBase}:refs/remotes/origin/${originBase}`, `refs/heads/${originBase}:${fetchRef}`,
                ], { network: true, timeoutMs: NETWORK_TIMEOUT_MS });
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
    if (!target.exists) throw new OpFailure('WORKTREE_PATH_MISSING', '작업 환경 경로를 찾을 수 없습니다.');
    const status = await gitOk(target.path, ['status', '--porcelain'], 'WORKTREE_STATUS_FAILED');
    const counts = (await gitOk(target.path, ['rev-list', '--left-right', '--count', `${params.baseBranch ?? 'HEAD'}...${params.branch}`], 'WORKTREE_STATUS_FAILED'))
        .trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
    const count = (value: number | undefined) => (Number.isFinite(value) && value! >= 0 ? value! : 0);
    return { dirty: status.trim() !== '', behind: count(counts[0]), ahead: count(counts[1]) };
}

async function removeWorktree(guard: PathGuard, ticket: WorktreeTicket & { op: 'remove' }): Promise<WorktreeOpResult<'remove'>> {
    const params: WorktreeOpParams<'remove'> = ticket.params;
    const target = await resolveWorktreeTarget(guard, params.worktreePath, ticket.projectId);
    if (!target.exists) return { outcome: 'missing' };
    return serialized(target.repoRoot, async () => {
        // Checked before anything is stopped or removed: a refusal leaves everything as it was.
        const status = await runGit(target.path, ['status', '--porcelain']);
        if (!params.force) {
            if (status.code !== 0) throw new OpFailure('WORKTREE_REMOVE_FAILED', gitError(status));
            if (status.stdout.trim()) throw new OpFailure('WORKTREE_DIRTY', 'contains modified or untracked files');
            if (params.branch && (await runGit(target.repoRoot, ['merge-base', '--is-ancestor', params.branch, 'HEAD'])).code !== 0) {
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

// ── Handlers ───────────────────────────────────────────────────────────────────────────────────

export function createWorktreeOpsHandlers(deps: WorktreeOpsDeps): Record<WorktreeOpsMethod, (request: unknown) => Promise<WorktreeOpAnswer>> {
    const now = deps.now ?? Date.now;
    const guard = pathGuard(deps.allowedRoot, deps.happyHomeDir);
    const tickets = new RpcNonceGuard({ windowMs: WORKTREE_TICKET_MAX_TTL_MS + ISSUE_SKEW_MS, maxEntries: 10_000, whenFull: 'refuse' });

    const run = (ticket: WorktreeTicket): Promise<Record<string, unknown>> => {
        switch (ticket.op) {
            case 'capability': return guard.directory(ticket.params.workspaceDir).then(readCapability);
            case 'prepare': return guard.directory(ticket.params.workspaceDir).then((dir) => serialized(dir, () => prepare(dir)));
            case 'create': return createWorktree(guard, ticket);
            case 'status': return worktreeStatus(guard, ticket);
            case 'remove': return removeWorktree(guard, ticket);
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
        const admission = tickets.admit(ticket.opId, ticket.issuedAt, at);
        if (admission === 'replayed') return refused('TICKET_REPLAYED', 'This ticket was already used');
        if (admission === 'full') return refused('TICKET_BUSY', 'Too many worktree operations in the window');

        try {
            const result = await run(ticket);
            const finishedAt = now();
            logger.debug('[worktree-ops] done', { op, opId: ticket.opId });
            return { success: true, result, finishedAt, attestation: attestWorktreeResult(machine.encryptionKey, ticket, result, finishedAt) };
        } catch (error) {
            if (error instanceof OpFailure) return refused(error.errorCode, error.message, error.details);
            logger.debug('[worktree-ops] failed', { op, error: error instanceof Error ? error.message : String(error) });
            return refused('WORKTREE_OP_FAILED', error instanceof Error ? error.message : 'Worktree operation failed');
        }
    };

    return Object.fromEntries(WORKTREE_OPS.map((op) => [worktreeOpMethod(op), handler(op)])) as Record<WorktreeOpsMethod, (request: unknown) => Promise<WorktreeOpAnswer>>;
}
