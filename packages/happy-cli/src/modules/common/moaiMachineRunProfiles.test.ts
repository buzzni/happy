import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import moaiExtensionProfiles from './fixtures/moai-2.1.0-profiles.json';
import { MOAI_MANAGED_TOOL } from './moaiMachineRunProfiles';
import {
    createManagedProjectWriteScopePolicy,
    createProfileAwareMachineRunHandler,
    TRUSTED_MACHINE_RUN_PROFILE_REGISTRY,
} from './machineRunProfile';

const READ_PROFILES = ['status', 'ready', 'prime', 'show', 'stats', 'wiki-ls', 'wiki-show', 'show-all', 'backlog-all', 'show-archived', 'show-archived-after', 'read', 'read-all', 'read-group', 'skill-status', 'show-all-worktree', 'show-worktree'].map((name) => `buzzni.moai.${name}`);
const WRITE_PROFILES = ['add', 'mv', 'edit', 'rm', 'note', 'defer', 'link', 'backlog'].map((name) => `buzzni.moai.${name}`);
const PROJECT_WRITE_PROFILES = ['init'].map((name) => `buzzni.moai.${name}`);

describe('Moai 2.0 host-owned machine.run catalog', () => {
    it('ships every read and write operation in the daemon registry', () => {
        const profiles = TRUSTED_MACHINE_RUN_PROFILE_REGISTRY.list();
        expect(profiles.map((profile) => profile.id).sort()).toEqual([...READ_PROFILES, ...WRITE_PROFILES, ...PROJECT_WRITE_PROFILES].sort());
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
            expect(profile.writeScope ?? 'none').toBe(WRITE_PROFILES.includes(profile.id) ? 'moai' : PROJECT_WRITE_PROFILES.includes(profile.id) ? 'project' : 'none');
        }
    });


    // Source: saycode-extensions 0399a76 (PR #56), packages/moai/extension.json, less skill-install-saycode.
    it('accepts the released-CLI-compatible Moai 2.1 declarations without digest drift', () => {
        for (const declared of moaiExtensionProfiles) {
            const actual = TRUSTED_MACHINE_RUN_PROFILE_REGISTRY.resolve(declared.id);
            expect(actual, declared.id).toBeDefined();
            const { profileDigest, ...profile } = actual!;
            expect(profile, declared.id).toEqual(declared);
        }
    });

    it('does not advertise skill installation before the pinned CLI supports --hook-exe', () => {
        expect(TRUSTED_MACHINE_RUN_PROFILE_REGISTRY.resolve('buzzni.moai.skill-install-saycode')).toBeUndefined();
        expect(MOAI_MANAGED_TOOL.version).toBe('0.17.0');
        expect(Object.keys(MOAI_MANAGED_TOOL.artifacts).sort()).toEqual(['darwin-arm64', 'linux-x64']);
        for (const artifact of Object.values(MOAI_MANAGED_TOOL.artifacts)) {
            expect(artifact!.url).toContain('/v0.17.0/');
            expect(artifact!.sha256).toMatch(/^[a-f0-9]{64}$/);
            expect(artifact!.executableSha256).toMatch(/^[a-f0-9]{64}$/);
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
            expect(await ids(machine)).toEqual([...READ_PROFILES, ...WRITE_PROFILES, ...PROJECT_WRITE_PROFILES].sort());
            expect(await ids(session)).toEqual([...READ_PROFILES].sort());
            expect(await ids(windows)).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

const MOAI_PROFILE_DIGESTS: Record<string, string> = {
    'buzzni.moai.show-all': '75e61d8b0686f8e5c71e494c5d4b4bf65ab7b37afb1dd2d068004052f1e7aa74',
    'buzzni.moai.backlog-all': '58bfa1bfc2bf9c19bb111317f8a23e40d9a9994bb6a04e2b994c0e6568923126',
    'buzzni.moai.show-archived': 'ab1c6e3dc041b2fdf4dc52e43a58fd12f271aeddc9b0bb15dfd590785d46e61a',
    'buzzni.moai.show-archived-after': '9e28732d6aea127d24c4082abf21cfd2b28c5562762de18ec79d4202ac65fb01',
    'buzzni.moai.read': '4ad4173f7be5631b1610714b5ae395d745e40dba1f88ae0ace767abaefe12829',
    'buzzni.moai.read-all': '8b4293566e6942cfe26ecc5fad8c3c2ffc0b18b5407a5bea4cad104e09ef6516',
    'buzzni.moai.read-group': '399bd26be8a47f99878453309f3672f5c0c2a61f277414fa19d308fd27215b8c',
    'buzzni.moai.show-all-worktree': '7b9fa0e1d8e93b93bceb9de7b43808095080de536b68257c53d4623ed970aca6',
    'buzzni.moai.show-worktree': '6008088310d006082a3a45ea40124fe2b1aba09357c8861135600b7fc88cbb8b',
    'buzzni.moai.skill-status': '336f786c1bd0765a08b9a0d22709d846a9db7df00ebfe4e5ff8064f848ccb7e3',
    'buzzni.moai.init': 'a2777dc330cb5c57d56141253c87d3b1727c966c71975d39e774a4eae4083760',

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
