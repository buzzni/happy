import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import tweetnacl from 'tweetnacl'

import {
  createServerAutomationCache,
  decryptServerAutomationPayload,
} from './serverAutomationCache'

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
      }],
    })

    expect(applied).toEqual({ nextSeq: 9n, acknowledgements: [{ automationId: 'automation-1', revision: 2 }] })
    expect(cache.read().automations).toHaveLength(1)
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('secret name')
    expect(raw).not.toContain('secret prompt')
    expect(raw).not.toContain('/repo/project')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)

    expect(decryptServerAutomationPayload(cache.read().automations[0]!, keyPair.secretKey)).toEqual({
      name: 'secret name', schedule: { kind: 'interval', minutes: 30 }, prompt: 'secret prompt',
      directory: '/repo/project', scriptCommand: null, suppressSilent: true, agent: 'codex',
    })
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

  it('fails closed on a corrupt cache instead of silently resetting its cursor', () => {
    writeFileSync(file, '{ corrupt')
    const cache = createServerAutomationCache({ filePath: file })

    expect(() => cache.read()).toThrow('automation-cache-invalid')
    expect(() => cache.applySync({ serverTime: 1, nextSeq: '1', changes: [] }))
      .toThrow('automation-cache-invalid')
    expect(readFileSync(file, 'utf8')).toBe('{ corrupt')
  })
})
