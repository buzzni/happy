/** Project-scoped read and create-only write hardening. This is not an OS sandbox
 * against a hostile process continually changing the filesystem: Node has no
 * portable openat API. Reject links, validate real paths, and withhold results
 * (or report failure after a write) if path identity changes.
 */
import { constants, type BigIntStats, type Dir, type Dirent } from 'node:fs';
import { lstat, mkdir, open, opendir, readdir, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function denied(): Error & { code: string } {
    return Object.assign(new Error('Workspace path is outside the project, linked, or changed during reading'), { code: 'WORKSPACE_PATH_DENIED' });
}

function errorCode(error: unknown): unknown {
    return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
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
    return { path, info: snapshots[snapshots.length - 1].info, verify, snapshots, realPath: realTarget };
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

function pathIdentity(info: BigIntStats): string {
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/** At most 32 open iterators, one lookahead entry each; abandoned cursors expire after two minutes. */
export function createWorkspaceDownloadDirectoryReader(openDirectory: (path: string) => Promise<Dir> = opendir, now: () => number = Date.now) {
    type Listing = {
        allowedRoot: string; workspaceRoot: string; path: string;
        snapshot: Awaited<ReturnType<typeof captureWorkspacePath>>; directory: Dir;
        offset: number; pending?: Dirent | null; lastUsed: number; busy: boolean; cancelled: boolean; closing?: Promise<void>;
    };
    const listings = new Map<string, Listing>();
    let opening = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stopTimer = () => { if (!listings.size && !opening && timer) { clearInterval(timer); timer = undefined; } };
    const remove = async (id: string) => {
        const listing = listings.get(id);
        if (!listing) return;
        // Retain the slot while close is pending, including overlapping cleanup calls.
        const closing = listing.closing ??= listing.directory.close();
        try { await closing; }
        catch (error) {
            listing.closing = undefined;
            if (errorCode(error) !== 'ERR_DIR_CLOSED') throw error;
        }
        listings.delete(id);
        stopTimer();
    };
    const expire = async () => {
        for (const [id, listing] of listings) {
            if (!listing.busy && now() - listing.lastUsed >= 120_000) await remove(id);
        }
    };
    const matches = (listing: Listing, allowedRoot: string, workspaceRoot: string, path: string) => (
        [allowedRoot, workspaceRoot, path].every(validPath) && listing.allowedRoot === resolve(allowedRoot)
        && listing.workspaceRoot === resolve(workspaceRoot) && listing.path === resolve(path)
    );
    return {
        async list(allowedRoot: string, workspaceRoot: string, path: string, offset: number, expectedIdentity?: string, listingId?: string) {
            if (!Number.isSafeInteger(offset) || offset < 0) throw denied();
            await expire();
            if (listingId === undefined) {
                if (offset !== 0) throw denied();
                if (listings.size + opening >= 32) throw Object.assign(new Error('Too many active workspace listings'), { code: 'WORKSPACE_LISTING_BUSY' });
                opening++;
                try {
                    const snapshot = await captureWorkspacePath(allowedRoot, workspaceRoot, path);
                    if (!snapshot.info.isDirectory()) throw denied();
                    const directory = await openDirectory(snapshot.path);
                    listingId = randomUUID();
                    listings.set(listingId, { allowedRoot: resolve(allowedRoot), workspaceRoot: resolve(workspaceRoot), path: resolve(path), snapshot, directory, offset: 0, lastUsed: now(), busy: false, cancelled: false });
                    if (!timer) timer = setInterval(() => { void expire().catch(error => console.warn('Workspace listing expiry failed', error)); }, 10_000).unref();
                } finally { opening--; stopTimer(); }
            }
            const listing = listings.get(listingId);
            if (!listing || listing.busy || listing.closing || !matches(listing, allowedRoot, workspaceRoot, path) || listing.offset !== offset) throw denied();
            listing.busy = true;
            try {
                const identity = pathIdentity(listing.snapshot.info);
                if (listing.cancelled || (expectedIdentity !== undefined && expectedIdentity !== identity)) throw denied();
                await listing.snapshot.verify();
                const entries = [];
                let ended = false;
                while (entries.length < 1000) {
                    if (listing.cancelled) throw denied();
                    const entry = listing.pending === undefined ? await listing.directory.read() : listing.pending;
                    listing.pending = undefined;
                    if (!entry) { ended = true; break; }
                    // Keep denied stats for the client's subtree/ignore filtering; never drop an entry.
                    const info = await lstat(join(listing.path, entry.name)).catch(() => undefined);
                    const kind = info ?? entry;
                    entries.push({ name: entry.name, type: kind.isSymbolicLink() ? 'other' : kind.isDirectory() ? 'directory' : kind.isFile() ? 'file' : 'other', size: info?.size, modified: info?.mtimeMs });
                }
                if (!ended) listing.pending = await listing.directory.read();
                if (listing.cancelled) throw denied();
                await listing.snapshot.verify();
                listing.offset += entries.length;
                listing.lastUsed = now();
                const done = ended || listing.pending === null;
                if (done) await remove(listingId);
                return { entries, identity, listingId, nextOffset: done ? null : listing.offset };
            } catch (error) {
                try { await remove(listingId); } catch (cleanupError) { console.warn('Workspace listing cleanup failed', cleanupError); }
                throw error;
            } finally { listing.busy = false; }
        },
        async close(allowedRoot: string, workspaceRoot: string, path: string, listingId: string) {
            const listing = listings.get(listingId);
            if (!listing) return;
            if (!matches(listing, allowedRoot, workspaceRoot, path)) throw denied();
            if (listing.busy) listing.cancelled = true;
            else await remove(listingId);
        },
        async dispose() {
            for (const [id, listing] of listings) {
                if (listing.busy) listing.cancelled = true;
                else await remove(id);
            }
        },
    };
}

/** Each range verifies both the path and opened descriptor, including across requests. */
export async function readWorkspaceFileChunk(allowedRoot: string, workspaceRoot: string, path: string, offset: number, length: number, expectedIdentity?: string) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 3 * 1024 * 1024) {
        throw Object.assign(new Error('Invalid workspace chunk range'), { code: 'WORKSPACE_RANGE_INVALID' });
    }
    const snapshot = await captureWorkspacePath(allowedRoot, workspaceRoot, path);
    if (!snapshot.info.isFile()) throw denied();
    const file = await open(snapshot.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
        const info = await file.stat({ bigint: true });
        const identity = pathIdentity(info);
        if (!info.isFile() || identity !== pathIdentity(snapshot.info) || (expectedIdentity !== undefined && identity !== expectedIdentity)) throw denied();
        if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw Object.assign(new Error('Workspace file size is not representable'), { code: 'WORKSPACE_LIMIT' });
        const size = Number(info.size);
        const buffer = Buffer.alloc(Math.min(length, Math.max(0, size - offset)));
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead);
            if (!result.bytesRead) break;
            bytesRead += result.bytesRead;
        }
        if (pathIdentity(await file.stat({ bigint: true })) !== identity) throw denied();
        await snapshot.verify();
        return { content: buffer.subarray(0, bytesRead).toString('base64'), offset, bytesRead, totalBytes: size, modified: Number(info.mtimeNs) / 1e6, eof: offset + bytesRead >= size, identity };
    } finally { await file.close(); }
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

