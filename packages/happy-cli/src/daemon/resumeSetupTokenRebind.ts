import { MANUAL_PERSONAL_ENV } from './manualPersonalClaude'
/**
 * Resume authority for a setup-token-bound session whose recorded account left this PC
 * (Saycode specs/managed-account-session-continuation).
 *
 * A group sync removes the slots of accounts no longer assigned to the member, including the one an idle
 * conversation was bound to. That conversation stays the same session: it moves onto an account Studio
 * still assigns, through the same rebind a used-up account takes mid-session, and resumes on it.
 */
import type { ResumeSessionResult } from '@/modules/common/registerCommonHandlers'
import { AiCredentialRuntimeError } from './aiCredentialRuntime'
import { shareInFlight } from './resumeGuards'
import type { RebindResult } from './setupTokenAccountSwitch'
import { readSetupTokenResumeSelection, type SaycodeAgentEnvironment } from './sessionEnv'

/**
 * The recorded account itself is gone or replaced; an unexpected failure (with a cause) is not a reason to move.
 * A token-proof binding reports a removed slot as TOKEN_MISMATCH: no desired slot holds its token any more.
 */
const ACCOUNT_LEFT = new Set(['CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE', 'CLAUDE_SETUP_TOKEN_BINDING_STALE', 'CLAUDE_SETUP_TOKEN_BINDING_TOKEN_MISMATCH'])

export async function resumeSetupTokenEnvironment(input: {
  sessionId: string
  /** The session's recorded binding; absent for a session that never ran on an organization account. */
  recorded: string | undefined
  resolve: () => Promise<Record<string, string>>
  manualChoice?: string
  rebind: (sessionId: string, running: string) => Promise<RebindResult>
}): Promise<{ environment: Record<string, string>; rebound: boolean }> {
  if (input.manualChoice !== undefined && !/^[a-f0-9]{64}$/.test(input.manualChoice)) throw new Error('CLAUDE_PERSONAL_SELECTION_INVALID')
  try {
    return { environment: await input.resolve(), rebound: false }
  } catch (error) {
    if (!input.recorded || !(error instanceof AiCredentialRuntimeError) || error.failureCause || !ACCOUNT_LEFT.has(error.kind)) throw error
    const result = await input.rebind(input.sessionId, input.recorded)
    if (!result.ok) throw new AiCredentialRuntimeError(`CLAUDE_SETUP_TOKEN_RESUME_${result.reason}`)
    return { environment: result.environment, rebound: true }
  }
}

/** Saycode specs/claude-org-personal-coexistence I: resume only on the organization this daemon recorded. */
export type ResumeAuthRequirement = { version: 1; kind: 'organization'; companyId: string }

/** A malformed requirement is refused, not ignored: ignoring it would resume on whatever login this PC has. */
export function parseResumeAuthRequirement(value: unknown): ResumeAuthRequirement | undefined {
  if (value === undefined) return undefined
  const row = value as Record<string, unknown> | null
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['version', 'kind', 'companyId'].includes(key))
    || row.version !== 1 || row.kind !== 'organization' || typeof row.companyId !== 'string' || !row.companyId || row.companyId.length > 128) {
    throw new Error('Resume auth requirement is invalid')
  }
  return { version: 1, kind: 'organization', companyId: row.companyId }
}

/**
 * A Desktop that turned personal Claude off cannot see which account an idle-reaped conversation used.
 * The recorded binding can: a session that has one never resumes on a personal login (see above).
 */
export function organizationResumeRefusal(requirement: ResumeAuthRequirement | undefined, agentEnvironment: SaycodeAgentEnvironment | undefined, restoringManual = false): string | undefined {
  if (!requirement) return undefined
  if (agentEnvironment?.[MANUAL_PERSONAL_ENV] !== undefined && !restoringManual) return 'CLAUDE_ORGANIZATION_RESUME_REQUIRED'
  let companyId: string | undefined
  try { companyId = readSetupTokenResumeSelection(agentEnvironment)?.binding.companyId } catch { /* An unreadable record proves nothing. */ }
  return companyId === requirement.companyId ? undefined : 'CLAUDE_ORGANIZATION_RESUME_REQUIRED'
}

/**
 * Concurrent resumes of one session share a single attempt, decided with the first caller's options only.
 * A caller with a requirement never takes that result: it may be a child on this PC's login (review #976).
 */
export function shareResumeInFlight(
  inflight: Map<string, Promise<ResumeSessionResult>>,
  sessionId: string,
  requirement: ResumeAuthRequirement | undefined,
  start: () => Promise<ResumeSessionResult>,
): Promise<ResumeSessionResult> {
  if (requirement && inflight.has(sessionId)) {
    return Promise.resolve({ type: 'error', code: 'SESSION_LIVE', errorMessage: `Session ${sessionId} is already being resumed; retry once it settles.` })
  }
  return shareInFlight(inflight, sessionId, start)
}
