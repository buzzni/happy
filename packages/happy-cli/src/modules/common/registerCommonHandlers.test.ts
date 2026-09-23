import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerCommonHandlers } from './registerCommonHandlers';

type Handler = (data: Record<string, unknown>) => Promise<Record<string, unknown>>;

const temporaryDirectories: string[] = [];

async function createHandlers() {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happy-read-chunk-'));
    temporaryDirectories.push(workingDirectory);
    const handlers = new Map<string, Handler>();
    const manager = {
        registerHandler: (method: string, handler: Handler) => {
            handlers.set(method, handler);
        },
    } as unknown as RpcHandlerManager;
    registerCommonHandlers(manager, workingDirectory);
    return { handlers, workingDirectory };
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => (
        rm(directory, { recursive: true, force: true })
    )));
});

describe('registerCommonHandlers bash scheduling', () => {
    it('keeps legacy requests foreground-compatible and accepts background classification', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        const handler = handlers.get('bash');

        await expect(handler?.({ command: 'printf legacy', cwd: workingDirectory })).resolves.toMatchObject({
            success: true,
            stdout: 'legacy',
            exitCode: 0,
        });
        await expect(handler?.({
            command: 'printf background',
            cwd: workingDirectory,
            executionClass: 'background',
        })).resolves.toMatchObject({
            success: true,
            stdout: 'background',
            exitCode: 0,
        });
    });
});

describe('registerCommonHandlers readFileChunk', () => {
    it('returns the requested bytes with stable file metadata and EOF state', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        const path = join(workingDirectory, 'large.bin');
        await writeFile(path, Buffer.from('abcdefgh'));
        const handler = handlers.get('readFileChunk');

        await expect(handler?.({ path, offset: 2, length: 3 })).resolves.toMatchObject({
            success: true,
            content: Buffer.from('cde').toString('base64'),
            offset: 2,
            bytesRead: 3,
            totalBytes: 8,
            eof: false,
            modified: expect.any(Number),
        });
        await expect(handler?.({ path, offset: 5, length: 3 })).resolves.toMatchObject({
            success: true,
            content: Buffer.from('fgh').toString('base64'),
            offset: 5,
            bytesRead: 3,
            totalBytes: 8,
            eof: true,
            modified: expect.any(Number),
        });
    });

    it('rejects traversal and requests larger than 3 MiB', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        const handler = handlers.get('readFileChunk');

        await expect(handler?.({
            path: join(workingDirectory, '..', 'outside.bin'),
            offset: 0,
            length: 1,
        })).resolves.toMatchObject({ success: false });
        await expect(handler?.({
            path: join(workingDirectory, 'large.bin'),
            offset: 0,
            length: 3 * 1024 * 1024 + 1,
        })).resolves.toEqual({
            success: false,
            error: 'Chunk length must be an integer between 1 and 3145728 bytes',
        });
    });
});

describe('project-scoped file RPCs', () => {
    it('reads project files and returns structured absence without using legacy handlers', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        const path = join(workingDirectory, 'spec.md');
        await writeFile(path, '# scoped');
        await expect(handlers.get('listWorkspaceDirectory')?.({ workspaceRoot: workingDirectory, path: workingDirectory })).resolves.toMatchObject({
            success: true, entries: [expect.objectContaining({ name: 'spec.md', type: 'file', size: 8 })],
        });
        await expect(handlers.get('readWorkspaceFile')?.({ workspaceRoot: workingDirectory, path })).resolves.toEqual({
            success: true, content: Buffer.from('# scoped').toString('base64'),
        });
        await expect(handlers.get('readWorkspaceFile')?.({ workspaceRoot: workingDirectory, path: join(workingDirectory, 'missing') })).resolves.toMatchObject({
            success: false, errorCode: 'ENOENT',
        });
        await expect(handlers.get('listWorkspaceDirectory')?.({ path: workingDirectory })).resolves.toMatchObject({
            success: false, errorCode: 'WORKSPACE_PATH_DENIED',
        });
    });
});
