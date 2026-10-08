import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createManagedProjectWriteScopePolicy,
    createProfileAwareMachineRunHandler,
    TRUSTED_MACHINE_RUN_PROFILE_REGISTRY,
} from './machineRunProfile';

const READ_PROFILES = ['status', 'ready', 'prime', 'show', 'stats', 'wiki-ls', 'wiki-show'].map((name) => `buzzni.moai.${name}`);
const WRITE_PROFILES = ['add', 'mv', 'edit', 'rm', 'note', 'defer', 'link', 'backlog'].map((name) => `buzzni.moai.${name}`);

describe('Moai v0.8.0 host-owned machine.run catalog', () => {
    it('ships every read and write operation in the daemon registry', () => {
        const profiles = TRUSTED_MACHINE_RUN_PROFILE_REGISTRY.list();
        expect(profiles.map((profile) => profile.id).sort()).toEqual([...READ_PROFILES, ...WRITE_PROFILES].sort());
        for (const profile of profiles) {
            expect(profile).toMatchObject({
                executable: 'moai',
                cwd: 'workspaceRoot',
                // Moai reads its user config from HOME, and writes take the actor from git config.
                envAllowlist: ['HOME'],
                descendantAllowlist: ['git'],
                stdin: 'none',
            });
            expect(profile.argv.slice(0, 3)).toEqual(['--json', '-C', '{{workspaceRoot}}']);
            expect(profile.writeScope ?? 'none').toBe(WRITE_PROFILES.includes(profile.id) ? 'moai' : 'none');
        }
    });

    it('limits a status move to the four Moai columns', () => {
        expect(TRUSTED_MACHINE_RUN_PROFILE_REGISTRY.resolve('buzzni.moai.mv')?.parameters.target)
            .toEqual({ type: 'string', maxLength: 32, values: ['todo', 'in_progress', 'review', 'done'] });
    });

    // Extensions declare these profiles verbatim; Desktop computes the same digest
    // from the manifest. A change here must be mirrored in the Moai extension.
    it('keeps the profile digests the Moai extension manifest is pinned to', () => {
        const digests = Object.fromEntries(TRUSTED_MACHINE_RUN_PROFILE_REGISTRY.list().map((profile) => [profile.id, profile.profileDigest]));
        expect(digests).toEqual(MOAI_PROFILE_DIGESTS);
    });

    it('advertises write operations only where the host installed the write policy', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-moai-catalog-'));
        try {
            const machine = createProfileAwareMachineRunHandler(root, TRUSTED_MACHINE_RUN_PROFILE_REGISTRY, { platform: 'darwin', writeScopePolicy: createManagedProjectWriteScopePolicy() });
            const session = createProfileAwareMachineRunHandler(root, TRUSTED_MACHINE_RUN_PROFILE_REGISTRY, { platform: 'linux' });
            const windows = createProfileAwareMachineRunHandler(root, TRUSTED_MACHINE_RUN_PROFILE_REGISTRY, { platform: 'win32' });
            const ids = async (handler: typeof machine) => {
                const response = await handler({ action: 'capabilities' });
                return response.action === 'capabilities' ? response.profiles.map((profile) => profile.id).sort() : [];
            };
            expect(await ids(machine)).toEqual([...READ_PROFILES, ...WRITE_PROFILES].sort());
            expect(await ids(session)).toEqual([...READ_PROFILES].sort());
            expect(await ids(windows)).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

const MOAI_PROFILE_DIGESTS: Record<string, string> = {
    'buzzni.moai.add': 'c36a5991cca3a460098b140ce3da31e2435242853bf3b85fcea4af1be4f3fc46',
    'buzzni.moai.backlog': 'fe7d0e75b7728f8993a197f7d07adeffe3efd0a345a22fa234803bcf81d88ada',
    'buzzni.moai.defer': '04b9cf21d5204be7f19ea24256a8a908d24021ae32e02403509737f1e777fdbc',
    'buzzni.moai.edit': 'db01944a5d32b746baa5cccefecfedcc44ee25398316a64d32c342bff70fea09',
    'buzzni.moai.link': 'c1c64b8599fdf5b10c036e636a12b10f95f06afb482824eb03473042946fb1d9',
    'buzzni.moai.mv': '52b23b9974a7e81ca3444e291553647ceb2d3535081d737ad922403a9ab12722',
    'buzzni.moai.note': '15c4b2d392301f5c8bb5312b99b1ab4e19a85d53bb96521428f5418fe52b0338',
    'buzzni.moai.prime': 'a3dfa272ef1708558429067f62db2fdb80abab339a099bbd4c6496db83515c57',
    'buzzni.moai.ready': '4b87f8176180c40b121847c03e6d0f7dd694ed2760485874aea457b5c654402b',
    'buzzni.moai.rm': '87cf16849c20cb8bed60c549479a2c04e8059ca0f04998afc22521329be508d9',
    'buzzni.moai.show': '3974f63352e420d45c2171b2abeeb4fcd25ff951c1c5e6ae8d49b9fa6b8707c1',
    'buzzni.moai.stats': '9c902a7ecefc05a7f7f5247b6fde59f8d74215aaf64a87088644ee4be2bbd04f',
    'buzzni.moai.status': '24dea4a121c0527eaacdb5d24e88085d31b4402d08437c49a0157b9f824e3672',
    'buzzni.moai.wiki-ls': 'a69f86adaad508dc3f7b42612417c606324eeea9a47cfc7233908aac3d8d66b0',
    'buzzni.moai.wiki-show': '4764a7838018292379c19a25ebb460615e42320afce7ac8cf2f4d30788c99816',
};
