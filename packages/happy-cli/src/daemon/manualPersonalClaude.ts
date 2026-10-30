/** Explicit personal selection: scoped proof in, process-local credential out; never a machine login switch. */
import { createPublicKey, verify } from 'node:crypto'
import { z } from 'zod'
import { readPersonalClaudeCredential, type PersonalClaudeCredential } from '@/claude/personalClaudeCredential'
import { fetchStudioPublicKey, type StudioPublicKey } from './setupTokenBindingProof'
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '@/claude/utils/claudeAuthOverrideEnv'

export const MANUAL_PERSONAL_ENV = 'HAPPY_AI_AUTH_MANUAL_PERSONAL'
export const manualPersonalSelectionSchema = z.object({ version: z.literal(1), accountRef: z.string().regex(/^[a-f0-9]{64}$/),
    nonce: z.string().regex(/^[a-f0-9]{48}$/), launchId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), consentProof: z.string().min(1).max(4096) }).strict()
export type ManualPersonalSelection = z.infer<typeof manualPersonalSelectionSchema>
const claimsSchema = z.object({ purpose: z.literal('manual'), type: z.literal('claude-personal-selection-v1'), aud: z.string(), keyId: z.string(),
    companyId: z.string(), userId: z.string(), machineId: z.string(), sessionId: z.string(), bindingNonce: z.string(),
    accountRef: z.string(), nonce: z.string(), issuedAt: z.number().int().positive(), expiresAt: z.number().int().positive() }).strict()
export function verifyManualPersonalConsent(envelope: string, publicKey: { keyId: string; publicKeyBase64: string }, expected: {
    origin: string; companyId: string; userId: string; machineId: string; bindingNonce: string; accountRef: string; nonce: string; launchId: string; now: number
}): boolean {
    try {
        if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(envelope) || envelope.length > 4096) return false
        const [encoded, signature] = envelope.split('.')
        const key = createPublicKey({ key: Buffer.from(publicKey.publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
        if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(encoded), key, Buffer.from(signature, 'base64url'))) return false
        const claims = claimsSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
        return Number.isFinite(expected.now) && claims.keyId === publicKey.keyId && claims.aud === `claude-collector-v1@${expected.origin}`
            && claims.expiresAt - claims.issuedAt === 60000 && expected.now < claims.expiresAt && expected.now >= claims.issuedAt - 5000
            && claims.sessionId === expected.launchId && ['companyId', 'userId', 'machineId', 'bindingNonce', 'accountRef', 'nonce'].every(key => claims[key as keyof typeof claims] === expected[key as keyof typeof expected])
    } catch { return false }
}
export function createManualPersonalSpawn(origin: string | null, machineId: string, deps: { key?: () => Promise<StudioPublicKey | null>; personal?: (ref: string) => Promise<PersonalClaudeCredential | null>; now?: () => number } = {}) {
    const used = new Map<string, number>()
    return async (selection: { kind: string; groupScope?: string; personalSelection?: ManualPersonalSelection } | undefined, environment: Record<string, string>, binding?: { companyId: string; userId: string; machineId: string; nonce: string }) => {
        if (selection?.kind !== 'claude-setup-token' || !selection.personalSelection) return environment
        const chosen = manualPersonalSelectionSchema.parse(selection.personalSelection)
        if (!origin || !binding || binding.machineId !== machineId || binding.companyId !== selection.groupScope) throw new Error('CLAUDE_PERSONAL_SELECTION_FORBIDDEN')
        const key = await (deps.key?.() ?? fetchStudioPublicKey(origin, fetch)), credential = await (deps.personal?.(chosen.accountRef) ?? readPersonalClaudeCredential(chosen.accountRef)), now = deps.now?.() ?? Date.now()
        if (!key || !credential || !verifyManualPersonalConsent(chosen.consentProof, key, { origin, ...binding, bindingNonce: binding.nonce,
            accountRef: chosen.accountRef, nonce: chosen.nonce, launchId: chosen.launchId, now })) throw new Error('CLAUDE_PERSONAL_SELECTION_FORBIDDEN')
        for (const [nonce, expiry] of used) if (expiry <= now) used.delete(nonce)
        if (used.has(chosen.nonce) || used.size >= 10000) throw new Error('CLAUDE_PERSONAL_SELECTION_REPLAY')
        used.set(chosen.nonce, now + 60000)
        const env = { ...environment }
        for (const key of CLAUDE_AUTH_OVERRIDE_ENV_KEYS) delete env[key]
        return { ...env, CLAUDE_CODE_OAUTH_TOKEN: credential.accessToken, HAPPY_AI_AUTH_SOURCE: 'personal-subscription', [MANUAL_PERSONAL_ENV]: chosen.accountRef }
    }
}
