import { describe, expect, it, vi } from 'vitest';

import {
  AutomationApiError,
  automationPayloadSchema,
  githubTriggerSchema,
  automationRunSchema,
  automationTargetSchema,
  createAutomationApiClient,
  decryptAutomationPayload,
  encryptAutomationPayload,
  type AutomationCryptoAdapter,
  type AutomationPublic,
} from './automation';

describe('github trigger automation payload', () => {
  it('accepts a server-backed PR trigger without changing legacy scheduled payloads', () => {
    const payload = {
      name: 'PR review',
      schedule: { kind: 'github' as const, minutes: 15 },
      prompt: 'Review {pr.number}: {pr.title}',
      directory: '/repo',
      scriptCommand: null,
      suppressSilent: false,
      agent: 'codex' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: {
          baseBranch: 'main', label: null, excludeDraft: true,
          authors: ['octocat'], paths: ['apps/web'],
        },
        action: 'start-session' as const,
        githubCredentialId: 'credential-1',
      },
    };

    expect(automationPayloadSchema.parse(payload)).toEqual(payload);
    const { githubTrigger: _githubTrigger, ...legacyPayload } = payload;
    expect(automationPayloadSchema.safeParse(legacyPayload).success).toBe(false);
    expect(automationPayloadSchema.safeParse({
      ...payload,
      schedule: { kind: 'interval', minutes: 15 },
    }).success).toBe(false);
    expect(automationPayloadSchema.parse({
      ...legacyPayload,
      schedule: { kind: 'interval', minutes: 15 },
    })).toEqual({ ...legacyPayload, schedule: { kind: 'interval', minutes: 15 } });
  });

  it('accepts AgentTask review only with an explicit GitHub credential', () => {
    const githubTrigger = {
      event: 'opened' as const,
      filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
      action: 'agent-task-review' as const,
      githubCredentialId: 'credential-1',
    };
    expect(automationPayloadSchema.safeParse({
      ...payload,
      schedule: { kind: 'github', minutes: 15 },
      githubTrigger,
    }).success).toBe(true);
    expect(automationPayloadSchema.safeParse({
      ...payload,
      schedule: { kind: 'github', minutes: 15 },
      githubTrigger: { ...githubTrigger, githubCredentialId: null },
    }).success).toBe(false);
  });

  it('accepts the issue_opened trigger event', () => {
    const issuePayload = {
      ...payload,
      schedule: { kind: 'github' as const, minutes: 15 as const },
      githubTrigger: {
        event: 'issue_opened' as const,
        filter: { baseBranch: null, label: 'bug', excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    };
    expect(automationPayloadSchema.parse(issuePayload)).toEqual(issuePayload);
  });

  it('accepts optional nullable model/effort seeds without requiring them', () => {
    const seeded = { ...payload, model: 'sonnet', effort: 'high' };
    expect(automationPayloadSchema.parse(seeded)).toEqual(seeded);
    expect(automationPayloadSchema.parse({ ...payload, model: null, effort: null }))
      .toEqual({ ...payload, model: null, effort: null });
    expect(automationPayloadSchema.parse(payload)).not.toHaveProperty('model');
  });
});

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
  runRequestedAt: null,
  enabledAt: 1,
  appliedRevision: 1,
  appliedAt: null,
  createdAt: 1,
  updatedAt: 2,
};

