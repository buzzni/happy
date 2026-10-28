import { describe, expect, it, vi } from 'vitest'
import { AiCredentialRuntimeError } from './aiCredentialRuntime'
import type { ResumeSessionResult } from '@/modules/common/registerCommonHandlers'
import { organizationResumeRefusal, parseResumeAuthRequirement, resumeSetupTokenEnvironment, shareResumeInFlight } from './resumeSetupTokenRebind'

const RECORDED = '{"account":"removed"}'
const NEXT = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next', HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: '{"account":"assigned"}' }
const refused = (kind: string, failureCause?: string) => Object.assign(new AiCredentialRuntimeError(kind), failureCause ? { failureCause } : {})

describe('resume of a setup-token session whose account left this PC (Saycode specs/managed-account-session-continuation)', () => {
  it('resumes on the recorded account when it is still usable', async () => {
    const rebind = vi.fn()
    expect(await resumeSetupTokenEnvironment({ sessionId: 's', recorded: RECORDED, resolve: async () => ({ token: 'same' }), rebind }))
      .toEqual({ environment: { token: 'same' }, rebound: false })
    expect(rebind).not.toHaveBeenCalled()
  })

  // TOKEN_MISMATCH: a token-proof binding finds no desired slot holding its token once the slot is removed.
  it.each(['CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE', 'CLAUDE_SETUP_TOKEN_BINDING_STALE', 'CLAUDE_SETUP_TOKEN_BINDING_TOKEN_MISMATCH'])('moves the same session onto an assigned account after %s', async kind => {
    const rebind = vi.fn(async () => ({ ok: true as const, environment: NEXT }))
    expect(await resumeSetupTokenEnvironment({ sessionId: 's', recorded: RECORDED, resolve: async () => { throw refused(kind) }, rebind }))
      .toEqual({ environment: NEXT, rebound: true })
    expect(rebind).toHaveBeenCalledWith('s', RECORDED)
  })

  it('names the reason when no account can replace the removed one', async () => {
    const rebind = vi.fn(async () => ({ ok: false as const, reason: 'NO_ACCOUNT' as const }))
    await expect(resumeSetupTokenEnvironment({ sessionId: 's', recorded: RECORDED, resolve: async () => { throw refused('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE') }, rebind }))
      .rejects.toThrow('CLAUDE_SETUP_TOKEN_RESUME_NO_ACCOUNT')
  })

  it('keeps the account for an unexpected failure, a different refusal, or a session with no recorded binding', async () => {
    const rebind = vi.fn()
    const cases = [
      { recorded: RECORDED, error: refused('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE', 'Error:ETIMEDOUT') },
      { recorded: RECORDED, error: refused('CLAUDE_SETUP_TOKEN_SELECTION_REQUIRED') },
      { recorded: RECORDED, error: new Error('disk full') },
      { recorded: undefined, error: refused('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE') },
    ]
    for (const { recorded, error } of cases) {
      await expect(resumeSetupTokenEnvironment({ sessionId: 's', recorded, resolve: async () => { throw error }, rebind })).rejects.toBe(error)
    }
    expect(rebind).not.toHaveBeenCalled()
  })
})

// Saycode specs/claude-org-personal-coexistence I: a Desktop with personal Claude off cannot see which
// account an idle-reaped conversation used, so it asks the daemon that holds the record to resume only on it.
describe('organization-only resume requirement', () => {
  const record = { managedAccountId: '0b6f2c1e-1111-4a2b-8c3d-000000000001', credentialGeneration: 3, groupScope: 'company-1', companyId: 'company-1', userId: 'user-1',
    machineId: 'machine-1', keyId: 'a'.repeat(64), nonce: '6a1f7d3e-2222-4b2b-8c3d-000000000009', issuedAt: 1_800_000_000_000 }
  const organizationSession = { HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: JSON.stringify({ version: 1, ...record }) }
  const requirement = { version: 1, kind: 'organization', companyId: 'company-1' } as const

  it('accepts only the closed requirement shape and treats absence as no requirement', () => {
    expect(parseResumeAuthRequirement(undefined)).toBeUndefined()
    expect(parseResumeAuthRequirement(requirement)).toEqual(requirement)
    for (const value of [null, 'organization', { ...requirement, version: 2 }, { ...requirement, kind: 'personal' }, { ...requirement, companyId: '' }, { ...requirement, extra: true }]) {
      expect(() => parseResumeAuthRequirement(value)).toThrow(/requirement/)
    }
  })

  it('lets a session recorded on the required organization resume', () => {
    expect(organizationResumeRefusal(requirement, organizationSession)).toBeUndefined()
    expect(organizationResumeRefusal(undefined, {})).toBeUndefined()
  })

  it('refuses a session with no organization record, another organization, or an unreadable record', () => {
    for (const environment of [undefined, {}, { HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: JSON.stringify({ version: 1, ...record, companyId: 'company-2', groupScope: 'company-2' }) }, { HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: '{"version":1}' }]) {
      expect(organizationResumeRefusal(requirement, environment)).toBe('CLAUDE_ORGANIZATION_RESUME_REQUIRED')
    }
  })

  // Review #976: a joiner shares the first resume's result, which was decided without the joiner's requirement.
  it('refuses a requirement resume that would join one already in flight, and retries it alone once that settles', async () => {
    const inflight = new Map<string, Promise<ResumeSessionResult>>()
    let release!: () => void
    const start = vi.fn(() => new Promise<ResumeSessionResult>(resolve => { release = () => resolve({ type: 'success', sessionId: 's1' }) }))

    const personal = shareResumeInFlight(inflight, 's1', undefined, start)
    const organization = shareResumeInFlight(inflight, 's1', requirement, start)
    release()

    expect(await personal).toEqual({ type: 'success', sessionId: 's1' })
    expect(await organization).toMatchObject({ type: 'error', code: 'SESSION_LIVE' })
    expect(start).toHaveBeenCalledTimes(1)
    const own = vi.fn(async (): Promise<ResumeSessionResult> => ({ type: 'error', code: 'CLAUDE_ORGANIZATION_RESUME_REQUIRED', errorMessage: 'no record' }))
    expect(await shareResumeInFlight(inflight, 's1', requirement, own)).toMatchObject({ code: 'CLAUDE_ORGANIZATION_RESUME_REQUIRED' })
    expect(own).toHaveBeenCalledTimes(1)
  })
})
