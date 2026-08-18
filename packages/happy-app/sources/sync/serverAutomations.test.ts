import { beforeAll, describe, expect, it, vi } from 'vitest';
import sodiumNode from 'libsodium-wrappers';
import { AutomationApiError, type AutomationApiClient, type AutomationPublic, type AutomationRun, type AutomationTarget } from '@slopus/happy-wire';

vi.mock('expo-crypto', () => ({
    CryptoDigestAlgorithm: { SHA256: 'SHA-256', SHA512: 'SHA-512' },
    getRandomBytes: (length: number) => new Uint8Array(require('node:crypto').randomBytes(length)),
    digest: async (algorithm: string, value: Uint8Array) => (
        new Uint8Array(require('node:crypto').createHash(algorithm.toLowerCase().replace('-', '')).update(value).digest())
    ),
}));
vi.mock('@/encryption/libsodium.lib', () => ({ default: require('libsodium-wrappers') }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { request: vi.fn() } }));

import { encodeBase64 } from '@/encryption/base64';
import { automationCrypto } from './automationCrypto';
import { createServerAutomationRepository, deriveAutomationViewerKeyPair } from './serverAutomations';
import { decryptAutomationPayload } from '@slopus/happy-wire';

const crossClientSecret = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const desktopFixture = {
    payload: {
        name: 'Desktop fixture', schedule: { kind: 'daily' as const, hour: 9, minute: 20 },
        prompt: 'Created by Desktop', directory: '/workspace/project', scriptCommand: null,
        suppressSilent: true, agent: 'codex' as const,
    },
    payloadCiphertext: 'AdLyO6qORnC4v/oUIwXuA2w3FG3/v2Y0N8+ojICNfsdlUIJEWE/fix4qFkDBm7WSHg3dX3ccSNbM/CVSavCq8v1AiU1e8vgdOKUTcpScwCGLFxceU0a0+rqvqRExMZj07i3eKS/g3ot82aGiD3ZyZvN9uhPc1zeWGiYnbPPBm0BxLGm/kWT0V73wSRie3Bmq2XBNx4RvEg6+7S0Xy74+B2SBXaLuZAPX+4KMqf3WRT5kV3E2qAvj9HbbVSWNjnqe4dKm+gNbnilW8YSs4pQ1/fV3dQ+k5uNNU0uDaovAAI4OnTdMF253OWOE5JH8Bw==',
    viewerKeyEnvelope: 'ASDGNuOuNrLOP1WhySO+DO5KRavB+KnrBbSTT6tvPddHOuAOt1F2XsV/Fwj7efctp9+ofad5oKWENJWLcTGAJGJyXptLXo2dhLRiZuoeFs/ZPTgKFytu3U4YcdBnzw0EyDFocTxhWl5j',
};

function row(patch: Partial<AutomationPublic> = {}): AutomationPublic {
    return {
        id: 'automation-1', projectId: 'project-1', ownerAccountId: 'account-1',
        machineAccountId: 'account-1', machineId: 'machine-1', revision: 1, generation: 1,
        payloadVersion: 1, payloadCiphertext: 'ciphertext', viewerKeyId: 'viewer-key',
        viewerKeyVersion: 1, viewerKeyEnvelope: 'viewer-envelope', machineKeyVersion: 2,
        paused: false, enabledAt: 1, appliedRevision: 0, appliedAt: null, runRequestedAt: null,
        createdAt: 1, updatedAt: 1,
        ...patch,
    };
}

