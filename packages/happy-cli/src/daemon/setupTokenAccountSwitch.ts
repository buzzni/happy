/**
 * Mid-session organization setup-token account switch (Saycode specs/claude-setup-token-account-selection).
 *
 * A session bound to a setup-token account reports the usage its provider observed, and asks to move to
 * another account once that one is used up. Studio chooses the account (remaining quota, nearest reset) for
 * this dedicated machine's member; the daemon authenticates with its machine token. The grant Studio returns
 * goes through exactly the verification a new launch does — signature, machine, account generation, nonce,
 * group journal and the token slot — so a switch can never bind what a launch could not.
 */
import type { AiAuthSelection, SetupTokenBinding } from './sessionEnv'
import { readSetupTokenResumeSelection, SETUP_TOKEN_BINDING_ENV } from './sessionEnv'
import type { TrackedSession } from './types'
import { logger } from '@/ui/logger'

export type SetupTokenUsageObservation = {
  observedAt: number
  windows: Array<{ kind: 'unified5h' | 'unified7d'; pct: number | null; resetsAt: number | null }>
  reason: 'ok' | 'rate-limited'
  retryAt: number | null
}
export type SetupTokenAccountSwitchDeps = {
  findSession(sessionId: string): TrackedSession | undefined
  /** The daemon's single trusted Studio origin (HAPPY_APLUS_STUDIO_ORIGIN). */
  studioOrigin: string | null
  machineId: string
  /** The daemon's machine token; Studio has Happy confirm it owns this machine and session. */
  bearer(): string
  fetch: typeof fetch
  /** A new grant (a switch), or the daemon's recorded binding (catching up a session that missed a switch). */
  sessionEnvironment(agent: string, selection: AiAuthSelection, recorded?: SetupTokenBinding): Promise<Record<string, string>>
  /** Records the new binding as the session's resume authority. */
  recordAgentEnvironment(session: TrackedSession, binding: string): void
}
/** FORBIDDEN: Studio refuses this binding for good (PC reassigned, unknown binding); the session stops asking. */
export type SwitchFailure = 'NOT_BOUND' | 'STALE' | 'STUDIO_UNAVAILABLE' | 'NO_ACCOUNT' | 'FORBIDDEN' | 'REQUEST_FAILED' | 'BINDING_REJECTED'

const REQUEST_TIMEOUT_MS = 15_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const parseBinding = (value: string | undefined) => {
  try { return readSetupTokenResumeSelection({ [SETUP_TOKEN_BINDING_ENV]: value }) } catch { return undefined }
}
/**
 * The daemon's record for the session against the binding the session runs: the same one, a newer record
 * (the session missed a switch this daemon finished), or an older record (this daemon lost a switch).
 */
function boundSession(deps: SetupTokenAccountSwitchDeps, sessionId: string, running: string) {
  const session = deps.findSession(sessionId)
  const recorded = parseBinding(session?.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV])
  const current = parseBinding(running)
  if (!session || !recorded || !current) return null
  const state = current.binding.nonce === recorded.binding.nonce ? 'same' as const
    : recorded.binding.issuedAt > current.binding.issuedAt ? 'session-behind' as const : 'daemon-behind' as const
  return { session, recorded, state }
}
const failure = (reason: SwitchFailure, detail: string) => {
  logger.debug(`[setup-token-switch] ${reason}: ${detail}`)
  return { ok: false as const, reason }
}
const refusal = (status: number) => status === 401 || status === 403 ? 'FORBIDDEN' as const : 'REQUEST_FAILED' as const

