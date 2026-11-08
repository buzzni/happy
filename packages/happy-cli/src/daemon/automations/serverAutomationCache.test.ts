import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import tweetnacl from 'tweetnacl'
import { createHash } from 'node:crypto'
import {
  encryptAutomationPayload,
  encryptSessionFollowupPayload,
  type AutomationCryptoAdapter,
  type SessionFollowupDaemon,
} from '@slopus/happy-wire'

import {
  createServerAutomationCache,
  openServerAutomationPayload,
  trustedServerAutomationPayload,
  trustedSessionFollowupPayload,
} from './serverAutomationCache'
import type { PayloadTrust } from './payloadTrust'

function bundle(payload: object, recipientPublicKey: Uint8Array) {
  const dek = tweetnacl.randomBytes(tweetnacl.secretbox.keyLength)
  const payloadNonce = tweetnacl.randomBytes(tweetnacl.secretbox.nonceLength)
  const payloadCiphertext = tweetnacl.secretbox(new TextEncoder().encode(JSON.stringify(payload)), payloadNonce, dek)
  const payloadBundle = new Uint8Array(1 + payloadNonce.length + payloadCiphertext.length)
  payloadBundle.set([1], 0)
  payloadBundle.set(payloadNonce, 1)
  payloadBundle.set(payloadCiphertext, 1 + payloadNonce.length)

  const ephemeral = tweetnacl.box.keyPair()
  const envelopeNonce = tweetnacl.randomBytes(tweetnacl.box.nonceLength)
  const encryptedDek = tweetnacl.box(dek, envelopeNonce, recipientPublicKey, ephemeral.secretKey)
  const envelope = new Uint8Array(1 + ephemeral.publicKey.length + envelopeNonce.length + encryptedDek.length)
  envelope.set([1], 0)
  envelope.set(ephemeral.publicKey, 1)
  envelope.set(envelopeNonce, 1 + ephemeral.publicKey.length)
  envelope.set(encryptedDek, 1 + ephemeral.publicKey.length + envelopeNonce.length)
  return {
    payloadCiphertext: Buffer.from(payloadBundle).toString('base64'),
    machineKeyEnvelope: Buffer.from(envelope).toString('base64'),
  }
}

