import { z } from 'zod';
import {
    AutomationApiError,
    createAutomationApiClient,
    decryptAutomationPayload,
    encryptAutomationPayload,
    type AutomationApiClient,
    type AutomationPayload,
    type AutomationPublic,
    type AutomationRun,
    type AutomationTarget,
} from '@slopus/happy-wire';

import type { AuthCredentials } from '@/auth/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { deriveKey } from '@/encryption/deriveKey';
import sodium from '@/encryption/libsodium.lib';
import { apiSocket } from '@/sync/apiSocket';
import { automationCrypto } from '@/sync/automationCrypto';

const AutomationProjectSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    membership: z.enum(['owner', 'editor', 'viewer']),
    config: z.preprocess(
        (value) => value && typeof value === 'object' ? value : null,
        z.object({ workspaceDir: z.string().optional() }).passthrough().nullable(),
    ),
});

export type AutomationProject = z.infer<typeof AutomationProjectSchema>;

export interface ServerAutomationItem {
    row: AutomationPublic;
    payload: AutomationPayload;
    runs: AutomationRun[];
}

export interface ServerAutomationRepository {
    listProjects(): Promise<AutomationProject[]>;
    listProject(projectId: string): Promise<ServerAutomationItem[]>;
    create(projectId: string, payload: AutomationPayload): Promise<ServerAutomationItem>;
    update(item: ServerAutomationItem, payload: AutomationPayload): Promise<ServerAutomationItem>;
    setPaused(item: ServerAutomationItem, paused: boolean): Promise<ServerAutomationItem>;
    remove(item: ServerAutomationItem): Promise<void>;
}

type ViewerKeyPair = { publicKey: Uint8Array; privateKey: Uint8Array };

async function viewerKeyPair(secret: string): Promise<ViewerKeyPair> {
    const master = decodeBase64(secret, 'base64url');
    if (master.length !== 32) throw new Error('automation-viewer-key-invalid');
    const seed = await deriveKey(master, 'Happy EnCoder', ['content']);
    return sodium.crypto_box_seed_keypair(seed);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function ensureViewerTarget(
    api: AutomationApiClient,
    projectId: string,
    keyPair: ViewerKeyPair,
): Promise<AutomationTarget> {
    let target = await api.getTarget(projectId);
    if (target.viewerPublicKey === null) {
        try {
            const registered = await api.setViewerKey(projectId, {
                expectedKeyVersion: target.viewerKeyVersion,
                publicKey: encodeBase64(keyPair.publicKey),
            });
            target = {
                ...target,
                viewerPublicKey: encodeBase64(keyPair.publicKey),
                viewerKeyVersion: registered.keyVersion,
            };
        } catch (error) {
            if (!(error instanceof AutomationApiError) || error.status !== 409) throw error;
            target = await api.getTarget(projectId);
        }
    }
    if (!sameBytes(decodeBase64(target.viewerPublicKey ?? ''), keyPair.publicKey)) {
        throw new Error('automation-viewer-key-mismatch');
    }
    return target;
}

async function itemFromRow(row: AutomationPublic, runs: AutomationRun[], keyPair: ViewerKeyPair): Promise<ServerAutomationItem> {
    const payload = await decryptAutomationPayload({
        payloadVersion: row.payloadVersion,
        payloadCiphertext: row.payloadCiphertext,
        keyEnvelope: row.viewerKeyEnvelope,
        recipientSecretKey: keyPair.privateKey,
        crypto: automationCrypto,
    });
    return {
        row,
        payload,
        runs: runs.filter((run) => run.automationId === row.id).slice(0, 20),
    };
}

export function createServerAutomationRepository(input: {
    api: AutomationApiClient;
    secret: string;
    listProjects: () => Promise<AutomationProject[]>;
}): ServerAutomationRepository {
    const keyPairPromise = viewerKeyPair(input.secret);

    async function encrypt(projectId: string, payload: AutomationPayload) {
        const keyPair = await keyPairPromise;
        const target = await ensureViewerTarget(input.api, projectId, keyPair);
        return encryptAutomationPayload({
            payload,
            viewer: { publicKey: keyPair.publicKey, keyVersion: target.viewerKeyVersion },
            machine: { publicKey: decodeBase64(target.machinePublicKey), keyVersion: target.machineKeyVersion },
            crypto: automationCrypto,
        });
    }

    return {
        listProjects: input.listProjects,
        async listProject(projectId) {
            const keyPair = await keyPairPromise;
            await ensureViewerTarget(input.api, projectId, keyPair);
            const [rows, runs] = await Promise.all([
                input.api.listAutomations(projectId),
                input.api.listRuns(projectId, { limit: 100 }),
            ]);
            return Promise.all(rows.map((row) => itemFromRow(row, runs, keyPair)));
        },
        async create(projectId, payload) {
            const row = await input.api.createAutomation(projectId, {
                ...await encrypt(projectId, payload),
                paused: false,
            });
            return itemFromRow(row, [], await keyPairPromise);
        },
        async update(item, payload) {
            const row = await input.api.updateAutomation(item.row.projectId, item.row.id, {
                expectedRevision: item.row.revision,
                ...await encrypt(item.row.projectId, payload),
            });
            return itemFromRow(row, item.runs, await keyPairPromise);
        },
        async setPaused(item, paused) {
            const row = await input.api.updateAutomation(item.row.projectId, item.row.id, {
                expectedRevision: item.row.revision,
                paused,
            });
            return { row, payload: item.payload, runs: item.runs };
        },
        async remove(item) {
            await input.api.deleteAutomation(item.row.projectId, item.row.id, item.row.revision);
        },
    };
}

export function createServerAutomationRepositoryForCredentials(credentials: AuthCredentials): ServerAutomationRepository {
    const api = createAutomationApiClient({
        baseUrl: '',
        token: credentials.token,
        fetch: (path, init) => apiSocket.request(path, init),
    });
    return createServerAutomationRepository({
        api,
        secret: credentials.secret,
        listProjects: async () => {
            const response = await apiSocket.request('/v1/projects');
            const value = await response.json();
            if (!response.ok) throw new Error('automation-project-list-failed');
            return z.object({ projects: z.array(AutomationProjectSchema) }).parse(value).projects;
        },
    });
}
