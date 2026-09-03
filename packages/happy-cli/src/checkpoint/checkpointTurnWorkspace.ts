import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as tar from 'tar';
import {
    checkpointOperationRefPrefix,
    checkpointPinRefPrefix,
    resolveCheckpointStoreLayout,
    type CheckpointStoreBinding,
} from './checkpointStore';

export type CheckpointTurnWorkspaceRequest = Omit<CheckpointStoreBinding, 'checkpointRoot'> & {
    operationId: string;
    checkpointId: string;
    projectPath?: string;
    readOnlyPassthroughPaths?: string[];
};

type CheckpointTurnWorkspaceKey = Omit<CheckpointTurnWorkspaceRequest, 'checkpointId'>;

export type PreparedCheckpointTurnWorkspace = {
    path: string;
};

export class CheckpointTurnWorkspace {
    private readonly checkpointRoot: string;

    constructor(checkpointRoot: string) {
        this.checkpointRoot = resolve(checkpointRoot);
    }

    pathFor(request: CheckpointTurnWorkspaceKey): string {
        return join(
            this.checkpointRoot,
            'workspaces',
            opaqueKey([request.sessionId, request.projectId, request.worktreeId]),
            'turns',
            opaqueKey([request.operationId]),
            'active',
        );
    }

    frozenPathFor(request: CheckpointTurnWorkspaceKey): string {
        return join(dirname(this.pathFor(request)), 'sealed');
    }

    async freeze(request: CheckpointTurnWorkspaceKey): Promise<PreparedCheckpointTurnWorkspace> {
        const activePath = this.pathFor(request);
        const turnPath = dirname(activePath);
        const volatilePath = join(turnPath, 'volatile');
        const sealedPath = this.frozenPathFor(request);
        if (await pathExists(sealedPath)) return { path: sealedPath };
        if (await pathExists(activePath)) {
            if (await pathExists(volatilePath)) {
                throw new Error('checkpoint volatile turn workspace already exists');
            }
            await rename(activePath, volatilePath);
        } else if (!(await pathExists(volatilePath))) {
            throw new Error('checkpoint active turn workspace is missing');
        }
        await createStableSealedCopy(volatilePath, sealedPath);
        return { path: sealedPath };
    }

    async remove(request: CheckpointTurnWorkspaceKey): Promise<void> {
        await rm(dirname(this.pathFor(request)), { recursive: true, force: true });
    }

    async prepare(
        request: CheckpointTurnWorkspaceRequest,
    ): Promise<PreparedCheckpointTurnWorkspace> {
        validateCheckpointId(request.checkpointId);
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        });
        await assertCheckpointOwnedByBinding(layout.gitDirectory, layout.refName, request.checkpointId);

        const workspacePath = this.pathFor(request);
        await mkdir(dirname(workspacePath), { recursive: true, mode: 0o700 });
        await mkdir(workspacePath, { recursive: false, mode: 0o700 });
        try {
            await extractGitArchive([
                `--git-dir=${layout.gitDirectory}`,
                'archive',
                '--format=tar',
                request.checkpointId,
            ], this.checkpointRoot, workspacePath);
            await assertNoSymlinks(workspacePath);
            await initializeWorkspaceGit(
                workspacePath,
                request.checkpointId,
                request.readOnlyPassthroughPaths ?? [],
            );
            await linkReadOnlyPassthroughs(
                workspacePath,
                request.projectPath,
                request.readOnlyPassthroughPaths ?? [],
            );
            return { path: workspacePath };
        } catch (error) {
            await rm(dirname(workspacePath), { recursive: true, force: true });
            throw error;
        }
    }
}

async function createStableSealedCopy(sourcePath: string, sealedPath: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const temporaryPath = `${sealedPath}.sealing-${randomUUID()}`;
        try {
            const before = await fingerprintTree(sourcePath);
            await cp(sourcePath, temporaryPath, {
                recursive: true,
                force: false,
                errorOnExist: true,
                preserveTimestamps: true,
                verbatimSymlinks: true,
            });
            const [after, sealed] = await Promise.all([
                fingerprintTree(sourcePath),
                fingerprintTree(temporaryPath),
            ]);
            if (before === after && after === sealed) {
                await rename(temporaryPath, sealedPath);
                return;
            }
        } finally {
            await rm(temporaryPath, { recursive: true, force: true });
        }
    }
    throw new Error('checkpoint turn workspace did not become stable before apply');
}

async function fingerprintTree(rootPath: string): Promise<string> {
    const hash = createHash('sha256');
    const visit = async (relativePath: string): Promise<void> => {
        const directoryPath = join(rootPath, relativePath);
        const entries = await readdir(directoryPath, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const entryRelativePath = join(relativePath, entry.name);
            const entryPath = join(rootPath, entryRelativePath);
            const stats = await lstat(entryPath);
            if (stats.isDirectory()) {
                hash.update(JSON.stringify(['directory', entryRelativePath, stats.mode]));
                await visit(entryRelativePath);
            } else if (stats.isFile()) {
                hash.update(JSON.stringify(['file', entryRelativePath, stats.mode, stats.size]));
                for await (const chunk of createReadStream(entryPath)) hash.update(chunk);
            } else if (stats.isSymbolicLink()) {
                hash.update(JSON.stringify(['symlink', entryRelativePath, await readlink(entryPath)]));
            } else {
                throw new Error(`checkpoint turn workspace contains unsupported entry: ${entryRelativePath}`);
            }
        }
    };
    await visit('');
    return hash.digest('hex');
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
    }
}

