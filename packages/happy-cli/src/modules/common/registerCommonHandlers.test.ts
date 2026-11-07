import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { configuration } from '@/configuration';
import { createWorkspaceTurnAdmission, createFilesystemWriteAdmission } from '@/utils/workspaceTurnAdmission';
import { registerCommonHandlers, type CommonHandlerOptions } from './registerCommonHandlers';
import { createManagedProjectWriteScopePolicy, createTrustedMachineRunProfileResolver } from './machineRunProfile';
import { managedMachineToolPlatform } from './managedMachineTool';

type Handler = (data: Record<string, unknown>) => Promise<Record<string, unknown>>;

// Counts the handlers' stat calls, so a test can tell a walk that stopped from one that
// only stopped counting.
const statCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs/promises')>();
    return { ...actual, stat: (...args: Parameters<typeof actual.stat>) => { statCalls.count++; return actual.stat(...args); } };
});

const temporaryDirectories: string[] = [];

async function createHandlers(workingDirectory?: string, options?: CommonHandlerOptions) {
    if (!workingDirectory) {
        workingDirectory = await mkdtemp(join(tmpdir(), 'happy-read-chunk-'));
        temporaryDirectories.push(workingDirectory);
    }
    const handlers = new Map<string, Handler>();
    const manager = {
        registerHandler: (method: string, handler: Handler) => {
            handlers.set(method, handler);
        },
    } as unknown as RpcHandlerManager;
    registerCommonHandlers(manager, workingDirectory, options);
    return { handlers, workingDirectory };
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => (
        rm(directory, { recursive: true, force: true })
    )));
});

