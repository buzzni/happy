import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CODEX_THREAD_TRANSFER_PENDING_TTL_MS,
    createCodexThreadTransferRuntime,
} from './codexThreadTransfer';

describe('Codex native thread transfer', () => {
    const roots: string[] = [];

    afterEach(async () => {
        const { rm } = await import('node:fs/promises');
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('forks an imported rollout without running a model turn and preserves the source', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-transfer-'));
        roots.push(root);
        const codexHome = join(root, '.codex');
        const sourceDirectory = join(root, 'workspace', 'source');
        const targetDirectory = join(root, 'workspace', 'target');
        const sourcePath = join(
            codexHome,
            'sessions',
            '2026',
            '08',
            '31',
            'rollout-2026-08-31T00-00-00-thread-source.jsonl',
        );
        const content = Buffer.from([
            JSON.stringify({ type: 'session_meta', payload: { id: 'thread-source', cwd: sourceDirectory } }),
            JSON.stringify({ type: 'response_item', payload: { role: 'user', content: 'hello' } }),
        ].join('\n') + '\n');
        await mkdir(join(codexHome, 'sessions', '2026', '08', '31'), { recursive: true });
        await mkdir(sourceDirectory, { recursive: true });
        await mkdir(targetDirectory, { recursive: true });
        await writeFile(sourcePath, content);

        const readThreadPath = vi.fn(async () => sourcePath);
        const forkThreadFromPath = vi.fn(async (_input: { path: string; cwd: string }) => ({
            threadId: 'thread-target',
        }));
        const runtime = createCodexThreadTransferRuntime({
            allowedRoot: root,
            codexHome,
            readThreadPath,
            forkThreadFromPath,
        });

        const inspected = await runtime.inspectSource({ codexThreadId: 'thread-source' });
        expect(inspected).toMatchObject({
            size: content.length,
            sha256: createHash('sha256').update(content).digest('hex'),
        });
        const sourceChunk = await runtime.readSourceChunk({
            codexThreadId: 'thread-source',
            expectedSize: inspected.size,
            expectedModified: inspected.modified,
            offset: 0,
            length: inspected.size,
        });
        const begun = await runtime.beginImport({
            directory: targetDirectory,
            sourceCodexThreadId: 'thread-source',
            requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            size: inspected.size,
            sha256: inspected.sha256,
        });
        if (begun.status !== 'ready') throw new Error('expected ready transfer');
        await runtime.writeImportChunk({
            transferId: begun.transferId,
            offset: 0,
            content: sourceChunk.content,
        });

        await expect(runtime.commitImport({
            transferId: begun.transferId,
        })).resolves.toEqual({ status: 'imported', newCodexThreadId: 'thread-target' });
        expect(await readFile(sourcePath)).toEqual(content);
        expect(forkThreadFromPath).toHaveBeenCalledWith({
            path: expect.stringContaining('.aplus-codex-transfer-'),
            cwd: targetDirectory,
        });
        expect(existsSync(forkThreadFromPath.mock.calls[0]![0].path)).toBe(false);
        expect(readThreadPath).toHaveBeenCalledWith('thread-source');
        expect(readThreadPath).toHaveBeenCalledTimes(1);

        await expect(runtime.beginImport({
            directory: targetDirectory,
            sourceCodexThreadId: 'thread-source',
            requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            size: inspected.size,
            sha256: inspected.sha256,
        })).resolves.toEqual({
            status: 'already-present',
            newCodexThreadId: 'thread-target',
        });
        expect(forkThreadFromPath).toHaveBeenCalledOnce();
    });

    it('rejects rollout paths outside the Codex sessions root and symbolic links', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-transfer-security-'));
        roots.push(root);
        const codexHome = join(root, '.codex');
        const sessionsRoot = join(codexHome, 'sessions');
        const outsidePath = join(root, 'outside.jsonl');
        const linkedPath = join(sessionsRoot, 'linked.jsonl');
        await mkdir(sessionsRoot, { recursive: true });
        await writeFile(outsidePath, '{}\n');
        await symlink(outsidePath, linkedPath);
        const readThreadPath = vi.fn();
        const runtime = createCodexThreadTransferRuntime({
            allowedRoot: root,
            codexHome,
            readThreadPath,
            forkThreadFromPath: vi.fn(),
        });

        readThreadPath.mockResolvedValueOnce(outsidePath);
        await expect(runtime.inspectSource({ codexThreadId: 'thread-outside' }))
            .rejects.toThrow('outside the native sessions directory');

        readThreadPath.mockResolvedValueOnce(linkedPath);
        await expect(runtime.inspectSource({ codexThreadId: 'thread-link' }))
            .rejects.toThrow('must be a regular file');
    });

    it('rejects a symlinked target staging directory before creating transfer files', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-transfer-target-security-'));
        roots.push(root);
        const codexHome = join(root, '.codex');
        const targetDirectory = join(root, 'workspace', 'target');
        const outsideStaging = join(root, 'outside-staging');
        await mkdir(join(codexHome, 'sessions'), { recursive: true });
        await mkdir(join(targetDirectory, '.aplus'), { recursive: true });
        await mkdir(outsideStaging, { recursive: true });
        await symlink(outsideStaging, join(targetDirectory, '.aplus', 'native-session-transfers'));
        const runtime = createCodexThreadTransferRuntime({
            allowedRoot: root,
            codexHome,
            readThreadPath: vi.fn(),
            forkThreadFromPath: vi.fn(),
        });

        await expect(runtime.beginImport({
            directory: targetDirectory,
            sourceCodexThreadId: 'thread-source',
            requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            size: 2,
            sha256: 'a'.repeat(64),
        })).rejects.toThrow('must not be a symbolic link');
        expect(await readdir(outsideStaging)).toEqual([]);
    });

    it('removes expired transfer files left by a previous daemon runtime', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-transfer-orphan-'));
        roots.push(root);
        const codexHome = join(root, '.codex');
        const targetDirectory = join(root, 'workspace', 'target');
        const stagingDirectory = join(targetDirectory, '.aplus', 'native-session-transfers');
        await mkdir(join(codexHome, 'sessions'), { recursive: true });
        await mkdir(stagingDirectory, { recursive: true });
        const orphanName = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.aplus-codex-transfer-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl';
        const orphanPath = join(stagingDirectory, orphanName);
        await writeFile(orphanPath, 'orphan');
        const expiredAt = new Date(Date.now() - CODEX_THREAD_TRANSFER_PENDING_TTL_MS - 1_000);
        await utimes(orphanPath, expiredAt, expiredAt);
        await writeFile(join(stagingDirectory, 'keep.txt'), 'keep');
        const runtime = createCodexThreadTransferRuntime({
            allowedRoot: root,
            codexHome,
            readThreadPath: vi.fn(),
            forkThreadFromPath: vi.fn(),
        });

        const begun = await runtime.beginImport({
            directory: targetDirectory,
            sourceCodexThreadId: 'thread-source',
            requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            size: 2,
            sha256: 'a'.repeat(64),
        });
        if (begun.status !== 'ready') throw new Error('expected ready transfer');

        expect(await readdir(stagingDirectory)).not.toContain(orphanName);
        expect(await readdir(stagingDirectory)).toContain('keep.txt');
        await runtime.abortImport({ transferId: begun.transferId });
    });

    it('preserves recent transfer files that may belong to an overlapping daemon runtime', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-transfer-overlap-'));
        roots.push(root);
        const codexHome = join(root, '.codex');
        const targetDirectory = join(root, 'workspace', 'target');
        const stagingDirectory = join(targetDirectory, '.aplus', 'native-session-transfers');
        await mkdir(join(codexHome, 'sessions'), { recursive: true });
        await mkdir(stagingDirectory, { recursive: true });
        const activeName = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.aplus-codex-transfer-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl';
        await writeFile(join(stagingDirectory, activeName), 'still-active');
        const runtime = createCodexThreadTransferRuntime({
            allowedRoot: root,
            codexHome,
            readThreadPath: vi.fn(),
            forkThreadFromPath: vi.fn(),
        });

        const begun = await runtime.beginImport({
            directory: targetDirectory,
            sourceCodexThreadId: 'thread-source',
            requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            size: 2,
            sha256: 'a'.repeat(64),
        });
        if (begun.status !== 'ready') throw new Error('expected ready transfer');

        expect(await readdir(stagingDirectory)).toContain(activeName);
        await runtime.abortImport({ transferId: begun.transferId });
    });

    it('accepts only one of two concurrent chunks for the same offset', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-transfer-concurrent-write-'));
        roots.push(root);
        const codexHome = join(root, '.codex');
        const targetDirectory = join(root, 'workspace', 'target');
        const content = Buffer.from('abc');
        await mkdir(join(codexHome, 'sessions'), { recursive: true });
        await mkdir(targetDirectory, { recursive: true });
        const runtime = createCodexThreadTransferRuntime({
            allowedRoot: root,
            codexHome,
            readThreadPath: vi.fn(),
            forkThreadFromPath: vi.fn(async () => ({ threadId: 'thread-target' })),
        });
        const begun = await runtime.beginImport({
            directory: targetDirectory,
            sourceCodexThreadId: 'thread-source',
            requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            size: content.length,
            sha256: createHash('sha256').update(content).digest('hex'),
        });
        if (begun.status !== 'ready') throw new Error('expected ready transfer');

        const results = await Promise.allSettled([
            runtime.writeImportChunk({
                transferId: begun.transferId,
                offset: 0,
                content: content.toString('base64'),
            }),
            runtime.writeImportChunk({
                transferId: begun.transferId,
                offset: 0,
                content: content.toString('base64'),
            }),
        ]);

        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
        await expect(runtime.commitImport({ transferId: begun.transferId })).resolves.toEqual({
            status: 'imported',
            newCodexThreadId: 'thread-target',
        });
    });
});
