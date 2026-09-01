import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { validatePath } from '@/modules/common/pathSecurity';

export const CODEX_THREAD_TRANSFER_CHUNK_MAX_BYTES = 3 * 1024 * 1024;
export const CODEX_THREAD_TRANSFER_MAX_BYTES = 512 * 1024 * 1024;
export const CODEX_THREAD_TRANSFER_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSFER_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.aplus-codex-transfer-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i;

type SourceSnapshot = {
    path: string;
    size: number;
    modified: number;
    sha256: string;
};

type PendingImport = {
    directory: string;
    tempPath: string;
    receiptPath: string;
    sourceCodexThreadId: string;
    requestId: string;
    size: number;
    sha256: string;
    bytesWritten: number;
    writeChain: Promise<void>;
    cleanupTimer: ReturnType<typeof setTimeout>;
};

type CodexThreadTransferDeps = {
    allowedRoot: string;
    codexHome: string;
    readThreadPath: (threadId: string) => Promise<string>;
    forkThreadFromPath: (input: { path: string; cwd: string }) => Promise<{ threadId: string }>;
};

function assertSafeThreadId(threadId: string): void {
    if (!threadId || threadId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(threadId)) {
        throw new Error('codexThreadId must contain safe identifier characters only');
    }
}

function assertTransferSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 1 || size > CODEX_THREAD_TRANSFER_MAX_BYTES) {
        throw new Error(
            `Codex thread size must be an integer between 1 and ${CODEX_THREAD_TRANSFER_MAX_BYTES} bytes`,
        );
    }
}

function assertChunk(input: { offset: number; length: number; declaredSize: number }): void {
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
        throw new Error('Chunk offset must be a non-negative integer');
    }
    if (
        !Number.isSafeInteger(input.length)
        || input.length < 1
        || input.length > CODEX_THREAD_TRANSFER_CHUNK_MAX_BYTES
    ) {
        throw new Error(
            `Chunk length must be an integer between 1 and ${CODEX_THREAD_TRANSFER_CHUNK_MAX_BYTES} bytes`,
        );
    }
    if (input.offset + input.length > input.declaredSize) {
        throw new Error('Chunk exceeds the declared Codex thread size');
    }
}

function decodeChunk(content: string): Buffer {
    if (!content || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) {
        throw new Error('Chunk content must be non-empty base64');
    }
    const decoded = Buffer.from(content, 'base64');
    if (decoded.toString('base64').replace(/=+$/, '') !== content.replace(/=+$/, '')) {
        throw new Error('Chunk content must be valid base64');
    }
    return decoded;
}

async function sha256File(path: string): Promise<string> {
    const hash = createHash('sha256');
    await new Promise<void>((resolveHash, reject) => {
        const stream = createReadStream(path);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolveHash);
    });
    return hash.digest('hex');
}

function isInside(path: string, parent: string): boolean {
    const rel = relative(parent, path);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function isErrno(error: unknown, code: string): boolean {
    return (error as NodeJS.ErrnoException)?.code === code;
}

async function ensureTransferDirectory(input: {
    directory: string;
    allowedRoot: string;
}): Promise<string> {
    const [canonicalTarget, canonicalAllowedRoot] = await Promise.all([
        realpath(input.directory),
        realpath(input.allowedRoot),
    ]);
    if (!isInside(canonicalTarget, canonicalAllowedRoot)) {
        throw new Error('directory is outside the working directory');
    }
    let parent = canonicalTarget;
    for (const name of ['.aplus', 'native-session-transfers']) {
        const next = join(parent, name);
        try {
            await mkdir(next);
        } catch (error) {
            if (!isErrno(error, 'EEXIST')) throw error;
        }
        const entry = await lstat(next);
        if (entry.isSymbolicLink()) {
            throw new Error(`Codex thread transfer directory '${name}' must not be a symbolic link`);
        }
        if (!entry.isDirectory()) {
            throw new Error(`Codex thread transfer directory '${name}' must be a directory`);
        }
        const canonicalNext = await realpath(next);
        if (!isInside(canonicalNext, canonicalTarget)) {
            throw new Error(`Codex thread transfer directory '${name}' is outside the target directory`);
        }
        parent = canonicalNext;
    }
    return parent;
}

async function inspectRollout(input: {
    codexThreadId: string;
    codexHome: string;
    readThreadPath: CodexThreadTransferDeps['readThreadPath'];
}): Promise<SourceSnapshot> {
    assertSafeThreadId(input.codexThreadId);
    const reportedPath = await input.readThreadPath(input.codexThreadId);
    const fileEntry = await lstat(reportedPath);
    if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) {
        throw new Error('Codex thread source must be a regular file');
    }
    const [canonicalPath, canonicalSessionsRoot] = await Promise.all([
        realpath(reportedPath),
        realpath(join(input.codexHome, 'sessions')),
    ]);
    if (!isInside(canonicalPath, canonicalSessionsRoot)) {
        throw new Error('Codex thread source is outside the native sessions directory');
    }
    const before = await stat(canonicalPath);
    assertTransferSize(before.size);
    const sha256 = await sha256File(canonicalPath);
    const after = await stat(canonicalPath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error('Codex thread source changed during transfer');
    }
    return {
        path: canonicalPath,
        size: before.size,
        modified: before.mtimeMs,
        sha256,
    };
}

