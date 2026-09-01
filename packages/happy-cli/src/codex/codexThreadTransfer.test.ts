import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CODEX_THREAD_TRANSFER_PENDING_TTL_MS,
    createCodexThreadTransferRuntime,
} from './codexThreadTransfer';

describe('Codex native thread transfer', () => {
    const roots: string[] = [];

    const stagingDirectory = (codexHome: string, targetDirectory: string) => join(
        codexHome,
        '.aplus',
        'native-session-transfers',
        createHash('sha256').update(targetDirectory).digest('hex'),
    );

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
        let importFileMode: number | undefined;
        const forkThreadFromPath = vi.fn(async (input: { path: string; cwd: string }) => {
            importFileMode = (await stat(input.path)).mode & 0o777;
            return { threadId: 'thread-target' };
        });
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
        const importedPath = forkThreadFromPath.mock.calls[0]![0].path;
        expect(relative(targetDirectory, importedPath)).toMatch(/^\.\.[/\\]/);
        expect(existsSync(join(targetDirectory, '.aplus'))).toBe(false);
        expect(importFileMode).toBe(0o600);
        expect(existsSync(importedPath)).toBe(false);
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

    it('reuses an untouched pending import when the begin response is retried', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-transfer-retry-'));
        roots.push(root);
        const codexHome = join(root, '.codex');
        const targetDirectory = join(root, 'workspace', 'target');
        await mkdir(join(codexHome, 'sessions'), { recursive: true });
        await mkdir(targetDirectory, { recursive: true });
        const runtime = createCodexThreadTransferRuntime({
            allowedRoot: root,
            codexHome,
            readThreadPath: vi.fn(),
            forkThreadFromPath: vi.fn(),
        });
        const input = {
            directory: targetDirectory,
            sourceCodexThreadId: 'thread-source',
            requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            size: 3,
            sha256: 'a'.repeat(64),
        };

        const first = await runtime.beginImport(input);
        if (first.status !== 'ready') throw new Error('expected ready transfer');

        await expect(runtime.beginImport(input)).resolves.toEqual(first);
        await runtime.writeImportChunk({
            transferId: first.transferId,
            offset: 0,
            content: Buffer.from('a').toString('base64'),
        });
        const restarted = await runtime.beginImport(input);
        if (restarted.status !== 'ready') throw new Error('expected restarted transfer');
        expect(restarted.transferId).not.toBe(first.transferId);
        await runtime.abortImport({ transferId: restarted.transferId });
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

    it('rejects a symlinked Codex staging directory before creating transfer files', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-transfer-target-security-'));
        roots.push(root);
        const codexHome = join(root, '.codex');
        const targetDirectory = join(root, 'workspace', 'target');
        const outsideStaging = join(root, 'outside-staging');
        await mkdir(join(codexHome, 'sessions'), { recursive: true });
        await mkdir(targetDirectory, { recursive: true });
        await mkdir(join(codexHome, '.aplus'), { recursive: true });
        await mkdir(outsideStaging, { recursive: true });
        await symlink(outsideStaging, join(codexHome, '.aplus', 'native-session-transfers'));
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

    it('rejects a Codex home inside the target directory', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-transfer-home-security-'));
        roots.push(root);
        const targetDirectory = join(root, 'workspace', 'target');
        const codexHome = join(targetDirectory, '.codex');
        await mkdir(join(codexHome, 'sessions'), { recursive: true });
        const runtime = createCodexThreadTransferRuntime({
            allowedRoot: root,
            codexHome,
            readThreadPath: vi.fn(),
            forkThreadFromPath: vi.fn(),
        });

        await expect(runtime.beginImport({
            directory: targetDirectory,
            sourceCodexThreadId: 'thread-source',
            requestId: '99999999-9999-4999-8999-999999999999',
            size: 2,
            sha256: 'a'.repeat(64),
        })).rejects.toThrow('Codex home must be outside the target directory');
        expect(existsSync(join(codexHome, '.aplus'))).toBe(false);
    });

    it('removes expired transfer files left by a previous daemon runtime', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-transfer-orphan-'));
        roots.push(root);
        const codexHome = join(root, '.codex');
        const targetDirectory = join(root, 'workspace', 'target');
        const transferDirectory = stagingDirectory(codexHome, targetDirectory);
        await mkdir(join(codexHome, 'sessions'), { recursive: true });
        await mkdir(targetDirectory, { recursive: true });
        await mkdir(transferDirectory, { recursive: true });
        const orphanName = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.aplus-codex-transfer-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl';
        const orphanPath = join(transferDirectory, orphanName);
        await writeFile(orphanPath, 'orphan');
        const expiredAt = new Date(Date.now() - CODEX_THREAD_TRANSFER_PENDING_TTL_MS - 1_000);
        await utimes(orphanPath, expiredAt, expiredAt);
        await writeFile(join(transferDirectory, 'keep.txt'), 'keep');
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

        expect(await readdir(transferDirectory)).not.toContain(orphanName);
        expect(await readdir(transferDirectory)).toContain('keep.txt');
        await runtime.abortImport({ transferId: begun.transferId });
    });

    it('preserves recent transfer files that may belong to an overlapping daemon runtime', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-transfer-overlap-'));
        roots.push(root);
        const codexHome = join(root, '.codex');
        const targetDirectory = join(root, 'workspace', 'target');
        const transferDirectory = stagingDirectory(codexHome, targetDirectory);
        await mkdir(join(codexHome, 'sessions'), { recursive: true });
        await mkdir(targetDirectory, { recursive: true });
        await mkdir(transferDirectory, { recursive: true });
        const activeName = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.aplus-codex-transfer-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl';
        await writeFile(join(transferDirectory, activeName), 'still-active');
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

        expect(await readdir(transferDirectory)).toContain(activeName);
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

    it('forks only once when the same completed import is committed concurrently', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-transfer-concurrent-commit-'));
        roots.push(root);
        const codexHome = join(root, '.codex');
        const targetDirectory = join(root, 'workspace', 'target');
        const content = Buffer.from('abc');
        await mkdir(join(codexHome, 'sessions'), { recursive: true });
        await mkdir(targetDirectory, { recursive: true });
        const forkThreadFromPath = vi.fn(async () => ({ threadId: 'thread-target' }));
        const runtime = createCodexThreadTransferRuntime({
            allowedRoot: root,
            codexHome,
            readThreadPath: vi.fn(),
            forkThreadFromPath,
        });
        const begun = await runtime.beginImport({
            directory: targetDirectory,
            sourceCodexThreadId: 'thread-source',
            requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            size: content.length,
            sha256: createHash('sha256').update(content).digest('hex'),
        });
        if (begun.status !== 'ready') throw new Error('expected ready transfer');
        await runtime.writeImportChunk({
            transferId: begun.transferId,
            offset: 0,
            content: content.toString('base64'),
        });

        const results = await Promise.all([
            runtime.commitImport({ transferId: begun.transferId }),
            runtime.commitImport({ transferId: begun.transferId }),
        ]);

        expect(forkThreadFromPath).toHaveBeenCalledOnce();
        expect(results).toEqual([
            { status: 'imported', newCodexThreadId: 'thread-target' },
            { status: 'imported', newCodexThreadId: 'thread-target' },
        ]);
    });
});