describe('server automation repository', () => {
    beforeAll(async () => sodiumNode.ready);

    it('derives the Desktop viewer identity and decrypts a Desktop-produced fixture', async () => {
        const keyPair = await deriveAutomationViewerKeyPair(crossClientSecret);

        expect(encodeBase64(keyPair.publicKey)).toBe('JBr5eUFa1tvJnZOvjCur8ojPlghK1uj+cHLtTiKdRFs=');
        await expect(decryptAutomationPayload({
            payloadVersion: 1,
            payloadCiphertext: desktopFixture.payloadCiphertext,
            keyEnvelope: desktopFixture.viewerKeyEnvelope,
            recipientSecretKey: keyPair.privateKey,
            crypto: automationCrypto,
        })).resolves.toEqual(desktopFixture.payload);
    });

    it('registers the stable viewer key and round-trips CRUD without a local mutation queue', async () => {
        const machine = sodiumNode.crypto_box_keypair();
        const target: AutomationTarget = {
            machineAccountId: 'account-1', machineId: 'machine-1',
            machinePublicKey: encodeBase64(machine.publicKey), machineKeyVersion: 2,
            viewerPublicKey: null, viewerKeyVersion: 0,
        };
        let stored: AutomationPublic | null = null;
        const api: AutomationApiClient = {
            getTarget: vi.fn(async () => target),
            setViewerKey: vi.fn(async () => ({ keyVersion: 1 })),
            replaceViewerKeyIfUnused: vi.fn(),
            listAutomations: vi.fn(async () => stored ? [stored] : []),
            listRuns: vi.fn(async () => []),
            runAutomationNow: vi.fn(),
            createAutomation: vi.fn(async (projectId, input) => {
                stored = row({ projectId, ...input, viewerKeyVersion: 1 });
                return stored;
            }),
            adoptAutomation: vi.fn(),
            activateAutomationAdoption: vi.fn(),
            updateAutomation: vi.fn(async (_projectId, _automationId, input) => {
                stored = row({ ...stored!, ...input, revision: 2, generation: 2 });
                return stored;
            }),
            deleteAutomation: vi.fn(async () => row({ ...stored!, revision: 3 })),
        };
        const repository = createServerAutomationRepository({
            api,
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
            listProjects: vi.fn(async () => [{
                id: 'project-1', name: 'Project', membership: 'owner' as const,
                config: { workspaceDir: '/workspace/project' },
            }]),
        });
        const payload = {
            name: 'Review', schedule: { kind: 'interval' as const, minutes: 30 },
            prompt: 'Review this project', directory: '/workspace/project', scriptCommand: null,
            suppressSilent: true, agent: 'codex' as const,
        };

        const created = await repository.create('project-1', payload);
        expect(created.payload).toEqual(payload);
        expect(api.setViewerKey).toHaveBeenCalledWith('project-1', expect.objectContaining({ expectedKeyVersion: 0 }));
        expect(api.createAutomation).toHaveBeenCalledWith('project-1', expect.objectContaining({
            machineKeyVersion: 2, viewerKeyVersion: 1,
        }));
        const listed = await repository.listProject('project-1');
        expect(listed.items[0]?.payload).toEqual(payload);
        expect(listed.failedRowCount).toBe(0);
        const updated = await repository.update(created, { ...payload, name: 'Updated' });
        expect(updated.payload.name).toBe('Updated');
        expect(api.updateAutomation).toHaveBeenCalledWith('project-1', 'automation-1', expect.objectContaining({ expectedRevision: 1 }));
    });

    it('replaces a mismatched viewer key only through the server unused-project guard', async () => {
        const machine = sodiumNode.crypto_box_keypair();
        const otherViewer = sodiumNode.crypto_box_keypair();
        const secret = encodeBase64(new Uint8Array(32).fill(7), 'base64url');
        const expectedViewer = await deriveAutomationViewerKeyPair(secret);
        const replaceViewerKeyIfUnused = vi.fn(async () => ({ keyVersion: 3 }));
        const api = {
            getTarget: vi.fn(async () => ({
                machineAccountId: 'account-1', machineId: 'machine-1',
                machinePublicKey: encodeBase64(machine.publicKey), machineKeyVersion: 2,
                viewerPublicKey: encodeBase64(otherViewer.publicKey), viewerKeyVersion: 2,
            })),
            replaceViewerKeyIfUnused,
            listAutomations: vi.fn(async () => []),
            listRuns: vi.fn(async () => []),
        } as unknown as AutomationApiClient;
        const repository = createServerAutomationRepository({ api, secret, listProjects: vi.fn(async () => []) });

        await expect(repository.listProject('project-1')).resolves.toEqual({ items: [], failedRowCount: 0 });
        expect(replaceViewerKeyIfUnused).toHaveBeenCalledWith('project-1', {
            expectedKeyVersion: 2,
            publicKey: encodeBase64(expectedViewer.publicKey),
        });
    });

    it('converges when another client wins the viewer-key replacement CAS', async () => {
        const machine = sodiumNode.crypto_box_keypair();
        const secret = encodeBase64(new Uint8Array(32).fill(7), 'base64url');
        const viewer = await deriveAutomationViewerKeyPair(secret);
        const getTarget = vi.fn()
            .mockResolvedValueOnce({
                machineAccountId: 'account-1', machineId: 'machine-1',
                machinePublicKey: encodeBase64(machine.publicKey), machineKeyVersion: 2,
                viewerPublicKey: encodeBase64(sodiumNode.crypto_box_keypair().publicKey), viewerKeyVersion: 2,
            })
            .mockResolvedValueOnce({
                machineAccountId: 'account-1', machineId: 'machine-1',
                machinePublicKey: encodeBase64(machine.publicKey), machineKeyVersion: 2,
                viewerPublicKey: encodeBase64(viewer.publicKey), viewerKeyVersion: 3,
            });
        const api = {
            getTarget,
            replaceViewerKeyIfUnused: vi.fn(async () => {
                throw new AutomationApiError(409, 'viewer-key-version-conflict');
            }),
            listAutomations: vi.fn(async () => []),
            listRuns: vi.fn(async () => []),
        } as unknown as AutomationApiClient;
        const repository = createServerAutomationRepository({ api, secret, listProjects: vi.fn(async () => []) });

        await expect(repository.listProject('project-1')).resolves.toEqual({ items: [], failedRowCount: 0 });
        expect(getTarget).toHaveBeenCalledTimes(2);
    });

    it('maps run history and preserves payload when pause succeeds', async () => {
        const keypair = sodiumNode.crypto_box_keypair();
        const run: AutomationRun = {
            id: 'run-1', automationId: 'automation-1', generation: 1, scheduledFor: 10,
            machineId: 'machine-1', status: 'COMPLETED', sessionId: 'session-1', outcome: 'WOKE',
            detailCiphertext: null, claimedAt: 10, startedAt: 11, completedAt: 12, lateReport: false,
        };
        const api = {
            getTarget: vi.fn(async () => ({
                machineAccountId: 'account-1', machineId: 'machine-1', machinePublicKey: encodeBase64(keypair.publicKey),
                machineKeyVersion: 1, viewerPublicKey: encodeBase64(keypair.publicKey), viewerKeyVersion: 1,
            })),
            setViewerKey: vi.fn(), listAutomations: vi.fn(async () => []), listRuns: vi.fn(async () => [run]),
            createAutomation: vi.fn(), deleteAutomation: vi.fn(),
            updateAutomation: vi.fn(async (_projectId: string, _id: string, input: { expectedRevision: number; paused?: boolean }) => row({ revision: 2, paused: input.paused })),
        } as unknown as AutomationApiClient;
        const repository = createServerAutomationRepository({
            api, secret: encodeBase64(new Uint8Array(32).fill(9), 'base64url'), listProjects: vi.fn(async () => []),
        });
        const item = {
            row: row(),
            payload: {
                name: 'Review', schedule: { kind: 'daily' as const, hour: 9, minute: 20 }, prompt: 'Review',
                directory: '/workspace', scriptCommand: null, suppressSilent: true, agent: null,
            },
            runs: [run],
        };

        const paused = await repository.setPaused(item, true);
        expect(paused.payload).toEqual(item.payload);
        expect(paused.runs).toEqual([run]);
        expect(paused.row.paused).toBe(true);
        expect(api.updateAutomation).toHaveBeenCalledWith('project-1', 'automation-1', { expectedRevision: 1, paused: true });
    });

    it('keeps decryptable rows when another row is corrupt', async () => {
        const secret = crossClientSecret;
        const viewer = await deriveAutomationViewerKeyPair(secret);
        const machine = sodiumNode.crypto_box_keypair();
        const valid = row({
            payloadCiphertext: desktopFixture.payloadCiphertext,
            viewerKeyEnvelope: desktopFixture.viewerKeyEnvelope,
            viewerKeyId: 'viewer-key',
        });
        const corrupt = row({
            id: 'automation-corrupt',
            payloadCiphertext: desktopFixture.payloadCiphertext,
            viewerKeyEnvelope: 'corrupt',
        });
        const api = {
            getTarget: vi.fn(async () => ({
                machineAccountId: 'account-1', machineId: 'machine-1', machinePublicKey: encodeBase64(machine.publicKey),
                machineKeyVersion: 1, viewerPublicKey: encodeBase64(viewer.publicKey), viewerKeyVersion: 1,
            })),
            setViewerKey: vi.fn(),
            listAutomations: vi.fn(async () => [valid, corrupt]),
            listRuns: vi.fn(async () => []),
        } as unknown as AutomationApiClient;
        const repository = createServerAutomationRepository({
            api, secret, listProjects: vi.fn(async () => []),
        });

        const result = await repository.listProject('project-1');

        expect(result.items).toHaveLength(1);
        expect(result.items[0]?.row.id).toBe('automation-1');
        expect(result.failedRowCount).toBe(1);
    });
});
