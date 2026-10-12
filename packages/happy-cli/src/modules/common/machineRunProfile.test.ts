import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { installManagedMachineTool, managedMachineToolPlatform } from './managedMachineTool';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    createManagedProjectWriteScopePolicy,
    createProfileAwareMachineRunHandler,
    createTrustedMachineRunProfileResolver,
    TRUSTED_MACHINE_RUN_PROFILE_REGISTRY,
    type MachineRunProfile,
} from './machineRunProfile';
import type { TypedMachineRunRequest, TypedMachineRunResponse } from './typedMachineRun';

function profile(overrides: Partial<MachineRunProfile> = {}): MachineRunProfile {
    return {
        id: 'buzzni.test.echo',
        executable: 'printf',
        argv: ['{{message}}'],
        parameters: { message: { type: 'string', maxLength: 128 } },
        cwd: 'workspaceRoot',
        envAllowlist: [],
        timeoutMs: 2_000,
        outputLimitBytes: 16,
        stdin: 'none',
        ...overrides,
    };
}

async function waitForStatus(handler: (input: unknown) => Promise<any>, operationId: string) {
    for (let attempt = 0; attempt < 120; attempt++) {
        const status = await handler({ action: 'status', operationId });
        if (status.state !== 'running') return status;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('operation did not finish');
}

describe('profile-aware machine.run adapter', () => {
    it('validates and freezes trusted profiles before resolving them', () => {
        const source = profile({
            parameters: { message: { type: 'string', maxLength: 128, values: ['safe'] } },
            descendantAllowlist: ['git'],
        });
        const resolver = createTrustedMachineRunProfileResolver([source]);
        source.argv[0] = 'changed';
        if (source.parameters.message.type === 'string' && source.parameters.message.values) source.parameters.message.values.push('changed');
        expect(resolver.resolve('buzzni.test.echo')?.argv).toEqual(['{{message}}']);
        expect(resolver.resolve('buzzni.test.echo')?.parameters.message).toEqual({ type: 'string', maxLength: 128, values: ['safe'] });
        expect(resolver.resolve('buzzni.test.echo')?.descendantAllowlist).toEqual(['git']);
        expect(() => {
            const parameter = resolver.resolve('buzzni.test.echo')?.parameters.message;
            if (parameter?.type === 'string') parameter.values?.push('still-immutable');
        }).toThrow();
        expect(() => createTrustedMachineRunProfileResolver([profile(), profile({ id: 'buzzni.test.echo' })])).toThrow('duplicate profile id');
        expect(() => createTrustedMachineRunProfileResolver([profile({ executable: 'sh' })])).toThrow('unsupported executable');
        expect(() => createTrustedMachineRunProfileResolver([profile({ argv: ['/tmp/tool'] })])).toThrow('unsafe argument');
        for (const key of ['PATH', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'GIT_CONFIG_COUNT']) {
            expect(() => createTrustedMachineRunProfileResolver([profile({ envAllowlist: [key] })])).toThrow('unsafe environment allowlist');
        }
    });

    it('resolves a profile to argv with bounded parameters and a minimal environment', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const handler = createProfileAwareMachineRunHandler(root, [profile({
                executable: 'printf',
                argv: ['%s', '{{message}}'],
                envAllowlist: ['SAFE'],
                outputLimitBytes: 128,
            })], { environment: { PATH: process.env.PATH, SAFE: 'allowed', SECRET: 'hidden' } });
            const capabilities = await handler({ action: 'capabilities' });
            await expect(capabilities).toMatchObject({
                supported: true,
                shell: false,
                stdin: 'none',
                profiles: [{ id: 'buzzni.test.echo', timeoutMs: 2_000, outputLimitBytes: 128, profileDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }],
            });
            const profileDigest = capabilities.action === 'capabilities' ? capabilities.profiles[0].profileDigest : '';
            const started = await handler({ action: 'start', profileId: 'buzzni.test.echo', profileDigest, workspaceRoot: root, parameters: { message: 'value;${HOME}' } });
            expect(started).toMatchObject({ action: 'start', state: 'accepted' });
            if (started.action !== 'start') return;
            await expect(waitForStatus(handler, started.operationId)).resolves.toMatchObject({
                state: 'passed', stdout: 'value;${HOME}', exitCode: 0,
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('rejects unknown and out-of-range profile parameters', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const handler = createProfileAwareMachineRunHandler(root, [profile()]);
            const digest = (await handler({ action: 'capabilities' }) as Extract<Awaited<ReturnType<typeof handler>>, { action: 'capabilities' }>).profiles[0].profileDigest;
            const request = (parameters: Record<string, unknown>) => ({ action: 'start', profileId: 'buzzni.test.echo', profileDigest: digest, workspaceRoot: root, parameters });
            await expect(handler({ ...request({ message: 'x' }), profileId: 'missing.profile' })).rejects.toThrow('MACHINE_RUN_PROFILE_NOT_FOUND');
            await expect(handler(request({ unknown: 'x' }))).rejects.toThrow('unknown parameter');
            await expect(handler(request({}))).rejects.toThrow('missing parameter');
            await expect(handler(request({ message: 'x'.repeat(129) }))).rejects.toThrow('invalid parameter');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('renders partial placeholders and appends unused parameters in declaration order', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const handler = createProfileAwareMachineRunHandler(root, [profile({
                argv: ['%s:%s:%s', '{{message}}', '{{suffix}}'],
                parameters: {
                    message: { type: 'string', maxLength: 32 },
                    suffix: { type: 'string', maxLength: 32 },
                    count: { type: 'integer', min: 1, max: 9 },
                },
            })]);
            const capabilities = await handler({ action: 'capabilities' }) as Extract<Awaited<ReturnType<typeof handler>>, { action: 'capabilities' }>;
            const started = await handler({ action: 'start', profileId: 'buzzni.test.echo', profileDigest: capabilities.profiles[0].profileDigest, workspaceRoot: root, parameters: { count: 3, suffix: 'b', message: 'a' } });
            if (started.action !== 'start') return;
            await expect(waitForStatus(handler, started.operationId)).resolves.toMatchObject({ state: 'passed', stdout: 'a:b:3', exitCode: 0 });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('negotiates Windows as explicitly unsupported before attempting a child', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const handler = createProfileAwareMachineRunHandler(root, [profile()], { platform: 'win32' });
            await expect(handler({ action: 'capabilities' })).resolves.toMatchObject({
                supported: false,
                reason: 'MACHINE_RUN_UNSUPPORTED_PLATFORM: Windows Job backend is required',
                profiles: [],
            });
            await expect(handler({ action: 'start', profileId: 'buzzni.test.echo', profileDigest: 'a'.repeat(64), workspaceRoot: root, parameters: { message: 'x' } })).rejects.toThrow('MACHINE_RUN_UNSUPPORTED_PLATFORM');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('reports an unavailable capability when no trusted profile is registered', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const handler = createProfileAwareMachineRunHandler(root, []);
            await expect(handler({ action: 'capabilities' })).resolves.toMatchObject({
                supported: false,
                profiles: [],
                reason: 'MACHINE_RUN_PROFILE_REGISTRY_UNAVAILABLE: no trusted profiles are registered',
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('refuses declared write scopes until the daemon has a filesystem evidence backend', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const handler = createProfileAwareMachineRunHandler(root, [profile({ writeScope: 'project', descendantAllowlist: ['git'] })]);
            const capabilities = await handler({ action: 'capabilities' }) as Extract<Awaited<ReturnType<typeof handler>>, { action: 'capabilities' }>;
            expect(capabilities.supported).toBe(false);
            expect(capabilities.profiles).toEqual([]);
            const digest = createTrustedMachineRunProfileResolver([profile({ writeScope: 'project', descendantAllowlist: ['git'] })]).list()[0].profileDigest;
            await expect(handler({ action: 'start', profileId: 'buzzni.test.echo', profileDigest: digest, workspaceRoot: root, parameters: { message: 'x' } })).rejects.toThrow('MACHINE_RUN_WRITE_SCOPE_UNSUPPORTED');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('executes a project write only with an explicit host policy and releases its workspace lock', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const resolver = createTrustedMachineRunProfileResolver([profile({ writeScope: 'project' })]);
            const policy = {
                acquire: vi.fn(async () => {
                    let released = false;
                    return () => { released = true; };
                }),
            };
            const handler = createProfileAwareMachineRunHandler(root, resolver, {
                writeScopePolicy: policy,
                typedHandler: vi.fn(async (request: TypedMachineRunRequest): Promise<TypedMachineRunResponse> => request.action === 'start'
                    ? { version: 1, action: 'start', operationId: 'write-op', state: 'accepted' }
                    : { version: 1, action: 'status', operationId: 'write-op', state: 'passed', stdout: '', stderr: '', exitCode: 0, truncated: false, timedOut: false, remoteMayContinue: false, descendantsReaped: true, processGroupEvidence: { kind: 'no-local-trace' } }),
            });
            const digest = resolver.list()[0].profileDigest;
            await expect(handler({ action: 'start', profileId: profile().id, profileDigest: digest, workspaceRoot: root, parameters: { message: 'x' } })).resolves.toMatchObject({ operationId: 'write-op' });
            expect(policy.acquire).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: await realpath(root) }));
            await handler({ action: 'status', operationId: 'write-op' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('serializes project and .moai writes on one workspace and rejects escaping metadata', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        const outside = await mkdtemp(join(tmpdir(), 'happy-machine-outside-'));
        try {
            const resolver = createTrustedMachineRunProfileResolver([
                profile({ id: 'buzzni.moai.project', writeScope: 'project' }),
                profile({ id: 'buzzni.moai.meta', writeScope: 'moai' }),
            ]);
            const [projectProfile, moaiProfile] = resolver.list();
            const policy = createManagedProjectWriteScopePolicy();
            const release = await policy.acquire({ profile: projectProfile, workspaceRoot: root });
            await expect(policy.acquire({ profile: moaiProfile, workspaceRoot: root })).rejects.toThrow('MACHINE_RUN_WRITE_SCOPE_BUSY');
            release();
            const again = await policy.acquire({ profile: moaiProfile, workspaceRoot: root });
            again();

            await symlink(outside, join(root, '.moai'));
            await expect(policy.acquire({ profile: moaiProfile, workspaceRoot: root })).rejects.toThrow('MACHINE_RUN_WRITE_SCOPE_DENIED');
            await rm(join(root, '.moai'));
            await mkdir(join(root, '.moai'));
            await symlink(outside, join(root, '.git'));
            await expect(policy.acquire({ profile: projectProfile, workspaceRoot: root })).rejects.toThrow('protected symlink .git');
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
        }
    });

    it('lets a profile resolve only its executable and allowlisted descendants by name', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const finder = (descendantAllowlist: string[]) => profile({
                id: 'buzzni.test.find', executable: 'find', parameters: {}, outputLimitBytes: 4096, descendantAllowlist,
                argv: ['{{workspaceRoot}}', '-maxdepth', '0', '-exec', 'ls', '-d', '{}', '+'],
            });
            const run = async (descendantAllowlist: string[]) => {
                const resolver = createTrustedMachineRunProfileResolver([finder(descendantAllowlist)]);
                const handler = createProfileAwareMachineRunHandler(root, resolver);
                const started = await handler({ action: 'start', profileId: 'buzzni.test.find', profileDigest: resolver.list()[0].profileDigest, workspaceRoot: root, parameters: {} });
                if (started.action !== 'start') throw new Error('not started');
                return { handler, status: await waitForStatus(handler, started.operationId) };
            };
            await expect(run([])).resolves.toMatchObject({ status: { state: 'failed' } });
            const allowed = await run(['ls']);
            expect(allowed.status).toMatchObject({ state: 'passed', exitCode: 0, stdout: expect.stringContaining(await realpath(root)) });
            await expect(allowed.handler({ action: 'capabilities' })).resolves.toMatchObject({
                supported: true,
                profiles: [{ id: 'buzzni.test.find', writeScope: 'none', descendantAllowlist: ['ls'] }],
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('runs an allowlisted git descendant without hooks, pager or credential prompts', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            expect(spawnSync('git', ['init', '-q', root]).status).toBe(0);
            const resolver = createTrustedMachineRunProfileResolver([
                profile({ id: 'buzzni.test.env', executable: 'printenv', outputLimitBytes: 4096, descendantAllowlist: ['git'], argv: ['{{name}}'],
                    parameters: { name: { type: 'string', maxLength: 32, values: ['GIT_TERMINAL_PROMPT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_PAGER'] } } }),
                profile({ id: 'buzzni.test.git', executable: 'find', parameters: {}, outputLimitBytes: 4096, descendantAllowlist: ['git'],
                    argv: ['{{workspaceRoot}}', '-maxdepth', '0', '-exec', 'git', 'status', '--porcelain', '{}', '+'] }),
            ]);
            const handler = createProfileAwareMachineRunHandler(root, resolver);
            const runProfile = async (index: number, parameters: Record<string, string> = {}) => {
                const target = resolver.list()[index];
                const started = await handler({ action: 'start', profileId: target.id, profileDigest: target.profileDigest, workspaceRoot: root, parameters });
                if (started.action !== 'start') throw new Error('not started');
                return waitForStatus(handler, started.operationId);
            };
            const expected = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_PAGER: 'cat' };
            for (const [name, value] of Object.entries(expected)) {
                await expect(runProfile(0, { name })).resolves.toMatchObject({ state: 'passed', stdout: `${value}\n` });
            }
            await expect(runProfile(1)).resolves.toMatchObject({ state: 'passed', exitCode: 0 });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('holds a project write lock until the process exits, not until a status poll', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const resolver = createTrustedMachineRunProfileResolver([profile({
                id: 'buzzni.test.sleep', executable: 'sleep', argv: ['0.4'], parameters: {}, writeScope: 'project', descendantAllowlist: ['git'],
            })]);
            const handler = createProfileAwareMachineRunHandler(root, resolver, { writeScopePolicy: createManagedProjectWriteScopePolicy() });
            await expect(handler({ action: 'capabilities' })).resolves.toMatchObject({
                supported: true, profiles: [{ id: 'buzzni.test.sleep', writeScope: 'project' }],
            });
            const request = { action: 'start', profileId: 'buzzni.test.sleep', profileDigest: resolver.list()[0].profileDigest, workspaceRoot: root, parameters: {} };
            const started = await handler(request);
            if (started.action !== 'start') throw new Error('not started');
            await expect(handler({ action: 'status', operationId: started.operationId })).resolves.toMatchObject({ state: 'running' });
            await expect(handler(request)).rejects.toThrow('MACHINE_RUN_WRITE_SCOPE_BUSY');
            await expect(waitForStatus(handler, started.operationId)).resolves.toMatchObject({ state: 'passed' });
            await new Promise((resolve) => setTimeout(resolve, 50));
            await expect(handler(request)).resolves.toMatchObject({ state: 'accepted' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('does not advertise write profiles when the host installed no write policy', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const handler = createProfileAwareMachineRunHandler(root, [
                profile(),
                profile({ id: 'buzzni.test.write', writeScope: 'moai', descendantAllowlist: ['git'] }),
            ]);
            await expect(handler({ action: 'capabilities' })).resolves.toMatchObject({ supported: true, profiles: [{ id: 'buzzni.test.echo' }] });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('runs a managed tool only from its verified install, never from PATH', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const script = '#!/bin/sh\necho managed\n';
            const source = join(root, 'src');
            await mkdir(join(source, 'fake-tool-v1'), { recursive: true });
            await writeFile(join(source, 'fake-tool-v1', 'fake-tool'), script, { mode: 0o755 });
            await tar.c({ gzip: true, file: join(root, 'a.tar.gz'), cwd: source, portable: true }, ['fake-tool-v1']);
            const bytes = await readFile(join(root, 'a.tar.gz'));
            const artifact = {
                url: 'https://github.com/buzzni/fake/releases/download/v1/fake-tool-v1.tar.gz',
                sha256: createHash('sha256').update(bytes).digest('hex'),
                archiveRoot: 'fake-tool-v1',
                executableSha256: createHash('sha256').update(script).digest('hex'),
            };
            const fakeTool = { id: 'buzzni.fake', version: '1.0.0', executable: 'fake-tool', artifacts: { 'darwin-arm64': artifact, 'linux-x64': artifact } };
            const decoys = join(root, 'decoys');
            await mkdir(decoys);
            await writeFile(join(decoys, 'fake-tool'), '#!/bin/sh\necho from-path\n', { mode: 0o755 });
            const toolsRoot = join(root, 'tools');
            const resolver = createTrustedMachineRunProfileResolver([profile({ id: 'buzzni.fake.run', executable: 'fake-tool', argv: ['x'], parameters: {} })]);
            const handler = createProfileAwareMachineRunHandler(root, resolver, {
                environment: { PATH: `${decoys}:/usr/bin:/bin` },
                managedTools: { root: toolsRoot, tools: [fakeTool] },
            });
            await expect(handler({ action: 'capabilities' })).resolves.toMatchObject({
                profiles: [{ id: 'buzzni.fake.run', tool: 'buzzni.fake' }],
                tools: [{ toolId: 'buzzni.fake', version: '1.0.0', supported: true, installed: false }],
            });
            const request = { action: 'start', profileId: 'buzzni.fake.run', profileDigest: resolver.list()[0].profileDigest, workspaceRoot: root, parameters: {} };
            await expect(handler(request)).rejects.toThrow('MACHINE_RUN_TOOL_NOT_INSTALLED');

            await installManagedMachineTool(fakeTool, {
                root: toolsRoot, platform: managedMachineToolPlatform(),
                fetch: async () => ({ ok: true, status: 200, url: artifact.url, headers: new Headers(), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }),
            });
            const started = await handler(request);
            if (started.action !== 'start') throw new Error('not started');
            await expect(waitForStatus(handler, started.operationId)).resolves.toMatchObject({ state: 'passed', stdout: 'managed\n' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('advertises the stable link for an installed tool but executes only the re-verified versioned binary', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const script = '#!/bin/sh\necho managed\n';
            const source = join(root, 'src');
            await mkdir(join(source, 'fake-tool-v1'), { recursive: true });
            await writeFile(join(source, 'fake-tool-v1', 'fake-tool'), script, { mode: 0o755 });
            await tar.c({ gzip: true, file: join(root, 'a.tar.gz'), cwd: source, portable: true }, ['fake-tool-v1']);
            const bytes = await readFile(join(root, 'a.tar.gz'));
            const artifact = {
                url: 'https://github.com/buzzni/fake/releases/download/v1/fake-tool-v1.tar.gz',
                sha256: createHash('sha256').update(bytes).digest('hex'),
                archiveRoot: 'fake-tool-v1',
                executableSha256: createHash('sha256').update(script).digest('hex'),
            };
            const fakeTool = { id: 'buzzni.fake', version: '1.0.0', executable: 'fake-tool', artifacts: { 'darwin-arm64': artifact, 'linux-x64': artifact } };
            const toolsRoot = join(root, 'tools');
            const stablePath = join(toolsRoot, 'buzzni.fake', 'bin', 'fake-tool');
            const versionedPath = join(toolsRoot, 'buzzni.fake', '1.0.0', 'fake-tool');
            const resolver = createTrustedMachineRunProfileResolver([profile({ id: 'buzzni.fake.run', executable: 'fake-tool', argv: ['x'], parameters: {} })]);
            let wrapper = '';
            const handler = createProfileAwareMachineRunHandler(root, resolver, {
                platform: 'darwin',
                tempDirectory: root,
                environment: { PATH: '/usr/bin:/bin' },
                managedTools: { root: toolsRoot, tools: [fakeTool], platform: 'darwin-arm64' },
                typedHandler: vi.fn(async (request: TypedMachineRunRequest, trusted): Promise<TypedMachineRunResponse> => {
                    if (request.action !== 'start' || !trusted?.env.PATH) throw new Error('unexpected request');
                    wrapper = await readFile(join(trusted.env.PATH, 'fake-tool'), 'utf8');
                    return { version: 1, action: 'start', operationId: 'op-1', state: 'accepted' };
                }),
            });
            const before = await handler({ action: 'capabilities' });
            if (before.action !== 'capabilities') throw new Error('not capabilities');
            for (const field of ['executablePath', 'resolvedVersion', 'executableSha256']) expect(before.tools[0]).not.toHaveProperty(field);

            await installManagedMachineTool(fakeTool, {
                root: toolsRoot, platform: 'darwin-arm64',
                fetch: async () => ({ ok: true, status: 200, url: artifact.url, headers: new Headers(), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }),
            });
            await expect(handler({ action: 'capabilities' })).resolves.toMatchObject({
                tools: [{ toolId: 'buzzni.fake', version: '1.0.0', supported: true, installed: true, executablePath: stablePath, resolvedVersion: '1.0.0', executableSha256: artifact.executableSha256 }],
            });

            await handler({ action: 'start', profileId: 'buzzni.fake.run', profileDigest: resolver.list()[0].profileDigest, workspaceRoot: root, parameters: {} });
            expect(wrapper).toContain(`exec '${versionedPath}'`);
            expect(wrapper).not.toContain(stablePath);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('does not advertise a managed-tool profile on a platform without a pinned artifact', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const fakeTool = { id: 'buzzni.fake', version: '1.0.0', executable: 'fake-tool', artifacts: {} };
            const handler = createProfileAwareMachineRunHandler(root, [profile({ id: 'buzzni.fake.run', executable: 'fake-tool', argv: ['x'], parameters: {} })], {
                managedTools: { root: join(root, 'tools'), tools: [fakeTool] },
            });
            await expect(handler({ action: 'capabilities' })).resolves.toMatchObject({ supported: false, profiles: [] });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('requires the trusted digest and daemon workspace root at the RPC boundary', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const handler = createProfileAwareMachineRunHandler(root, [profile()]);
            const capabilities = await handler({ action: 'capabilities' }) as Extract<Awaited<ReturnType<typeof handler>>, { action: 'capabilities' }>;
            const profileDigest = capabilities.profiles[0].profileDigest;
            const base = { action: 'start', profileId: 'buzzni.test.echo', profileDigest, workspaceRoot: root, parameters: { message: 'x' } };
            await expect(handler({ ...base, profileDigest: 'b'.repeat(64) })).rejects.toThrow('MACHINE_RUN_PROFILE_DIGEST_MISMATCH');
            await expect(handler({ ...base, workspaceRoot: '.' })).rejects.toThrow('workspaceRoot must be absolute');
            await expect(handler({ ...base, workspaceRoot: join(root, '..') })).rejects.toThrow('MACHINE_RUN_WORKSPACE_ROOT_DENIED');
            const outside = await mkdtemp(join(tmpdir(), 'happy-machine-profile-outside-'));
            const link = join(root, 'linked');
            await symlink(outside, link);
            await expect(handler({ ...base, workspaceRoot: link })).rejects.toThrow('MACHINE_RUN_WORKSPACE_ROOT_DENIED');
            await rm(outside, { recursive: true, force: true });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('rejects renderer-supplied resolved profiles and unknown authority fields', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const handler = createProfileAwareMachineRunHandler(root, [profile()]);
            const capabilities = await handler({ action: 'capabilities' }) as Extract<Awaited<ReturnType<typeof handler>>, { action: 'capabilities' }>;
            const request = { action: 'start', profileId: 'buzzni.test.echo', profileDigest: capabilities.profiles[0].profileDigest, workspaceRoot: root, parameters: { message: 'x' } };
            await expect(handler({ ...request, profile: { executable: 'printf', argv: ['x'] } })).rejects.toThrow('unknown field profile');
            await expect(handler({ ...request, authority: 'renderer' })).rejects.toThrow('unknown field authority');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

/**
 * Desktop keeps the same fixture under its `tests/` and asserts it sends exactly
 * these shapes. Both copies must change together, or Desktop and the daemon
 * drift into requests one side rejects.
 */
describe('Desktop machine.run request conformance (v1 fixture)', () => {
    type FixtureRequests = Record<'capabilities' | 'start' | 'status' | 'cancel', Record<string, unknown>>;
    const fixture = (): Promise<FixtureRequests> => readFile(join(__dirname, '__fixtures__', 'desktop-machine-run-requests.v1.json'), 'utf8').then((raw) => JSON.parse(raw) as FixtureRequests);
    const handler = (root: string) => createProfileAwareMachineRunHandler(root, TRUSTED_MACHINE_RUN_PROFILE_REGISTRY, {
        platform: 'darwin',
        typedHandler: vi.fn(async (request: TypedMachineRunRequest): Promise<TypedMachineRunResponse> => {
            if (request.action === 'cancel') return { version: 1, action: 'cancel', operationId: request.operationId, state: 'already-terminal', remoteMayContinue: false, descendantsReaped: true, processGroupEvidence: { kind: 'no-local-trace' } };
            if (request.action === 'status') return { version: 1, action: 'status', operationId: request.operationId, state: 'passed', stdout: '', stderr: '', exitCode: 0, truncated: false, timedOut: false, remoteMayContinue: false, descendantsReaped: true, processGroupEvidence: { kind: 'no-local-trace' } };
            throw new Error('unexpected start');
        }),
    });

    it('accepts every Desktop request shape at the daemon boundary', async () => {
        const requests = await fixture();
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const machineRun = handler(root);
            await expect(machineRun(requests.capabilities)).resolves.toMatchObject({ action: 'capabilities', version: 1 });
            // Shape, profile id and pinned digest all pass; only the fixture's
            // workspace (outside this daemon's root) stops it. A digest drift
            // fails here with MACHINE_RUN_PROFILE_DIGEST_MISMATCH instead.
            await expect(machineRun(requests.start)).rejects.toThrow('MACHINE_RUN_WORKSPACE_ROOT_DENIED');
            await expect(machineRun(requests.status)).resolves.toMatchObject({ action: 'status', operationId: 'op-1' });
            await expect(machineRun(requests.cancel)).resolves.toMatchObject({ action: 'cancel', operationId: 'op-1' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it.each(['status', 'cancel'] as const)('rejects a %s request carrying start-only fields', async (action) => {
        const requests = await fixture();
        const machineRun = handler(tmpdir());
        await expect(machineRun({ ...requests[action], workspaceRoot: '/workspace/project' })).rejects.toThrow('MACHINE_RUN_INVALID: unknown field workspaceRoot');
        await expect(machineRun({ ...requests[action], profileDigest: requests.start.profileDigest })).rejects.toThrow('MACHINE_RUN_INVALID: unknown field profileDigest');
    });
});

