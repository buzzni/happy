import { describe, it, expect, vi } from 'vitest'
import { createPersonalClaudeFallback } from './personalClaudeFallback'
const credential = { accountRef: 'personal-ref', label: 'pe…@example.test', accessToken: 'fixture-personal', expiresAt: 900000 }
function fixture(busy = () => false) {
 const clock={now:1000}
 const env: Record<string, string | undefined> = { HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: 'org-binding', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-org', ANTHROPIC_API_KEY: 'must-remove' }
 const availability = vi.fn(async () => ({ allLimited: true, consentApproved: true, availableAccountIds: [] as string[] }))
 const personal = vi.fn(async () => credential)
 const rebind = vi.fn(async () => ({ ok: true as const, environment: { HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: 'new-org-binding', CLAUDE_CODE_OAUTH_TOKEN: 'new-org-token' } }))
 const state = createPersonalClaudeFallback({ env, binding: () => env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING, availability, personal, rebind, busy, now: () => clock.now, notify: vi.fn() })
 return { state, env, availability, personal, rebind, clock }
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

it('requires a matching error reason at acceptance and can continue only with live authority', async () => {
 const f=fixture()
 f.availability.mockResolvedValue({allLimited:false,availableAccountIds:[],consentApproved:true,fallbackReason:'organization-authentication'} as any)
 const offer=await f.state.status()
 expect(offer).toMatchObject({reason:'organization-authentication'})
 await f.state.accept(offer!.accountRef,offer!.nonce!,'fixture-proof')
 await expect(f.state.beforeUserTurn()).resolves.toBeUndefined()
 f.availability.mockRejectedValue(new Error('membership unavailable'))
 await expect(f.state.beforeUserTurn()).rejects.toThrow()
 const g=fixture(),old=await g.state.status()
 g.availability.mockResolvedValue({allLimited:false,availableAccountIds:[],consentApproved:true,fallbackReason:'organization-lookup'} as any)
 await expect(g.state.accept(old!.accountRef,old!.nonce!,'fixture-proof')).rejects.toThrow()
 expect(g.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-org')
})

it('forwards a provider refusal time without mistaking a transport failure for authorization', async () => {
 const f=fixture()
 f.state.noteOrganizationAuthentication(true)
 await f.state.status()
 expect(f.availability).toHaveBeenLastCalledWith('org-binding',undefined,{kind:'authentication',observedAt:1000})
 f.state.noteOrganizationAuthentication(false)
 await f.state.status()
 expect(f.availability).toHaveBeenLastCalledWith('org-binding',undefined,undefined)
})

it('rejects consent that expires during the online authority check', async () => {
 const f=fixture(),offer=await f.state.status()
 f.availability.mockImplementation(async()=>{f.clock.now=61001;return{allLimited:true,availableAccountIds:[],consentApproved:true}})
 await expect(f.state.accept(offer!.accountRef,offer!.nonce!,'fixture-proof')).rejects.toThrow()
 expect(f.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-org')
})

it('manually chooses personal Claude with organization quota left and keeps the choice', async () => {
 const f=fixture(); f.availability.mockResolvedValue({allLimited:false, availableAccountIds:['org'], consentApproved:true})
 const offer=await f.state.status(credential.accountRef)
 expect(offer).toMatchObject({accountRef:credential.accountRef,reason:'manual-selection'})
 await f.state.accept(offer!.accountRef,offer!.nonce!,'manual-proof')
 expect(f.availability).toHaveBeenLastCalledWith('org-binding',expect.objectContaining({purpose:'manual'}),undefined)
 await f.state.beforeUserTurn()
 expect(f.rebind).not.toHaveBeenCalled()
 expect(f.state.identity()).toMatchObject({accountRef:credential.accountRef})
 expect(await f.state.restoreOrganization()).toBe(true)
 expect(f.state.identity()).toBeNull()
})

it('defers a manual selection during a response until the next verified request boundary', async () => {
 let busy = true
 const f = fixture(() => busy), offer = await f.state.status(credential.accountRef)
 await f.state.accept(offer!.accountRef, offer!.nonce!, 'manual-proof')
 expect(f.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-org')
 expect(f.state.identity()).toBeNull()
 expect(f.state.generation()).toBe(0)
 busy = false; await f.state.beforeUserTurn()
 expect(f.state.identity()?.accountRef).toBe(credential.accountRef)
 expect(f.state.generation()).toBe(1)
 expect(await f.state.status()).toMatchObject({state:'personal', mode:'manual'})
})

it('revalidates a persisted manual choice before initializing the provider on the same conversation', async () => {
 const f = fixture()
 const restored = createPersonalClaudeFallback({ env:f.env, binding:()=>f.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING, initialManual:credential.accountRef,
 availability:f.availability, personal:f.personal, rebind:f.rebind, busy:()=>false, now:()=>f.clock.now, notify:vi.fn() })
 f.availability.mockResolvedValue({allLimited:false,availableAccountIds:['org'],consentApproved:false})
 await restored.initialize(); await restored.beforeUserTurn()
 expect(restored.identity()?.accountRef).toBe(credential.accountRef)
 expect(f.rebind).not.toHaveBeenCalled()
 f.availability.mockRejectedValue(new Error('revoked'))
 await expect(restored.beforeUserTurn()).rejects.toThrow()
})

it.each([false, true])('keeps displayed manual consent through generic polling (organization limited=%s)', async limited => {
 const f=fixture(); f.availability.mockResolvedValue({allLimited:limited, availableAccountIds:limited?[]:['org'], consentApproved:true})
 const offered=await f.state.status(credential.accountRef)
 await f.state.status()
 await f.state.accept(offered!.accountRef,offered!.nonce!,'manual-proof')
 expect(f.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-personal')
})