/** Creates a new file inside the project, never overwriting and never writing
 * through a link (aplus-dev-studio#5176). The deepest existing ancestor is
 * captured like a read; each missing directory is created alone and checked
 * before descending; the file itself is opened O_EXCL|O_NOFOLLOW. Afterwards
 * the identity (dev/ino) of every ancestor is re-checked. Directory times are
 * not, because creating the children changes them, so this is the read
 * boundary's "detect, then fail" guarantee rather than an atomic one.
 */
export async function writeWorkspaceFile(allowedRoot: string, workspaceRoot: string, target: string, content: Buffer): Promise<void> {
    if (![allowedRoot, workspaceRoot, target].every(validPath)) throw denied();
    const root = resolve(workspaceRoot);
    const path = resolve(target);
    const allowed = resolve(allowedRoot);
    // Bound the root before probing anything, so lstat errors never describe paths outside it.
    if (!within(allowed, root) || relative(root, path) === '' || !within(root, path)) throw denied();
    if (relative(allowed, path).split(sep).length > 128) throw denied();
    const missing: string[] = [];
    let ancestor = dirname(path);
    // relative(), not string equality: Windows compares paths case-insensitively.
    while (relative(root, ancestor) !== '') {
        try {
            await lstat(ancestor);
            break;
        } catch (error) {
            if (errorCode(error) === 'ENOTDIR') throw denied();
            if (errorCode(error) !== 'ENOENT') throw error;
        }
        missing.unshift(basename(ancestor));
        ancestor = dirname(ancestor);
    }
    const snapshot = await captureWorkspacePath(allowedRoot, workspaceRoot, ancestor);
    if (!snapshot.info.isDirectory()) throw denied();
    const created: Array<{ path: string; info: BigIntStats }> = [];
    let directory = snapshot.path;
    for (const part of missing) {
        directory = join(directory, part);
        try {
            await mkdir(directory);
        } catch (error) {
            if (errorCode(error) !== 'EEXIST') throw error;
        }
        // Whoever created it, it must be a real directory before anything goes inside.
        const info = await lstat(directory, { bigint: true });
        if (info.isSymbolicLink() || !info.isDirectory()) throw denied();
        created.push({ path: directory, info });
    }
    // Only an existing regular file is "already exists"; anything else at the leaf is refused.
    const refuseExisting = async (): Promise<never> => {
        const existing = await lstat(path).catch(() => undefined);
        if (!existing?.isFile()) throw denied();
        throw Object.assign(new Error('Workspace file already exists'), { code: 'EEXIST' });
    };
    // Windows has no O_NOFOLLOW and CREATE_NEW follows a dangling link to create
    // its target, so refuse anything already at the leaf before opening.
    if (!constants.O_NOFOLLOW) {
        let present = true;
        try {
            await lstat(path);
        } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
            present = false;
        }
        if (present) return await refuseExisting();
    }
    let handle;
    try {
        handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0));
    } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        // O_EXCL also refuses a link at the leaf, dangling or not.
        return await refuseExisting();
    }
    let opened: BigIntStats;
    try {
        opened = await handle.stat({ bigint: true });
    } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        throw error;
    }
    try {
        await handle.writeFile(content);
        await handle.close();
    } catch (error) {
        await handle.close().catch(() => undefined);
        // A short write must not survive as a file the next create-only attempt
        // would report as already existing. Remove it only while it is still ours.
        const current = await lstat(path, { bigint: true }).catch(() => undefined);
        if (current && current.dev === opened.dev && current.ino === opened.ino) await unlink(path).catch(() => undefined);
        throw error;
    }
    const written = await lstat(path, { bigint: true });
    if (!written.isFile() || written.dev !== opened.dev || written.ino !== opened.ino) throw denied();
    for (const entry of [...snapshot.snapshots, ...created]) {
        const current = await lstat(entry.path, { bigint: true });
        if (current.dev !== entry.info.dev || current.ino !== entry.info.ino) throw denied();
    }
    if (!within(snapshot.realPath, await realpath(path))) throw denied();
}
