import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import {
  automationPayloadSchema,
  decryptAutomationPayload,
  encryptAutomationPayload,
  openAutomationPayloadForMachine,
  type AutomationCryptoAdapter,
  automationExecutionSessionId,
  isAutomationExecutionSessionId,
} from './automation';

const payload = {
  name: 'Daily report', schedule: { kind: 'daily' as const, hour: 9, minute: 0 },
  prompt: 'Report this run only', directory: '/workspace', scriptCommand: null,
  suppressSilent: false, agent: 'codex' as const,
  conversation: { sessionId: 'display-session' },
  contextPolicy: { kind: 'isolated' as const, reference: null },
};
const key = nacl.box.keyPair();
const crypto: AutomationCryptoAdapter = {
  randomBytes: nacl.randomBytes,
  secretBoxSeal: (value, secret) => {
    const nonce = nacl.randomBytes(24);
    return new Uint8Array([...nonce, ...nacl.secretbox(value, nonce, secret)]);
  },
  secretBoxOpen: (value, secret) => nacl.secretbox.open(value.slice(24), value.slice(0, 24), secret),
  boxSeal: (value, recipient) => {
    const sender = nacl.box.keyPair();
    const nonce = nacl.randomBytes(24);
    return new Uint8Array([...sender.publicKey, ...nonce, ...nacl.box(value, nonce, recipient, sender.secretKey)]);
  },
  boxOpen: (value, recipient) => nacl.box.open(value.slice(56), value.slice(32, 56), value.slice(0, 32), recipient),
  sha256: async value => new Uint8Array(createHash('sha256').update(value).digest()),
  encodeBase64: (value, urlSafe) => Buffer.from(value).toString(urlSafe ? 'base64url' : 'base64'),
  decodeBase64: value => new Uint8Array(Buffer.from(value, 'base64')),
};

async function encrypt() {
  return encryptAutomationPayload({ payload, viewer: { publicKey: key.publicKey, keyVersion: 1 },
    machine: { publicKey: key.publicKey, keyVersion: 1 }, crypto });
}