describe('automation wire contract', () => {
  it('preserves the target daemon automation capability and defaults legacy responses', () => {
    const target = {
      machineAccountId: 'account-1', machineId: 'machine-1',
      machinePublicKey: Buffer.alloc(32, 1).toString('base64'), machineKeyVersion: 1,
      viewerPublicKey: null, viewerKeyVersion: 0,
    };
    expect(automationTargetSchema.parse({ ...target, automationProtocolVersion: 3 }))
      .toMatchObject({ automationProtocolVersion: 3 });
    expect(automationTargetSchema.parse(target)).toMatchObject({ automationProtocolVersion: 1 });
  });

  it('preserves a safe degraded connector code on a completed run', () => {
    const run = {
      id: 'run-1', automationId: 'automation-1', generation: 1, scheduledFor: 1,
      machineId: 'machine-1', status: 'COMPLETED', sessionId: 'session-1', outcome: 'WOKE',
      detailCiphertext: null, failureCode: null, degradedCode: 'GRANT_MISSING', queueDepth: 2,
      queuePosition: 1, queueTotal: 3, queueEstimatedAt: 4,
      claimedAt: 1, startedAt: 2, completedAt: 3, lateReport: false,
    };
    expect(automationRunSchema.parse(run)).toEqual(run);
    expect(automationRunSchema.safeParse({ ...run, degradedCode: 'secret: do not expose' }).success).toBe(false);
  });

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

  it('requests an immediate run with the current revision', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ automation: { ...automation, revision: 3, runRequestedAt: 100 } }),
    }));
    const client = createAutomationApiClient({ baseUrl: 'https://happy.test', token: 'token', fetch });

    await expect(client.runAutomationNow('project-1', 'automation-1', 2))
      .resolves.toMatchObject({ revision: 3, runRequestedAt: 100 });
    expect(fetch).toHaveBeenCalledWith(
      'https://happy.test/v1/projects/project-1/automations/automation-1/run',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRevision: 2 }) }),
    );
  });

  it('replaces a viewer key through the guarded unused-project endpoint', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ keyVersion: 3 }),
    }));
    const client = createAutomationApiClient({ baseUrl: 'https://happy.test', token: 'token', fetch });
    const publicKey = Buffer.from(bytes(32, 7)).toString('base64');

    await expect(client.replaceViewerKeyIfUnused('project-1', {
      expectedKeyVersion: 2,
      publicKey,
    })).resolves.toEqual({ keyVersion: 3 });
    expect(fetch).toHaveBeenCalledWith(
      'https://happy.test/v1/projects/project-1/automation-viewer-key/replace-if-unused',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ expectedKeyVersion: 2, publicKey }),
      }),
    );
  });

  it('uses an explicit confirmed adoption endpoint for a legacy identity', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ automation, migrationPending: true, desiredPaused: false }),
    }));
    const client = createAutomationApiClient({ baseUrl: 'https://happy.test', token: 'token', fetch });
    const encrypted = await encryptAutomationPayload({
      payload,
      viewer: { publicKey: bytes(32, 11), keyVersion: 2 },
      machine: { publicKey: bytes(32, 13), keyVersion: 4 },
      crypto: fakeCrypto(),
    });

    await expect(client.adoptAutomation('project-1', {
      ...encrypted,
      legacyMachineId: 'machine-1',
      legacyAutomationId: 'legacy-1',
      ownershipConfirmed: true,
      desiredPaused: false,
    })).resolves.toEqual({ automation, migrationPending: true, desiredPaused: false });
    expect(fetch).toHaveBeenCalledWith(
      'https://happy.test/v1/projects/project-1/automation-adoptions',
      expect.objectContaining({ method: 'POST' }),
    );
    await expect(client.adoptAutomation('project-1', {
      ...encrypted,
      legacyMachineId: 'machine-1',
      legacyAutomationId: 'legacy-2',
      ownershipConfirmed: false,
      desiredPaused: false,
    } as never)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('activates a staged adoption by revision', async () => {
    const activated = { ...automation, revision: 2, generation: 4, paused: false };
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ automation: activated }),
    }));
    const client = createAutomationApiClient({ baseUrl: 'https://happy.test', token: 'token', fetch });

    await expect(client.activateAutomationAdoption('project-1', 'automation-1', 1)).resolves.toEqual(activated);
    expect(fetch).toHaveBeenCalledWith(
      'https://happy.test/v1/projects/project-1/automation-adoptions/automation-1/activate',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRevision: 1 }) }),
    );
  });
});

// 2026-08-31 — hsmoa 리뷰 프롬프트의 "high 이면 @eunchong 을 멘션하라" 는 한 번도
// 동작하지 않았다. PR 코멘트는 서버가 조립하고 워커 텍스트가 들어가지 않기 때문이다.
// 담당자는 설정으로 전달돼야 하고, 그 통로가 이 스키마다.
describe('githubTriggerSchema escalateTo', () => {
  const base = {
    event: 'opened' as const,
    filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
    action: 'agent-task-review' as const,
    githubCredentialId: 'credential-1',
  };

  it('carries escalation handles', () => {
    expect(githubTriggerSchema.parse({ ...base, escalateTo: ['eunchong'] }).escalateTo)
      .toEqual(['eunchong']);
  });

  it('stays valid without the field so existing automations keep working', () => {
    expect(githubTriggerSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an unbounded list', () => {
    expect(githubTriggerSchema.safeParse({
      ...base, escalateTo: Array.from({ length: 11 }, (_, index) => `user-${index}`),
    }).success).toBe(false);
  });
});
