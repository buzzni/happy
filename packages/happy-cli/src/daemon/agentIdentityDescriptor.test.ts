import { describe, expect, it, vi } from 'vitest'
import { createAgentIdentityAuthority } from './agentIdentityDescriptor'

const state = { machineId: 'machine', happyAccountId: 'account', epoch: 'launch' }
const descriptor = { version: 1, type: 'saycode-machine-agent-identity', issuedAt: 1_000, descriptorId: 'descriptor', machineId: state.machineId, happyAccountId: state.happyAccountId, registrationRevision: 'a'.repeat(64), ownerSubject: { issuer: 'https://studio.test', userId: 'user' }, registrationType: 'personal', accountKind: 'personal', observedAt: 1_000, expiresAt: 61_000, issuer: 'https://studio.test', audience: 'https://happy.test', keyId: 'b'.repeat(64), signature: Buffer.alloc(64).toString('base64url') }
function fixture() {
  let current = { ...state }
  let value: unknown = { ...descriptor }
  let verified = true
  let account: string | null = 'account'
  const authority = createAgentIdentityAuthority({
    readState: () => current,
    fetchDescriptor: async () => value,
    verifyDescriptor: async () => verified,
    targetAccount: async () => account,
    now: () => 2_000,
  })
  return { authority, state: (v: typeof state) => { current = v }, descriptor: (v: unknown) => { value = v }, verify: (v: boolean) => { verified = v }, account: (v: string | null) => { account = v } }
}
describe('personal machine descriptor authority', () => {
  it('admits only a verified personal descriptor and a server-confirmed same-account target', async () => {
    expect(await fixture().authority.inspect('target')).toMatchObject({ relation: 'own-sibling', proof: 'personal-same-account' })
  })
  it.each([
    null, {}, { ...descriptor, registrationType: 'company' }, { ...descriptor, accountKind: 'company' },
    { ...descriptor, machineId: 'other' }, { ...descriptor, happyAccountId: 'other' },
    { ...descriptor, epoch: 'unsigned-extra-field' },
    { ...descriptor, expiresAt: 1_999 },
    { ...descriptor, observedAt: 3_000 }, { ...descriptor, expiresAt: 61_001 },
    { ...descriptor, ownerSubject: null },
  ])('does not infer personal ownership from missing or invalid evidence %j', async value => {
    const f = fixture(); f.descriptor(value)
    expect(await f.authority.inspect('target')).toMatchObject({ relation: 'unknown', proof: null })
  })
  it('rejects bad signatures and different or unknown target accounts', async () => {
    const f = fixture(); f.verify(false)
    expect(await f.authority.inspect('target')).toMatchObject({ relation: 'unknown' })
    f.verify(true); f.account('other')
    expect(await f.authority.inspect('target')).toMatchObject({ relation: 'other', proof: null })
    f.account(null)
    expect(await f.authority.inspect('target')).toMatchObject({ relation: 'unknown' })
  })
  it('verifies the original canonical signed document without adding a local epoch', async () => {
    const raw = { ...descriptor }
    const verifyDescriptor = vi.fn(async (value: unknown) => value === raw)
    const authority = createAgentIdentityAuthority({ readState: () => state, fetchDescriptor: async () => raw,
      verifyDescriptor, targetAccount: async () => 'account', now: () => 2_000 })
    expect(await authority.inspect('target')).toMatchObject({ relation: 'own-sibling', proof: 'personal-same-account' })
    expect(verifyDescriptor).toHaveBeenCalledWith(raw, state)
    expect(raw).not.toHaveProperty('epoch')
  })
  it.each(['fetch', 'verify', 'target'] as const)('fences all current registration fields across %s awaits', async stage => {
    for (const changed of [{ machineId: 'new-machine' }, { happyAccountId: 'new-account' },
      { epoch: 'new-host' }]) {
      let current = { ...state }
      const change = (at: string) => { if (at === stage) current = { ...current, ...changed } }
      let targetReads = 0
      const authority = createAgentIdentityAuthority({ readState: () => current,
        fetchDescriptor: async () => { change('fetch'); return descriptor },
        verifyDescriptor: async () => { change('verify'); return true }, now: () => 2_000,
        targetAccount: async () => { targetReads++; change('target'); return 'account' } })
      expect(await authority.inspect('target')).toMatchObject({ relation: 'unknown', proof: null, reason: 'identity-changed' })
      expect(targetReads).toBe(stage === 'target' ? 1 : 0)
    }
  })
  it('invalidates an answer when daemon account state changes during target lookup', async () => {
    let current = { ...state }
    const authority = createAgentIdentityAuthority({ readState: () => current, fetchDescriptor: async () => descriptor,
      verifyDescriptor: async () => true, now: () => 2_000, targetAccount: async () => { current = { ...state, epoch: 'next' }; return 'account' } })
    expect(await authority.inspect('target')).toMatchObject({ relation: 'unknown', reason: 'identity-changed' })
  })
  it.each(['registrationRevision', 'subject', 'machine', 'account'])('invalidates a bound authority on descriptor %s change and never rebinds', async field => {
    let current: unknown = { ...descriptor }
    let now = 2_000
    const authority = createAgentIdentityAuthority({ readState: () => state, fetchDescriptor: async () => current,
      verifyDescriptor: async () => true, targetAccount: async () => 'account', now: () => now })
    expect(await authority.inspect('target')).toMatchObject({ relation: 'own-sibling' })
    now = 62_000
    const fresh = { ...descriptor, issuedAt: now, observedAt: now, expiresAt: now + 60_000 }
    current = { ...fresh, ...(field === 'registrationRevision' ? { registrationRevision: 'c'.repeat(64) }
      : field === 'subject' ? { ownerSubject: { ...descriptor.ownerSubject, userId: 'other' } }
      : field === 'machine' ? { machineId: 'other' } : { happyAccountId: 'other' }) }
    expect(await authority.inspect('target')).toMatchObject({ relation: 'unknown', reason: 'identity-changed' })
    current = fresh
    expect(await authority.inspect('target')).toMatchObject({ relation: 'unknown', reason: 'identity-changed' })
  })
  it('refreshes an expired snapshot when the bound identity and revision stay the same', async () => {
    let now = 2_000
    const authority = createAgentIdentityAuthority({ readState: () => state,
      fetchDescriptor: async () => ({ ...descriptor, descriptorId: String(now), issuedAt: now, observedAt: now, expiresAt: now + 60_000 }),
      verifyDescriptor: async () => true, targetAccount: async () => 'account', now: () => now })
    expect(await authority.inspect('target')).toMatchObject({ relation: 'own-sibling' })
    now = 62_000
    expect(await authority.inspect('target')).toMatchObject({ relation: 'own-sibling' })
  })
  it('fails closed until the T4o signed identity source is connected', async () => {
    expect(await createAgentIdentityAuthority().inspect('target')).toMatchObject({ relation: 'unknown', reason: 'identity-unavailable' })
  })
})
