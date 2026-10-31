/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary F8 — moving a strict
 * machine to a new company key, and finishing that after a crash at any step.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from '@/api/encryption';
import type { MachineMetadata } from '@/api/types';
import type { Credentials } from '@/persistence';
import {
    CompanyKeyReseedError,
    CompanyKeyReseedUnsettledError,
    StrictMachineControlError,
    reseedCompanyKey,
    settleMachineControl,
    type CompanyKeyRecord,
    type MachineControlIo,
    type MachineKeyRotationRequest,
    type PendingMachineKeyRotation,
} from './machineControl';

const oldCompany = tweetnacl.box.keyPair();
const newCompany = tweetnacl.box.keyPair();
const server = tweetnacl.box.keyPair();
const oldKey = new Uint8Array(32).fill(1);
const newKey = new Uint8Array(32).fill(9);
const metadata = { host: 'h', platform: 'linux', happyCliVersion: 't', homeDir: '/h', happyHomeDir: '/h/.happy', happyLibDir: '/l' } as MachineMetadata;
const target = { publicKey: newCompany.publicKey, generation: 2 };

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const open = (bundle: string, secretKey: Uint8Array) => {
    const bytes = decodeBase64(bundle);
    return tweetnacl.box.open(bytes.slice(33 + 24), bytes.slice(33, 33 + 24), bytes.slice(1, 33), secretKey);
};

function strictCredentials(machineKey = oldKey, publicKey = oldCompany.publicKey): Credentials {
    return { token: 'token', encryption: { type: 'dataKey', publicKey, machineKey, neverEscrowed: true } };
}

function harness(options: { pending?: unknown; record?: CompanyKeyRecord | null; serverEnvelope?: string; rotate?: MachineControlIo['rotate'] } = {}) {
    const calls: string[] = [];
    const state = {
        pending: (options.pending ?? null) as unknown,
        record: (options.record === undefined ? { version: 1, publicKeySha256: sha256(oldCompany.publicKey), generation: 1 } : options.record) as CompanyKeyRecord | null,
        serverEnvelope: options.serverEnvelope ?? 'old-envelope',
        written: null as Credentials | null,
        committed: null as { publicKey: Uint8Array; generation: number } | null,
        rotations: [] as MachineKeyRotationRequest[],
    };
    const io: MachineControlIo = {
        readPending: async () => state.pending,
        writePending: async (pending) => { calls.push('writePending'); state.pending = structuredClone(pending); },
        deletePending: async () => { calls.push('deletePending'); state.pending = null; },
        writeCredentials: async (credentials) => { calls.push('writeCredentials'); state.written = credentials; },
        fetchMachine: async () => { calls.push('fetchMachine'); return { dataEncryptionKey: state.serverEnvelope, metadataVersion: 7 }; },
        rotate: async (_machineId, request) => {
            calls.push('rotate');
            state.rotations.push(request);
            if (options.rotate) await options.rotate('machine-1', request);
            state.serverEnvelope = request.dataEncryptionKey;
        },
        commitCompanyKey: async (committed) => { calls.push('commitCompanyKey'); state.committed = committed; },
        readCompanyKeyRecord: async () => state.record,
        writeCompanyKeyRecord: async (record) => { calls.push('writeCompanyKeyRecord'); state.record = record; },
        randomKey: () => newKey,
        now: () => 1_000,
    };
    return { io, calls, state };
}

const reseed = (h: ReturnType<typeof harness>, credentials = strictCredentials()) => reseedCompanyKey({
    credentials, machineId: 'machine-1', serverPublicKey: encodeBase64(server.publicKey), metadata, io: h.io, target,
});

function pendingReseed(overrides: Partial<PendingMachineKeyRotation> = {}): PendingMachineKeyRotation {
    return {
        version: 2,
        machineId: 'machine-1',
        fromKeySha256: sha256(oldKey),
        machineKey: encodeBase64(newKey),
        dataEncryptionKey: 'new-envelope',
        serverRpcKeyEnvelope: null,
        reseed: { publicKey: encodeBase64(newCompany.publicKey), generation: 2, fromEnvelopeSha256: sha256('old-envelope') },
        ...overrides,
    } as PendingMachineKeyRotation;
}

