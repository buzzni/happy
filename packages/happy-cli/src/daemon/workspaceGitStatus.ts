/**
 * aplus-dev-studio specs/work-machine-migration — `workspace-git-status`, the
 * git status Studio's repository panel shows: branch, upstream and base
 * ahead/behind, changed files with their porcelain status codes (untracked
 * included), local branches with whether a worktree has them checked out,
 * and remotes.
 *
 * Studio used to read this by sending a node script through `bash`. A work
 * machine counts every `bash` as new work, so opening a project page on a
 * migrated machine recorded its first execution and closed the way back.
 * Here the caller chooses only the workspace and an optional base branch;
 * the git invocations are fixed, so the server can classify the method as a
 * read. The answer mirrors the shape of that script's `status` object.
 *
 * `workspace-current-pr` is the same script's `current-pr` read, which Studio
 * runs right after the status for a project without a server-side GitHub
 * connection: the checked-out branch's same-repository pull request on the
 * GitHub `origin`, from `gh pr list`.
 *
 * Paths go through the same boundary as the workspace file RPCs. File names
 * leave the machine here, so this is not a server-lane method.
 */
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { captureWorkspacePath } from '@/modules/common/workspaceFileBoundary';
import { approvedAnchor } from '@/modules/common/pathSecurity';
import type { MetadataDeps } from './machineMetadataMethods';

export const WORKSPACE_GIT_STATUS_METHOD = 'workspace-git-status';
export const WORKSPACE_CURRENT_PR_METHOD = 'workspace-current-pr';

export interface WorkspaceGitStatusDeps {
    allowedRoot: string;
    /** Folders outside the allowed root the machine owner approved, asked on every call. */
    approvedRoots: () => readonly string[];
    /** The strict machine's happy home guard (isStrictlyGuardedPath). */
    isGuardedPath: (path: string) => boolean;
    runFile: MetadataDeps['runFile'];
    now: () => number;
}

type Answer = Record<string, unknown>;
type GitFile = { path: string; previousPath?: string; index: string; worktree: string };

/** The whole read must finish before Studio's 120 s RPC deadline. */
const DEADLINE_MS = 100_000;
const MAX_BASE_LENGTH = 255;
const CLEARED_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX'];

class GitStatusFailure extends Error {
    constructor(readonly errorCode: string, message: string) { super(message); }
}

function failure(errorCode: string, error: string): Answer {
    return { success: false, errorCode, error };
}

function gitEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined || key.startsWith('HAPPY_') || CLEARED_GIT_ENV.includes(key)) continue;
        env[key] = value;
    }
    return { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' };
}

function statusParams(params: unknown): { workspaceRoot: string; path: string; base: string | null } | null {
    if (!params || typeof params !== 'object') return null;
    const { workspaceRoot, path, base } = params as Record<string, unknown>;
    if (typeof workspaceRoot !== 'string' || typeof path !== 'string') return null;
    if (base !== undefined && base !== null && (typeof base !== 'string' || base.length > MAX_BASE_LENGTH)) return null;
    return { workspaceRoot, path, base: typeof base === 'string' && base ? base : null };
}

/** `git status --porcelain=v1 -z`: a rename or copy carries its source as the next field. */
function parsePorcelain(output: string): GitFile[] {
    const entries = output.split('\0');
    const files: GitFile[] = [];
    for (let index = 0; index < entries.length; index++) {
        const line = entries[index];
        if (!line) continue;
        const file: GitFile = { path: line.slice(3), index: line[0], worktree: line[1] };
        if (/[RC]/.test(line.slice(0, 2))) file.previousPath = entries[++index];
        files.push(file);
    }
    return files;
}

const lines = (output: string) => output.trim().split('\n').filter(Boolean);

type WorkspaceGit = {
    cwd: string;
    /** One git call; throws GitStatusFailure when git is missing or does not finish. */
    run: (args: string[]) => Promise<Awaited<ReturnType<MetadataDeps['runFile']>>>;
    /** stdout of a call that must succeed. */
    git: (args: string[]) => Promise<string>;
    /** Trimmed stdout, or null when the call fails. */
    optional: (args: string[]) => Promise<string | null>;
};

/**
 * The workspace directory through the workspace file boundary, and fixed git calls in it.
 * Throws GitStatusFailure for a path it refuses.
 */
