import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export type CheckpointStoreBinding = {
    checkpointRoot: string;
    sessionId: string;
    projectId: string;
    worktreeId: string | null;
};

export type CheckpointStoreLayout = {
    gitDirectory: string;
    refName: string;
    indexFile: string;
    metadataFile: string;
    ledgerFile: string;
};

export type CheckpointSnapshotRequest = Omit<CheckpointStoreBinding, 'checkpointRoot'> & {
    operationId: string;
    projectPath: string;
    excludedPaths?: string[];
    excludedPatterns?: string[];
};

export type CheckpointSnapshotResult = {
    checkpointId: string;
    created: boolean;
};

type GitResult = {
    stdout: string;
    stderr: string;
    exitCode: number;
};

export function resolveCheckpointStoreLayout(
    binding: CheckpointStoreBinding,
): CheckpointStoreLayout {
    const identityKey = createHash('sha256')
        .update(JSON.stringify([
            binding.sessionId,
            binding.projectId,
            binding.worktreeId,
        ]))
        .digest('hex');
    const gitDirectory = join(resolve(binding.checkpointRoot), 'store');

    return {
        gitDirectory,
        refName: `refs/saycode-checkpoints/${identityKey}`,
        indexFile: join(gitDirectory, 'indexes', identityKey),
        metadataFile: join(gitDirectory, 'bindings', `${identityKey}.json`),
        ledgerFile: join(gitDirectory, 'ledgers', `${identityKey}.jsonl`),
    };
}

export function validateCheckpointProjectPath(input: {
    projectPath: string;
    checkpointRoot: string;
    userHomePath: string;
}): void {
    const projectPath = resolve(input.projectPath);
    const checkpointRoot = resolve(input.checkpointRoot);
    const userHomePath = resolve(input.userHomePath);
    if (projectPath === parse(projectPath).root || projectPath === userHomePath) {
        throw new Error('checkpoint project path is too broad');
    }
    if (
        isWithin(projectPath, checkpointRoot)
        || isWithin(checkpointRoot, projectPath)
    ) {
        throw new Error('checkpoint store overlaps project path');
    }
}

function isWithin(parent: string, child: string): boolean {
    const childRelativePath = relative(parent, child);
    return childRelativePath === '' || (
        !childRelativePath.startsWith(`..${sep}`)
        && childRelativePath !== '..'
        && !isAbsolute(childRelativePath)
    );
}

export class CheckpointStore {
    private readonly checkpointRoot: string;
    private initialization: Promise<void> | null = null;
    private readonly latestOperationByRef = new Map<string, {
        operationId: string;
        snapshot: Promise<CheckpointSnapshotResult>;
    }>();

    constructor(checkpointRoot: string) {
        this.checkpointRoot = resolve(checkpointRoot);
    }

    snapshotTurn(request: CheckpointSnapshotRequest): Promise<CheckpointSnapshotResult> {
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        });
        const current = this.latestOperationByRef.get(layout.refName);
        if (current?.operationId === request.operationId) {
            return current.snapshot;
        }

        const snapshot = this.createSnapshot(request, layout).catch((error) => {
            if (this.latestOperationByRef.get(layout.refName)?.snapshot === snapshot) {
                this.latestOperationByRef.delete(layout.refName);
            }
            throw error;
        });
        this.latestOperationByRef.set(layout.refName, {
            operationId: request.operationId,
            snapshot,
        });
        return snapshot;
    }

    private async createSnapshot(
        request: CheckpointSnapshotRequest,
        layout: CheckpointStoreLayout,
    ): Promise<CheckpointSnapshotResult> {
        const projectPath = await realpath(request.projectPath);
        if (!(await stat(projectPath)).isDirectory()) {
            throw new Error('checkpoint project path must be a directory');
        }
        const userHomePath = await realpath(homedir()).catch(() => resolve(homedir()));
        validateCheckpointProjectPath({
            projectPath,
            checkpointRoot: this.checkpointRoot,
            userHomePath,
        });
        await this.ensureInitialized(layout.gitDirectory);
        await mkdir(dirname(layout.indexFile), { recursive: true });
        await mkdir(dirname(layout.metadataFile), { recursive: true });
        await bindProjectPath(layout.metadataFile, request, projectPath);

        const environment = this.gitEnvironment(layout, projectPath);
        const parent = await runGit(
            ['rev-parse', '--verify', `${layout.refName}^{commit}`],
            projectPath,
            environment,
            new Set([0, 128]),
        );
        const parentId = parent.exitCode === 0 ? parent.stdout.trim() : null;

        if (parentId) {
            await runGit(['read-tree', parentId], projectPath, environment);
        } else {
            await rm(layout.indexFile, { force: true });
        }

        const excludedPaths = normalizeExcludedPaths(request.excludedPaths ?? []);
        const excludedPatterns = normalizeExcludedPatterns(request.excludedPatterns ?? []);
        await runGit([
            'add',
            '-A',
            '--',
            '.',
            ...excludedPaths.map((path) => `:(exclude,top,literal)${path}`),
            ...excludedPatterns.map((pattern) => `:(exclude,top,glob)${pattern}`),
        ], projectPath, environment);
        if (excludedPaths.length > 0 || excludedPatterns.length > 0) {
            await runGit([
                'rm',
                '-r',
                '-f',
                '--cached',
                '--ignore-unmatch',
                '--',
                ...excludedPaths.map((path) => `:(top,literal)${path}`),
                ...excludedPatterns.map((pattern) => `:(top,glob)${pattern}`),
            ], projectPath, environment);
        }
        const tree = (await runGit(['write-tree'], projectPath, environment)).stdout.trim();
        if (parentId) {
            const parentTree = (await runGit(
                ['rev-parse', `${parentId}^{tree}`],
                projectPath,
                environment,
            )).stdout.trim();
            if (tree === parentTree) {
                return { checkpointId: parentId, created: false };
            }
        }

        const commitArgs = ['commit-tree', tree, '-m', `checkpoint ${request.operationId}`, '--no-gpg-sign'];
        if (parentId) commitArgs.push('-p', parentId);
        const checkpointId = (await runGit(commitArgs, projectPath, environment)).stdout.trim();
        const updateRefArgs = ['update-ref', layout.refName, checkpointId];
        if (parentId) updateRefArgs.push(parentId);
        await runGit(updateRefArgs, projectPath, environment);
        return { checkpointId, created: true };
    }

    private ensureInitialized(gitDirectory: string): Promise<void> {
        if (!this.initialization) {
            this.initialization = initializeGitStore(gitDirectory).catch((error) => {
                this.initialization = null;
                throw error;
            });
        }
        return this.initialization;
    }

    private gitEnvironment(layout: CheckpointStoreLayout, projectPath: string): NodeJS.ProcessEnv {
        const environment: NodeJS.ProcessEnv = {
            ...process.env,
            GIT_DIR: layout.gitDirectory,
            GIT_WORK_TREE: projectPath,
            GIT_INDEX_FILE: layout.indexFile,
            GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
            GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_AUTHOR_NAME: 'Saycode Checkpoint',
            GIT_AUTHOR_EMAIL: 'checkpoint@saycode.local',
            GIT_COMMITTER_NAME: 'Saycode Checkpoint',
            GIT_COMMITTER_EMAIL: 'checkpoint@saycode.local',
        };
        delete environment.GIT_NAMESPACE;
        delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
        return environment;
    }
}

