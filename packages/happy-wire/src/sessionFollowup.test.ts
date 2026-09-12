import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_FOLLOWUP_WIRE_VERSION,
  createSessionFollowupApiClient,
  decryptSessionFollowupPayload,
  encryptSessionFollowupPayload,
  sessionFollowupCreateRequestSchema,
  sessionFollowupDeliverRequestSchema,
  sessionFollowupEvaluationRequestSchema,
  sessionFollowupPublicSchema,
  sessionFollowupSyncResponseSchema,
  type SessionFollowupPublic,
} from './sessionFollowup';
import type { AutomationCryptoAdapter } from './automation';

function fakeCrypto(): AutomationCryptoAdapter {
  return {
    randomBytes: (length) => new Uint8Array(length).fill(7),
    secretBoxSeal: (plaintext) => new Uint8Array([...new Uint8Array(40), ...plaintext]),
    secretBoxOpen: (bundle) => bundle.slice(40),
    boxSeal: (plaintext) => new Uint8Array([...new Uint8Array(72), ...plaintext]),
    boxOpen: (bundle) => bundle.slice(72),
    sha256: async () => new Uint8Array(32).fill(9),
    encodeBase64: (value) => Buffer.from(value).toString('base64'),
    decodeBase64: (value) => new Uint8Array(Buffer.from(value, 'base64')),
  };
}

const payload = {
  kind: 'existing-session-prompt' as const,
  directory: '/workspace/project',
  prompt: 'Review again and return the JSON contract.',
  evaluator: { kind: 'review-findings-v1' as const },
};