describe('registerCommonHandlers bash scheduling', () => {
    it('forwards host admission to the explicitly enabled raw machine-run adapter', async () => {
        const admitSubprocess = vi.fn(async (_roots: readonly string[]) => { throw new Error('WORKSPACE_BUSY'); });
        const { handlers, workingDirectory } = await createHandlers(undefined, { admitSubprocess,
            machineRun: { allowLegacyRaw: true, profileRegistry: createTrustedMachineRunProfileResolver([]) } });
        await expect(handlers.get('machine-run')!({ version: 1, action: 'start', executable: 'printf', args: ['blocked'], cwd: workingDirectory }))
            .rejects.toThrow('WORKSPACE_BUSY');
        expect(admitSubprocess).toHaveBeenCalledWith([await realpath(workingDirectory)]);
    });
    it.each(['machine.run', 'machine-run'])('forwards host admission through the %s profile adapter', async method => {
        const registry = createTrustedMachineRunProfileResolver([{
            id: 'buzzni.test.admission', executable: 'printf', argv: ['{{message}}'],
            parameters: { message: { type: 'string', maxLength: 32 } }, cwd: 'workspaceRoot',
            envAllowlist: [], timeoutMs: 1000, outputLimitBytes: 1024, stdin: 'none',
        }]);
        const admitSubprocess = vi.fn(async (_roots: readonly string[]) => { throw new Error('WORKSPACE_OWNER_UNCONFIRMED'); });
        const { handlers, workingDirectory } = await createHandlers(undefined, { admitSubprocess, machineRun: { profileRegistry: registry } });
        await expect(handlers.get(method)!({ action: 'start', profileId: 'buzzni.test.admission',
            profileDigest: registry.resolve('buzzni.test.admission')!.profileDigest, workspaceRoot: workingDirectory, parameters: { message: 'blocked' } }))
            .rejects.toThrow('WORKSPACE_OWNER_UNCONFIRMED');
        const canonical = await realpath(workingDirectory);
        expect(admitSubprocess).toHaveBeenCalledWith([canonical, canonical]);
    });
    it('checks host workspace admission before a legacy shell effect and ignores request-supplied admission', async () => {
        const admitSubprocess = vi.fn(async (_roots: readonly string[]) => { throw new Error('WORKSPACE_OWNER_UNCONFIRMED'); });
        const options = { childEnvBoundary: 'session' as const, admitSubprocess };
        const { handlers, workingDirectory } = await createHandlers(undefined, options);
        await expect(handlers.get('bash')!({ command: 'printf unsafe > untracked-shell.txt', cwd: workingDirectory,
            admitSubprocess: async () => undefined })).resolves.toMatchObject({ success: false, error: 'WORKSPACE_OWNER_UNCONFIRMED' });
        expect(admitSubprocess).toHaveBeenCalledWith([workingDirectory]);
        await expect(readFile(join(workingDirectory, 'untracked-shell.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it.each([undefined, '/'])('uses the actual process cwd for default-shell admission (%s)', async cwd => {
        const admitSubprocess = vi.fn(async (_roots: readonly string[]) => undefined);
        const { handlers } = await createHandlers(undefined, { childEnvBoundary: 'session', admitSubprocess } as CommonHandlerOptions);
        await expect(handlers.get('bash')!({ command: 'printf admitted', ...(cwd ? { cwd } : {}) }))
            .resolves.toMatchObject({ success: true, stdout: 'admitted' });
        expect(admitSubprocess).toHaveBeenCalledWith([process.cwd()]);
    });
    it.each(['ripgrep', 'difftastic'])('checks host admission before starting a legacy raw %s process', async method => {
        const runner = method === 'ripgrep' ? await import('@/modules/ripgrep/index') : await import('@/modules/difftastic/index');
        const execute = vi.spyOn(runner, 'run').mockRejectedValue(new Error('untracked process invoked'));
        const admitSubprocess = vi.fn(async (_roots: readonly string[]) => { throw new Error('WORKSPACE_BUSY'); });
        try {
            const options = { childEnvBoundary: 'session' as const, admitSubprocess };
            const { handlers, workingDirectory } = await createHandlers(undefined, options);
            await expect(handlers.get(method)!({ args: ['--version'], cwd: workingDirectory }))
                .resolves.toMatchObject({ success: false, error: 'WORKSPACE_BUSY' });
            expect(admitSubprocess).toHaveBeenCalledWith([workingDirectory]);
            expect(execute).not.toHaveBeenCalled();
        } finally { execute.mockRestore(); }
    });
    it.each(['ripgrep', 'difftastic'])('refuses internal raw %s before starting any process', async method => {
        const runner = method === 'ripgrep' ? await import('@/modules/ripgrep/index') : await import('@/modules/difftastic/index');
        const execute = vi.spyOn(runner, 'run').mockRejectedValue(new Error('untracked process invoked'));
        try {
            const { handlers, workingDirectory } = await createHandlers(undefined, { processExecution: 'disabled' });
            await expect(handlers.get(method)!({ args: ['--version'], cwd: workingDirectory }))
                .resolves.toMatchObject({ success: false, error: 'AUTOMATION_PROCESS_RPC_UNSUPPORTED' });
            expect(execute).not.toHaveBeenCalled();
        } finally { execute.mockRestore(); }
    });
    it('refuses an internal execution shell before it can start an untracked writer', async () => {
        const { handlers, workingDirectory } = await createHandlers(undefined, { processExecution: 'disabled' } as CommonHandlerOptions);
        await expect(handlers.get('bash')!({ command: 'printf unsafe > forbidden.txt', cwd: workingDirectory,
            processExecution: 'enabled' })).resolves.toMatchObject({ success: false, error: 'AUTOMATION_PROCESS_RPC_UNSUPPORTED' });
        await expect(readFile(join(workingDirectory, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('drops another session from machine-scope commands and keeps a session its own scope (utils/childEnv)', async () => {
        const injected = { HAPPY_RECONNECT_SESSION_ID: 'cmr-poisoned', APLUS_SESSION_ID: 'self-session' };
        Object.assign(process.env, injected);
        const command = 'printf "%s|%s" "${HAPPY_RECONNECT_SESSION_ID-}" "${APLUS_SESSION_ID-}"';
        try {
            const machine = await createHandlers();
            await expect(machine.handlers.get('bash')?.({ command, cwd: machine.workingDirectory })).resolves.toMatchObject({ stdout: '|' });
            const session = await createHandlers(undefined, { childEnvBoundary: 'in-session' });
            await expect(session.handlers.get('bash')?.({ command, cwd: session.workingDirectory })).resolves.toMatchObject({ stdout: '|self-session' });
        } finally {
            for (const key of Object.keys(injected)) delete process.env[key];
        }
    });

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

describe('registerCommonHandlers machine.run capability', () => {
    it.each(['machine-run', 'machine.run'])('refuses untracked internal %s execution and capability advertising', async method => {
        const registry = createTrustedMachineRunProfileResolver([{
            id: 'buzzni.test.echo', executable: 'printf', argv: ['{{message}}'],
            parameters: { message: { type: 'string', maxLength: 32 } }, cwd: 'workspaceRoot',
            envAllowlist: [], timeoutMs: 1000, outputLimitBytes: 1024, stdin: 'none',
        }]);
        const { handlers, workingDirectory } = await createHandlers(undefined, {
            processExecution: 'disabled', machineRun: { allowLegacyRaw: true, profileRegistry: registry },
        } as CommonHandlerOptions);
        const request = method === 'machine-run' ? { version: 1, action: 'start', executable: 'printf', args: ['raw'] }
            : { action: 'start', profileId: 'buzzni.test.echo', profileDigest: registry.resolve('buzzni.test.echo')!.profileDigest,
                workspaceRoot: workingDirectory, parameters: { message: 'raw' } };
        await expect(handlers.get(method)!({ ...request, processExecution: 'enabled' })).rejects.toThrow('AUTOMATION_PROCESS_RPC_UNSUPPORTED');
        await expect(handlers.get(method)!({ action: 'capabilities' })).rejects.toThrow('AUTOMATION_PROCESS_RPC_UNSUPPORTED');
    });
    it('keeps the raw RPC and exposes profile capability negotiation on both method names', async () => {
        const { handlers } = await createHandlers(undefined, {
            machineRun: {
                allowLegacyRaw: true,
                profileRegistry: createTrustedMachineRunProfileResolver([{
                    id: 'buzzni.test.echo', executable: 'printf', argv: ['{{message}}'],
                    parameters: { message: { type: 'string', maxLength: 32 } }, cwd: 'workspaceRoot',
                    envAllowlist: [], timeoutMs: 1000, outputLimitBytes: 1024, stdin: 'none',
                }]),
            },
        });
        await expect(handlers.get('machine.run')?.({ action: 'capabilities' })).resolves.toMatchObject({
            supported: true,
            protocolVersion: 1,
            runtime: { packageName: '@buzzni/happy-cli', packageVersion: expect.any(String), protocolVersion: 1 },
            capabilities: ['machine.run.v1'],
            profiles: [{ id: 'buzzni.test.echo' }],
        });
        await expect(handlers.get('machine-run')?.({ action: 'capabilities' })).resolves.toMatchObject({ supported: true, profiles: [{ id: 'buzzni.test.echo' }] });
        await expect(handlers.get('machine-run')?.({ version: 1, action: 'start', executable: 'printf', args: ['raw'] })).resolves.toMatchObject({ action: 'start', state: 'accepted' });
    });

    it('does not expose the raw executable alias without an explicit internal gate', async () => {
        const { handlers } = await createHandlers(undefined, {
            machineRun: {
                profileRegistry: createTrustedMachineRunProfileResolver([]),
            },
        });
        await expect(handlers.get('machine-run')?.({ version: 1, action: 'start', executable: 'printf', args: ['raw'] }))
            .rejects.toThrow('MACHINE_RUN_LEGACY_RAW_UNAVAILABLE');
    });

    it('advertises a write profile only where the host installed a write policy', async () => {
        const registry = createTrustedMachineRunProfileResolver([{
            id: 'buzzni.test.write', executable: 'printf', argv: ['x'], parameters: {}, cwd: 'workspaceRoot',
            envAllowlist: [], timeoutMs: 1000, outputLimitBytes: 1024, stdin: 'none', writeScope: 'moai', descendantAllowlist: ['git'],
        }]);
        const machine = await createHandlers(undefined, { machineRun: { profileRegistry: registry, writeScopePolicy: createManagedProjectWriteScopePolicy() } });
        await expect(machine.handlers.get('machine.run')?.({ action: 'capabilities' })).resolves.toMatchObject({
            supported: true, profiles: [{ id: 'buzzni.test.write', writeScope: 'moai', descendantAllowlist: ['git'] }],
        });
        const session = await createHandlers(undefined, { machineRun: { profileRegistry: registry } });
        await expect(session.handlers.get('machine.run')?.({ action: 'capabilities' })).resolves.toMatchObject({ supported: false, profiles: [] });
    });

    it('exposes managed tool status everywhere but install only where the host allows it', async () => {
        const toolsRoot = await mkdtemp(join(tmpdir(), 'happy-tools-'));
        temporaryDirectories.push(toolsRoot);
        const fakeTool = { id: 'buzzni.fake', version: '1.0.0', executable: 'fake-tool', artifacts: {} };
        const managedTools = { root: toolsRoot, tools: [fakeTool] };
        const registry = createTrustedMachineRunProfileResolver([]);
        const machine = await createHandlers(undefined, { machineRun: { profileRegistry: registry, managedTools, allowToolInstall: true } });
        const tool = machine.handlers.get('machine.tool');
        await expect(tool?.({ version: 1, action: 'status', toolId: 'buzzni.fake' })).resolves.toEqual({
            version: 1, action: 'status', tool: { toolId: 'buzzni.fake', version: '1.0.0', platform: managedMachineToolPlatform(), supported: false, installed: false },
        });
        await expect(tool?.({ version: 1, action: 'install', toolId: 'buzzni.fake' })).rejects.toThrow('MANAGED_TOOL_UNSUPPORTED_PLATFORM');
        await expect(tool?.({ version: 1, action: 'status', toolId: 'buzzni.unknown' })).rejects.toThrow('MANAGED_TOOL_NOT_FOUND');
        await expect(tool?.({ version: 1, action: 'install', toolId: 'buzzni.fake', url: 'https://example.com' })).rejects.toThrow('MANAGED_TOOL_INVALID');

        const session = await createHandlers(undefined, { machineRun: { profileRegistry: registry, managedTools } });
        await expect(session.handlers.get('machine.tool')?.({ version: 1, action: 'install', toolId: 'buzzni.fake' })).rejects.toThrow('MANAGED_TOOL_INSTALL_UNAVAILABLE');
    });

    it('fails closed when the daemon has no host-owned profile registry', async () => {
        const { handlers } = await createHandlers(undefined, { machineRun: { profileRegistry: createTrustedMachineRunProfileResolver([]) } });
        await expect(handlers.get('machine.run')?.({ action: 'capabilities' })).resolves.toMatchObject({
            supported: false,
            profiles: [],
            reason: 'MACHINE_RUN_PROFILE_REGISTRY_UNAVAILABLE: no trusted profiles are registered',
        });
        await expect(handlers.get('machine.run')?.({
            action: 'start', profileId: 'extension.arbitrary', profileDigest: 'a'.repeat(64), workspaceRoot: '/tmp', parameters: {},
        })).rejects.toThrow('MACHINE_RUN_PROFILE_NOT_FOUND');
    });
});

describe('registerCommonHandlers workspace downloads', () => {
    it('continues an opaque listing cursor and exposes explicit cleanup', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        await Promise.all(Array.from({ length: 1001 }, (_, i) => mkdir(join(workingDirectory, `entry-${i}`))));
        const list = handlers.get('listWorkspaceDownloadDirectory')!;
        const first = await list({ workspaceRoot: workingDirectory, path: workingDirectory, offset: 0 });
        expect(first).toMatchObject({ success: true, nextOffset: 1000, listingId: expect.any(String) });
        await expect(handlers.get('closeWorkspaceDownloadDirectory')!({ workspaceRoot: workingDirectory, path: workingDirectory, listingId: first.listingId })).resolves.toMatchObject({ success: true });
        await expect(list({ workspaceRoot: workingDirectory, path: workingDirectory, offset: first.nextOffset, expectedIdentity: first.identity, listingId: first.listingId })).resolves.toMatchObject({ success: false, errorCode: 'WORKSPACE_PATH_DENIED' });
    });

    it('uses separate safe capabilities and refuses a listed file replaced by an outside link', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        const root = join(workingDirectory, 'project');
        await mkdir(root);
        const path = join(root, 'listed.bin');
        const outside = join(workingDirectory, 'outside.bin');
        await writeFile(path, 'inside');
        await writeFile(outside, 'secret');
        const list = handlers.get('listWorkspaceDownloadDirectory');
        const read = handlers.get('readWorkspaceFileChunk');
        expect(list).toBeTypeOf('function');
        expect(read).toBeTypeOf('function');
        await expect(list!({ workspaceRoot: root, path: root, offset: 0 })).resolves.toMatchObject({
            success: true, entries: [expect.objectContaining({ name: 'listed.bin' })], nextOffset: null, identity: expect.any(String),
        });
        await rm(path);
        await symlink(outside, path, 'file');
        await expect(read!({ workspaceRoot: root, path, offset: 0, length: 1 })).resolves.toMatchObject({ success: false, errorCode: 'WORKSPACE_PATH_DENIED' });
    });

    it('returns stable identity and rejects a project sibling and invalid chunk range', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        const root = join(workingDirectory, 'project');
        await mkdir(root);
        const path = join(root, 'inside.bin');
        await writeFile(path, 'inside');
        const read = handlers.get('readWorkspaceFileChunk');
        expect(read).toBeTypeOf('function');
        const first = await read!({ workspaceRoot: root, path, offset: 0, length: 1 });
        expect(first).toMatchObject({ success: true, identity: expect.any(String), totalBytes: 6 });
        await expect(read!({ workspaceRoot: root, path, offset: 1, length: 2, expectedIdentity: first.identity })).resolves.toMatchObject({ success: true, identity: first.identity });
        await expect(read!({ workspaceRoot: root, path: join(workingDirectory, 'outside'), offset: 0, length: 1 })).resolves.toMatchObject({ success: false, errorCode: 'WORKSPACE_PATH_DENIED' });
        await expect(read!({ workspaceRoot: root, path, offset: 0, length: 3 * 1024 ** 2 + 1 })).resolves.toMatchObject({ success: false, errorCode: 'WORKSPACE_RANGE_INVALID' });
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

describe('registerCommonHandlers writeFile attempts', () => {
    const b64 = (text: string) => Buffer.from(text).toString('base64');
    const sha = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');
    let attemptCounter = 0;
    const nextAttemptId = () => `attempt-${process.pid}-${Date.now()}-${++attemptCounter}`;

    it('refuses to overwrite a file that changed after the client opened it', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        const path = join(workingDirectory, 'notes.md');
        await writeFile(path, 'opened');
        await writeFile(path, 'changed elsewhere');

        await expect(handlers.get('writeFile')?.({
            path, content: b64('mine'), expectedHash: sha('opened'), attemptId: nextAttemptId(),
        })).resolves.toMatchObject({ success: false, errorCode: 'HASH_MISMATCH' });
        await expect(readFile(path, 'utf8')).resolves.toBe('changed elsewhere');
    });

    it('answers a resent attempt with its first result instead of a conflict', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        const path = join(workingDirectory, 'notes.md');
        await writeFile(path, 'opened');
        const request = { path, content: b64('mine'), expectedHash: sha('opened'), attemptId: nextAttemptId() };

        await expect(handlers.get('writeFile')?.(request)).resolves.toEqual({ success: true, hash: sha('mine') });
        // The first answer was lost; the client sends the same attempt again.
        await expect(handlers.get('writeFile')?.(request)).resolves.toEqual({ success: true, hash: sha('mine'), replayed: true });
        await expect(readFile(path, 'utf8')).resolves.toBe('mine');
    });

    it('answers a resent attempt that overlaps the first one with the same result', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        const path = join(workingDirectory, 'notes.md');
        await writeFile(path, 'opened');
        const request = { path, content: b64('mine'), expectedHash: sha('opened'), attemptId: nextAttemptId() };

        const [first, resent] = await Promise.all([handlers.get('writeFile')?.(request), handlers.get('writeFile')?.(request)]);
        expect(first).toEqual({ success: true, hash: sha('mine') });
        expect(resent).toEqual({ success: true, hash: sha('mine'), replayed: true });
    });

    it('refuses an attempt id reused for a different write without touching the file', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        const path = join(workingDirectory, 'notes.md');
        await writeFile(path, 'opened');
        const attemptId = nextAttemptId();
        await handlers.get('writeFile')?.({ path, content: b64('mine'), expectedHash: sha('opened'), attemptId });

        await expect(handlers.get('writeFile')?.({
            path, content: b64('other'), expectedHash: sha('mine'), attemptId,
        })).resolves.toMatchObject({ success: false, errorCode: 'ATTEMPT_CONFLICT' });
        await expect(readFile(path, 'utf8')).resolves.toBe('mine');
    });

    it('treats a resent attempt whose record is gone as done when the file already holds its bytes', async () => {
        // A daemon restart loses the record; the retry must still not read as a conflict.
        const first = await createHandlers();
        const path = join(first.workingDirectory, 'notes.md');
        await writeFile(path, 'mine');

        await expect(first.handlers.get('writeFile')?.({
            path, content: b64('mine'), expectedHash: sha('opened'), attemptId: nextAttemptId(),
        })).resolves.toEqual({ success: true, hash: sha('mine'), replayed: true });
    });

    it('creates a new file once and answers the resent create as done', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        const path = join(workingDirectory, 'nested', 'new.md');
        const request = { path, content: b64('fresh'), expectedHash: null, attemptId: nextAttemptId() };

        await expect(handlers.get('writeFile')?.(request)).resolves.toEqual({ success: true, hash: sha('fresh') });
        await expect(handlers.get('writeFile')?.(request)).resolves.toEqual({ success: true, hash: sha('fresh'), replayed: true });
        await expect(handlers.get('writeFile')?.({
            path, content: b64('second'), expectedHash: null, attemptId: nextAttemptId(),
        })).resolves.toMatchObject({ success: false, errorCode: 'FILE_EXISTS' });
        await expect(readFile(path, 'utf8')).resolves.toBe('fresh');
    });

    it('answers FILE_EXISTS when a named create finds a directory at the path', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        const path = join(workingDirectory, 'taken');
        await mkdir(path);

        await expect(handlers.get('writeFile')?.({
            path, content: b64('x'), expectedHash: null, attemptId: nextAttemptId(),
        })).resolves.toMatchObject({ success: false, errorCode: 'FILE_EXISTS' });
    });

    it('keeps the legacy answer for a write without an attempt id', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        const path = join(workingDirectory, 'notes.md');
        await writeFile(path, 'mine');

        // Same bytes, but without an attempt the hash gate is all there is.
        await expect(handlers.get('writeFile')?.({
            path, content: b64('mine'), expectedHash: sha('opened'),
        })).resolves.toMatchObject({ success: false, errorCode: 'HASH_MISMATCH', error: expect.stringContaining('File hash mismatch') });
        await expect(handlers.get('writeFile')?.({
            path: join(workingDirectory, 'gone.md'), content: b64('x'), expectedHash: sha('opened'),
        })).resolves.toMatchObject({ success: false, errorCode: 'FILE_MISSING' });
    });

    it('lets only one of two overlapping writes from the same opened version through', async () => {
        // Two clients opened the same version; the gate and the write must not interleave.
        const { handlers, workingDirectory } = await createHandlers();
        const path = join(workingDirectory, 'notes.md');
        await writeFile(path, 'opened');

        const answers = await Promise.all(['first', 'second'].map((text) => handlers.get('writeFile')?.({
            path, content: b64(text), expectedHash: sha('opened'), attemptId: nextAttemptId(),
        })));
        expect(answers.filter((answer) => answer?.success)).toHaveLength(1);
        expect(answers.filter((answer) => answer?.errorCode === 'HASH_MISMATCH')).toHaveLength(1);
        await expect(readFile(path, 'utf8')).resolves.toBe(answers[0]?.success ? 'first' : 'second');
    });

    it('rejects a malformed attempt id before writing', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        const path = join(workingDirectory, 'new.md');

        await expect(handlers.get('writeFile')?.({
            path, content: b64('x'), expectedHash: null, attemptId: 'bad id/with spaces',
        })).resolves.toMatchObject({ success: false, errorCode: 'INVALID_ATTEMPT_ID' });
        await expect(readdir(workingDirectory)).resolves.toEqual([]);
    });
});

/*
 * A 151 MB tree of a repository root went over happy-server's 100 MB message
 * limit, so the server closed the machine socket on every answer and the caller
 * asked again after each reconnect (2026-10-31). A partial tree would hide files
 * without saying so; an over-limit tree is refused instead.
 */
describe('registerCommonHandlers getDirectoryTree entry limit', () => {
    async function createTree(entries: number) {
        const { handlers, workingDirectory } = await createHandlers(undefined, { directoryTreeMaxEntries: 4 });
        await mkdir(join(workingDirectory, 'src'));
        for (let i = 0; i < entries - 2; i++) await writeFile(join(workingDirectory, 'src', `f${i}.ts`), '');
        return { handler: handlers.get('getDirectoryTree'), workingDirectory };
    }

    it('returns the tree when it holds exactly the limit', async () => {
        const { handler, workingDirectory } = await createTree(4);

        const result = await handler?.({ path: workingDirectory, maxDepth: 8 }) as any;

        expect(result.success).toBe(true);
        expect(result.tree.children).toEqual([expect.objectContaining({ name: 'src' })]);
        expect(result.tree.children[0].children).toHaveLength(2);
    });

    it('refuses a tree over the limit instead of returning part of it', async () => {
        const { handler, workingDirectory } = await createTree(5);

        const result = await handler?.({ path: workingDirectory, maxDepth: 8 });

        expect(result).toEqual({
            success: false,
            errorCode: 'DIRECTORY_TREE_TOO_LARGE',
            error: 'Directory tree has more than 4 entries; open a subdirectory or lower maxDepth',
        });
    });

    it('stops reading the disk once the limit is passed', async () => {
        const { handler, workingDirectory } = await createTree(50);
        statCalls.count = 0;

        await expect(handler?.({ path: workingDirectory, maxDepth: 8 })).resolves.toMatchObject({ success: false });

        // One stat per node it kept, not one per entry on disk.
        expect(statCalls.count).toBeLessThanOrEqual(4);
    });
});

// aplus-dev-studio specs/remote-file-list-pages — the file list of a workspace
// too large for one getDirectoryTree answer, a page at a time.
describe('registerCommonHandlers listFilesPage', () => {
    async function createWorkspace() {
        const { handlers, workingDirectory } = await createHandlers();
        const files = ['.gitignore', 'a.txt', 'src/b.ts', 'src/deep/c.ts', 'src/deep/deeper/d.ts', 'out/e.js', 'node_modules/x/i.js'];
        for (const rel of files) {
            await mkdir(dirname(join(workingDirectory, rel)), { recursive: true });
            await writeFile(join(workingDirectory, rel), rel === '.gitignore' ? 'out/\n' : 'x');
        }
        return { handlers, workingDirectory };
    }

    function treeFiles(node: any, root: string): string[] {
        if (node.type === 'file') return [node.path.slice(root.length + 1)];
        return (node.children ?? []).flatMap((child: any) => treeFiles(child, root));
    }

    async function allPages(list: Handler, params: Record<string, unknown>) {
        const pages: any[] = [];
        let cursor: string | undefined;
        do {
            const page = await list({ ...params, ...(cursor === undefined ? {} : { cursor }) });
            pages.push(page);
            cursor = page.nextCursor as string | undefined;
        } while (cursor);
        return pages;
    }

    it('pages through exactly the files getDirectoryTree would return', async () => {
        const { handlers, workingDirectory } = await createWorkspace();
        const tree = await handlers.get('getDirectoryTree')!({ path: workingDirectory, maxDepth: 3 });

        const pages = await allPages(handlers.get('listFilesPage')!, { path: workingDirectory, maxDepth: 3, limit: 2 });

        expect(pages.map((page) => page.entries.length)).toEqual([2, 2]);
        expect(pages.at(-1).nextCursor).toBeNull();
        const listed = pages.flatMap((page) => page.entries.map((entry: any) => entry.relPath));
        expect(listed).toEqual(['.gitignore', 'a.txt', 'src/b.ts', 'src/deep/c.ts']);
        expect([...listed].sort()).toEqual(treeFiles(tree.tree, workingDirectory).sort());
        expect(pages[0].entries[1]).toEqual({
            relPath: 'a.txt', absPath: join(workingDirectory, 'a.txt'), size: 1, modified: expect.any(Number),
        });
    });

    it('lists nothing below maxDepth 1, as getDirectoryTree shows no children there', async () => {
        const { handlers, workingDirectory } = await createWorkspace();

        await expect(handlers.get('listFilesPage')!({ path: workingDirectory, maxDepth: 0 })).resolves.toEqual({
            success: true, entries: [], nextCursor: null,
        });
    });

    it('refuses a page size it cannot keep under the socket message limit, and paths outside the workspace', async () => {
        const { handlers, workingDirectory } = await createWorkspace();
        const list = handlers.get('listFilesPage')!;

        await expect(list({ path: workingDirectory, maxDepth: 3, limit: 10_001 })).resolves.toEqual({
            success: false, error: 'limit must be an integer between 1 and 10000',
        });
        await expect(list({ path: join(workingDirectory, '..'), maxDepth: 3 })).resolves.toMatchObject({ success: false });
    });

    it('treats a null cursor as the first page and refuses one that is not a string', async () => {
        const { handlers, workingDirectory } = await createWorkspace();
        const list = handlers.get('listFilesPage')!;

        await expect(list({ path: workingDirectory, maxDepth: 3, cursor: null, limit: 1 })).resolves.toMatchObject({
            success: true, entries: [expect.objectContaining({ relPath: '.gitignore' })],
        });
        await expect(list({ path: workingDirectory, maxDepth: 3, cursor: 5 })).resolves.toEqual({
            success: false, error: 'cursor must be a string',
        });
    });

    it('refuses a maxDepth that is not a non-negative integer', async () => {
        const { handlers, workingDirectory } = await createWorkspace();
        const list = handlers.get('listFilesPage')!;

        for (const maxDepth of [undefined, 0.5, -1, Number.NaN]) {
            await expect(list({ path: workingDirectory, maxDepth }), String(maxDepth)).resolves.toEqual({
                success: false, error: 'maxDepth must be a non-negative integer',
            });
        }
    });

    // getDirectoryTree fails on a root it cannot read; an empty "success" here would let a
    // move or a backup carry nothing without saying so.
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('fails on a root it cannot read', async () => {
        const { handlers, workingDirectory } = await createWorkspace();
        const locked = join(workingDirectory, 'locked');
        await mkdir(locked);
        await writeFile(join(locked, 'a.txt'), 'x');
        await chmod(locked, 0o000);
        try {
            await expect(handlers.get('listFilesPage')!({ path: locked, maxDepth: 3 })).resolves.toEqual({
                success: false, error: 'Failed to access the specified path',
            });
        } finally {
            await chmod(locked, 0o755);
        }
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

    // aplus-dev-studio#5176: session digests are written here instead of writeFile,
    // which follows a committed `.ax` link into another user's folder.
    it('creates new project files without overwriting or writing through a link', async () => {
        const { handlers, workingDirectory } = await createHandlers();
        const write = handlers.get('writeWorkspaceFile');
        const path = join(workingDirectory, '.ax', 'session-digests', 'req-1', 'index.md');
        const content = Buffer.from('# digest').toString('base64');

        await expect(write?.({ workspaceRoot: workingDirectory, path, content, expectedHash: null })).resolves.toEqual({
            success: true, hash: createHash('sha256').update('# digest').digest('hex'),
        });
        await expect(readFile(path, 'utf8')).resolves.toBe('# digest');
        await expect(write?.({ workspaceRoot: workingDirectory, path, content: Buffer.from('other').toString('base64'), expectedHash: null })).resolves.toMatchObject({
            success: false, errorCode: 'EEXIST',
        });
        await expect(readFile(path, 'utf8')).resolves.toBe('# digest');
        await expect(write?.({ workspaceRoot: workingDirectory, path: join(workingDirectory, 'new.md'), content, expectedHash: 'abc' })).resolves.toMatchObject({
            success: false, errorCode: 'WORKSPACE_OVERWRITE_UNSUPPORTED',
        });
        await expect(write?.({ path: join(workingDirectory, 'new.md'), content, expectedHash: null })).resolves.toMatchObject({
            success: false, errorCode: 'WORKSPACE_PATH_DENIED',
        });

        const outside = await mkdtemp(join(tmpdir(), 'happy-write-outside-'));
        temporaryDirectories.push(outside);
        const project = join(workingDirectory, 'linked-project');
        await mkdir(project);
        await symlink(outside, join(project, '.ax'), process.platform === 'win32' ? 'junction' : 'dir');
        await expect(write?.({ workspaceRoot: project, path: join(project, '.ax', 'session-digests', 'r', 'index.md'), content, expectedHash: null })).resolves.toMatchObject({
            success: false, errorCode: 'WORKSPACE_PATH_DENIED',
        });
        await expect(readdir(outside)).resolves.toEqual([]);
    });
});

/*
 * aplus-dev-studio specs/e2ee-machine-control-boundary R11 — under strict
 * machine control no file RPC reaches the machine key, the session keys or the
 * account secret backup, even from a working directory that contains them.
 */
describe('file RPCs under strict machine control', () => {
    const mode = configuration as { machineControl: 'compat' | 'strict' };
    const previous = mode.machineControl;
    afterEach(() => { mode.machineControl = previous; });

    it('keeps out of the happy home and nowhere else', async () => {
        const home = configuration.happyHomeDir;
        const { handlers, workingDirectory } = await createHandlers(dirname(home));
        await writeFile(join(home, 'sessions.json'), '{"secret":true}');
        const project = await mkdtemp(join(workingDirectory, 'happy-strict-project-'));
        temporaryDirectories.push(project);
        await writeFile(join(project, 'notes.md'), 'ok');
        mode.machineControl = 'strict';

        await expect(handlers.get('readFile')?.({ path: join(home, 'sessions.json') })).resolves.toMatchObject({ success: false });
        await expect(handlers.get('writeFile')?.({ path: join(home, 'access.key'), content: 'eA==', expectedHash: null })).resolves.toMatchObject({ success: false });
        await expect(handlers.get('listDirectory')?.({ path: home })).resolves.toMatchObject({ success: false });
        await expect(handlers.get('readWorkspaceFile')?.({ workspaceRoot: home, path: join(home, 'sessions.json') })).resolves.toMatchObject({
            success: false, errorCode: 'WORKSPACE_PATH_DENIED',
        });
        await expect(handlers.get('listWorkspaceDirectory')?.({ workspaceRoot: dirname(home), path: home })).resolves.toMatchObject({
            success: false, errorCode: 'WORKSPACE_PATH_DENIED',
        });
        await expect(handlers.get('writeWorkspaceFile')?.({ workspaceRoot: dirname(home), path: join(home, 'access.key'), content: 'eA==', expectedHash: null })).resolves.toMatchObject({
            success: false, errorCode: 'WORKSPACE_PATH_DENIED',
        });

        await expect(handlers.get('readFile')?.({ path: join(project, 'notes.md') })).resolves.toMatchObject({ success: true });
        // A workspace read re-checks every directory from its allowed root down and refuses
        // when one changed. The shared temp root changes under parallel tests, so this read
        // is rooted at the project.
        const { handlers: projectHandlers } = await createHandlers(project);
        await expect(projectHandlers.get('readWorkspaceFile')?.({ workspaceRoot: project, path: join(project, 'notes.md') })).resolves.toMatchObject({ success: true });
    });

    it('leaves the happy home where it was in compat', async () => {
        const home = configuration.happyHomeDir;
        const { handlers } = await createHandlers(dirname(home));
        await mkdir(home, { recursive: true });
        await writeFile(join(home, 'sessions.json'), '{}');
        mode.machineControl = 'compat';

        await expect(handlers.get('readFile')?.({ path: join(home, 'sessions.json') })).resolves.toMatchObject({ success: true });
    });
});

describe.skipIf(process.platform === 'win32')('common filesystem mutation admission', () => {
    const mutation = createFilesystemWriteAdmission({ home: configuration.happyHomeDir });
    it.each(['writeFile', 'writeWorkspaceFile', 'renameFile', 'deleteFile', 'copyFile', 'ensureDirectory'])(
        'does not mutate files through %s while an automatic writer owns the workspace', async method => {
            const f = await createHandlers(undefined, Object.assign({ childEnvBoundary: 'session' as const }, { withFilesystemMutation: mutation }));
            const original = join(f.workingDirectory, 'original.txt'); await writeFile(original, 'original');
            const auto = createWorkspaceTurnAdmission({ home: configuration.happyHomeDir,
                sessionId: `automation-run:${randomUUID()}`, kind: 'automation', roots: [f.workingDirectory] });
            await auto.tryAcquire();
            const requests: Record<string, Record<string, unknown>> = {
                writeFile: { path: join(f.workingDirectory, 'created.txt'), content: Buffer.from('new').toString('base64') },
                writeWorkspaceFile: { workspaceRoot: f.workingDirectory, path: join(f.workingDirectory, 'created.txt'), content: Buffer.from('new').toString('base64') },
                renameFile: { path: original, newName: 'renamed.txt' }, deleteFile: { path: original },
                copyFile: { path: original, newName: 'copied.txt' }, ensureDirectory: { path: join(f.workingDirectory, 'created-dir') },
            };
            try {
                const result = await f.handlers.get(method)!(requests[method]);
                expect(result).toMatchObject({ success: false, error: expect.stringContaining('WORKSPACE_BUSY') });
                expect(await readFile(original, 'utf8')).toBe('original');
                expect(await readdir(f.workingDirectory)).toEqual(['original.txt']);
            } finally { await auto.release(true); }
            expect(await f.handlers.get(method)!(requests[method])).toHaveProperty('success', true);
        });
    it('keeps a refused write retryable and replays its original receipt without overwriting later automatic changes', async () => {
        const f = await createHandlers(undefined, { withFilesystemMutation: mutation });
        const path = join(f.workingDirectory, 'saved.txt');
        const request = { path, content: Buffer.from('saved').toString('base64'), expectedHash: null, attemptId: 'same-write-attempt' };
        const auto = createWorkspaceTurnAdmission({ home: configuration.happyHomeDir,
            sessionId: `automation-run:${randomUUID()}`, kind: 'automation', roots: [f.workingDirectory] });
        await auto.tryAcquire();
        try { expect(await f.handlers.get('writeFile')!(request)).toMatchObject({ success: false, error: 'WORKSPACE_BUSY' }); }
        finally { await auto.release(true); }
        const first = await f.handlers.get('writeFile')!(request);
        expect(first).toHaveProperty('success', true);
        await auto.tryAcquire();
        try {
            await writeFile(path, 'later automatic change');
            expect(await f.handlers.get('writeFile')!(request)).toEqual({ ...first, replayed: true });
            expect(await readFile(path, 'utf8')).toBe('later automatic change');
        } finally { await auto.release(true); }
    });

});
/*
 * aplus-dev-studio specs/approved-folder-roots — a folder outside the machine's
 * allowed root (e.g. C:\workspace beside C:\Users\me) opens only once the
 * machine owner approved it on this machine.
 */
describe('file RPCs for a folder the machine owner approved', () => {
    it('lists, runs commands in and creates folders under an approved folder outside the allowed root, and nothing beside it', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'happy-approved-'));
        temporaryDirectories.push(outside);
        const project = join(outside, 'hmall_ui');
        await mkdir(project);
        await writeFile(join(project, 'README.md'), 'hello');
        const beside = await mkdtemp(join(tmpdir(), 'happy-not-approved-'));
        temporaryDirectories.push(beside);

        const closed = await createHandlers();
        await expect(closed.handlers.get('listDirectory')?.({ path: project })).resolves.toMatchObject({ success: false });

        let approved: string[] = [outside];
        const { handlers } = await createHandlers(undefined, { approvedRoots: () => approved });
        await expect(handlers.get('listDirectory')?.({ path: project })).resolves.toMatchObject({
            success: true, entries: [expect.objectContaining({ name: 'README.md' })],
        });
        await expect(handlers.get('readFile')?.({ path: join(project, 'README.md') })).resolves.toMatchObject({ success: true });
        await expect(handlers.get('bash')?.({ command: 'echo ok', cwd: project })).resolves.toMatchObject({ success: true });
        await expect(handlers.get('ensureDirectory')?.({ path: join(outside, 'new-app') })).resolves.toMatchObject({ success: true });
        await expect(handlers.get('deleteFile')?.({ path: outside })).resolves.toMatchObject({ success: false });
        await expect(handlers.get('listDirectory')?.({ path: beside })).resolves.toMatchObject({ success: false });

        approved = [];
        await expect(handlers.get('listDirectory')?.({ path: project })).resolves.toMatchObject({ success: false });
    });

    it('anchors the workspace read, download and create-only write RPCs at an approved folder, until revoked', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'happy-approved-workspace-'));
        temporaryDirectories.push(outside);
        const project = join(outside, 'hmall_ui');
        await mkdir(project);
        await writeFile(join(project, 'README.md'), 'hello');

        let approved: string[] = [outside];
        const { handlers } = await createHandlers(undefined, { approvedRoots: () => approved });
        await expect(handlers.get('listWorkspaceDirectory')?.({ workspaceRoot: project, path: project })).resolves.toMatchObject({ success: true });
        await expect(handlers.get('readWorkspaceFile')?.({ workspaceRoot: project, path: join(project, 'README.md') })).resolves.toMatchObject({
            success: true, content: Buffer.from('hello').toString('base64'),
        });
        await expect(handlers.get('listWorkspaceDownloadDirectory')?.({ workspaceRoot: project, path: project, offset: 0 })).resolves.toMatchObject({ success: true });
        await expect(handlers.get('writeWorkspaceFile')?.({ workspaceRoot: project, path: join(project, 'notes.md'), content: Buffer.from('new').toString('base64'), expectedHash: null })).resolves.toMatchObject({ success: true });
        expect(await readFile(join(project, 'notes.md'), 'utf8')).toBe('new');

        approved = [];
        await expect(handlers.get('listWorkspaceDirectory')?.({ workspaceRoot: project, path: project })).resolves.toMatchObject({ success: false, errorCode: 'WORKSPACE_PATH_DENIED' });
        await expect(handlers.get('readWorkspaceFile')?.({ workspaceRoot: project, path: join(project, 'README.md') })).resolves.toMatchObject({ success: false });
        await expect(handlers.get('writeWorkspaceFile')?.({ workspaceRoot: project, path: join(project, 'other.md'), content: 'eA==', expectedHash: null })).resolves.toMatchObject({ success: false });
    });
});
