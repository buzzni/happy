import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    CLAUDE_SESSION_TRANSFER_CHUNK_MAX_BYTES,
    CLAUDE_SESSION_TRANSFER_MAX_BYTES,
    CLAUDE_SESSION_TRANSFER_PENDING_TTL_MS,
    assertValidClaudeSessionChunk,
    createClaudeSessionTransferHandler,
    createClaudeSessionTransferRuntime,
    inspectClaudeSessionTransferSource,
    readClaudeSessionTransferSourceChunk,
    resolveClaudeSessionTransferPath,
} from './claudeSessionTransfer';

const SESSION_ID = '93a9705e-bc6a-406d-8dce-8acc014dedbd';

describe('Claude session transfer input validation', () => {
    let root: string;
    let projectDirectory: string;
    let previousClaudeConfigDir: string | undefined;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'happy-claude-transfer-'));
        projectDirectory = join(root, 'workspace', 'project');
        await mkdir(projectDirectory, { recursive: true });
        previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = join(root, '.claude');
    });

    afterEach(async () => {
        vi.useRealTimers();
        if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
        await rm(root, { recursive: true, force: true });
    });

    it('derives the JSONL path from an allowed cwd and UUID instead of accepting a raw Claude path', () => {
        const path = resolveClaudeSessionTransferPath({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        });

        expect(path).toBe(join(
            root,
            '.claude',
            'projects',
            projectDirectory.replace(/[^a-zA-Z0-9-]/g, '-'),
            `${SESSION_ID}.jsonl`,
        ));
    });

    it('rejects a cwd outside the daemon allowed root', () => {
        expect(() => resolveClaudeSessionTransferPath({
            directory: join(root, '..', 'outside'),
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        })).toThrow('outside the working directory');
    });

    it('rejects a non-UUID native session id', () => {
        expect(() => resolveClaudeSessionTransferPath({
            directory: projectDirectory,
            claudeSessionId: '../../.credentials',
            allowedRoot: root,
        })).toThrow('valid UUID');
    });

    it.each([
        { offset: -1, length: 1, declaredSize: 10 },
        { offset: 0.5, length: 1, declaredSize: 10 },
        { offset: 0, length: 0, declaredSize: 10 },
        { offset: 0, length: CLAUDE_SESSION_TRANSFER_CHUNK_MAX_BYTES + 1, declaredSize: 10 },
        { offset: 8, length: 3, declaredSize: 10 },
    ])('rejects invalid chunk bounds %#', (input) => {
        expect(() => assertValidClaudeSessionChunk(input)).toThrow();
    });

    it('inspects and reads a stable source JSONL in bounded chunks', async () => {
        const path = resolveClaudeSessionTransferPath({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        });
        const content = Buffer.from('{"type":"user"}\n{"type":"assistant"}\n');
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);

        const snapshot = await inspectClaudeSessionTransferSource({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        });

        expect(snapshot).toMatchObject({
            size: content.length,
            sha256: createHash('sha256').update(content).digest('hex'),
        });

        const first = await readClaudeSessionTransferSourceChunk({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
            expectedSize: snapshot.size,
            expectedModified: snapshot.modified,
            offset: 0,
            length: 7,
        });
        const second = await readClaudeSessionTransferSourceChunk({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
            expectedSize: snapshot.size,
            expectedModified: snapshot.modified,
            offset: first.bytesRead,
            length: snapshot.size - first.bytesRead,
        });

        expect(Buffer.concat([
            Buffer.from(first.content, 'base64'),
            Buffer.from(second.content, 'base64'),
        ])).toEqual(content);
        expect(first.eof).toBe(false);
        expect(second.eof).toBe(true);
    });

    it('rejects an oversized source before hashing it', async () => {
        const path = resolveClaudeSessionTransferPath({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        });
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, 'seed');
        await truncate(path, CLAUDE_SESSION_TRANSFER_MAX_BYTES + 1);

        await expect(inspectClaudeSessionTransferSource({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        })).rejects.toThrow('session size');
    });

    it('rejects a source that changed after inspection', async () => {
        const path = resolveClaudeSessionTransferPath({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        });
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, '{"type":"user"}\n');
        const snapshot = await inspectClaudeSessionTransferSource({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        });
        await appendFile(path, '{"type":"assistant"}\n');

        await expect(readClaudeSessionTransferSourceChunk({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
            expectedSize: snapshot.size,
            expectedModified: snapshot.modified,
            offset: 0,
            length: snapshot.size,
        })).rejects.toThrow('changed during transfer');
    });

    it('requires destination chunks to arrive sequentially and removes the temp file on abort', async () => {
        const runtime = createClaudeSessionTransferRuntime({ allowedRoot: root });
        const content = Buffer.from('{"type":"user"}\n');
        const begun = await runtime.beginImport({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            size: content.length,
            sha256: createHash('sha256').update(content).digest('hex'),
        });
        expect(begun.status).toBe('ready');
        if (begun.status !== 'ready') throw new Error('expected ready import');

        await expect(runtime.writeImportChunk({
            transferId: begun.transferId,
            offset: 1,
            content: content.toString('base64'),
        })).rejects.toThrow('next offset');

        await runtime.writeImportChunk({
            transferId: begun.transferId,
            offset: 0,
            content: content.subarray(0, 5).toString('base64'),
        });
        await runtime.abortImport({ transferId: begun.transferId });

        const bucket = dirname(resolveClaudeSessionTransferPath({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        }));
        expect(await readdir(bucket)).toEqual([]);
    });

    it('rejects overlapping imports for the same destination session until the first is aborted', async () => {
        const runtime = createClaudeSessionTransferRuntime({ allowedRoot: root });
        const first = await runtime.beginImport({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            size: 10,
            sha256: 'a'.repeat(64),
        });
        if (first.status !== 'ready') throw new Error('expected ready import');

        await expect(runtime.beginImport({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            size: 12,
            sha256: 'b'.repeat(64),
        })).rejects.toThrow('already in progress');

        await runtime.abortImport({ transferId: first.transferId });
        const retried = await runtime.beginImport({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            size: 12,
            sha256: 'b'.repeat(64),
        });
        if (retried.status !== 'ready') throw new Error('expected ready import');
        await runtime.abortImport({ transferId: retried.transferId });
    });

    it('expires an abandoned pending import and removes its temp file', async () => {
        vi.useFakeTimers();
        const runtime = createClaudeSessionTransferRuntime({ allowedRoot: root });
        const begun = await runtime.beginImport({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            size: 10,
            sha256: 'a'.repeat(64),
        });
        if (begun.status !== 'ready') throw new Error('expected ready import');
        const bucket = dirname(resolveClaudeSessionTransferPath({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        }));

        expect(await readdir(bucket)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_TRANSFER_PENDING_TTL_MS);
        vi.useRealTimers();

        await vi.waitFor(async () => {
            expect(await readdir(bucket)).toEqual([]);
        });
        await expect(runtime.writeImportChunk({
            transferId: begun.transferId,
            offset: 0,
            content: Buffer.from('x').toString('base64'),
        })).rejects.toThrow('Unknown Claude session transfer');
    });

    it('removes orphaned transfer files left by a previous daemon before importing', async () => {
        const destinationPath = resolveClaudeSessionTransferPath({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        });
        const bucket = dirname(destinationPath);
        await mkdir(bucket, { recursive: true });
        const orphanName = `${SESSION_ID}.jsonl.aplus-transfer-93a9705e-bc6a-406d-8dce-8acc014dedbd.tmp`;
        const orphanPath = join(bucket, orphanName);
        await writeFile(orphanPath, 'orphan');
        const expiredAt = new Date(Date.now() - CLAUDE_SESSION_TRANSFER_PENDING_TTL_MS - 1_000);
        await utimes(orphanPath, expiredAt, expiredAt);

        const runtime = createClaudeSessionTransferRuntime({ allowedRoot: root });
        const begun = await runtime.beginImport({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            size: 10,
            sha256: 'a'.repeat(64),
        });
        if (begun.status !== 'ready') throw new Error('expected ready import');

        const entries = await readdir(bucket);
        expect(entries).toHaveLength(1);
        expect(entries).not.toContain(orphanName);
        await runtime.abortImport({ transferId: begun.transferId });
    });

    it('rejects a destination chunk that exceeds its declared session size', async () => {
        const runtime = createClaudeSessionTransferRuntime({ allowedRoot: root });
        const begun = await runtime.beginImport({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            size: 2,
            sha256: createHash('sha256').update('ok').digest('hex'),
        });
        if (begun.status !== 'ready') throw new Error('expected ready import');

        await expect(runtime.writeImportChunk({
            transferId: begun.transferId,
            offset: 0,
            content: Buffer.from('too long').toString('base64'),
        })).rejects.toThrow('declared session size');
        await runtime.abortImport({ transferId: begun.transferId });
    });

    it('commits a verified import atomically and replaces a stale staged seed', async () => {
        const path = resolveClaudeSessionTransferPath({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        });
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, 'stale snapshot');
        const runtime = createClaudeSessionTransferRuntime({ allowedRoot: root });
        const content = Buffer.from('{"type":"user","message":"latest"}\n');
        const begun = await runtime.beginImport({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            size: content.length,
            sha256: createHash('sha256').update(content).digest('hex'),
        });
        if (begun.status !== 'ready') throw new Error('expected ready import');

        await runtime.writeImportChunk({
            transferId: begun.transferId,
            offset: 0,
            content: content.subarray(0, 8).toString('base64'),
        });
        await runtime.writeImportChunk({
            transferId: begun.transferId,
            offset: 8,
            content: content.subarray(8).toString('base64'),
        });

        await expect(runtime.commitImport({ transferId: begun.transferId }))
            .resolves.toEqual({ status: 'imported' });
        expect(await readFile(path)).toEqual(content);
        expect((await readdir(dirname(path))).filter((name) => name.includes('.aplus-transfer-'))).toEqual([]);
    });

    it('treats an identical destination seed as already present without opening a transfer', async () => {
        const path = resolveClaudeSessionTransferPath({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        });
        const content = Buffer.from('{"type":"user"}\n');
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);

        const runtime = createClaudeSessionTransferRuntime({ allowedRoot: root });
        await expect(runtime.beginImport({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            size: content.length,
            sha256: createHash('sha256').update(content).digest('hex'),
        })).resolves.toEqual({ status: 'already-present' });
        expect(await readdir(dirname(path))).toEqual([`${SESSION_ID}.jsonl`]);
    });

    it('removes an unverified temp file when commit detects a hash mismatch', async () => {
        const runtime = createClaudeSessionTransferRuntime({ allowedRoot: root });
        const content = Buffer.from('{"type":"user"}\n');
        const begun = await runtime.beginImport({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            size: content.length,
            sha256: '0'.repeat(64),
        });
        if (begun.status !== 'ready') throw new Error('expected ready import');
        await runtime.writeImportChunk({
            transferId: begun.transferId,
            offset: 0,
            content: content.toString('base64'),
        });

        await expect(runtime.commitImport({ transferId: begun.transferId }))
            .rejects.toThrow('hash mismatch');
        const bucket = dirname(resolveClaudeSessionTransferPath({
            directory: projectDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        }));
        expect(await readdir(bucket)).toEqual([]);
    });

    it('transfers a session larger than two chunk limits through the RPC action handler', async () => {
        const sourceDirectory = join(root, 'workspace', 'source');
        const destinationDirectory = join(root, 'workspace', 'destination');
        await mkdir(sourceDirectory, { recursive: true });
        await mkdir(destinationDirectory, { recursive: true });
        const sourcePath = resolveClaudeSessionTransferPath({
            directory: sourceDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        });
        const content = Buffer.alloc(CLAUDE_SESSION_TRANSFER_CHUNK_MAX_BYTES * 2 + 777, 97);
        await mkdir(dirname(sourcePath), { recursive: true });
        await writeFile(sourcePath, content);
        const sourceHandler = createClaudeSessionTransferHandler({ allowedRoot: root });
        const destinationHandler = createClaudeSessionTransferHandler({ allowedRoot: root });

        const snapshot = await sourceHandler({
            action: 'inspect-source',
            directory: sourceDirectory,
            claudeSessionId: SESSION_ID,
        });
        if (snapshot.action !== 'inspect-source') throw new Error('expected source snapshot');
        const begun = await destinationHandler({
            action: 'begin-import',
            directory: destinationDirectory,
            claudeSessionId: SESSION_ID,
            size: snapshot.size,
            sha256: snapshot.sha256,
        });
        if (begun.action !== 'begin-import' || begun.status !== 'ready') {
            throw new Error('expected ready import');
        }

        let offset = 0;
        while (offset < snapshot.size) {
            const length = Math.min(
                CLAUDE_SESSION_TRANSFER_CHUNK_MAX_BYTES,
                snapshot.size - offset,
            );
            const chunk = await sourceHandler({
                action: 'read-source-chunk',
                directory: sourceDirectory,
                claudeSessionId: SESSION_ID,
                expectedSize: snapshot.size,
                expectedModified: snapshot.modified,
                offset,
                length,
            });
            if (chunk.action !== 'read-source-chunk') throw new Error('expected source chunk');
            const written = await destinationHandler({
                action: 'write-import-chunk',
                transferId: begun.transferId,
                offset,
                content: chunk.content,
            });
            if (written.action !== 'write-import-chunk') throw new Error('expected destination write');
            offset = written.bytesWritten;
        }

        await expect(destinationHandler({
            action: 'commit-import',
            transferId: begun.transferId,
        })).resolves.toEqual({ action: 'commit-import', status: 'imported' });
        const destinationPath = resolveClaudeSessionTransferPath({
            directory: destinationDirectory,
            claudeSessionId: SESSION_ID,
            allowedRoot: root,
        });
        expect(await readFile(destinationPath)).toEqual(content);
    }, 60_000);
});
