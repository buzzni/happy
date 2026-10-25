import { describe, it, expect, vi } from 'vitest'
import { createPersonalClaudeFallback } from './personalClaudeFallback'
const credential = { accountRef: 'personal-ref', label: 'pe…@example.test', accessToken: 'fixture-personal', expiresAt: 900000 }
function fixture() {
 const env: Record<string, string | undefined> = { HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: 'org-binding', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-org', ANTHROPIC_API_KEY: 'must-remove' }
 const availability = vi.fn(async () => ({ allLimited: true, consentApproved: true, availableAccountIds: [] as string[] }))
 const personal = vi.fn(async () => credential)
 const rebind = vi.fn(async () => ({ ok: true as const, environment: { HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: 'new-org-binding', CLAUDE_CODE_OAUTH_TOKEN: 'new-org-token' } }))
 const state = createPersonalClaudeFallback({ env, binding: () => env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING, availability, personal, rebind, busy: () => false, now: () => 1000, notify: vi.fn() })
 return { state, env, availability, personal, rebind }
}
describe('same conversation personal fallback', () => {
 it('never switches without scoped consent and rejects stale or revoked quota evidence', async () => {
  const f = fixture(); const offer = await f.state.status()
  expect(f.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-org')
  f.availability.mockResolvedValue({ allLimited: false, consentApproved: false, availableAccountIds: [] })
  await expect(f.state.accept(offer!.accountRef, offer!.nonce!, 'fixture-signed-consent')).rejects.toThrow()
  expect(f.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-org')
 })
 it('switches only this process and returns only after verified organization availability', async () => {
  const f = fixture(); const offer = await f.state.status()
  await f.state.accept(offer!.accountRef, offer!.nonce!, 'fixture-signed-consent')
  expect(f.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-personal')
  expect(f.env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(f.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING).toBeUndefined()
  await f.state.beforeUserTurn(); expect(f.rebind).not.toHaveBeenCalled()
  f.availability.mockResolvedValue({ allLimited: false, consentApproved: false, availableAccountIds: ['available-org'] })
  await f.state.beforeUserTurn()
  expect(f.rebind).toHaveBeenCalledOnce()
  expect(f.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('new-org-token')
  expect(f.state.identity()).toBeNull()
 })
 it('consumes consent once and does not mistake network failures for exhaustion', async () => {
  const f=fixture(); const offer=await f.state.status()
  await Promise.allSettled([f.state.accept(offer!.accountRef, offer!.nonce!, 'fixture-signed-consent'), f.state.accept(offer!.accountRef, offer!.nonce!, 'fixture-signed-consent')])
  expect(f.state.generation()).toBe(1)
  const g=fixture();g.availability.mockRejectedValue(new Error('offline'))
  await expect(g.state.status()).rejects.toThrow('offline')
  expect(g.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-org')
 })
})

it('does not leak personal authentication when the remote wrapper closes or changes mode', async () => {
 const f=fixture(), offer=await f.state.status()
 await f.state.accept(offer!.accountRef,offer!.nonce!,'fixture-proof')
 f.state.cancel()
 expect(f.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-org')
 expect(f.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING).toBe('org-binding')
 expect(f.env.HAPPY_AI_AUTH_SOURCE).toBeUndefined()
})
it('rejects a missing owner consent signature even when every account is limited', async () => {
 const f=fixture(),offer=await f.state.status()
 f.availability.mockResolvedValue({allLimited:true,availableAccountIds:[],consentApproved:false})
 await expect(f.state.accept(offer!.accountRef,offer!.nonce!,'forged-proof')).rejects.toThrow()
 expect(f.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-org')
})

it('does not authorize another personal request when organization authority cannot be rechecked', async () => {
 const f=fixture(),offer=await f.state.status()
 await f.state.accept(offer!.accountRef,offer!.nonce!,'fixture-proof')
 f.availability.mockRejectedValue(new Error('network error'))
 await expect(f.state.beforeUserTurn()).rejects.toThrow('CLAUDE_PERSONAL_FALLBACK_RECHECK_REQUIRED')
 expect(f.rebind).not.toHaveBeenCalled()
 f.state.cancel()
})

it('supports an organization-only restoration without granting another personal request', async () => {
 const f=fixture(),offer=await f.state.status()
 await f.state.accept(offer!.accountRef,offer!.nonce!,'fixture-proof')
 expect(await f.state.restoreOrganization()).toBe(false)
 f.availability.mockResolvedValue({allLimited:false,availableAccountIds:['org'],consentApproved:false})
 expect(await f.state.restoreOrganization()).toBe(true)
 expect(f.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('new-org-token')
 expect(f.state.identity()).toBeNull()
})