describe('serverAutomationCache', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'server-automation-cache-'))
    file = path.join(dir, 'server-automations.v1.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps isolated v6 deltas in a separate cache format without reinterpreting or overwriting the legacy cache', () => {
    const key = tweetnacl.box.keyPair()
    const payload = { name: 'Task', prompt: 'Independent occurrence', directory: '/work', agent: 'codex',
      scriptCommand: null, suppressSilent: false, schedule: { kind: 'interval', minutes: 60 }, conversation: { sessionId: 'manual' },
      contextPolicy: { kind: 'isolated', reference: null } }
    const encrypted = bundle(payload, key.publicKey)
    const delta = (payloadVersion: number, seq: string) => ({ serverTime: 1000, nextSeq: seq, changes: [{
      seq, automationId: 'a1', revision: 2, generation: 2, kind: 'UPSERT', payloadVersion, ...encrypted,
      machineKeyVersion: 1, paused: false, enabledAt: 1,
    }] })
    const legacy = createServerAutomationCache({ filePath: file })
    legacy.applySync(delta(4, '1'))
    const beforeLegacy = readFileSync(file, 'utf8')
    expect(() => legacy.applySync(delta(6, '2'))).toThrow('automation-sync-invalid')
    const contextFile = path.join(dir, 'server-automations.context-v6.json')
    const isolated = createServerAutomationCache({ filePath: contextFile, format: 'isolated-v6' })
    expect(isolated.read().cursor).toBe(0n)
    isolated.applySync(delta(6, '2'))
    isolated.markAcknowledged([{ automationId: 'a1', revision: 2 }])
    const afterContext = readFileSync(contextFile, 'utf8')
    const restored = createServerAutomationCache({ filePath: contextFile, format: 'isolated-v6' }).read()
    expect(restored.automations[0]).toHaveProperty('payloadVersion', 6)
    expect(openServerAutomationPayload(restored.automations[0], key.secretKey)).toMatchObject({ ok: true, payload })
    expect(restored.pendingAcknowledgements).toEqual([])
    expect(() => createServerAutomationCache({ filePath: contextFile }).read()).toThrow('automation-cache-invalid')
    expect(() => createServerAutomationCache({ filePath: file, format: 'isolated-v6' }).applySync(delta(6, '2'))).toThrow('automation-cache-invalid')
    expect(readFileSync(file, 'utf8')).toBe(beforeLegacy)
    expect(readFileSync(contextFile, 'utf8')).toBe(afterContext)
    expect(afterContext).not.toContain(payload.prompt)
  })

  it('retains isolated deletion targets until the original cancellation is acknowledged', () => {
    const key = tweetnacl.box.keyPair(), encrypted = bundle({ name: 'sealed target' }, key.publicKey)
    const cache = createServerAutomationCache({ filePath: file, format: 'isolated-v6' })
    cache.applySync({ serverTime: 1000, nextSeq: '1', changes: [{ seq: '1', automationId: 'a1', revision: 2,
      generation: 2, kind: 'TOMBSTONE', chatDeleted: true, payloadVersion: 6, ...encrypted, machineKeyVersion: 1, paused: true, enabledAt: 1 }] })
    expect(createServerAutomationCache({ filePath: file, format: 'isolated-v6' }).read().pendingCancellations)
      .toEqual([expect.objectContaining({ automationId: 'a1', payloadVersion: 6 })])
    cache.markCancelled!([{ automationId: 'a1', revision: 1 }]); expect(cache.read().pendingCancellations).toHaveLength(1)
    cache.markCancelled!([{ automationId: 'a1', revision: 2 }]); expect(cache.read().pendingCancellations).toEqual([])
  })

  it('durably resets only the isolated sync cursor while preserving pending cancellation and acknowledgement', () => {
    const key = tweetnacl.box.keyPair(), encrypted = bundle({ name: 'sealed target' }, key.publicKey)
    const cache = createServerAutomationCache({ filePath: file, format: 'isolated-v6' })
    cache.applySync({ serverTime: 1000, nextSeq: '2', changes: [
      { seq: '1', automationId: 'a1', revision: 2, generation: 2, kind: 'UPSERT', payloadVersion: 6, ...encrypted, machineKeyVersion: 1, paused: false, enabledAt: 1 },
      { seq: '2', automationId: 'a2', revision: 2, generation: 2, kind: 'TOMBSTONE', chatDeleted: true, payloadVersion: 6, ...encrypted, machineKeyVersion: 1, paused: true, enabledAt: 1 },
    ] })
    const before = cache.read()
    ;(cache as any).resetCursor()
    expect(createServerAutomationCache({ filePath: file, format: 'isolated-v6' }).read()).toEqual({ ...before, cursor: 0n })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('atomically stores only encrypted deltas and advances the durable cursor', () => {
    const keyPair = tweetnacl.box.keyPair()
    const encrypted = bundle({
      name: 'secret name', schedule: { kind: 'interval', minutes: 30 }, prompt: 'secret prompt',
      directory: '/repo/project', scriptCommand: null, suppressSilent: true, agent: 'codex',
    }, keyPair.publicKey)
    const cache = createServerAutomationCache({ filePath: file })

    const applied = cache.applySync({
      serverTime: 1_000,
      nextSeq: '9',
      changes: [{
        seq: '9', automationId: 'automation-1', revision: 2, generation: 3, kind: 'UPSERT',
        payloadVersion: 1, ...encrypted, machineKeyVersion: 4, paused: false, enabledAt: 500,
        runRequestedAt: 900,
      }],
    })

    expect(applied).toEqual({ nextSeq: 9n, acknowledgements: [{ automationId: 'automation-1', revision: 2 }] })
    expect(cache.read().automations).toHaveLength(1)
    expect(cache.read().automations[0]).toMatchObject({ revision: 2, runRequestedAt: 900 })
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('secret name')
    expect(raw).not.toContain('secret prompt')
    expect(raw).not.toContain('/repo/project')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)

    expect(openServerAutomationPayload(cache.read().automations[0]!, keyPair.secretKey)).toEqual({
      ok: true,
      payload: {
        name: 'secret name', schedule: { kind: 'interval', minutes: 30 }, prompt: 'secret prompt',
        directory: '/repo/project', scriptCommand: null, suppressSilent: true, agent: 'codex',
      },
      authentication: { kind: 'anonymous' },
    })
  })

  it('remembers whether the last sync came from a server that records missed runs', () => {
    // scheduled-missed-run-policy: an old server never acks automation-missed-record, so the
    // daemon only waits on that event after the server said it understands it.
    const cache = createServerAutomationCache({ filePath: file })
    expect(cache.read().missedRunRecord).toBe(false)

    cache.applySync({ serverTime: 1_000, nextSeq: '1', changes: [], missedRunRecord: 1 })
    expect(cache.read().missedRunRecord).toBe(true)
    cache.markAcknowledged([])
    expect(createServerAutomationCache({ filePath: file }).read().missedRunRecord).toBe(true)

    // A rolled-back server stops advertising it on the next sync.
    cache.applySync({ serverTime: 2_000, nextSeq: '1', changes: [] })
    expect(cache.read().missedRunRecord).toBe(false)
  })

  it('remembers whether the last sync came from a server that accepts late catch-up claims', () => {
    // scheduled-missed-run-policy R11·R14: an old server ignores catchUp and denies the late slot.
    const cache = createServerAutomationCache({ filePath: file })
    expect(cache.read().catchUpClaim).toBe(false)

    cache.applySync({ serverTime: 1_000, nextSeq: '1', changes: [], missedRunRecord: 1, catchUpClaim: 1 })
    expect(cache.read().catchUpClaim).toBe(true)
    expect(createServerAutomationCache({ filePath: file }).read().catchUpClaim).toBe(true)

    cache.applySync({ serverTime: 2_000, nextSeq: '1', changes: [], missedRunRecord: 1 })
    expect(cache.read().catchUpClaim).toBe(false)
  })

  it('durably keeps the sealed deletion target until its session stop is acknowledged', () => {
    const keyPair = tweetnacl.box.keyPair(); const encrypted = bundle({ name: 'task', prompt: 'work', directory: '/chat', schedule: { kind: 'interval', minutes: 15 }, conversation: { sessionId: 's' } }, keyPair.publicKey)
    const cache = createServerAutomationCache({ filePath: file })
    cache.applySync({ serverTime: 1000, nextSeq: '1', changes: [{ seq: '1', automationId: 'a', revision: 2, generation: 2, kind: 'TOMBSTONE', chatDeleted: true, payloadVersion: 4, ...encrypted, machineKeyVersion: 1, paused: true, enabledAt: 1 }] })
    expect(cache.read().automations).toEqual([])
    expect(createServerAutomationCache({ filePath: file }).read().pendingCancellations).toHaveLength(1)
    expect(readFileSync(file, 'utf8')).not.toContain('/chat')
    cache.markCancelled!([{ automationId: 'a', revision: 1 }]); expect(cache.read().pendingCancellations).toHaveLength(1)
    cache.markCancelled!([{ automationId: 'a', revision: 2 }]); expect(cache.read().pendingCancellations).toEqual([])
  })

  it('applies tombstones and ignores stale upserts without moving the cursor backwards', () => {
    const keyPair = tweetnacl.box.keyPair()
    const encrypted = bundle({
      name: 'name', schedule: { kind: 'daily', hour: 9, minute: 0 }, prompt: 'prompt',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude',
    }, keyPair.publicKey)
    const cache = createServerAutomationCache({ filePath: file })
    cache.applySync({ serverTime: 1, nextSeq: '2', changes: [{
      seq: '2', automationId: 'automation-1', revision: 2, generation: 2, kind: 'UPSERT',
      payloadVersion: 1, ...encrypted, machineKeyVersion: 1, paused: false, enabledAt: 1,
    }] })
    cache.applySync({ serverTime: 2, nextSeq: '3', changes: [{
      seq: '3', automationId: 'automation-1', revision: 1, generation: 1, kind: 'UPSERT',
      payloadVersion: 1, ...encrypted, machineKeyVersion: 1, paused: false, enabledAt: 1,
    }] })
    expect(cache.read().automations[0]!.revision).toBe(2)

    cache.applySync({ serverTime: 3, nextSeq: '4', changes: [{
      seq: '4', automationId: 'automation-1', revision: 3, generation: 3, kind: 'TOMBSTONE',
    }] })
    expect(cache.read()).toMatchObject({ cursor: 4n, automations: [] })
  })

  it('rejects malformed or non-monotonic sync responses without overwriting the last good cache', () => {
    const cache = createServerAutomationCache({ filePath: file })
    expect(() => cache.applySync({ serverTime: 1, nextSeq: '2', changes: [] })).not.toThrow()
    const before = readFileSync(file, 'utf8')

    expect(() => cache.applySync({ serverTime: 2, nextSeq: '1', changes: [] })).toThrow('automation-sync-invalid')
    expect(() => cache.applySync({ serverTime: 2, nextSeq: '3', changes: [{ kind: 'UPSERT' }] })).toThrow('automation-sync-invalid')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('quarantines a previous v5 cache without losing supported work, cancellation targets or acknowledgements', () => {
    const encrypted = bundle({ name: 'task' }, tweetnacl.box.keyPair().publicKey)
    const supported = { automationId: 'legacy', revision: 2, generation: 1, payloadVersion: 4, ...encrypted, machineKeyVersion: 1, paused: false, enabledAt: 1 }
    const native = { ...supported, automationId: 'native', payloadVersion: 5 }
    const original = JSON.stringify({ version: 1, conversationSync: true, chatLifecycleSync: true, cursor: '99', serverTime: 100, syncedAt: 100,
      automations: [supported, native], pendingAcknowledgements: [{ automationId: 'legacy', revision: 2 }, { automationId: 'native', revision: 2 }],
      pendingCancellations: [{ ...supported, automationId: 'cancel' }, { ...native, automationId: 'native-cancel' }] })
    writeFileSync(file, original)
    const cache = createServerAutomationCache({ filePath: file })
    expect(cache.read()).toMatchObject({ cursor: 0n, automations: [supported], pendingAcknowledgements: [{ automationId: 'legacy', revision: 2 }], pendingCancellations: [{ ...supported, automationId: 'cancel' }] })
    const backups = readdirSync(dir).filter(name => name.includes('unsupported-v5'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(path.join(dir, backups[0]), 'utf8')).toBe(original)
    if (process.platform !== 'win32') expect(statSync(path.join(dir, backups[0])).mode & 0o777).toBe(0o600)
    expect(createServerAutomationCache({ filePath: file }).read().cursor).toBe(0n)
    cache.applySync({ serverTime: 101, nextSeq: '100', changes: [{ seq: '100', kind: 'TOMBSTONE', automationId: 'native', revision: 3, generation: 1 }] })
    expect(cache.read().automations).toMatchObject([supported])
    expect(cache.read().cursor).toBe(100n)
  })

  it('resyncs a previous reservation-aware cache once even when only v4 rows remain', () => {
    const cache = createServerAutomationCache({ filePath: file })
    cache.applySync({ serverTime: 100, nextSeq: '99', changes: [] })
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...disk, reservationSync: true }))
    expect(cache.read().cursor).toBe(0n)
    cache.applySync({ serverTime: 101, nextSeq: '100', changes: [] })
    expect(cache.read().cursor).toBe(100n)
  })

  it('fails closed on a corrupt cache instead of silently resetting its cursor', () => {
    writeFileSync(file, '{ corrupt')
    const cache = createServerAutomationCache({ filePath: file })

    expect(() => cache.read()).toThrow('automation-cache-invalid')
    expect(() => cache.applySync({ serverTime: 1, nextSeq: '1', changes: [] }))
      .toThrow('automation-cache-invalid')
    expect(readFileSync(file, 'utf8')).toBe('{ corrupt')
  })
})

