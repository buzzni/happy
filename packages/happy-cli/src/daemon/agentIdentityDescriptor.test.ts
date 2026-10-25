import { describe, expect, it } from 'vitest'
import { createAgentIdentityAuthority } from './agentIdentityDescriptor'

const state = { machineId: 'machine', happyAccountId: 'account', registrationRevision: 2, epoch: 'launch' }
const descriptor = { descriptorId: 'descriptor', ...state, ownerSubject: { issuer: 'studio', userId: 'user' }, registrationType: 'personal', accountKind: 'personal', observedAt: 1_000, expiresAt: 61_000, issuer: 'studio', audience: 'happy-agent', keyId: 'key', signature: 'signed' }
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
    { ...descriptor, registrationRevision: 1 }, { ...descriptor, expiresAt: 1_999 },
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
  it('invalidates an answer when daemon account state changes during target lookup', async () => {
    let current = { ...state }
    const authority = createAgentIdentityAuthority({ readState: () => current, fetchDescriptor: async () => descriptor,
      verifyDescriptor: async () => true, now: () => 2_000, targetAccount: async () => { current = { ...state, epoch: 'next' }; return 'account' } })
    expect(await authority.inspect('target')).toMatchObject({ relation: 'unknown', reason: 'identity-changed' })
  })
  it('fails closed until the T4o signed identity source is connected', async () => {
    expect(await createAgentIdentityAuthority().inspect('target')).toMatchObject({ relation: 'unknown', reason: 'identity-unavailable' })
  })
})
