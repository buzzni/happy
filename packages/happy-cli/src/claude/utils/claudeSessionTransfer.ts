import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { validatePath } from '@/modules/common/pathSecurity';
import { getProjectPath } from './path';

export const CLAUDE_SESSION_TRANSFER_CHUNK_MAX_BYTES = 3 * 1024 * 1024;
export const CLAUDE_SESSION_TRANSFER_MAX_BYTES = 512 * 1024 * 1024;
export const CLAUDE_SESSION_TRANSFER_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSFER_TEMP_RE = /^[0-9a-f-]{36}\.jsonl\.aplus-transfer-[0-9a-f-]{36}\.tmp$/i;

export type ClaudeSessionTransferSourceSnapshot = {
    size: number;
    modified: number;
    sha256: string;
};

export function resolveClaudeSessionTransferPath(input: {
    directory: string;
    claudeSessionId: string;
    allowedRoot: string;
}): string {
    if (!UUID_RE.test(input.claudeSessionId)) {
        throw new Error('claudeSessionId must be a valid UUID');
    }
    const validation = validatePath(input.directory, input.allowedRoot);
    if (!validation.valid || !validation.resolvedPath) {
        throw new Error(validation.error ?? 'directory is outside the working directory');
    }
    return join(getProjectPath(validation.resolvedPath), `${input.claudeSessionId}.jsonl`);
}

export function assertValidClaudeSessionChunk(input: {
    offset: number;
    length: number;
    declaredSize: number;
}): void {
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
        throw new Error('Chunk offset must be a non-negative integer');
    }
    if (
        !Number.isSafeInteger(input.length)
        || input.length < 1
        || input.length > CLAUDE_SESSION_TRANSFER_CHUNK_MAX_BYTES
    ) {
        throw new Error(
            `Chunk length must be an integer between 1 and ${CLAUDE_SESSION_TRANSFER_CHUNK_MAX_BYTES} bytes`,
        );
    }
    if (!Number.isSafeInteger(input.declaredSize) || input.declaredSize < 0) {
        throw new Error('Declared size must be a non-negative integer');
    }
    if (input.offset + input.length > input.declaredSize) {
        throw new Error('Chunk exceeds the declared session size');
    }
}

async function sha256File(path: string): Promise<string> {
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(path);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    return hash.digest('hex');
}

function assertUnchangedSource(
    actual: { size: number; mtimeMs: number },
    expected: { expectedSize: number; expectedModified: number },
): void {
    if (actual.size !== expected.expectedSize || actual.mtimeMs !== expected.expectedModified) {
        throw new Error('Claude session source changed during transfer');
    }
}

export async function inspectClaudeSessionTransferSource(input: {
    directory: string;
    claudeSessionId: string;
    allowedRoot: string;
}): Promise<ClaudeSessionTransferSourceSnapshot> {
    const path = resolveClaudeSessionTransferPath(input);
    const before = await stat(path);
    if (!before.isFile()) throw new Error('Claude session source must be a file');
    const sha256 = await sha256File(path);
    const after = await stat(path);
    assertUnchangedSource(after, {
        expectedSize: before.size,
        expectedModified: before.mtimeMs,
    });
    return { size: before.size, modified: before.mtimeMs, sha256 };
}

export async function readClaudeSessionTransferSourceChunk(input: {
    directory: string;
    claudeSessionId: string;
    allowedRoot: string;
    expectedSize: number;
    expectedModified: number;
    offset: number;
    length: number;
}): Promise<{ content: string; bytesRead: number; eof: boolean }> {
    assertValidClaudeSessionChunk({
        offset: input.offset,
        length: input.length,
        declaredSize: input.expectedSize,
    });
    if (!Number.isFinite(input.expectedModified) || input.expectedModified < 0) {
        throw new Error('Expected modified time must be a non-negative number');
    }

    const path = resolveClaudeSessionTransferPath(input);
    assertUnchangedSource(await stat(path), input);
    const file = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(input.length);
        const { bytesRead } = await file.read(buffer, 0, input.length, input.offset);
        assertUnchangedSource(await file.stat(), input);
        return {
            content: buffer.subarray(0, bytesRead).toString('base64'),
            bytesRead,
            eof: input.offset + bytesRead >= input.expectedSize,
        };
    } finally {
        await file.close();
    }
}

type PendingClaudeSessionImport = {
    tempPath: string;
    finalPath: string;
    size: number;
    sha256: string;
    bytesWritten: number;
    cleanupTimer: ReturnType<typeof setTimeout>;
};