export function createSetupTokenAccountSwitch(deps: SetupTokenAccountSwitchDeps) {
  const post = (route: string, body: object) => deps.fetch(`${deps.studioOrigin}/api/claude-setup-token/daemon/${route}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${deps.bearer()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const inFlight = new Map<string, Promise<RebindResult>>()

  async function rebindOnce(sessionId: string, running: string): Promise<RebindResult> {
    const bound = boundSession(deps, sessionId, running)
    if (!bound) return failure('NOT_BOUND', `rebind: no binding recorded for session ${sessionId}`)
    const { session, recorded } = bound
    // Never move a session back onto a binding older than the one it runs.
    if (bound.state === 'daemon-behind') return failure('STALE', `session ${sessionId} runs a newer binding than this daemon records`)
    // The session missed a switch this daemon finished (its request timed out): catch it up, no new grant.
    if (bound.state === 'session-behind') {
      try { return { ok: true, environment: await deps.sessionEnvironment('claude', recorded.selection, recorded.binding) } }
      catch (error) { logger.debug(`[setup-token-switch] recorded binding unusable for ${sessionId}; asking Studio: ${(error as Error)?.message}`) }
    }
    if (!deps.studioOrigin) return failure('STUDIO_UNAVAILABLE', 'rebind: Studio origin is not configured')
    const binding = recorded.binding
    let grant: Record<string, unknown>
    try {
      const response = await post('rebind', { machineId: deps.machineId, sessionId, companyId: binding.companyId, bindingNonce: binding.nonce })
      const body = await response.json().catch(() => null) as Record<string, unknown> | null
      if (response.status === 409 && body?.error === 'SETUP_TOKEN_DAEMON_NO_ACCOUNT') return { ok: false, reason: 'NO_ACCOUNT' }
      if (!response.ok || !body) return failure(refusal(response.status), `rebind ${response.status} ${String(body?.error ?? '')}`)
      grant = body
    } catch (error) { return failure('REQUEST_FAILED', `rebind ${(error as Error)?.name ?? 'error'}`) }
    if (grant.version !== 1 || typeof grant.bindingGrant !== 'string' || typeof grant.managedAccountId !== 'string' || !UUID.test(grant.managedAccountId)
      || !Number.isSafeInteger(grant.credentialGeneration) || Number(grant.credentialGeneration) < 1) return failure('REQUEST_FAILED', 'rebind answered an unreadable grant')
    let environment: Record<string, string>
    try {
      environment = await deps.sessionEnvironment('claude', { kind: 'claude-setup-token', managedAccountId: grant.managedAccountId,
        groupScope: binding.groupScope, credentialGeneration: grant.credentialGeneration as number, bindingGrant: grant.bindingGrant })
    } catch (error) { return failure('BINDING_REJECTED', `grant verification: ${(error as Error)?.message}`) }
    // The session stays with its member and organization; only the account changes.
    const next = parseBinding(environment[SETUP_TOKEN_BINDING_ENV])?.binding
    if (!next || next.userId !== binding.userId || next.companyId !== binding.companyId || next.machineId !== binding.machineId || !environment.CLAUDE_CODE_OAUTH_TOKEN) {
      return failure('BINDING_REJECTED', 'the new binding changes member, machine or organization')
    }
    deps.recordAgentEnvironment(session, environment[SETUP_TOKEN_BINDING_ENV])
    return { ok: true, environment }
  }

  return {
    /** `running`: the binding record the session itself runs with, so usage is never booked to another account. */
    async reportUsage(sessionId: string, running: string, observation: SetupTokenUsageObservation): Promise<{ ok: true } | { ok: false; reason: SwitchFailure }> {
      const bound = boundSession(deps, sessionId, running)
      if (!bound) return failure('NOT_BOUND', `usage: no binding recorded for session ${sessionId}`)
      if (bound.state !== 'same') return failure('STALE', `usage: session ${sessionId} runs another binding than this daemon records`)
      if (!deps.studioOrigin) return failure('STUDIO_UNAVAILABLE', 'usage: Studio origin is not configured')
      const { binding } = bound.recorded
      try {
        const response = await post('usage', { machineId: deps.machineId, sessionId, companyId: binding.companyId, bindingNonce: binding.nonce, observation })
        return response.ok ? { ok: true } : failure(refusal(response.status), `usage ${response.status}`)
      } catch (error) { return failure('REQUEST_FAILED', `usage ${(error as Error)?.name ?? 'error'}`) }
    },

    /** One switch per session at a time; a second request while one runs gets that one's answer. */
    rebind(sessionId: string, running: string): Promise<RebindResult> {
      const pending = inFlight.get(sessionId)
      if (pending) return pending
      const started = rebindOnce(sessionId, running).finally(() => inFlight.delete(sessionId))
      inFlight.set(sessionId, started)
      return started
    },
  }
}
type RebindResult = { ok: true; environment: Record<string, string> } | { ok: false; reason: SwitchFailure }
export type SetupTokenAccountSwitch = ReturnType<typeof createSetupTokenAccountSwitch>