describe('reseedCompanyKey', () => {
    it('replaces the machine key under the new company key on the server, then locally, and removes the record last', async () => {
        const h = harness();
        const result = await reseed(h);

        expect(result.changed).toBe(true);
        expect(h.state.rotations).toHaveLength(1);
        const request = h.state.rotations[0];
        expect(request.expectedDataEncryptionKey).toBe('old-envelope');
        expect(open(request.dataEncryptionKey, newCompany.secretKey)).toEqual(newKey);
        expect(open(request.dataEncryptionKey, oldCompany.secretKey)).toBeNull();
        expect(h.state.written?.encryption).toEqual({ type: 'dataKey', publicKey: newCompany.publicKey, machineKey: newKey, neverEscrowed: true });
        expect(h.state.committed).toEqual(target);
        expect(h.state.record).toEqual({ version: 1, publicKeySha256: sha256(newCompany.publicKey), generation: 2 });
        expect(h.calls.slice(-4)).toEqual(['writeCredentials', 'commitCompanyKey', 'writeCompanyKeyRecord', 'deletePending']);
        expect(result.credentials.encryption).toEqual(h.state.written?.encryption);
    });

    it('answers unchanged for the key it already uses, recording the generation', async () => {
        const h = harness({ record: { version: 1, publicKeySha256: sha256(newCompany.publicKey), generation: null } });
        const result = await reseed(h, strictCredentials(oldKey, newCompany.publicKey));

        expect(result.changed).toBe(false);
        expect(h.state.rotations).toEqual([]);
        expect(h.state.record?.generation).toBe(2);
    });

    it('refuses a generation that is not newer than the recorded one', async () => {
        const h = harness({ record: { version: 1, publicKeySha256: sha256(oldCompany.publicKey), generation: 2 } });
        await expect(reseed(h)).rejects.toMatchObject({ code: 'STALE_GENERATION' });
        expect(h.calls).toEqual([]);
    });

    it('refuses while another key replacement is pending', async () => {
        const h = harness({ pending: pendingReseed() });
        await expect(reseed(h)).rejects.toBeInstanceOf(CompanyKeyReseedError);
        expect(h.state.rotations).toEqual([]);
    });

    it('drops its record and keeps the old key when the server swap fails and nothing changed there', async () => {
        const h = harness({ rotate: async () => { throw new Error('offline') } });
        await expect(reseed(h)).rejects.toThrow('offline');
        expect(h.state.serverEnvelope).toBe('old-envelope');
        expect(h.state.written).toBeNull();
        expect(h.state.pending).toBeNull();
    });

    it('reports an unsettled reseed and keeps its record when the server may have taken the new envelope', async () => {
        const h = harness();
        h.io.rotate = async (_machineId, request) => {
            h.state.serverEnvelope = request.dataEncryptionKey;
            h.io.fetchMachine = async () => { throw new Error('offline') };
            throw new Error('socket hang up');
        };
        await expect(reseed(h)).rejects.toBeInstanceOf(CompanyKeyReseedUnsettledError);
        expect(h.state.written).toBeNull();
        expect(h.state.pending).toMatchObject({ version: 2 });
    });

    it('reports an unsettled reseed when the local commit fails after the server swap', async () => {
        const h = harness();
        h.io.writeCredentials = async () => { throw new Error('disk full') };
        await expect(reseed(h)).rejects.toBeInstanceOf(CompanyKeyReseedUnsettledError);
        expect(h.state.serverEnvelope).not.toBe('old-envelope');
        expect(h.state.pending).toMatchObject({ version: 2 });
    });

    it('does not swap over an envelope it did not start from', async () => {
        const h = harness();
        h.io.writePending = async (pending) => { h.state.pending = pending; h.state.serverEnvelope = 'someone-else'; };
        await expect(reseed(h)).rejects.toMatchObject({ code: 'ENVELOPE_CHANGED' });
        expect(h.state.rotations).toEqual([]);
        expect(h.state.written).toBeNull();
    });
});

describe('settleMachineControl resuming a company key reseed', () => {
    const settle = (h: ReturnType<typeof harness>, credentials = strictCredentials()) => settleMachineControl({
        mode: 'strict', credentials, machineId: 'machine-1', serverPublicKey: null, metadata, io: h.io,
    });

    it('swaps and commits when it stopped before the server swap', async () => {
        const h = harness({ pending: pendingReseed() });
        const credentials = await settle(h);

        expect(h.state.rotations.map((r) => r.expectedDataEncryptionKey)).toEqual(['old-envelope']);
        expect(credentials.encryption).toEqual({ type: 'dataKey', publicKey: newCompany.publicKey, machineKey: newKey, neverEscrowed: true });
        expect(h.state.record?.generation).toBe(2);
        expect(h.state.pending).toBeNull();
    });

    it('commits without swapping again when the server already holds the new envelope', async () => {
        const h = harness({ pending: pendingReseed(), serverEnvelope: 'new-envelope' });
        await settle(h);
        expect(h.state.rotations).toEqual([]);
        expect(h.state.committed).toEqual(target);
    });

    it('finishes the remaining steps when access.key was already replaced', async () => {
        const h = harness({ pending: pendingReseed(), serverEnvelope: 'new-envelope' });
        const credentials = await settle(h, strictCredentials(newKey, newCompany.publicKey));

        expect(h.calls).not.toContain('fetchMachine');
        expect(h.calls).not.toContain('writeCredentials');
        expect(h.state.committed).toEqual(target);
        expect(h.state.record).toEqual({ version: 1, publicKeySha256: sha256(newCompany.publicKey), generation: 2 });
        expect(h.state.pending).toBeNull();
        expect(credentials.encryption.type === 'dataKey' && credentials.encryption.publicKey).toEqual(newCompany.publicKey);
    });

    it('does not start on an envelope that is neither the old nor the new one, and keeps the record', async () => {
        const h = harness({ pending: pendingReseed(), serverEnvelope: 'someone-else' });
        await expect(settle(h)).rejects.toBeInstanceOf(StrictMachineControlError);
        expect(h.state.rotations).toEqual([]);
        expect(h.state.pending).not.toBeNull();
    });
});

describe('settleMachineControl and the company key record', () => {
    const settle = (h: ReturnType<typeof harness>, mode: 'compat' | 'strict') => settleMachineControl({
        mode, credentials: strictCredentials(), machineId: 'machine-1', serverPublicKey: null, metadata, io: h.io,
    });

    it('records the key a strict machine already uses, with the generation unknown', async () => {
        const h = harness({ record: null });
        await settle(h, 'strict');
        expect(h.state.record).toEqual({ version: 1, publicKeySha256: sha256(oldCompany.publicKey), generation: null });
    });

    it('refuses to start strict when access.key holds a company key the record does not', async () => {
        const h = harness({ record: { version: 1, publicKeySha256: sha256(newCompany.publicKey), generation: 2 } });
        await expect(settle(h, 'strict')).rejects.toMatchObject({ reason: 'company-key-changed' });
    });

    it('leaves the record alone in compat mode', async () => {
        const h = harness({ record: null });
        h.io.writePending = async () => { throw new Error('unexpected') };
        await settle(h, 'compat');
        expect(h.calls).not.toContain('writeCompanyKeyRecord');
    });
});