/*
 * aplus-dev-studio specs/e2ee-machine-control-boundary R12-R14 — automations and
 * follow-ups a customer key sealed, as the daemon receives and judges them.
 */
const naclCrypto: AutomationCryptoAdapter = {
  randomBytes: (length) => tweetnacl.randomBytes(length),
  secretBoxSeal: (plaintext, key) => {
    const nonce = tweetnacl.randomBytes(24)
    return new Uint8Array([...nonce, ...tweetnacl.secretbox(plaintext, nonce, key)])
  },
  secretBoxOpen: (bundle, key) => tweetnacl.secretbox.open(bundle.subarray(24), bundle.subarray(0, 24), key),
  boxSeal: (plaintext, publicKey) => {
    const ephemeral = tweetnacl.box.keyPair()
    const nonce = tweetnacl.randomBytes(24)
    return new Uint8Array([...ephemeral.publicKey, ...nonce, ...tweetnacl.box(plaintext, nonce, publicKey, ephemeral.secretKey)])
  },
  boxOpen: (bundle, secretKey) => tweetnacl.box.open(bundle.subarray(56), bundle.subarray(32, 56), bundle.subarray(0, 32), secretKey),
  sha256: async (value) => new Uint8Array(createHash('sha256').update(value).digest()),
  encodeBase64: (value) => Buffer.from(value).toString('base64'),
  decodeBase64: (value) => new Uint8Array(Buffer.from(value, 'base64')),
}

