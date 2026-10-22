/**
 * Resume authority for a setup-token-bound session whose recorded account left this PC
 * (Saycode specs/managed-account-session-continuation).
 *
 * A group sync removes the slots of accounts no longer assigned to the member, including the one an idle
 * conversation was bound to. That conversation stays the same session: it moves onto an account Studio
 * still assigns, through the same rebind a used-up account takes mid-session, and resumes on it.
 */
import { AiCredentialRuntimeError } from './aiCredentialRuntime'
import type { RebindResult } from './setupTokenAccountSwitch'

/**
 * The recorded account itself is gone or replaced; an unexpected failure (with a cause) is not a reason to move.
 * A token-proof binding reports its removed account as TOKEN_MISMATCH (no desired slot holds its token).
 */
const ACCOUNT_LEFT = new Set(['CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE', 'CLAUDE_SETUP_TOKEN_BINDING_STALE', 'CLAUDE_SETUP_TOKEN_BINDING_TOKEN_MISMATCH'])

export async function resumeSetupTokenEnvironment(input: {
  sessionId: string
  /** The session's recorded binding; absent for a session that never ran on an organization account. */
  recorded: string | undefined
  resolve: () => Promise<Record<string, string>>
  rebind: (sessionId: string, running: string) => Promise<RebindResult>
}): Promise<{ environment: Record<string, string>; rebound: boolean }> {
  try {
    return { environment: await input.resolve(), rebound: false }
  } catch (error) {
    if (!input.recorded || !(error instanceof AiCredentialRuntimeError) || error.failureCause || !ACCOUNT_LEFT.has(error.kind)) throw error
    const result = await input.rebind(input.sessionId, input.recorded)
    if (!result.ok) throw new AiCredentialRuntimeError(`CLAUDE_SETUP_TOKEN_RESUME_${result.reason}`)
    return { environment: result.environment, rebound: true }
  }
}