function assertValidImportManifest(size: number, sha256: string): void {
    if (!Number.isSafeInteger(size) || size < 1 || size > CLAUDE_SESSION_TRANSFER_MAX_BYTES) {
        throw new Error(
            `Claude session size must be an integer between 1 and ${CLAUDE_SESSION_TRANSFER_MAX_BYTES} bytes`,
        );
    }
    if (!/^[0-9a-f]{64}$/i.test(sha256)) {
        throw new Error('Claude session sha256 must be a 64-character hexadecimal digest');
    }
}

function decodeTransferChunk(content: string): Buffer {
    if (typeof content !== 'string' || content.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) {
        throw new Error('Chunk content must be non-empty base64');
    }
    const buffer = Buffer.from(content, 'base64');
    const normalizedInput = content.replace(/=+$/, '');
    if (buffer.toString('base64').replace(/=+$/, '') !== normalizedInput) {
        throw new Error('Chunk content must be valid base64');
    }
    return buffer;
}

async function removeOrphanedTransferFiles(projectsPath: string): Promise<void> {
    let buckets;
    try {
        buckets = await readdir(projectsPath, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    await Promise.all(buckets.filter((entry) => entry.isDirectory()).map(async (bucket) => {
        const bucketPath = join(projectsPath, bucket.name);
        const entries = await readdir(bucketPath, { withFileTypes: true }).catch(() => []);
        await Promise.all(entries
            .filter((entry) => (
                (entry.isFile() || entry.isSymbolicLink())
                && TRANSFER_TEMP_RE.test(entry.name)
            ))
            .map(async (entry) => {
                const path = join(bucketPath, entry.name);
                const file = await stat(path).catch(() => null);
                if (!file) return;
                const age = Date.now() - file.mtimeMs;
                const remaining = Math.max(0, CLAUDE_SESSION_TRANSFER_PENDING_TTL_MS - age);
                if (remaining === 0) {
                    await rm(path, { force: true });
                    return;
                }
                const timer = setTimeout(() => {
                    void rm(path, { force: true }).catch(() => {});
                }, remaining);
                timer.unref();
            }));
    }));
}

export function createClaudeSessionTransferRuntime(input: { allowedRoot: string }) {
    const pending = new Map<string, PendingClaudeSessionImport>();
    const orphanCleanup = removeOrphanedTransferFiles(dirname(getProjectPath(input.allowedRoot)))
        .catch(() => {});

    const discardPending = async (
        transferId: string,
        transfer: PendingClaudeSessionImport,
    ): Promise<void> => {
        pending.delete(transferId);
        clearTimeout(transfer.cleanupTimer);
        await rm(transfer.tempPath, { force: true });
    };

    return {
        async beginImport(request: {
            directory: string;
            claudeSessionId: string;
            size: number;
            sha256: string;
        }): Promise<{ status: 'ready'; transferId: string } | { status: 'already-present' }> {
            await orphanCleanup;
            assertValidImportManifest(request.size, request.sha256);
            const finalPath = resolveClaudeSessionTransferPath({ ...request, allowedRoot: input.allowedRoot });
            await mkdir(dirname(finalPath), { recursive: true });
            try {
                const existing = await stat(finalPath);
                if (existing.isFile() && existing.size === request.size) {
                    const existingHash = await sha256File(finalPath);
                    if (existingHash === request.sha256.toLowerCase()) {
                        return { status: 'already-present' };
                    }
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            const transferId = randomUUID();
            const tempPath = `${finalPath}.aplus-transfer-${transferId}.tmp`;
            const file = await open(tempPath, 'wx');
            await file.close();
            const cleanupTimer = setTimeout(async () => {
                const abandoned = pending.get(transferId);
                if (!abandoned) return;
                pending.delete(transferId);
                await rm(abandoned.tempPath, { force: true }).catch(() => {});
            }, CLAUDE_SESSION_TRANSFER_PENDING_TTL_MS);
            cleanupTimer.unref();
            pending.set(transferId, {
                tempPath,
                finalPath,
                size: request.size,
                sha256: request.sha256.toLowerCase(),
                bytesWritten: 0,
                cleanupTimer,
            });
            return { status: 'ready', transferId };
        },

        async writeImportChunk(request: {
            transferId: string;
            offset: number;
            content: string;
        }): Promise<{ bytesWritten: number }> {
            const transfer = pending.get(request.transferId);
            if (!transfer) throw new Error('Unknown Claude session transfer');
            if (request.offset !== transfer.bytesWritten) {
                throw new Error(`Chunk offset must match next offset ${transfer.bytesWritten}`);
            }
            const buffer = decodeTransferChunk(request.content);
            assertValidClaudeSessionChunk({
                offset: request.offset,
                length: buffer.length,
                declaredSize: transfer.size,
            });
            const file = await open(transfer.tempPath, 'r+');
            try {
                const result = await file.write(buffer, 0, buffer.length, request.offset);
                if (result.bytesWritten !== buffer.length) {
                    throw new Error('Failed to write the complete Claude session chunk');
                }
            } finally {
                await file.close();
            }
            transfer.bytesWritten += buffer.length;
            return { bytesWritten: transfer.bytesWritten };
        },

        async abortImport(request: { transferId: string }): Promise<{ aborted: boolean }> {
            const transfer = pending.get(request.transferId);
            if (!transfer) return { aborted: false };
            await discardPending(request.transferId, transfer);
            return { aborted: true };
        },

        async commitImport(request: {
            transferId: string;
        }): Promise<{ status: 'imported' | 'already-present' }> {
            const transfer = pending.get(request.transferId);
            if (!transfer) throw new Error('Unknown Claude session transfer');

            const discard = async () => {
                await discardPending(request.transferId, transfer);
            };

            if (transfer.bytesWritten !== transfer.size) {
                await discard();
                throw new Error(
                    `Claude session transfer is incomplete: ${transfer.bytesWritten}/${transfer.size} bytes`,
                );
            }

            const actualHash = await sha256File(transfer.tempPath);
            if (actualHash !== transfer.sha256) {
                await discard();
                throw new Error('Claude session transfer hash mismatch');
            }

            try {
                const existing = await stat(transfer.finalPath);
                if (existing.isFile() && existing.size === transfer.size) {
                    const existingHash = await sha256File(transfer.finalPath);
                    if (existingHash === transfer.sha256) {
                        await discard();
                        return { status: 'already-present' };
                    }
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    await discard();
                    throw error;
                }
            }

            try {
                await rename(transfer.tempPath, transfer.finalPath);
                pending.delete(request.transferId);
                clearTimeout(transfer.cleanupTimer);
                return { status: 'imported' };
            } catch (error) {
                await discard();
                throw error;
            }
        },
    };
}

type ClaudeSessionTransferRequest =
    | { action: 'inspect-source'; directory: string; claudeSessionId: string }
    | {
        action: 'read-source-chunk';
        directory: string;
        claudeSessionId: string;
        expectedSize: number;
        expectedModified: number;
        offset: number;
        length: number;
    }
    | {
        action: 'begin-import';
        directory: string;
        claudeSessionId: string;
        size: number;
        sha256: string;
    }
    | { action: 'write-import-chunk'; transferId: string; offset: number; content: string }
    | { action: 'commit-import'; transferId: string }
    | { action: 'abort-import'; transferId: string };

export type ClaudeSessionTransferResponse =
    | ({ action: 'inspect-source' } & ClaudeSessionTransferSourceSnapshot)
    | { action: 'read-source-chunk'; content: string; bytesRead: number; eof: boolean }
    | { action: 'begin-import'; status: 'ready'; transferId: string }
    | { action: 'begin-import'; status: 'already-present' }
    | { action: 'write-import-chunk'; bytesWritten: number }
    | { action: 'commit-import'; status: 'imported' | 'already-present' }
    | { action: 'abort-import'; aborted: boolean };

export function createClaudeSessionTransferHandler(input: { allowedRoot: string }) {
    const runtime = createClaudeSessionTransferRuntime(input);

    return async (value: unknown): Promise<ClaudeSessionTransferResponse> => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Claude session transfer request must be an object');
        }
        const request = value as ClaudeSessionTransferRequest;
        switch (request.action) {
            case 'inspect-source':
                return {
                    action: request.action,
                    ...await inspectClaudeSessionTransferSource({ ...request, allowedRoot: input.allowedRoot }),
                };
            case 'read-source-chunk':
                return {
                    action: request.action,
                    ...await readClaudeSessionTransferSourceChunk({ ...request, allowedRoot: input.allowedRoot }),
                };
            case 'begin-import':
                return { action: request.action, ...await runtime.beginImport(request) };
            case 'write-import-chunk':
                return { action: request.action, ...await runtime.writeImportChunk(request) };
            case 'commit-import':
                return { action: request.action, ...await runtime.commitImport(request) };
            case 'abort-import':
                return { action: request.action, ...await runtime.abortImport(request) };
            default:
                throw new Error('Unsupported Claude session transfer action');
        }
    };
}
