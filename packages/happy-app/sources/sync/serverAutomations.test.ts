import { beforeAll, describe, expect, it, vi } from 'vitest';
import sodiumNode from 'libsodium-wrappers';
import type { AutomationApiClient, AutomationPublic, AutomationRun, AutomationTarget } from '@slopus/happy-wire';

vi.mock('expo-crypto', () => ({
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    getRandomBytes: (length: number) => new Uint8Array(require('node:crypto').randomBytes(length)),
    digest: async (_algorithm: string, value: Uint8Array) => (
        new Uint8Array(require('node:crypto').createHash('sha256').update(value).digest())
    ),
}));
vi.mock('@/encryption/libsodium.lib', () => ({ default: require('libsodium-wrappers') }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { request: vi.fn() } }));

import { encodeBase64 } from '@/encryption/base64';
import { createServerAutomationRepository } from './serverAutomations';

function row(patch: Partial<AutomationPublic> = {}): AutomationPublic {
    return {
        id: 'automation-1', projectId: 'project-1', ownerAccountId: 'account-1',
        machineAccountId: 'account-1', machineId: 'machine-1', revision: 1, generation: 1,
        payloadVersion: 1, payloadCiphertext: 'ciphertext', viewerKeyId: 'viewer-key',
        viewerKeyVersion: 1, viewerKeyEnvelope: 'viewer-envelope', machineKeyVersion: 2,
        paused: false, enabledAt: 1, appliedRevision: 0, appliedAt: null, createdAt: 1, updatedAt: 1,
        ...patch,
    };
}

describe('server automation repository', () => {
    beforeAll(async () => sodiumNode.ready);

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
            listAutomations: vi.fn(async () => stored ? [stored] : []),
            listRuns: vi.fn(async () => []),
            createAutomation: vi.fn(async (projectId, input) => {
                stored = row({ projectId, ...input, viewerKeyVersion: 1 });
                return stored;
            }),
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
        expect(listed[0]?.payload).toEqual(payload);
        const updated = await repository.update(created, { ...payload, name: 'Updated' });
        expect(updated.payload.name).toBe('Updated');
        expect(api.updateAutomation).toHaveBeenCalledWith('project-1', 'automation-1', expect.objectContaining({ expectedRevision: 1 }));
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
});