export function createCodexThreadTransferRuntime(deps: CodexThreadTransferDeps) {
    const pending = new Map<string, PendingImport>();
    const pendingRequestIds = new Set<string>();
    const sourceSnapshots = new Map<string, SourceSnapshot>();
    const stagingCleanup = new Map<string, Promise<void>>();

    const removeOrphanedTransferFiles = async (stagingDir: string): Promise<void> => {
        const existing = stagingCleanup.get(stagingDir);
        if (existing) return existing;
        const cleanup = (async () => {
            const entries = await readdir(stagingDir, { withFileTypes: true });
            await Promise.all(entries.map(async (entry) => {
                if (!TRANSFER_FILE_RE.test(entry.name)) return;
                const path = join(stagingDir, entry.name);
                if (entry.isSymbolicLink()) {
                    await rm(path, { force: true });
                    return;
                }
                if (!entry.isFile()) return;
                let file;
                try {
                    file = await lstat(path);
                } catch (error) {
                    if (isErrno(error, 'ENOENT')) return;
                    throw error;
                }
                const remainingTtl = file.mtimeMs
                    + CODEX_THREAD_TRANSFER_PENDING_TTL_MS
                    - Date.now();
                if (remainingTtl <= 0) {
                    await rm(path, { force: true });
                    return;
                }
                const timer = setTimeout(() => {
                    void rm(path, { force: true }).catch((error) => {
                        console.warn('[codex-thread-transfer] orphan cleanup failed', error);
                    });
                }, remainingTtl);
                timer.unref();
            }));
        })();
        stagingCleanup.set(stagingDir, cleanup);
        try {
            await cleanup;
        } catch (error) {
            stagingCleanup.delete(stagingDir);
            throw error;
        }
    };

    const discard = async (transferId: string, transfer: PendingImport): Promise<void> => {
        pending.delete(transferId);
        pendingRequestIds.delete(transfer.requestId);
        clearTimeout(transfer.cleanupTimer);
        await transfer.writeChain;
        await rm(transfer.tempPath, { force: true });
    };

    return {
        async inspectSource(input: { codexThreadId: string }) {
            const snapshot = await inspectRollout({ ...input, ...deps });
            sourceSnapshots.set(input.codexThreadId, snapshot);
            return {
                size: snapshot.size,
                modified: snapshot.modified,
                sha256: snapshot.sha256,
            };
        },

        async readSourceChunk(input: {
            codexThreadId: string;
            expectedSize: number;
            expectedModified: number;
            offset: number;
            length: number;
        }) {
            assertChunk({
                offset: input.offset,
                length: input.length,
                declaredSize: input.expectedSize,
            });
            assertSafeThreadId(input.codexThreadId);
            const snapshot = sourceSnapshots.get(input.codexThreadId);
            if (!snapshot) throw new Error('Codex thread source must be inspected before reading');
            if (snapshot.size !== input.expectedSize || snapshot.modified !== input.expectedModified) {
                throw new Error('Codex thread source changed during transfer');
            }
            const before = await lstat(snapshot.path);
            if (
                !before.isFile()
                || before.isSymbolicLink()
                || before.size !== snapshot.size
                || before.mtimeMs !== snapshot.modified
                || await realpath(snapshot.path) !== snapshot.path
            ) {
                throw new Error('Codex thread source changed during transfer');
            }
            const file = await open(snapshot.path, 'r');
            try {
                const buffer = Buffer.alloc(input.length);
                const { bytesRead } = await file.read(buffer, 0, input.length, input.offset);
                const after = await file.stat();
                if (after.size !== snapshot.size || after.mtimeMs !== snapshot.modified) {
                    throw new Error('Codex thread source changed during transfer');
                }
                return {
                    content: buffer.subarray(0, bytesRead).toString('base64'),
                    bytesRead,
                    eof: input.offset + bytesRead >= input.expectedSize,
                };
            } finally {
                await file.close();
            }
        },

        async beginImport(input: {
            directory: string;
            sourceCodexThreadId: string;
            requestId: string;
            size: number;
            sha256: string;
        }): Promise<
            | { status: 'ready'; transferId: string }
            | { status: 'already-present'; newCodexThreadId: string }
        > {
            assertSafeThreadId(input.sourceCodexThreadId);
            assertTransferSize(input.size);
            if (!REQUEST_ID_RE.test(input.requestId)) {
                throw new Error('Codex thread import requestId must be a valid UUID');
            }
            if (!/^[0-9a-f]{64}$/i.test(input.sha256)) {
                throw new Error('Codex thread sha256 must be a 64-character hexadecimal digest');
            }
            const validation = validatePath(input.directory, deps.allowedRoot);
            if (!validation.valid || !validation.resolvedPath) {
                throw new Error(validation.error ?? 'directory is outside the working directory');
            }
            const stagingDir = await ensureTransferDirectory({
                directory: validation.resolvedPath,
                allowedRoot: deps.allowedRoot,
            });
            await removeOrphanedTransferFiles(stagingDir);
            const receiptPath = join(stagingDir, `${input.requestId}.receipt.json`);
            try {
                const receiptEntry = await lstat(receiptPath);
                if (!receiptEntry.isFile() || receiptEntry.isSymbolicLink()) {
                    throw new Error('Codex thread import receipt must be a regular file');
                }
                const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
                    sourceCodexThreadId?: unknown;
                    sha256?: unknown;
                    newCodexThreadId?: unknown;
                };
                if (
                    receipt.sourceCodexThreadId !== input.sourceCodexThreadId
                    || receipt.sha256 !== input.sha256.toLowerCase()
                    || typeof receipt.newCodexThreadId !== 'string'
                    || receipt.newCodexThreadId.length === 0
                ) {
                    throw new Error('Codex thread import request conflicts with an existing receipt');
                }
                return {
                    status: 'already-present',
                    newCodexThreadId: receipt.newCodexThreadId,
                };
            } catch (error) {
                if (!isErrno(error, 'ENOENT')) throw error;
            }
            if (pendingRequestIds.has(input.requestId)) {
                throw new Error('Codex thread import request is already in progress');
            }
            pendingRequestIds.add(input.requestId);
            const transferId = randomUUID();
            const tempPath = join(stagingDir, `${input.requestId}.aplus-codex-transfer-${transferId}.jsonl`);
            try {
                const file = await open(tempPath, 'wx');
                await file.close();
            } catch (error) {
                pendingRequestIds.delete(input.requestId);
                throw error;
            }
            const cleanupTimer = setTimeout(() => {
                const transfer = pending.get(transferId);
                if (transfer) void discard(transferId, transfer).catch(() => {});
            }, CODEX_THREAD_TRANSFER_PENDING_TTL_MS);
            cleanupTimer.unref();
            pending.set(transferId, {
                directory: validation.resolvedPath,
                tempPath,
                receiptPath,
                sourceCodexThreadId: input.sourceCodexThreadId,
                requestId: input.requestId,
                size: input.size,
                sha256: input.sha256.toLowerCase(),
                bytesWritten: 0,
                writeChain: Promise.resolve(),
                cleanupTimer,
            });
            return { status: 'ready', transferId };
        },

        async writeImportChunk(input: { transferId: string; offset: number; content: string }) {
            const transfer = pending.get(input.transferId);
            if (!transfer) throw new Error('Unknown Codex thread transfer');
            const previousWrite = transfer.writeChain;
            let releaseWrite!: () => void;
            transfer.writeChain = new Promise<void>((resolve) => {
                releaseWrite = resolve;
            });
            await previousWrite;
            try {
                if (pending.get(input.transferId) !== transfer) {
                    throw new Error('Unknown Codex thread transfer');
                }
                if (input.offset !== transfer.bytesWritten) {
                    throw new Error(`Chunk offset must match next offset ${transfer.bytesWritten}`);
                }
                const buffer = decodeChunk(input.content);
                assertChunk({ offset: input.offset, length: buffer.length, declaredSize: transfer.size });
                const file = await open(transfer.tempPath, 'r+');
                try {
                    const written = await file.write(buffer, 0, buffer.length, input.offset);
                    if (written.bytesWritten !== buffer.length) {
                        throw new Error('Failed to write the complete Codex thread chunk');
                    }
                } finally {
                    await file.close();
                }
                transfer.bytesWritten += buffer.length;
                return { bytesWritten: transfer.bytesWritten };
            } finally {
                releaseWrite();
            }
        },

        async abortImport(input: { transferId: string }) {
            const transfer = pending.get(input.transferId);
            if (!transfer) return { aborted: false };
            await discard(input.transferId, transfer);
            return { aborted: true };
        },

        async commitImport(input: { transferId: string }) {
            const transfer = pending.get(input.transferId);
            if (!transfer) throw new Error('Unknown Codex thread transfer');
            if (transfer.bytesWritten !== transfer.size) {
                await discard(input.transferId, transfer);
                throw new Error(
                    `Codex thread transfer is incomplete: ${transfer.bytesWritten}/${transfer.size} bytes`,
                );
            }
            if (await sha256File(transfer.tempPath) !== transfer.sha256) {
                await discard(input.transferId, transfer);
                throw new Error('Codex thread transfer hash mismatch');
            }
            try {
                const forked = await deps.forkThreadFromPath({
                    path: transfer.tempPath,
                    cwd: transfer.directory,
                });
                const receiptTempPath = `${transfer.receiptPath}.${randomUUID()}.tmp`;
                const receiptFile = await open(receiptTempPath, 'wx');
                try {
                    await receiptFile.writeFile(JSON.stringify({
                        version: 1,
                        sourceCodexThreadId: transfer.sourceCodexThreadId,
                        sha256: transfer.sha256,
                        newCodexThreadId: forked.threadId,
                    }));
                } finally {
                    await receiptFile.close();
                }
                await rename(receiptTempPath, transfer.receiptPath);
                return { status: 'imported' as const, newCodexThreadId: forked.threadId };
            } finally {
                await discard(input.transferId, transfer);
            }
        },
    };
}

