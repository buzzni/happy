import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { createManualPersonalSpawn, verifyManualPersonalConsent, MANUAL_PERSONAL_ENV } from './manualPersonalClaude'
import { verifyAiAuthSelection, applyAppliedAiAuthSourceEnv, captureSaycodeAgentEnvironment, SETUP_TOKEN_BINDING_ENV, formatSetupTokenBinding } from './sessionEnv'
const pair = generateKeyPairSync('ed25519'), spki = pair.publicKey.export({ format: 'der', type: 'spki' })
const publicKey = { keyId: createHash('sha256').update(spki).digest('hex'), publicKeyBase64: spki.toString('base64') }
const expected = { origin: 'https://studio.test', companyId: 'org', userId: 'u', machineId: 'pc', bindingNonce: '00000000-0000-4000-8000-000000000001', accountRef: 'a'.repeat(64), nonce: 'b'.repeat(48), launchId: 'launch', now: 100001 }
function proof(extra: Record<string, unknown> = {}) {
 const { origin, now, launchId, ...scope } = expected
 const claims = { ...scope, sessionId: launchId, purpose: 'manual', type: 'claude-personal-selection-v1', aud: `claude-collector-v1@${origin}`, keyId: publicKey.keyId, issuedAt: 100000, expiresAt: 160000, ...extra }
 const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url')
 return `${encoded}.${sign(null, Buffer.from(encoded), pair.privateKey).toString('base64url')}`
}
it('accepts only manual-purpose consent for this exact launch and account', () => {
 expect(verifyManualPersonalConsent(proof(), publicKey, expected)).toBe(true)
 for (const field of ['companyId','userId','machineId','bindingNonce','accountRef','nonce','sessionId','aud','type','purpose'])
   expect(verifyManualPersonalConsent(proof({ [field]: 'another' }), publicKey, expected), field).toBe(false)
 for (const now of [94999,160000,NaN]) expect(verifyManualPersonalConsent(proof(), publicKey, {...expected,now})).toBe(false)
 expect(verifyManualPersonalConsent(proof({expiresAt:200000}),publicKey,expected)).toBe(false)
 expect(verifyManualPersonalConsent(proof({unknown:true}),publicKey,expected)).toBe(false)
})
it('persists only a bounded choice alongside the existing resume authority', () => {
 const binding = formatSetupTokenBinding({ managedAccountId: expected.bindingNonce, credentialGeneration: 1, groupScope: 'org', companyId: 'org', userId: 'u', machineId: 'pc', keyId: 'f'.repeat(64), nonce: expected.bindingNonce, issuedAt: 100000 })
 const saved = captureSaycodeAgentEnvironment({ [SETUP_TOKEN_BINDING_ENV]: binding, [MANUAL_PERSONAL_ENV]: expected.accountRef, CLAUDE_CODE_OAUTH_TOKEN: 'secret-fixture', CONSENT_PROOF: proof() })
 expect(saved).toMatchObject({ [SETUP_TOKEN_BINDING_ENV]: binding, [MANUAL_PERSONAL_ENV]: expected.accountRef })
 expect(JSON.stringify(saved)).not.toContain('secret-fixture')
 expect(JSON.stringify(saved)).not.toContain(proof())
 expect(captureSaycodeAgentEnvironment({ [MANUAL_PERSONAL_ENV]: 'not-an-identity' })).toEqual({[MANUAL_PERSONAL_ENV]: ''})
})

it('applies the exact personal credential at a new spawn, verifies its final source and consumes consent once', async () => {
 const binding = {companyId:'org',groupScope:'org',userId:'u',machineId:'pc',managedAccountId:expected.bindingNonce,credentialGeneration:1,keyId:'f'.repeat(64),nonce:expected.bindingNonce,issuedAt:100000}
 const apply = createManualPersonalSpawn(expected.origin,'pc',{key:async()=>publicKey,personal:async(ref)=>ref===expected.accountRef?{accountRef:ref,label:'pe…@example.test',accessToken:'fixture-private-token',expiresAt:900000}:null,now:()=>100001})
 const selection = {kind:'claude-setup-token' as const,groupScope:'org',managedAccountId:binding.managedAccountId,credentialGeneration:1,personalSelection:{version:1 as const,accountRef:expected.accountRef,nonce:expected.nonce,launchId:expected.launchId,consentProof:proof()}}
 const environment = {[SETUP_TOKEN_BINDING_ENV]:formatSetupTokenBinding(binding),CLAUDE_CODE_OAUTH_TOKEN:'fixture-organization-token',ANTHROPIC_API_KEY:'must-not-survive'}
 const applied = await apply(selection,environment,binding)
 expect(applied.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-private-token')
 expect(applied.ANTHROPIC_API_KEY).toBeUndefined()
 expect(verifyAiAuthSelection(selection,applyAppliedAiAuthSourceEnv(applied,true))).toEqual({appliedSource:'personal-subscription'})
 expect(JSON.stringify(captureSaycodeAgentEnvironment(applied))).not.toContain('fixture-private-token')
 await expect(apply(selection,environment,binding)).rejects.toThrow('REPLAY')
})