async function initializeWorkspaceGit(
    workspacePath: string,
    checkpointId: string,
    readOnlyPassthroughPaths: string[],
): Promise<void> {
    const environment: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Saycode Checkpoint',
        GIT_AUTHOR_EMAIL: 'checkpoint@saycode.local',
        GIT_COMMITTER_NAME: 'Saycode Checkpoint',
        GIT_COMMITTER_EMAIL: 'checkpoint@saycode.local',
    };
    await runGitWorkspace(['init', '--quiet'], workspacePath, environment);
    await runGitWorkspace(['symbolic-ref', 'HEAD', 'refs/heads/saycode-checkpoint'], workspacePath, environment);
    await runGitWorkspace(['config', 'core.hooksPath', '.git/saycode-no-hooks'], workspacePath, environment);
    await runGitWorkspace(['config', 'commit.gpgSign', 'false'], workspacePath, environment);
    await runGitWorkspace(['config', 'tag.gpgSign', 'false'], workspacePath, environment);
    await mkdir(join(workspacePath, '.git', 'saycode-no-hooks'), { mode: 0o700 });
    if (readOnlyPassthroughPaths.length > 0) {
        await writeFile(
            join(workspacePath, '.git', 'info', 'exclude'),
            `${readOnlyPassthroughPaths.flatMap((path) => [path, `${path}/`]).join('\n')}\n`,
            { mode: 0o600 },
        );
    }
    await runGitWorkspace(['add', '-A', '--', '.'], workspacePath, environment);
    await runGitWorkspace([
        'commit',
        '--quiet',
        '--allow-empty',
        '--no-gpg-sign',
        '-m',
        `Saycode protected turn baseline ${checkpointId}`,
    ], workspacePath, environment);
}

async function linkReadOnlyPassthroughs(
    workspacePath: string,
    projectPath: string | undefined,
    paths: string[],
): Promise<void> {
    if (paths.length === 0) return;
    if (!projectPath) throw new Error('checkpoint passthrough requires a project path');
    const canonicalProjectPath = await realpath(projectPath);
    for (const path of paths) {
        const sourcePath = await realpath(join(canonicalProjectPath, path));
        const sourceRelativePath = relative(canonicalProjectPath, sourcePath);
        if (
            sourceRelativePath === ''
            || sourceRelativePath === '..'
            || sourceRelativePath.startsWith(`..${sep}`)
            || isAbsolute(sourceRelativePath)
            || !(await lstat(sourcePath)).isDirectory()
        ) {
            throw new Error('checkpoint passthrough escaped the project');
        }
        const targetPath = join(workspacePath, path);
        await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
        await symlink(sourcePath, targetPath, 'dir');
    }
}

function opaqueKey(parts: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function validateCheckpointId(checkpointId: string): void {
    if (!/^[a-f0-9]{40,64}$/.test(checkpointId)) {
        throw new Error('checkpoint turn workspace target is invalid');
    }
}

export async function assertCheckpointOwnedByBinding(
    gitDirectory: string,
    refName: string,
    checkpointId: string,
): Promise<void> {
    const layout = { refName };
    const ownedRefs = await runGitBuffer([
        `--git-dir=${gitDirectory}`,
        'for-each-ref',
        '--format=%(refname)',
        `--points-at=${checkpointId}`,
        checkpointOperationRefPrefix(layout),
        checkpointPinRefPrefix(layout),
    ], gitDirectory);
    if (ownedRefs.toString('utf8').trim().length > 0) return;
    const refs = await runGitBuffer([
        `--git-dir=${gitDirectory}`,
        'for-each-ref',
        '--format=%(refname)',
        `--contains=${checkpointId}`,
        refName,
    ], gitDirectory);
    if (refs.toString('utf8').trim() !== refName) {
        throw new Error('checkpoint turn workspace target does not belong to binding');
    }
}

async function assertNoSymlinks(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const stats = await lstat(path);
        if (stats.isSymbolicLink()) {
            throw new Error('checkpoint turn workspace contains an unsafe symlink');
        }
        if (stats.isDirectory()) await assertNoSymlinks(path);
    }
}

function runGitBuffer(args: string[], cwd: string): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
        execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 }, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
        });
    });
}

function runGitWorkspace(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolvePromise, reject) => {
        execFile('git', args, { cwd, env }, (error, _stdout, stderr) => {
            if (error) {
                reject(new Error(`workspace git ${args[0]} failed: ${stderr.trim()}`));
                return;
            }
            resolvePromise();
        });
    });
}

async function extractGitArchive(args: string[], cwd: string, workspacePath: string): Promise<void> {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
    });
    const exit = new Promise<void>((resolvePromise, reject) => {
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0) resolvePromise();
            else reject(new Error(`git archive failed (${code ?? 'unknown'}): ${stderr.trim()}`));
        });
    });
    try {
        await Promise.all([
            pipeline(child.stdout, tar.x({ cwd: workspacePath, strict: true, preservePaths: false })),
            exit,
        ]);
    } catch (error) {
        child.kill('SIGKILL');
        throw error;
    }
}
