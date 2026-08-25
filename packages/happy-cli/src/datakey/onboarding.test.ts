/**
 * aplus §6-1 dataKey 온보딩 (specs/e2ee-datakey-onboarding Phase 0).
 *
 * planDataKeyOnboarding 은 순수하다 — 파일을 쓰지 않고 "승격할지/무엇을"
 * 만 반환하므로, 게이트 미충족 시 credential 무변경(best-effort no-op)이
 * 구조적으로 성립한다. auth 계층이 ok 결과에서만 파일을 쓴다.
 */
import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { parseCredentials } from '@/persistence'
import { encodeBase64 } from '@/api/encryption'
import { planDataKeyOnboarding } from './onboarding'

const secret = new Uint8Array(randomBytes(32))
const publicKey = new Uint8Array(randomBytes(32))
const machineKey = new Uint8Array(randomBytes(32))
const accountPub = encodeBase64(publicKey)

const legacy = parseCredentials({ token: 'tok', secret: encodeBase64(secret) })!
const provisioned = parseCredentials({
  token: 'tok',
  secret: encodeBase64(secret),
  encryption: { publicKey: encodeBase64(publicKey), machineKey: encodeBase64(machineKey) },
})!
const dataKey = parseCredentials({
  token: 'tok',
  encryption: { publicKey: encodeBase64(publicKey), machineKey: encodeBase64(machineKey) },
})!

describe('planDataKeyOnboarding — 게이트 (AC2/AC5)', () => {
  it('promotes a provisioned legacy credential on a fresh machine', () => {
    const r = planDataKeyOnboarding({ credentials: provisioned, accountPublicKey: accountPub, hasLocalSessions: false })
    if (!r.ok) throw new Error('expected ok, got ' + r.reason)
    const parsed = parseCredentials(r.serialized)
    expect(parsed?.encryption.type).toBe('dataKey')
    if (parsed?.encryption.type !== 'dataKey') throw new Error('unreachable')
    expect(parsed.encryption.publicKey).toEqual(publicKey)
    expect(parsed.encryption.machineKey).toEqual(machineKey)
    expect((r.serialized as { secret?: unknown }).secret).toBeUndefined()
  })

  it('does NOT promote when the machine already has local sessions (AC2)', () => {
    const r = planDataKeyOnboarding({ credentials: provisioned, accountPublicKey: accountPub, hasLocalSessions: true })
    expect(r).toEqual({ ok: false, reason: 'has-local-sessions' })
  })

  it('does NOT promote a plain legacy credential without provisioned material', () => {
    const r = planDataKeyOnboarding({ credentials: legacy, accountPublicKey: accountPub, hasLocalSessions: false })
    expect(r).toEqual({ ok: false, reason: 'not-provisioned' })
  })

  it('does NOT promote when there is no account public key (AC5 legacy account)', () => {
    const r = planDataKeyOnboarding({ credentials: provisioned, accountPublicKey: null, hasLocalSessions: false })
    expect(r).toEqual({ ok: false, reason: 'no-account-key' })
  })

  it('does NOT promote an already dataKey-active credential', () => {
    const r = planDataKeyOnboarding({ credentials: dataKey, accountPublicKey: accountPub, hasLocalSessions: false })
    expect(r).toEqual({ ok: false, reason: 'already-datakey' })
  })

  it('refuses when the provisioned account public key disagrees with settings (safety)', () => {
    const otherPub = encodeBase64(new Uint8Array(randomBytes(32)))
    const r = planDataKeyOnboarding({ credentials: provisioned, accountPublicKey: otherPub, hasLocalSessions: false })
    expect(r).toEqual({ ok: false, reason: 'account-key-mismatch' })
  })

  it('carries the original credential as backup for deactivate (AC3)', () => {
    const r = planDataKeyOnboarding({ credentials: provisioned, accountPublicKey: accountPub, hasLocalSessions: false })
    if (!r.ok) throw new Error('expected ok')
    const back = parseCredentials(r.backup)
    expect(back?.encryption.type).toBe('legacy')
  })
})