async function openWorkspaceGit(deps: WorkspaceGitStatusDeps, workspaceRoot: string, path: string): Promise<WorkspaceGit> {
    if (deps.isGuardedPath(workspaceRoot) || deps.isGuardedPath(path)) {
        throw new GitStatusFailure('WORKSPACE_PATH_DENIED', 'Workspace path is in the happy home directory');
    }
    let cwd: string;
    try {
        const anchor = approvedAnchor(workspaceRoot, deps.allowedRoot, deps.approvedRoots());
        const snapshot = await captureWorkspacePath(anchor, workspaceRoot, path);
        if (!snapshot.info.isDirectory()) throw new GitStatusFailure('TARGET_MISSING', 'Workspace path is not a directory');
        cwd = snapshot.path;
    } catch (error) {
        if (error instanceof GitStatusFailure) throw error;
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') throw new GitStatusFailure('TARGET_MISSING', 'Workspace path does not exist');
        throw new GitStatusFailure('WORKSPACE_PATH_DENIED', 'Workspace path is outside the project or in the happy home directory');
    }

    const env = gitEnv();
    const deadline = Date.now() + DEADLINE_MS;
    const run: WorkspaceGit['run'] = async (args) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new GitStatusFailure('GIT_TIMEOUT', 'Git status exceeded its time limit');
        let result: Awaited<ReturnType<MetadataDeps['runFile']>>;
        try {
            // A status read must not start the repository's fsmonitor daemon.
            result = await deps.runFile('git', ['-c', 'core.fsmonitor=false', '--literal-pathspecs', ...args], { cwd, env, timeoutMs: remaining });
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') throw new GitStatusFailure('GIT_UNAVAILABLE', 'git is not installed');
            throw new GitStatusFailure('GIT_FAILED', error instanceof Error ? error.message : 'git failed');
        }
        if (result.code === null) throw new GitStatusFailure('GIT_TIMEOUT', 'Git status exceeded its time limit');
        return result;
    };
    return {
        cwd,
        run,
        git: async (args) => {
            const result = await run(args);
            if (result.code !== 0) throw new GitStatusFailure('GIT_FAILED', (result.stderr || result.stdout || 'git failed').trim());
            return result.stdout;
        },
        optional: async (args) => {
            const result = await run(args);
            return result.code === 0 ? result.stdout.trim() : null;
        },
    };
}

