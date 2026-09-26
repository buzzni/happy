/** Project-scoped read hardening. This is not an OS sandbox against a hostile
 * process continually changing the filesystem: Node has no portable openat API.
 * Reject links, validate real paths, and withhold results if path identity changes.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

function denied(): Error & { code: string } {
    return Object.assign(new Error('Workspace path is outside the project, linked, or changed during reading'), { code: 'WORKSPACE_PATH_DENIED' });
}

function within(root: string, path: string): boolean {
    const suffix = relative(root, path);
    return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

function validPath(value: string): boolean {
    return typeof value === 'string' && isAbsolute(value) && !value.includes('\0')
        && !(process.platform === 'win32' && (value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\') || value.slice(2).includes(':')));
}

export async function captureWorkspacePath(allowedRoot: string, workspaceRoot: string, target: string) {
    if (![allowedRoot, workspaceRoot, target].every(validPath)) throw denied();
    const allowed = resolve(allowedRoot);
    const root = resolve(workspaceRoot);
    const path = resolve(target);
    if (!within(allowed, root) || !within(root, path)) throw denied();
    // The machine boundary is the trusted anchor; allow platform aliases such
    // as macOS /tmp, but never accept a link at the project root or below it.
    const realAllowed = await realpath(allowed);
    const parts = relative(allowed, path).split(sep).filter(Boolean);
    if (parts.length > 128) throw denied();
    const paths = [allowed];
    for (const part of parts) paths.push(join(paths[paths.length - 1], part));
    const snapshots = await Promise.all(paths.map(async (entry, index) => {
        const info = await lstat(entry, { bigint: true });
        if (info.isSymbolicLink() && (index > 0 || entry === root)) throw denied();
        if (entry !== path && !info.isDirectory() && !info.isSymbolicLink()) throw denied();
        return { path: entry, info };
    }));
    const realRoot = await realpath(root);
    const realTarget = await realpath(path);
    if (!within(realAllowed, realRoot) || !within(realRoot, realTarget)) throw denied();
    const verify = async () => {
        for (const snapshot of snapshots) {
            const current = await lstat(snapshot.path, { bigint: true });
            if (current.dev !== snapshot.info.dev || current.ino !== snapshot.info.ino
                || current.ctimeNs !== snapshot.info.ctimeNs || current.mtimeNs !== snapshot.info.mtimeNs) throw denied();
        }
        if (await realpath(root) !== realRoot || await realpath(path) !== realTarget) throw denied();
    };
    await verify();
    return { path, info: snapshots[snapshots.length - 1].info, verify };
}

export async function listWorkspaceDirectory(allowedRoot: string, workspaceRoot: string, path: string) {
    const snapshot = await captureWorkspacePath(allowedRoot, workspaceRoot, path);
    if (!snapshot.info.isDirectory()) throw denied();
    const names = await readdir(snapshot.path);
    if (names.length > 10_000) throw Object.assign(new Error('Workspace listing limit exceeded'), { code: 'WORKSPACE_LIMIT' });
    const entries = [];
    for (const name of names) {
        // lstat never follows an entry link, including Windows junctions.
        const info = await lstat(join(snapshot.path, name));
        entries.push({ name, type: info.isSymbolicLink() ? 'other' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size, modified: info.mtimeMs });
    }
    await snapshot.verify();
    return entries;
}

export async function readWorkspaceFile(allowedRoot: string, workspaceRoot: string, path: string): Promise<Buffer> {
    const snapshot = await captureWorkspacePath(allowedRoot, workspaceRoot, path);
    if (!snapshot.info.isFile()) throw denied();
    const handle = await open(snapshot.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
        const info = await handle.stat({ bigint: true });
        if (info.dev !== snapshot.info.dev || info.ino !== snapshot.info.ino || !info.isFile()) throw denied();
        if (info.size > 8n * 1024n * 1024n) throw Object.assign(new Error('Workspace file limit exceeded'), { code: 'WORKSPACE_LIMIT' });
        const buffer = Buffer.alloc(Number(info.size) + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (BigInt(length) !== info.size) throw denied();
        await snapshot.verify();
        return buffer.subarray(0, length);
    } finally { await handle.close(); }
}
