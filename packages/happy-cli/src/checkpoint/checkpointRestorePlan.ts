import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CheckpointLedger, type CheckpointLedgerBinding } from './checkpointLedger';
import {
    CheckpointStore,
    resolveCheckpointStoreLayout,
    type CheckpointSnapshotRequest,
    type CheckpointSnapshotResult,
} from './checkpointStore';

export type CheckpointRestorePlanEntry =
    | { path: string; action: 'restore'; reason: 'agent-modified' | 'agent-deleted' }
    | { path: string; action: 'delete'; reason: 'agent-created' }
    | { path: string; action: 'skip'; reason: 'user-modified' | 'provenance-unknown' }
    | { path: string; action: 'conflict'; reason: 'unsupported-file-type' };

export type CheckpointRestorePlanRequest = CheckpointLedgerBinding & {
    checkpointId: string;
};

export type CheckpointRestorePlan = {
    checkpointId: string;
    entries: CheckpointRestorePlanEntry[];
};

type CurrentFileState =
    | { kind: 'missing' }
    | { kind: 'regular'; contentHash: string }
    | { kind: 'unsupported' };

export class CheckpointRestorePlanner {
    private readonly checkpointRoot: string;

    constructor(checkpointRoot: string) {
        this.checkpointRoot = resolve(checkpointRoot);
    }

    checkpointBeforeRestore(
        request: CheckpointSnapshotRequest,
    ): Promise<CheckpointSnapshotResult> {
        return new CheckpointStore(this.checkpointRoot).snapshotTurn(request);
    }

    async plan(request: CheckpointRestorePlanRequest): Promise<CheckpointRestorePlan> {
        validateCheckpointId(request.checkpointId);
        const projectPath = await realpath(request.projectPath);
        const records = await new CheckpointLedger(this.checkpointRoot).readRecords({
            ...request,
            projectPath,
        });
        await this.assertCheckpointOwnedByBinding(request, projectPath);
        const latestByPath = new Map(records.map((record) => [record.path, record]));
        const changedPaths = await this.listChangedPaths(request, projectPath);
        for (const path of latestByPath.keys()) changedPaths.add(path);
        const entries: CheckpointRestorePlanEntry[] = [];

        for (const path of [...changedPaths].sort()) {
            const record = latestByPath.get(path);
            if (!record) {
                entries.push({ path, action: 'skip', reason: 'provenance-unknown' });
                continue;
            }
            const [current, targetHash] = await Promise.all([
                readCurrentFileState(resolve(projectPath, path)),
                this.readCheckpointFileHash(request, path, projectPath),
            ]);
            if (current.kind === 'regular' && current.contentHash === targetHash) continue;
            if (current.kind === 'missing' && targetHash === null) continue;
            if (current.kind === 'unsupported') {
                entries.push({ path, action: 'conflict', reason: 'unsupported-file-type' });
            } else if (record.action === 'written' && current.kind === 'regular') {
                entries.push(current.contentHash === record.contentHash
                    ? targetHash === null
                        ? { path, action: 'delete', reason: 'agent-created' }
                        : { path, action: 'restore', reason: 'agent-modified' }
                    : { path, action: 'skip', reason: 'user-modified' });
            } else if (record.action === 'deleted' && current.kind === 'missing') {
                if (targetHash !== null) {
                    entries.push({ path, action: 'restore', reason: 'agent-deleted' });
                }
            } else {
                entries.push({ path, action: 'skip', reason: 'user-modified' });
            }
        }

        return { checkpointId: request.checkpointId, entries };
    }

    private async assertCheckpointOwnedByBinding(
        request: CheckpointRestorePlanRequest,
        projectPath: string,
    ): Promise<void> {
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        });
        const containingRef = await runGit([
            'for-each-ref',
            '--format=%(refname)',
            `--contains=${request.checkpointId}`,
            layout.refName,
        ], projectPath, checkpointGitEnvironment(layout.gitDirectory));
        if (containingRef.toString('utf8').trim() !== layout.refName) {
            throw new Error('checkpoint restore target does not belong to binding');
        }
    }

    private async listChangedPaths(
        request: CheckpointRestorePlanRequest,
        projectPath: string,
    ): Promise<Set<string>> {
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        });
        const indexesDirectory = join(layout.gitDirectory, 'restore-indexes');
        await mkdir(indexesDirectory, { recursive: true });
        const temporaryDirectory = await mkdtemp(join(indexesDirectory, 'plan-'));
        try {
            const environment = checkpointGitEnvironment(
                layout.gitDirectory,
                projectPath,
                join(temporaryDirectory, 'index'),
            );
            await runGit(['read-tree', request.checkpointId], projectPath, environment);
            const [tracked, untracked] = await Promise.all([
                runGit(['diff', '--name-only', '-z', request.checkpointId, '--'], projectPath, environment),
                runGit(['ls-files', '--others', '--exclude-standard', '-z'], projectPath, environment),
            ]);
            return new Set([...parseNullTerminatedPaths(tracked), ...parseNullTerminatedPaths(untracked)]);
        } finally {
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    }

    private async readCheckpointFileHash(
        request: CheckpointRestorePlanRequest,
        path: string,
        projectPath: string,
    ): Promise<string | null> {
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        });
        const environment = checkpointGitEnvironment(layout.gitDirectory);
        const treeEntry = await runGit([
            'ls-tree',
            '-z',
            request.checkpointId,
            '--',
            `:(top,literal)${path}`,
        ], projectPath, environment);
        if (treeEntry.length === 0) return null;
        const separator = treeEntry.indexOf(0x09);
        if (separator < 0) {
            throw new Error('checkpoint restore target contains an unsupported entry');
        }
        const header = treeEntry.subarray(0, separator).toString('utf8').split(' ');
        if (header.length !== 3 || header[1] !== 'blob') {
            throw new Error('checkpoint restore target contains an unsupported entry');
        }
        const contents = await runGit(['cat-file', 'blob', header[2]], projectPath, environment);
        return createHash('sha256').update(contents).digest('hex');
    }
}

function validateCheckpointId(checkpointId: string): void {
    if (!/^[a-f0-9]{40,64}$/.test(checkpointId)) {
        throw new Error('checkpoint restore target is invalid');
    }
}

async function readCurrentFileState(path: string): Promise<CurrentFileState> {
    let stats;
    try {
        stats = await lstat(path);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return { kind: 'missing' };
        }
        throw error;
    }
    if (!stats.isFile()) return { kind: 'unsupported' };
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return { kind: 'regular', contentHash: hash.digest('hex') };
}

function checkpointGitEnvironment(
    gitDirectory: string,
    projectPath?: string,
    indexFile?: string,
): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_DIR: gitDirectory,
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
    };
    if (projectPath) environment.GIT_WORK_TREE = projectPath;
    else delete environment.GIT_WORK_TREE;
    if (indexFile) environment.GIT_INDEX_FILE = indexFile;
    else delete environment.GIT_INDEX_FILE;
    delete environment.GIT_NAMESPACE;
    delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    return environment;
}

function parseNullTerminatedPaths(output: Buffer): string[] {
    return output.toString('utf8').split('\0').filter((path) => path.length > 0);
}

function runGit(
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
): Promise<Buffer> {
    return new Promise((resolvePromise, rejectPromise) => {
        execFile('git', args, {
            cwd,
            env: environment,
            encoding: 'buffer',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 60_000,
        }, (error, stdout, stderr) => {
            if (error) {
                rejectPromise(new Error(`git ${args[0]} failed: ${stderr || error.message}`));
                return;
            }
            resolvePromise(stdout);
        });
    });
}
