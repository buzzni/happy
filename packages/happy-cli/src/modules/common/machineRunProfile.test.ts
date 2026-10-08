import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createProfileAwareMachineRunHandler,
    createTrustedMachineRunProfileResolver,
    type MachineRunProfile,
} from './machineRunProfile';

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
    for (let attempt = 0; attempt < 20; attempt++) {
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

    it('does not advertise or execute profiles with unenforced descendant policy', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const resolver = createTrustedMachineRunProfileResolver([profile({ descendantAllowlist: ['git'] })]);
            const handler = createProfileAwareMachineRunHandler(root, resolver);
            await expect(handler({ action: 'capabilities' })).resolves.toMatchObject({ supported: false, profiles: [] });
            const digest = resolver.list()[0].profileDigest;
            await expect(handler({ action: 'start', profileId: profile().id, profileDigest: digest, workspaceRoot: root, parameters: { message: 'x' } })).rejects.toThrow('MACHINE_RUN_DESCENDANT_POLICY_UNSUPPORTED');
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
