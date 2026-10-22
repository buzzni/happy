import { describe, expect, it, vi } from 'vitest'
import { AiCredentialRuntimeError } from './aiCredentialRuntime'
import { resumeSetupTokenEnvironment } from './resumeSetupTokenRebind'

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
