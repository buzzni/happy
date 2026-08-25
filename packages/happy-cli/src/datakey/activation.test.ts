/**
 * aplus §6-1 CLI dataKey-활성 전환 (specs/e2ee-cli-datakey-activation Phase 0).
 *
 * 계획(plan) 함수는 순수하다 — 어떤 파일도 쓰지 않고 "무엇을 쓸지"만
 * 반환하므로, 게이트 실패 시 credential 무변경(AC3)이 구조적으로 성립한다.
 * 쓰기는 command 계층이 ok 결과에서만 수행한다.
 */
import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { parseCredentials } from '@/persistence'
import { encodeBase64 } from '@/api/encryption'
import {
  planDataKeyActivation,
  planDataKeyDeactivation,
  describeDataKeyStatus,
} from './activation'

const secret = new Uint8Array(randomBytes(32))
const publicKey = new Uint8Array(randomBytes(32))
const machineKey = new Uint8Array(randomBytes(32))

const legacyRaw = { token: 'tok', secret: encodeBase64(secret) }
const provisionedRaw = {
  token: 'tok',
  secret: encodeBase64(secret),
  encryption: { publicKey: encodeBase64(publicKey), machineKey: encodeBase64(machineKey) },
}
const dataKeyRaw = {
  token: 'tok',
  encryption: { publicKey: encodeBase64(publicKey), machineKey: encodeBase64(machineKey) },
}

const envelopePresent = async () => 'ZW52ZWxvcGU='
const envelopeMissing = async () => null
const serverDown = async (): Promise<string | null> => {
  throw new Error('network down')
}

describe('planDataKeyActivation — fail-closed 게이트 (AC3)', () => {
  it('refuses when there are no credentials', async () => {
    const result = await planDataKeyActivation({
      rawCredentials: null,
      machineId: 'm1',
      fetchServerEnvelope: envelopePresent,
    })
    expect(result).toEqual({ ok: false, reason: 'no-credentials' })
  })

  it('refuses unparseable credentials', async () => {
    const result = await planDataKeyActivation({
      rawCredentials: { garbage: true },
      machineId: 'm1',
      fetchServerEnvelope: envelopePresent,
    })
    expect(result).toEqual({ ok: false, reason: 'no-credentials' })
  })

  it('refuses when already dataKey-active', async () => {
    const result = await planDataKeyActivation({
      rawCredentials: dataKeyRaw,
      machineId: 'm1',
      fetchServerEnvelope: envelopePresent,
    })
    expect(result).toEqual({ ok: false, reason: 'already-datakey' })
  })

  it('refuses plain legacy credentials without provisioned material', async () => {
    const result = await planDataKeyActivation({
      rawCredentials: legacyRaw,
      machineId: 'm1',
      fetchServerEnvelope: envelopePresent,
    })
    expect(result).toEqual({ ok: false, reason: 'not-provisioned' })
  })

  it('refuses when the machine id is unknown', async () => {
    const result = await planDataKeyActivation({
      rawCredentials: provisionedRaw,
      machineId: null,
      fetchServerEnvelope: envelopePresent,
    })
    expect(result).toEqual({ ok: false, reason: 'no-machine-id' })
  })

  it('fails closed when the server envelope check errors (no silent activation)', async () => {
    const result = await planDataKeyActivation({
      rawCredentials: provisionedRaw,
      machineId: 'm1',
      fetchServerEnvelope: serverDown,
    })
    expect(result).toEqual({ ok: false, reason: 'server-unreachable' })
  })

  it('refuses when the server machine record has no dataEncryptionKey envelope', async () => {
    const result = await planDataKeyActivation({
      rawCredentials: provisionedRaw,
      machineId: 'm1',
      fetchServerEnvelope: envelopeMissing,
    })
    expect(result).toEqual({ ok: false, reason: 'server-envelope-missing' })
  })
})

describe('planDataKeyActivation — 성공 경로', () => {
  it('produces a dataKey credential that round-trips with the same material, and echoes the backup', async () => {
    const result = await planDataKeyActivation({
      rawCredentials: provisionedRaw,
      machineId: 'm1',
      fetchServerEnvelope: envelopePresent,
    })
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)

    // 백업은 원본 raw 그대로 — deactivate 가 바이트 동일 상태로 복원한다.
    expect(result.backup).toEqual(provisionedRaw)

    // 산출물은 secret 없는 dataKey 포맷으로 파싱되고, 재료가 병기분과 동일.
    const parsed = parseCredentials(result.serialized)
    expect(parsed?.encryption.type).toBe('dataKey')
    if (parsed?.encryption.type !== 'dataKey') throw new Error('unreachable')
    expect(parsed.token).toBe('tok')
    expect(parsed.encryption.publicKey).toEqual(publicKey)
    expect(parsed.encryption.machineKey).toEqual(machineKey)
    expect((result.serialized as { secret?: unknown }).secret).toBeUndefined()
  })
})

describe('planDataKeyDeactivation (AC4)', () => {
  it('refuses when current credentials are not dataKey-active', () => {
    expect(planDataKeyDeactivation({ rawCredentials: provisionedRaw, rawBackup: provisionedRaw }))
      .toEqual({ ok: false, reason: 'not-datakey' })
  })

  it('refuses when there is no backup', () => {
    expect(planDataKeyDeactivation({ rawCredentials: dataKeyRaw, rawBackup: null }))
      .toEqual({ ok: false, reason: 'no-backup' })
  })

  it('refuses a backup that does not parse as a legacy credential', () => {
    expect(planDataKeyDeactivation({ rawCredentials: dataKeyRaw, rawBackup: dataKeyRaw }))
      .toEqual({ ok: false, reason: 'backup-invalid' })
    expect(planDataKeyDeactivation({ rawCredentials: dataKeyRaw, rawBackup: { junk: 1 } }))
      .toEqual({ ok: false, reason: 'backup-invalid' })
  })

  it('restores the backup raw as-is', () => {
    const result = planDataKeyDeactivation({ rawCredentials: dataKeyRaw, rawBackup: provisionedRaw })
    expect(result).toEqual({ ok: true, restored: provisionedRaw })
  })
})

describe('describeDataKeyStatus', () => {
  it('classifies each credential shape', () => {
    expect(describeDataKeyStatus({ rawCredentials: null, rawBackup: null }))
      .toEqual({ variant: 'none', hasBackup: false })
    expect(describeDataKeyStatus({ rawCredentials: legacyRaw, rawBackup: null }))
      .toEqual({ variant: 'legacy', hasBackup: false })
    expect(describeDataKeyStatus({ rawCredentials: provisionedRaw, rawBackup: null }))
      .toEqual({ variant: 'legacy-provisioned', hasBackup: false })
    expect(describeDataKeyStatus({ rawCredentials: dataKeyRaw, rawBackup: provisionedRaw }))
      .toEqual({ variant: 'dataKey', hasBackup: true })
  })
})
