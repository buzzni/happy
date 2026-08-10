import { describe, expect, it, vi } from 'vitest';

import {
  AutomationApiError,
  automationPayloadSchema,
  createAutomationApiClient,
  decryptAutomationPayload,
  encryptAutomationPayload,
  type AutomationCryptoAdapter,
  type AutomationPublic,
} from './automation';

function bytes(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function fakeCrypto(): AutomationCryptoAdapter {
  return {
    randomBytes: (length) => bytes(length, 7),
    secretBoxSeal: (plaintext, key) => new Uint8Array([
      ...bytes(24, 1),
      ...plaintext.map((value) => value ^ key[0]!),
      ...bytes(16, 2),
    ]),
    secretBoxOpen: (bundle, key) => bundle.slice(24, -16).map((value) => value ^ key[0]!),
    boxSeal: (plaintext, publicKey) => new Uint8Array([
      ...bytes(32, 3),
      ...bytes(24, 4),
      ...plaintext.map((value) => value ^ publicKey[0]!),
      ...bytes(16, 5),
    ]),
    boxOpen: (bundle, secretKey) => bundle.slice(56, -16).map((value) => value ^ secretKey[0]!),
    sha256: async (value) => bytes(32, value[0] ?? 0),
    encodeBase64: (value, urlSafe = false) => {
      const base64 = Buffer.from(value).toString('base64');
      return urlSafe ? base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') : base64;
    },
    decodeBase64: (value) => new Uint8Array(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
  };
}

const payload = {
  name: 'Daily review',
  schedule: { kind: 'daily' as const, hour: 9, minute: 20 },
  prompt: 'Review the project',
  directory: '/workspace/project',
  scriptCommand: null,
  suppressSilent: true,
  agent: 'codex' as const,
};

const payloadCiphertext = Buffer.from([1, ...bytes(40, 2)]).toString('base64');
const keyEnvelope = Buffer.from([1, ...bytes(104, 3)]).toString('base64');

const automation: AutomationPublic = {
  id: 'automation-1',
  projectId: 'project-1',
  ownerAccountId: 'account-1',
  machineAccountId: 'account-1',
  machineId: 'machine-1',
  revision: 2,
  generation: 3,
  payloadVersion: 1,
  payloadCiphertext,
  viewerKeyId: 'viewer-key',
  viewerKeyVersion: 1,
  viewerKeyEnvelope: keyEnvelope,
  machineKeyVersion: 4,
  paused: false,
  enabledAt: 1,
  appliedRevision: 1,
  appliedAt: null,
  createdAt: 1,
  updatedAt: 2,
};

describe('automation wire contract', () => {
  it('rejects payloads that the daemon cannot execute safely', () => {
    expect(automationPayloadSchema.safeParse({ ...payload, schedule: { kind: 'interval', minutes: 14 } }).success).toBe(false);
    expect(automationPayloadSchema.safeParse({ ...payload, directory: '' }).success).toBe(false);
    expect(automationPayloadSchema.safeParse({ ...payload, scriptCommand: 'x'.repeat(8_001) }).success).toBe(false);
  });

  it('rejects incomplete encrypted payload patches', async () => {
    const client = createAutomationApiClient({
      baseUrl: 'https://happy.test',
      token: 'token',
      fetch: vi.fn(),
    });

    await expect(client.updateAutomation('project-1', 'automation-1', {
      expectedRevision: 1,
      payloadVersion: 1,
    } as never)).rejects.toThrow('encrypted payload fields must be replaced together');
  });

  it('round-trips one payload through versioned viewer and machine envelopes', async () => {
    const crypto = fakeCrypto();
    const encrypted = await encryptAutomationPayload({
      payload,
      viewer: { publicKey: bytes(32, 11), keyVersion: 2 },
      machine: { publicKey: bytes(32, 13), keyVersion: 4 },
      crypto,
    });

    expect(crypto.decodeBase64(encrypted.payloadCiphertext)[0]).toBe(1);
    expect(crypto.decodeBase64(encrypted.viewerKeyEnvelope)).toHaveLength(105);
    expect(crypto.decodeBase64(encrypted.machineKeyEnvelope)).toHaveLength(105);
    expect(encrypted.viewerKeyId).not.toContain('=');
    expect(await decryptAutomationPayload({
      payloadVersion: encrypted.payloadVersion,
      payloadCiphertext: encrypted.payloadCiphertext,
      keyEnvelope: encrypted.viewerKeyEnvelope,
      recipientSecretKey: bytes(32, 11),
      crypto,
    })).toEqual(payload);
  });

  it('fails closed on an unknown payload version or malformed envelope', async () => {
    const crypto = fakeCrypto();
    await expect(decryptAutomationPayload({
      payloadVersion: 2 as 1,
      payloadCiphertext: 'Ag==',
      keyEnvelope: 'AQ==',
      recipientSecretKey: bytes(32, 1),
      crypto,
    })).rejects.toThrow('automation-decrypt-failed');
  });
});

describe('createAutomationApiClient', () => {
  it('uses the shared REST paths and parses public rows', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ automations: [automation] }),
    }));
    const client = createAutomationApiClient({ baseUrl: 'https://happy.test/', token: 'token', fetch });

    await expect(client.listAutomations('project/1')).resolves.toEqual([automation]);
    expect(fetch).toHaveBeenCalledWith('https://happy.test/v1/projects/project%2F1/automations', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer token' }),
    }));
  });

  it('preserves the latest row on a revision conflict', async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'revision-conflict', latest: automation }),
    }));
    const client = createAutomationApiClient({ baseUrl: 'https://happy.test', token: 'token', fetch });

    const error = await client.updateAutomation('project-1', 'automation-1', {
      expectedRevision: 1,
      paused: true,
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AutomationApiError);
    expect(error).toMatchObject({ status: 409, code: 'revision-conflict', latest: automation });
  });
});