describe('isolated automation context wire contract', () => {
  it('preserves one explicitly selected memo and its revision in both E2EE copies', async () => {
    const authored = { ...payload, contextPolicy: { kind: 'isolated', reference: { kind: 'memo',
      memoId: '9e990bba-e408-4eae-8369-ae73ef31962f', revision: 2, title: '선택한 자료',
      text: '  사용자 지정 자료\nPRIVATE_MEMO_IGNORE_OTHER_TASKS  ', maxBytes: 16 * 1024 } } }
    const parsed = automationPayloadSchema.parse(authored)
    const encrypted = await encryptAutomationPayload({ payload: parsed, viewer: { publicKey: key.publicKey, keyVersion: 1 },
      machine: { publicKey: key.publicKey, keyVersion: 1 }, crypto })
    expect(encrypted.payloadVersion).toBe(6)
    expect(openAutomationPayloadForMachine({ ...encrypted, recipientSecretKey: key.secretKey, crypto })).toMatchObject({ ok: true, payload: authored })
    await expect(decryptAutomationPayload({ ...encrypted, keyEnvelope: encrypted.viewerKeyEnvelope, recipientSecretKey: key.secretKey, crypto }))
      .resolves.toEqual(authored)
  })

  it.each([
    { reason: 'invalid identity', change: { memoId: '../foreign' } },
    { reason: 'invalid revision', change: { revision: 0 } },
    { reason: 'empty title', change: { title: ' ' } },
    { reason: 'empty data', change: { text: '' } },
    { reason: 'whitespace data', change: { text: ' \n ' } },
    { reason: 'UTF-8 overflow', change: { text: '가'.repeat(5462) } },
    { reason: 'invalid bound', change: { maxBytes: 0 } },
    { reason: 'expanded bound', change: { maxBytes: 16385 } },
    { reason: 'recursive source', change: { references: [{ runId: 'prior-run' }] } },
    { reason: 'mixed source', change: { runId: 'implicit-prior-run' } },
  ])('rejects a selected memo with $reason without treating it as independent input', ({ change }) => {
    const reference = { kind: 'memo', memoId: '9e990bba-e408-4eae-8369-ae73ef31962f', revision: 1,
      title: 'Source', text: 'Selected data', maxBytes: 16384 }
    expect(automationPayloadSchema.safeParse({ ...payload, contextPolicy: { kind: 'isolated', reference } }).success).toBe(true)
    expect(automationPayloadSchema.safeParse({ ...payload, contextPolicy: { kind: 'isolated', reference: { ...reference, ...change } } }).success).toBe(false)
    expect(automationPayloadSchema.safeParse({ ...payload, contextPolicy: { kind: 'isolated', reference: [reference, reference] } }).success).toBe(false)
  })
  it('uses a run-owned namespace distinct from any display session', () => {
    expect(automationExecutionSessionId('run-1')).toBe('automation-run:run-1');
    expect(automationExecutionSessionId('run-1')).not.toBe(automationExecutionSessionId('run-2'));
    expect(isAutomationExecutionSessionId('manual-session')).toBe(false);
    expect(isAutomationExecutionSessionId(automationExecutionSessionId('run-1'))).toBe(true);
    for (const runId of ['', '../display', 'run:another', 'x'.repeat(161)]) {
      expect(() => automationExecutionSessionId(runId)).toThrow();
    }
  });

  it('limits the UTF-8 seed without changing the existing legacy character limit', () => {
    const prompt = '가'.repeat(21_846);
    expect(automationPayloadSchema.safeParse({ ...payload, prompt }).success).toBe(false);
    const { contextPolicy: _contextPolicy, ...legacy } = payload;
    expect(automationPayloadSchema.safeParse({ ...legacy, prompt }).success).toBe(true);
  });
  it('preserves the isolated policy in both encrypted copies using a distinct payload version', async () => {
    const encrypted = await encrypt();
    expect(encrypted.payloadVersion).toBe(6);
    await expect(decryptAutomationPayload({ ...encrypted, keyEnvelope: encrypted.viewerKeyEnvelope,
      recipientSecretKey: key.secretKey, crypto })).resolves.toEqual(payload);
    expect(openAutomationPayloadForMachine({ ...encrypted, recipientSecretKey: key.secretKey, crypto }))
      .toMatchObject({ ok: true, payload });
  });

  it('rejects relabeling isolated ciphertext as legacy continuation or independent execution', async () => {
    const encrypted = await encrypt();
    for (const payloadVersion of [1, 4] as const) {
      await expect(decryptAutomationPayload({ ...encrypted, payloadVersion,
        keyEnvelope: encrypted.viewerKeyEnvelope, recipientSecretKey: key.secretKey, crypto }))
        .rejects.toThrow('automation-decrypt-failed');
      expect(openAutomationPayloadForMachine({ ...encrypted, payloadVersion, recipientSecretKey: key.secretKey, crypto }))
        .toMatchObject({ ok: false, reason: 'malformed' });
    }
  });

  it('requires a display target without accepting an existing native context to resume', () => {
    expect(automationPayloadSchema.safeParse({ ...payload, conversation: undefined }).success).toBe(false);
    expect(automationPayloadSchema.safeParse({ ...payload,
      contextPolicy: { ...payload.contextPolicy, nativeSessionId: 'old-context' } }).success).toBe(false);
    expect(automationPayloadSchema.safeParse({ ...payload,
      contextPolicy: { kind: 'resume', reference: null } }).success).toBe(false);
  });

  it('never interprets an unreadable context policy as the absence of a policy', () => {
    for (const contextPolicy of [null, {}, { kind: 'isolated' }, { kind: 'unknown', reference: null }]) {
      expect(automationPayloadSchema.safeParse({ ...payload, contextPolicy }).success).toBe(false);
    }
  });

  it('keeps code and GitHub execution outside the isolated scheduled-conversation contract', () => {
    expect(automationPayloadSchema.safeParse({ ...payload, scriptCommand: 'node task.js' }).success).toBe(false);
    expect(automationPayloadSchema.safeParse({ ...payload, schedule: { kind: 'github', minutes: 15 },
      githubTrigger: { event: 'opened', filter: { baseBranch: null, label: null, excludeDraft: true,
        authors: [], paths: [] }, action: 'start-session', githubCredentialId: null } }).success).toBe(false);
  });

  it('bounds a previous-result reference and never accepts another run or automation as an implicit source', () => {
    const reference = { kind: 'previous-result', maxBytes: 16_384 };
    expect(automationPayloadSchema.parse({ ...payload, contextPolicy: { kind: 'isolated', reference } }))
      .toHaveProperty('contextPolicy.reference', reference);
    for (const invalid of [{ ...reference, maxBytes: 0 }, { ...reference, maxBytes: 16_385 },
      { ...reference, runId: 'another-run' }, { ...reference, automationId: 'another-automation' }]) {
      expect(automationPayloadSchema.safeParse({ ...payload,
        contextPolicy: { kind: 'isolated', reference: invalid } }).success).toBe(false);
    }
  });
});
