import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const LOCK_REF = 'refs/saycode-checkpoint-store-lock';
const LOCK_RETRY_MS = 100;
const LOCK_ATTEMPTS = 3_000;

type GitResult = {
    stdout: string;
    stderr: string;
    exitCode: number;
};

type LockOwner = {
    pid: number;
    token: string;
};

export async function withCheckpointStoreLock<T>(
    checkpointRoot: string,
    action: () => Promise<T>,
): Promise<T> {
    const gitDirectory = join(resolve(checkpointRoot), 'store');
    const owner = { pid: process.pid, token: randomUUID() };
    let ownerObject = await writeOwnerObject(gitDirectory, owner);

    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
        if (!(await objectExists(gitDirectory, ownerObject))) {
            ownerObject = await writeOwnerObject(gitDirectory, owner);
        }
        const acquired = await runGit(
            ['update-ref', LOCK_REF, ownerObject, ''],
            gitDirectory,
            new Set([0, 1, 128]),
        );
        if (acquired.exitCode === 0) {
            try {
                return await action();
            } finally {
                await runGit(
                    ['update-ref', '-d', LOCK_REF, ownerObject],
                    gitDirectory,
                    new Set([0, 1, 128]),
                );
            }
        }

        await releaseAbandonedLock(gitDirectory);
        if (attempt + 1 < LOCK_ATTEMPTS) await delay(LOCK_RETRY_MS);
    }
    throw new Error('checkpoint store lock timeout');
}

async function objectExists(gitDirectory: string, objectId: string): Promise<boolean> {
    const result = await runGit(
        ['cat-file', '-e', objectId],
        gitDirectory,
        new Set([0, 1, 128]),
    );
    return result.exitCode === 0;
}

async function writeOwnerObject(gitDirectory: string, owner: LockOwner): Promise<string> {
    const locksDirectory = join(gitDirectory, 'checkpoint-locks');
    await mkdir(locksDirectory, { recursive: true, mode: 0o700 });
    const ownerFile = join(locksDirectory, `${owner.token}.json`);
    await writeFile(ownerFile, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    try {
        return (await runGit(['hash-object', '-w', ownerFile], gitDirectory)).stdout.trim();
    } finally {
        await rm(ownerFile, { force: true });
    }
}

async function releaseAbandonedLock(gitDirectory: string): Promise<void> {
    const current = await runGit(
        ['rev-parse', '--verify', LOCK_REF],
        gitDirectory,
        new Set([0, 128]),
    );
    if (current.exitCode !== 0) return;
    const ownerObject = current.stdout.trim();
    const contents = await runGit(
        ['cat-file', 'blob', ownerObject],
        gitDirectory,
        new Set([0, 128]),
    );
    if (contents.exitCode !== 0) return;
    const owner = parseOwner(contents.stdout);
    if (!owner || isProcessRunning(owner.pid)) return;
    await runGit(
        ['update-ref', '-d', LOCK_REF, ownerObject],
        gitDirectory,
        new Set([0, 1, 128]),
    );
}

function parseOwner(value: string): LockOwner | null {
    try {
        const owner = JSON.parse(value) as Partial<LockOwner>;
        if (
            Number.isSafeInteger(owner.pid)
            && (owner.pid ?? 0) > 0
            && typeof owner.token === 'string'
            && /^[0-9a-f-]{36}$/.test(owner.token)
        ) {
            return { pid: owner.pid!, token: owner.token };
        }
    } catch {
        // Invalid owner blobs are retained for fail-closed manual recovery.
    }
    return null;
}

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
    }
}

function runGit(
    args: string[],
    gitDirectory: string,
    allowedExitCodes = new Set([0]),
): Promise<GitResult> {
    const environment = { ...process.env };
    delete environment.GIT_WORK_TREE;
    delete environment.GIT_INDEX_FILE;
    delete environment.GIT_NAMESPACE;
    delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    environment.GIT_DIR = gitDirectory;
    environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    environment.GIT_CONFIG_SYSTEM = process.platform === 'win32' ? 'NUL' : '/dev/null';
    environment.GIT_CONFIG_NOSYSTEM = '1';
    return new Promise((resolvePromise, rejectPromise) => {
        execFile('git', args, {
            cwd: gitDirectory,
            env: environment,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
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

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
