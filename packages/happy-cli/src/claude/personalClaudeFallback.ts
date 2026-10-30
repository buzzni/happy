import { randomBytes } from 'node:crypto'
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from './utils/claudeAuthOverrideEnv'
import type { PersonalClaudeCredential } from './personalClaudeCredential'

const BINDING = 'HAPPY_AI_AUTH_SETUP_TOKEN_BINDING'
const AUTH_KEYS = [...CLAUDE_AUTH_OVERRIDE_ENV_KEYS, BINDING, 'HAPPY_AI_AUTH_SOURCE', 'HAPPY_AI_AUTH_CONNECTION_VERSION', 'HAPPY_AI_AUTH_MANUAL_PERSONAL']
export const PERSONAL_RECHECK_NOTICE = 'The next request was not sent because Claude account availability could not be verified. Check the account and send again.'
export class PersonalClaudeRecheckRequired extends Error { constructor() { super('CLAUDE_PERSONAL_FALLBACK_RECHECK_REQUIRED') } }
type Reason = 'manual-selection' | 'quota-exhausted' | 'organization-authentication' | 'organization-lookup'
type Availability = { allLimited: boolean; availableAccountIds: string[]; consentApproved?: boolean; fallbackReason?: Reason }
const reasonOf = (quota: Availability): Reason | undefined => quota.fallbackReason ?? (quota.allLimited ? 'quota-exhausted' : undefined)
type Deps = {
    env: Record<string, string | undefined>; binding(): string | undefined; now(): number; busy(): boolean
    availability(binding: string, consent?: { proof: string; accountRef: string; nonce: string; purpose?: 'manual' }, organizationFailure?: { kind: 'authentication'; observedAt: number }): Promise<Availability>
    personal(accountRef?: string): Promise<PersonalClaudeCredential | null>
    initialManual?: string
    commitManual?(binding: string, consent: { proof: string; accountRef: string; nonce: string; purpose: 'manual'; commit: true }): Promise<void>
    rebind(binding: string, organizationFailure?: { kind: 'authentication'; observedAt: number }): Promise<{ ok: true; environment: Record<string, string> } | { ok: false; reason: string }>
    notify(message: string): void
}
/** A wrapper-process lease, never a machine login change. Losing the process loses personal consent. */
export function createPersonalClaudeFallback(deps: Deps) {
    let original: string | null = null, personal: PersonalClaudeCredential | null = null, generation = 0, manual = false
    let backup: Record<string, string | undefined> | null = null
    let offer: { nonce: string; accountRef: string; binding: string; expiresAt: number; reason: Reason } | null = null
    let pendingPersonal: PersonalClaudeCredential | null = null
    let authenticationFailedAt: number | null = null
    const availability = (binding: string, consent?: { proof: string; accountRef: string; nonce: string; purpose?: 'manual' }) => deps.availability(binding, consent, authenticationFailedAt !== null ? { kind: 'authentication', observedAt: authenticationFailedAt } : undefined)
    let transition = false, wake = new AbortController(), stopped = false, cancellationEpoch = 0
    const fail = () => new PersonalClaudeRecheckRequired()
    const apply = (environment: Record<string, string>) => {
        for (const key of AUTH_KEYS) delete deps.env[key]
        for (const [key, value] of Object.entries(environment)) deps.env[key] = value
        generation++; wake.abort(); wake = new AbortController()
    }
    const applyOrganization = async (binding: string) => {
        const result = await deps.rebind(binding, authenticationFailedAt !== null ? { kind: 'authentication', observedAt: authenticationFailedAt } : undefined)
        if (!result.ok || stopped || !result.environment.CLAUDE_CODE_OAUTH_TOKEN || !result.environment[BINDING]) throw fail()
        apply(result.environment); authenticationFailedAt = null; original = null; personal = null; backup = null; pendingPersonal = null; manual = false
        deps.notify('Organization Claude is available again. This conversation continues with the organization account.')
    }
    return {
        noteOrganizationAuthentication(failed: boolean) { if (!personal) { authenticationFailedAt = failed ? deps.now() : null; if (offer?.reason !== 'manual-selection') offer = null } },
        generation: () => generation,
        signal: (): AbortSignal => wake.signal,
        identity: () => personal ? { accountRef: personal.accountRef, label: personal.label } : null,
        cancelPending() { cancellationEpoch++; offer = null },
        cancel() { stopped = true; offer = null; wake.abort(); if (backup) { for (const key of AUTH_KEYS) { const value = backup[key]; if (value === undefined) delete deps.env[key]; else deps.env[key] = value } backup = null; personal = null; original = null } },
        async initialize() {
            if (!deps.initialManual) return
            const binding = deps.binding(), candidate = await deps.personal(deps.initialManual)
            if (!binding || !candidate) throw fail()
            await availability(binding)
            if (stopped || binding !== (original ?? deps.binding())) throw fail()
            backup = Object.fromEntries(AUTH_KEYS.map(key => [key, deps.env[key]])); original = binding; personal = candidate; manual = true
            apply({ CLAUDE_CODE_OAUTH_TOKEN: candidate.accessToken, HAPPY_AI_AUTH_SOURCE: 'personal-subscription' })
        },
        async status(accountRef?: string) {
            if (stopped || transition || !accountRef && deps.busy()) return null
            if (!accountRef && (personal || pendingPersonal)) return { state: 'personal' as const, accountRef: (personal ?? pendingPersonal)!.accountRef, label: (personal ?? pendingPersonal)!.label, ...(manual ? { mode: 'manual' as const } : {}) }
            const binding = original ?? deps.binding(); if (!binding) return null
            const quota = await availability(binding)
            if (!accountRef && offer?.reason === 'manual-selection' && offer.binding === binding && offer.expiresAt > deps.now() && !stopped && binding === (original ?? deps.binding())) return null
            if (stopped || binding !== (original ?? deps.binding()) || !accountRef && !reasonOf(quota)) { offer = null; return null }
            const candidate = await deps.personal(accountRef)
            if (!candidate || accountRef && candidate.accountRef !== accountRef || stopped || binding !== (original ?? deps.binding())) return null
            // Polling and a second viewer must not invalidate an already displayed confirmation.
            if (!offer || offer.binding !== binding || offer.accountRef !== candidate.accountRef || offer.expiresAt <= deps.now() || offer.reason !== (accountRef ? 'manual-selection' : reasonOf(quota)))
                offer = { nonce: randomBytes(24).toString('hex'), accountRef: candidate.accountRef, binding, expiresAt: deps.now() + 60_000, reason: accountRef ? 'manual-selection' : reasonOf(quota)! }
            return { state: 'offer' as const, label: candidate.label, accountRef: candidate.accountRef, nonce: offer.nonce, reason: offer.reason }
        },
        async accept(accountRef: string, nonce: string, proof: string) {
            const consent = offer, epoch = cancellationEpoch
            if (typeof proof !== 'string' || !proof.length || proof.length > 4096 || stopped || transition || deps.busy() && consent?.reason !== 'manual-selection' || !consent || consent.nonce !== nonce || consent.accountRef !== accountRef
                || consent.expiresAt <= deps.now() || consent.binding !== (original ?? deps.binding())) throw fail()
            transition = true; offer = null
            try {
                const quota = await availability(consent.binding, { proof, accountRef, nonce, ...(consent.reason === 'manual-selection' ? { purpose: 'manual' as const } : {}) }), candidate = await deps.personal(accountRef)
                if (stopped || consent.expiresAt <= deps.now() || epoch !== cancellationEpoch || deps.busy() && consent.reason !== 'manual-selection' || consent.binding !== (original ?? deps.binding()) || consent.reason !== 'manual-selection' && reasonOf(quota) !== consent.reason || quota.consentApproved !== true || !candidate || candidate.accountRef !== accountRef) throw fail()
                if (consent.reason === 'manual-selection') await deps.commitManual?.(consent.binding, { proof, accountRef, nonce, purpose: 'manual', commit: true })
                if (stopped || epoch !== cancellationEpoch || consent.binding !== (original ?? deps.binding())) throw fail()
                backup ??= Object.fromEntries(AUTH_KEYS.map(key => [key, deps.env[key]])); original = consent.binding; manual = consent.reason === 'manual-selection'
                if (manual && deps.busy()) pendingPersonal = candidate
                else { personal = candidate; pendingPersonal = null; apply({ CLAUDE_CODE_OAUTH_TOKEN: candidate.accessToken, HAPPY_AI_AUTH_SOURCE: 'personal-subscription' }) }
                deps.notify(manual ? 'Personal Claude was selected for this conversation.' : 'Personal Claude usage was approved for this conversation. It returns to organization Claude when an account is available.')
            } finally { transition = false }
        },
        async restoreOrganization() {
            if (stopped || transition || deps.busy()) return false
            const binding = original ?? deps.binding(); if (!binding) return false
            transition = true
            try {
                const quota = await availability(binding)
                if (stopped) return false
                if (!personal && !pendingPersonal) return true
                if (!quota.availableAccountIds.length) return false
                await applyOrganization(binding)
                return true
            } finally { transition = false }
        },
        async beforeUserTurn() {
            if (pendingPersonal) { personal = pendingPersonal; pendingPersonal = null; apply({ CLAUDE_CODE_OAUTH_TOKEN: personal.accessToken, HAPPY_AI_AUTH_SOURCE: 'personal-subscription' }) }
            if (!original || !personal) return
            if (transition || stopped) throw fail()
            transition = true
            try {
                // Failure is not permission to keep spending personal quota after authority was lost.
                const quota = await availability(original)
                if (stopped) throw fail()
                if (!manual && quota.availableAccountIds.length) {
                    await applyOrganization(original)
                } else {
                    if (!manual && !reasonOf(quota)) throw fail()
                    const current = await deps.personal(personal.accountRef)
                    if (!current || stopped || current.accountRef !== personal.accountRef) throw fail()
                    // Refresh only the selected local access token; no refresh credential is copied or used.
                    if (current.accessToken !== personal.accessToken) apply({ CLAUDE_CODE_OAUTH_TOKEN: current.accessToken, HAPPY_AI_AUTH_SOURCE: 'personal-subscription' })
                    personal = current
                }
            } catch { throw fail() } finally { transition = false }
        },
    }
}
