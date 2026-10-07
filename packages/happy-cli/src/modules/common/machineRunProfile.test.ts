import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
    });

    it('resolves a profile to argv with bounded parameters and a minimal environment', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const handler = createProfileAwareMachineRunHandler(root, [profile({
                executable: 'ruby',
                argv: ['-e', 'print "#{ENV.fetch("SAFE", "missing")}:#{ENV.fetch("SECRET", "missing")}:#{ARGV.fetch(0)}"'],
                envAllowlist: ['SAFE'],
                outputLimitBytes: 128,
            })], { environment: { PATH: process.env.PATH, SAFE: 'allowed', SECRET: 'hidden' } });
            await expect(handler({ action: 'capabilities' })).resolves.toMatchObject({
                supported: true,
                shell: false,
                stdin: 'none',
                profiles: [{ id: 'buzzni.test.echo', timeoutMs: 2_000, outputLimitBytes: 128 }],
            });
            const started = await handler({ action: 'start', profileId: 'buzzni.test.echo', parameters: { message: 'value;${HOME}' } });
            expect(started).toMatchObject({ action: 'start', state: 'accepted' });
            if (started.action !== 'start') return;
            await expect(waitForStatus(handler, started.operationId)).resolves.toMatchObject({
                state: 'passed', stdout: 'allowed:missing:value;${HOME}', exitCode: 0,
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('rejects unknown and out-of-range profile parameters', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-profile-'));
        try {
            const handler = createProfileAwareMachineRunHandler(root, [profile()]);
            await expect(handler({ action: 'start', profileId: 'missing.profile', parameters: {} })).rejects.toThrow('MACHINE_RUN_PROFILE_NOT_FOUND');
            await expect(handler({ action: 'start', profileId: 'buzzni.test.echo', parameters: { unknown: 'x' } })).rejects.toThrow('unknown parameter');
            await expect(handler({ action: 'start', profileId: 'buzzni.test.echo', parameters: {} })).rejects.toThrow('missing parameter');
            await expect(handler({ action: 'start', profileId: 'buzzni.test.echo', parameters: { message: 'x'.repeat(129) } })).rejects.toThrow('invalid parameter');
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
            await expect(handler({ action: 'start', profileId: 'buzzni.test.echo', parameters: { message: 'x' } })).rejects.toThrow('MACHINE_RUN_UNSUPPORTED_PLATFORM');
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
            await expect(handler({ action: 'start', profileId: 'buzzni.test.echo', parameters: { message: 'x' } })).rejects.toThrow('MACHINE_RUN_WRITE_SCOPE_UNSUPPORTED');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