export function createWorkspaceGitStatusHandler(deps: WorkspaceGitStatusDeps): (params: unknown) => Promise<Answer> {
    return async (params) => {
        const input = statusParams(params);
        if (!input) return failure('INVALID_PARAMS', 'workspaceRoot and path are required; base must be a branch name');
        try {
            const { cwd, run, git, optional } = await openWorkspaceGit(deps, input.workspaceRoot, input.path);
            const counts = async (ref: string) => {
                const value = await optional(['rev-list', '--left-right', '--count', `HEAD...${ref}`]);
                if (value === null) return null;
                const [ahead, behind] = value.split(/\s+/).map(Number);
                return { ahead, behind };
            };
            const inside = await run(['rev-parse', '--is-inside-work-tree']);
            if (inside.code !== 0 && !inside.stderr.includes('not a git repository')) {
                throw new GitStatusFailure('GIT_FAILED', inside.stderr.trim() || 'git failed');
            }
            if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
                return { success: true, status: { isGit: false, branch: null, files: [], branches: [], upstream: null, remotes: [], base: null, checkedAt: deps.now() } };
            }
            const baseName = input.base?.replace(/^refs\/heads\//, '').replace(/^(refs\/remotes\/)?origin\//, '') || null;
            const [toplevel, commonDir, branch, porcelain, upstream, worktrees, refs, remotes, base] = await Promise.all([
                git(['rev-parse', '--show-toplevel']),
                git(['rev-parse', '--git-common-dir']),
                optional(['symbolic-ref', '--quiet', '--short', 'HEAD']),
                git(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=normal']),
                optional(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
                git(['worktree', 'list', '--porcelain']),
                git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
                git(['remote']),
                baseName ? counts(`refs/heads/${baseName}`) : Promise.resolve(null),
            ]);
            const checkedOut = new Set(worktrees.split('\n')
                .filter((line) => line.startsWith('branch refs/heads/')).map((line) => line.slice('branch refs/heads/'.length)));
            return {
                success: true,
                status: {
                    isGit: true,
                    root: await realpath(toplevel.trim()),
                    common: await realpath(resolve(cwd, commonDir.trim())),
                    branch,
                    files: parsePorcelain(porcelain),
                    branches: lines(refs).map((name) => ({ name, checkedOut: checkedOut.has(name) })),
                    remotes: lines(remotes),
                    upstream: upstream ? { branch: upstream, ...await counts(upstream) } : null,
                    base: base && baseName ? { branch: baseName, ...base } : null,
                    checkedAt: deps.now(),
                },
            };
        } catch (error) {
            if (error instanceof GitStatusFailure) return failure(error.errorCode, error.message);
            return failure('GIT_FAILED', error instanceof Error ? error.message : 'git failed');
        }
    };
}

const GITHUB_REMOTE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
const GH_AUTH_FAILURE = /gh auth login|not logged|authentication|HTTP 401|Bad credentials/i;
const PR_STATES = ['OPEN', 'CLOSED', 'MERGED'];

type GhPr = { number?: unknown; url?: unknown; title?: unknown; state?: unknown; isCrossRepository?: unknown };

export function createWorkspaceCurrentPrHandler(deps: WorkspaceGitStatusDeps): (params: unknown) => Promise<Answer> {
    return async (params) => {
        const { workspaceRoot, path, branch } = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
        if (typeof workspaceRoot !== 'string' || typeof path !== 'string' || typeof branch !== 'string' || !branch || branch.length > MAX_BASE_LENGTH) {
            return failure('INVALID_PARAMS', 'workspaceRoot, path and branch are required');
        }
        try {
            const { cwd, optional } = await openWorkspaceGit(deps, workspaceRoot, path);
            if (await optional(['symbolic-ref', '--quiet', '--short', 'HEAD']) !== branch) return failure('BRANCH_CHANGED', 'The checked-out branch changed');
            const remote = await optional(['remote', 'get-url', 'origin']);
            if (!remote) return failure('REMOTE_MISSING', 'The repository has no origin');
            const match = GITHUB_REMOTE.exec(remote);
            if (!match) return failure('UNSUPPORTED_REMOTE', 'origin is not a GitHub repository');
            const repository = `https://github.com/${match[1]}/${match[2]}`;
            let result: Awaited<ReturnType<MetadataDeps['runFile']>>;
            try {
                result = await deps.runFile('gh', ['pr', 'list', '--repo', repository, '--head', branch, '--state', 'all',
                    '--limit', '20', '--json', 'number,url,title,state,isCrossRepository'], {
                    cwd, env: { ...gitEnv(), GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' }, timeoutMs: DEADLINE_MS,
                });
            } catch (error) {
                if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return failure('GH_UNAVAILABLE', 'gh is not installed');
                return failure('GH_FAILED', error instanceof Error ? error.message : 'gh failed');
            }
            if (result.code !== 0) {
                return GH_AUTH_FAILURE.test(`${result.stderr}${result.stdout}`)
                    ? failure('GH_AUTH_REQUIRED', 'gh is not logged in to GitHub')
                    : failure('GH_FAILED', 'gh pr list failed');
            }
            let list: unknown;
            try { list = JSON.parse(result.stdout); } catch { list = null; }
            if (!Array.isArray(list) || list.some((pr: GhPr | null) => !pr || typeof pr.isCrossRepository !== 'boolean')) {
                return failure('GH_FAILED', 'gh answered an unexpected pull request list');
            }
            const pr = (list as GhPr[]).find((candidate) => candidate.isCrossRepository === false);
            if (!pr) return { success: true, currentPr: null };
            if (!Number.isInteger(pr.number) || (pr.number as number) <= 0 || typeof pr.title !== 'string'
                || typeof pr.state !== 'string' || !PR_STATES.includes(pr.state) || typeof pr.url !== 'string'
                || !pr.url.toLowerCase().startsWith(`${repository}/pull/`.toLowerCase())) {
                return failure('GH_FAILED', 'gh answered an unexpected pull request');
            }
            return { success: true, currentPr: { number: pr.number, url: pr.url, title: pr.title, state: pr.state.toLowerCase() } };
        } catch (error) {
            if (error instanceof GitStatusFailure) return failure(error.errorCode, error.message);
            return failure('GIT_FAILED', error instanceof Error ? error.message : 'git failed');
        }
    };
}