type CodexThreadTransferRequest =
    | { action: 'inspect-source'; codexThreadId: string }
    | {
        action: 'read-source-chunk';
        codexThreadId: string;
        expectedSize: number;
        expectedModified: number;
        offset: number;
        length: number;
    }
    | {
        action: 'begin-import';
        directory: string;
        sourceCodexThreadId: string;
        requestId: string;
        size: number;
        sha256: string;
    }
    | { action: 'write-import-chunk'; transferId: string; offset: number; content: string }
    | { action: 'abort-import'; transferId: string }
    | { action: 'commit-import'; transferId: string };

export function createCodexThreadTransferHandler(deps: CodexThreadTransferDeps) {
    const runtime = createCodexThreadTransferRuntime(deps);
    return async (value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Codex thread transfer request must be an object');
        }
        const request = value as CodexThreadTransferRequest;
        switch (request.action) {
            case 'inspect-source':
                return { action: request.action, ...await runtime.inspectSource(request) };
            case 'read-source-chunk':
                return { action: request.action, ...await runtime.readSourceChunk(request) };
            case 'begin-import':
                return { action: request.action, ...await runtime.beginImport(request) };
            case 'write-import-chunk':
                return { action: request.action, ...await runtime.writeImportChunk(request) };
            case 'abort-import':
                return { action: request.action, ...await runtime.abortImport(request) };
            case 'commit-import':
                return { action: request.action, ...await runtime.commitImport(request) };
            default:
                throw new Error('Unsupported Codex thread transfer action');
        }
    };
}