describe('session follow-up wire', () => {
  it('encrypts the prompt/evaluator for viewer and daemon without exposing plaintext fields', async () => {
    const encrypted = await encryptSessionFollowupPayload({
      payload, viewer: { publicKey: new Uint8Array(32), keyVersion: 2 },
      machine: { publicKey: new Uint8Array(32), keyVersion: 3 }, crypto: fakeCrypto(),
    });
    expect(encrypted).not.toHaveProperty('prompt');
    await expect(decryptSessionFollowupPayload({
      payloadVersion: 1, payloadCiphertext: encrypted.payloadCiphertext,
      keyEnvelope: encrypted.machineKeyEnvelope, recipientSecretKey: new Uint8Array(32), crypto: fakeCrypto(),
    })).resolves.toEqual(payload);
  });

  it('enforces two to seven rounds and a bounded current round', async () => {
    const encrypted = await encryptSessionFollowupPayload({
      payload, viewer: { publicKey: new Uint8Array(32), keyVersion: 2 },
      machine: { publicKey: new Uint8Array(32), keyVersion: 3 }, crypto: fakeCrypto(),
    });
    const base = { ...encrypted, wireVersion: 1 as const, sessionId: 'session-1', currentRound: 1, responseBoundarySeq: 4 };
    expect(sessionFollowupCreateRequestSchema.safeParse({ ...base, totalRounds: 2 }).success).toBe(true);
    expect(sessionFollowupCreateRequestSchema.safeParse({ ...base, totalRounds: 7 }).success).toBe(true);
    expect(sessionFollowupCreateRequestSchema.safeParse({ ...base, totalRounds: 8 }).success).toBe(false);
    expect(sessionFollowupCreateRequestSchema.safeParse({ ...base, totalRounds: 3, currentRound: 4 }).success).toBe(false);
  });

  it('requires an explicit pagination boundary before daemon execution', () => {
    expect(sessionFollowupSyncResponseSchema.safeParse({
      serverTime: 1, nextSeq: '0', hasMore: false, changes: [],
    }).success).toBe(true);
    expect(sessionFollowupSyncResponseSchema.safeParse({
      serverTime: 1, nextSeq: '0', changes: [],
    }).success).toBe(false);
  });

  it('keeps daemon delivery and evaluation inside the versioned contract', () => {
    const delivery = {
      wireVersion: 1, followupId: 'followup-1', generation: 2, step: 3,
      claimToken: 'claim', expectedSeq: 11, localId: 'local-1',
    } as const;
    expect(sessionFollowupDeliverRequestSchema.safeParse({
      ...delivery, contentCiphertext: 'AQ==',
    }).success).toBe(true);
    expect(sessionFollowupDeliverRequestSchema.safeParse({
      ...delivery, contentCiphertext: 'not base64!',
    }).success).toBe(false);
    expect(sessionFollowupEvaluationRequestSchema.safeParse({
      wireVersion: 1, followupId: 'followup-1', generation: 2, step: 3,
      claimToken: 'claim', decision: 'TERMINATE', observedSeq: 12,
      terminalCode: 'STOPPED',
    }).success).toBe(false);
  });

  it('public status contains safe metadata and ciphertext, never review plaintext', async () => {
    const encrypted = await encryptSessionFollowupPayload({
      payload, viewer: { publicKey: new Uint8Array(32), keyVersion: 2 },
      machine: { publicKey: new Uint8Array(32), keyVersion: 3 }, crypto: fakeCrypto(),
    });
    const parsed = sessionFollowupPublicSchema.parse({
      id: 'followup-1', projectId: 'project-1', ownerAccountId: 'owner-1',
      machineAccountId: 'owner-1', machineId: 'machine-1', sessionId: 'session-1',
      revision: 1, generation: 1, step: 1, status: 'WAITING', terminalCode: null,
      totalRounds: 4, currentRound: 1, responseBoundarySeq: 4, lastObservedSeq: 4,
      payloadVersion: 1, payloadCiphertext: encrypted.payloadCiphertext,
      viewerKeyId: encrypted.viewerKeyId, viewerKeyVersion: 2,
      viewerKeyEnvelope: encrypted.viewerKeyEnvelope, machineKeyVersion: 3,
      completedAt: null, createdAt: 1, updatedAt: 1,
    });
    expect(parsed).not.toHaveProperty('reviewBody');
    expect(parsed).not.toHaveProperty('findings');
  });

  it('uses stable REST endpoints for start, stop, and status', async () => {
    const record = {
      id: 'followup-1', projectId: 'project-1', ownerAccountId: 'owner-1',
      machineAccountId: 'owner-1', machineId: 'machine-1', sessionId: 'session-1',
      revision: 1, generation: 1, step: 1, status: 'WAITING', terminalCode: null,
      totalRounds: 4, currentRound: 1, responseBoundarySeq: 4, lastObservedSeq: 4,
      payloadVersion: 1, payloadCiphertext: Buffer.from(new Uint8Array(41).fill(1)).toString('base64'),
      viewerKeyId: 'viewer', viewerKeyVersion: 2,
      viewerKeyEnvelope: Buffer.from(new Uint8Array(105).fill(1)).toString('base64'), machineKeyVersion: 3,
      completedAt: null, createdAt: 1, updatedAt: 1,
    } satisfies SessionFollowupPublic;
    const fetch = vi.fn(async (_url: string, _init: {
      method: string; headers: Record<string, string>; body?: string;
    }) => ({ ok: true, status: 200, json: async () => record }));
    const client = createSessionFollowupApiClient({ baseUrl: 'https://happy.test/', token: 'token', fetch });
    await client.get('project/1', 'followup/1');
    expect(fetch.mock.calls[0]![0]).toBe('https://happy.test/v1/projects/project%2F1/session-followups/followup%2F1');
    await client.stop('project-1', 'followup-1', 1);
    expect(fetch.mock.calls[1]![0]).toBe('https://happy.test/v1/projects/project-1/session-followups/followup-1/stop');
    expect(JSON.parse(fetch.mock.calls[1]![1].body!)).toEqual({ wireVersion: SESSION_FOLLOWUP_WIRE_VERSION, expectedRevision: 1 });
  });
});