describe('client-sealed payloads on the daemon', () => {
  const machine = tweetnacl.box.keyPair()
  const company = tweetnacl.box.keyPair()
  const viewer = tweetnacl.box.keyPair()
  const trust = (mode: 'compat' | 'strict'): PayloadTrust => ({
    mode, customerPublicKey: company.publicKey, machineAutomationPublicKey: machine.publicKey,
  })
  const automationPayload = {
    name: 'n', schedule: { kind: 'interval' as const, minutes: 30 }, prompt: 'p', directory: '/repo',
    scriptCommand: 'make', suppressSilent: false, agent: 'codex' as const,
  }
  const automationSeal = { version: 1 as const, machineId: 'machine-1', projectId: 'project-1', automationKey: 'automation-key-0001', sealedAt: 1 }

  async function automation(options: { sender?: typeof company; seal?: typeof automationSeal } = {}) {
    const encrypted = await encryptAutomationPayload({
      payload: { ...automationPayload, ...(options.seal ? { seal: options.seal } : {}) },
      viewer: { publicKey: viewer.publicKey, keyVersion: 1 },
      machine: { publicKey: machine.publicKey, keyVersion: 1 },
      ...(options.sender ? { sender: options.sender } : {}),
      crypto: naclCrypto,
    })
    let dir = ''
    try {
      dir = mkdtempSync(path.join(tmpdir(), 'server-automation-v3-'))
      const cache = createServerAutomationCache({ filePath: path.join(dir, 'cache.json') })
      cache.applySync({ serverTime: 1, nextSeq: '1', changes: [{
        seq: '1', automationId: 'automation-1', revision: 1, generation: 1, kind: 'UPSERT',
        payloadVersion: 1, payloadCiphertext: encrypted.payloadCiphertext, machineKeyEnvelope: encrypted.machineKeyEnvelope,
        machineKeyVersion: 1, paused: false, enabledAt: 1,
      }] })
      return cache.read().automations[0]!
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  }

  const judgeAutomation = async (mode: 'compat' | 'strict', options: Parameters<typeof automation>[0]) => {
    const synced = await automation(options)
    try {
      return trustedServerAutomationPayload(synced, { machineSecretKey: machine.secretKey, trust: trust(mode), machineId: 'machine-1' })
    } catch (error) {
      return (error as Error).message
    }
  }

  it('opens a sealed question only for its exact one-off request and source, never as an ordinary scheduled payload', async () => {
    const questionIdentity = { requestId: '9cc41d26-562e-4b48-8e2f-a38dc2c85a78', sourceRunId: 'selected-source' }
    const payload = { ...automationPayload, scriptCommand: null, conversation: { sessionId: 'manual' },
      contextPolicy: { kind: 'isolated' as const, reference: { kind: 'previous-result' as const, maxBytes: 16_384 } }, executionQuestion: questionIdentity, seal: automationSeal }
    const encrypted = await encryptAutomationPayload({ payload, viewer: { publicKey: viewer.publicKey, keyVersion: 1 },
      machine: { publicKey: machine.publicKey, keyVersion: 1 }, sender: company, crypto: naclCrypto })
    const row = { ...encrypted, automationId: 'automation-1', generation: 1, revision: 1, paused: true, enabledAt: 1 }
    const original = { machineSecretKey: machine.secretKey, trust: trust('strict'), machineId: 'machine-1' }
    expect(() => trustedServerAutomationPayload(row, original)).toThrow('PAYLOAD_UNREADABLE')
    const bound = { ...original, questionIdentity }
    expect(trustedServerAutomationPayload(row, bound)).toEqual(payload)
    const other = { ...original, questionIdentity: { ...questionIdentity, sourceRunId: 'other-source' } }
    expect(() => trustedServerAutomationPayload(row, other)).toThrow('PAYLOAD_UNREADABLE')
  })

  it('syncs a v3 automation and runs it in strict when the customer sealed it for this machine', async () => {
    await expect(judgeAutomation('strict', { sender: company, seal: automationSeal }))
      .resolves.toEqual({ ...automationPayload, seal: automationSeal })
  })

  it('refuses one sealed for another machine', async () => {
    await expect(judgeAutomation('strict', { sender: company, seal: { ...automationSeal, machineId: 'machine-2' } }))
      .resolves.toBe('PAYLOAD_CONTEXT_MISMATCH')
  })

  it('runs an anonymous automation only in compat', async () => {
    await expect(judgeAutomation('compat', {})).resolves.toEqual(automationPayload)
    await expect(judgeAutomation('strict', {})).resolves.toBe('PAYLOAD_SENDER_ANONYMOUS')
  })

  it('refuses a sender that is not the customer key', async () => {
    await expect(judgeAutomation('compat', { sender: tweetnacl.box.keyPair(), seal: automationSeal }))
      .resolves.toBe('PAYLOAD_SENDER_UNTRUSTED')
  })

  describe('session follow-ups', () => {
    const followupPayload = {
      kind: 'existing-session-prompt' as const, directory: '/repo', prompt: 'review', evaluator: { kind: 'review-findings-v1' as const },
    }
    const followupSeal = { version: 1 as const, machineId: 'machine-1', projectId: 'project-1', sessionId: 'session-1', sealedAt: 1 }

    async function judgeFollowup(mode: 'compat' | 'strict', options: { sender?: typeof company; seal?: typeof followupSeal }, record: Partial<SessionFollowupDaemon> = {}) {
      const encrypted = await encryptSessionFollowupPayload({
        payload: { ...followupPayload, ...(options.seal ? { seal: options.seal } : {}) },
        viewer: { publicKey: viewer.publicKey, keyVersion: 1 },
        machine: { publicKey: machine.publicKey, keyVersion: 1 },
        ...(options.sender ? { sender: options.sender } : {}),
        crypto: naclCrypto,
      })
      const followup = {
        id: 'followup-1', projectId: 'project-1', sessionId: 'session-1',
        payloadVersion: 1, payloadCiphertext: encrypted.payloadCiphertext, machineKeyEnvelope: encrypted.machineKeyEnvelope,
        ...record,
      } as SessionFollowupDaemon
      try {
        return trustedSessionFollowupPayload(followup, { machineSecretKey: machine.secretKey, trust: trust(mode), machineId: 'machine-1' })
      } catch (error) {
        return (error as Error).message
      }
    }

    it('runs one the customer sealed for this session', async () => {
      await expect(judgeFollowup('strict', { sender: company, seal: followupSeal })).resolves.toEqual({ ...followupPayload, seal: followupSeal })
    })

    it('refuses one moved to another session or project', async () => {
      await expect(judgeFollowup('strict', { sender: company, seal: followupSeal }, { sessionId: 'session-2' })).resolves.toBe('PAYLOAD_CONTEXT_MISMATCH')
      await expect(judgeFollowup('strict', { sender: company, seal: followupSeal }, { projectId: 'project-2' })).resolves.toBe('PAYLOAD_CONTEXT_MISMATCH')
    })

    it('runs an anonymous one only in compat', async () => {
      await expect(judgeFollowup('compat', {})).resolves.toEqual(followupPayload)
      await expect(judgeFollowup('strict', {})).resolves.toBe('PAYLOAD_SENDER_ANONYMOUS')
    })
  })
})

it.each(['conversationSync', 'chatLifecycleSync'])('resyncs once when an older daemon did not support %s', marker => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conversation-cache-'));
  const file = path.join(dir, 'cache.json');
  try {
    const cache = createServerAutomationCache({ filePath: file }); cache.applySync({ serverTime: 1, nextSeq: '9', changes: [] });
    const disk = JSON.parse(readFileSync(file, 'utf8')); delete disk[marker];
    writeFileSync(file, JSON.stringify(disk)); expect(cache.read().cursor).toBe(0n);
    cache.applySync({ serverTime: 2, nextSeq: '9', changes: [] }); expect(cache.read().cursor).toBe(9n);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