function normalizeExcludedPatterns(patterns: string[]): string[] {
    return [...new Set(patterns.map((pattern) => {
        if (
            pattern.length === 0
            || pattern.includes('\0')
            || pattern.startsWith('/')
            || pattern.startsWith('!')
            || pattern.split('/').includes('..')
        ) {
            throw new Error('checkpoint excluded pattern must be a project-relative glob');
        }
        return pattern;
    }))].sort();
}

function normalizeExcludedPaths(paths: string[]): string[] {
    return [...new Set(paths.map((path) => {
        if (
            path.length === 0
            || path.includes('\0')
            || /^(?:[A-Za-z]:|[\\/])/.test(path)
            || path.split(/[\\/]+/).includes('..')
        ) {
            throw new Error('checkpoint excluded path must be project-relative');
        }
        return path.split(sep).join('/');
    }))].sort();
}

async function bindProjectPath(
    metadataFile: string,
    request: CheckpointSnapshotRequest,
    projectPath: string,
): Promise<void> {
    try {
        const current = JSON.parse(await readFile(metadataFile, 'utf8')) as Record<string, unknown>;
        if (current.projectPath !== projectPath) {
            throw new Error('checkpoint binding path mismatch');
        }
        if (
            current.sessionId !== request.sessionId
            || current.projectId !== request.projectId
            || current.worktreeId !== request.worktreeId
        ) {
            throw new Error('checkpoint binding identity mismatch');
        }
        return;
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            throw error;
        }
    }

    await writeFile(metadataFile, JSON.stringify({
        sessionId: request.sessionId,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        projectPath,
    }));
}

async function initializeGitStore(gitDirectory: string): Promise<void> {
    try {
        await readFile(join(gitDirectory, 'HEAD'));
        return;
    } catch {
        await mkdir(dirname(gitDirectory), { recursive: true });
    }

    const environment = { ...process.env };
    delete environment.GIT_DIR;
    delete environment.GIT_WORK_TREE;
    delete environment.GIT_INDEX_FILE;
    delete environment.GIT_NAMESPACE;
    delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    environment.GIT_CONFIG_SYSTEM = process.platform === 'win32' ? 'NUL' : '/dev/null';
    environment.GIT_CONFIG_NOSYSTEM = '1';

    await runGit(['init', '--bare', gitDirectory], dirname(gitDirectory), environment);
    await mkdir(join(gitDirectory, 'indexes'), { recursive: true });
    await mkdir(join(gitDirectory, 'bindings'), { recursive: true });
    await writeFile(join(gitDirectory, 'info', 'exclude'), '.git/\n');
}

function runGit(
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
    allowedExitCodes = new Set([0]),
): Promise<GitResult> {
    return new Promise((resolvePromise, rejectPromise) => {
        execFile('git', args, {
            cwd,
            env: environment,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 60_000,
        }, (error, stdout, stderr) => {
            const exitCode = typeof error?.code === 'number' ? error.code : error ? -1 : 0;
            if (error && !allowedExitCodes.has(exitCode)) {
                rejectPromise(new Error(`git ${args[0]} failed: ${stderr || error.message}`));
                return;
            }
            resolvePromise({ stdout, stderr, exitCode });
        });
    });
}
