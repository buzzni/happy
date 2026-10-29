/**
 * Mid-session organization setup-token account switch (Saycode specs/claude-setup-token-account-selection).
 *
 * A session bound to a setup-token account reports the usage its provider observed, and asks to move to
 * another account once that one is used up. Studio chooses the account (remaining quota, nearest reset) for
 * this dedicated machine's member; the daemon authenticates with its machine token. The grant Studio returns
 * goes through exactly the verification a new launch does — signature, machine, account generation, nonce,
 * group journal and the token slot — so a switch can never bind what a launch could not.
 */
import { MachineRotationError } from './machineSetupTokenProtocol'
import type { MachineSetupTokenRuntime } from './machineSetupTokenRuntime'
import { isMachineSetupTokenBinding } from './sessionEnv'
import type { AiAuthSelection, SetupTokenBinding } from './sessionEnv'
import { parseSharedMachineSetupTokenAuthority, readSetupTokenResumeSelection, SETUP_TOKEN_BINDING_ENV, sharedMachineSetupTokenAccount } from './sessionEnv'
import type { TrackedSession } from './types'
import type { SessionPersistenceResult } from '@/persistence'
import { logger } from '@/ui/logger'

export type SetupTokenUsageObservation = {
  observationId?: string
  observedAt: number
  windows: Array<{ kind: 'unified5h' | 'unified7d'; pct: number | null; resetsAt: number | null }>
  reason: 'ok' | 'rate-limited' | 'authentication-failed'
  retryAt: number | null
}
export type SetupTokenAccountSwitchDeps = {
  /** The machine-rotation runtime of the binding's company (aplus Phase 3c: one per company). */
  machineRuntime?(companyId: string): MachineSetupTokenRuntime | null | Promise<MachineSetupTokenRuntime | null>
  findSession(sessionId: string): TrackedSession | undefined
  /** The daemon's single trusted Studio origin (HAPPY_APLUS_STUDIO_ORIGIN). */
  studioOrigin: string | null
  machineId: string
  /** The daemon's machine token; Studio has Happy confirm it owns this machine and session. */
  bearer(): string
  fetch: typeof fetch
  /** A new grant (a switch), or the daemon's recorded binding (catching up a session that missed a switch). */
  sessionEnvironment(agent: string, selection: AiAuthSelection, recorded?: SetupTokenBinding): Promise<Record<string, string>>
  /**
   * Measures a candidate with the switch permit Studio reserved for it, as the periodic collector would
   * (Saycode specs/setup-token-switch-usage-check). The reading to publish, or null when the check told nothing.
   * Without it the daemon does not offer to check candidates and Studio answers as before.
   */
  measure?(input: { companyId: string; machineId: string; managedAccountId: string; credentialGeneration: number; permit: Record<string, unknown> }): Promise<Record<string, unknown> | null>
  /** Durable ACK required; change committed memory only after publication succeeds. */
  recordAgentEnvironment(session: TrackedSession, binding: string): SessionPersistenceResult | Promise<SessionPersistenceResult>
  /**
   * An unbound shared-PC session moves within the accounts assigned to this PC, without Studio
   * (Saycode specs/shared-pc-session-account-continuation). `rebind` and `environment` answer null when none is usable;
   * `moved` saves the session's new record.
   */
  sharedMachine?: {
    reportUsage(managedAccountId: string, observation: SetupTokenUsageObservation): Promise<void>
    rebind(managedAccountId: string, observation?: SetupTokenUsageObservation): Promise<Record<string, string> | null>
    environment(managedAccountId: string): Promise<Record<string, string> | null>
    moved(): void
  }
}
/**
 * FORBIDDEN: Studio refuses this binding for good (PC reassigned, unknown binding); the session stops asking.
 * APPLY_REQUIRED: the account Studio would choose is not applied on this PC yet (specs/claude-setup-token-managed-sync R6).
 */
export type SwitchFailure = 'NOT_BOUND' | 'STALE' | 'STUDIO_UNAVAILABLE' | 'NO_ACCOUNT' | 'APPLY_REQUIRED' | 'FORBIDDEN' | 'REQUEST_FAILED' | 'BINDING_REJECTED' | 'PERSISTENCE_FAILED' | 'PERSISTENCE_INDETERMINATE' | 'STUDIO_BUDGET' | 'UNSUPPORTED' | 'ROTATION_LIMIT'

const REQUEST_TIMEOUT_MS = 15_000
/** Studio asks for at most this many checks per switch (its MAX_PROBES_PER_SWITCH); a further ask is not followed. */
const MAX_CHECKS_PER_SWITCH = 3
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
  if (isMachineSetupTokenBinding(current.binding) !== isMachineSetupTokenBinding(recorded.binding)) return null
  const recordedRevision = isMachineSetupTokenBinding(recorded.binding) ? recorded.binding.bindingRevision : recorded.binding.issuedAt
  const runningRevision = isMachineSetupTokenBinding(current.binding) ? current.binding.bindingRevision : current.binding.issuedAt
  const state = current.binding.nonce === recorded.binding.nonce ? 'same' as const
    : recordedRevision > runningRevision ? 'session-behind' as const : 'daemon-behind' as const
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
  // Retain a consumed grant's verified result until saved; retrying storage must not mint more grants.
  // This is process-local recovery only. A crash between nonce consumption and publication needs
  // the future server operation journal, not an invented rollback guarantee here.
  const pendingSaves = new WeakMap<TrackedSession, { running: string; committed: string; nextBinding: string; indeterminate: boolean }>()

  async function savePending(sessionId: string, session: TrackedSession, prepared?: Record<string, string>): Promise<RebindResult> {
    const pending = pendingSaves.get(session)!
    if (pending.indeterminate) return failure('PERSISTENCE_INDETERMINATE', 'resume authority requires recovery')
    let environment = prepared
    if (!environment) {
      // Retain only secret-free authority across retries. Custody may have changed while disk was unavailable.
      const next = parseBinding(pending.nextBinding)!
      try { environment = await deps.sessionEnvironment('claude', next.selection, next.binding) }
      catch { return failure('BINDING_REJECTED', 'pending binding is no longer usable') }
      if (environment[SETUP_TOKEN_BINDING_ENV] !== pending.nextBinding || !environment.CLAUDE_CODE_OAUTH_TOKEN) {
        return failure('BINDING_REJECTED', 'pending binding revalidation changed authority')
      }
    }
    if (deps.findSession(sessionId) !== session) {
      pendingSaves.delete(session)
      return failure('NOT_BOUND', 'session ended before publication')
    }
    if (session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV] !== pending.committed) return failure('STALE', 'committed binding changed before publication')
    let result: SessionPersistenceResult | undefined
    try { result = await deps.recordAgentEnvironment(session, pending.nextBinding) }
    catch {
      // An unexpected throw does not prove that publication never happened.
      pending.indeterminate = true
      return failure('PERSISTENCE_INDETERMINATE', 'recorder did not establish publication outcome')
    }
    if (deps.findSession(sessionId) !== session) {
      pendingSaves.delete(session)
      return failure('NOT_BOUND', 'session ended while awaiting publication')
    }
    if (result?.status !== 'committed') {
      pending.indeterminate = result?.status !== 'failed'
      return failure(pending.indeterminate ? 'PERSISTENCE_INDETERMINATE' : 'PERSISTENCE_FAILED', 'no durable ACK')
    }
    pendingSaves.delete(session)
    return { ok: true, environment }
  }

  /**
   * One check: reserve a switch permit, measure on this PC, publish. Every outcome is logged; none stops the switch.
   * `routes`: the member routes (a bound session's proof) or the shared-PC ones (the machine's own).
   */
  async function checkCandidate(routes: 'measure' | 'shared/measure', proof: { machineId: string; companyId: string }, candidate: { managedAccountId: string; credentialGeneration: number }) {
    const label = `[setup-token-switch] candidate ${candidate.managedAccountId}`
    try {
      const reserved = await post(`${routes}/reserve`, { ...proof, ...candidate })
      const permit = await reserved.json().catch(() => null) as Record<string, unknown> | null
      if (!reserved.ok || !permit || typeof permit.permitId !== 'string') { logger.debug(`${label}: not measured (${reserved.status} ${String(permit?.error ?? '')})`); return }
      const observation = await deps.measure!({ companyId: proof.companyId, machineId: proof.machineId, ...candidate, permit })
      if (!observation) { logger.debug(`${label}: measurement told nothing`); return }
      const published = await post(`${routes}/publish`, { ...proof, ...candidate, permitId: permit.permitId, observation })
      logger.debug(`${label}: measured, ${published.ok ? 'published' : `publish refused ${published.status}`}`)
    } catch (error) { logger.debug(`${label}: check failed ${(error as Error)?.name ?? 'error'}`) }
  }

  async function rebindOnce(sessionId: string, running: string, confirmedOnly = false, organizationFailure?: { kind: 'authentication'; observedAt: number }): Promise<RebindResult> {
    const bound = boundSession(deps, sessionId, running)
    if (!bound) return failure('NOT_BOUND', `rebind: no binding recorded for session ${sessionId}`)
    const { session, recorded } = bound
    const committed = session.agentEnvironment![SETUP_TOKEN_BINDING_ENV]!
    const pending = pendingSaves.get(session)
    if (pending) {
      // Do not apply a retained grant to a replacement session or a different running authority.
      if (pending.running !== running || pending.committed !== session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV]) return failure('STALE', 'pending save belongs to another session authority')
      return savePending(sessionId, session)
    }
    // Never move a session back onto a binding older than the one it runs.
    if (bound.state === 'daemon-behind') return failure('STALE', `session ${sessionId} runs a newer binding than this daemon records`)
    // The session missed a switch this daemon finished (its request timed out): catch it up, no new grant.
    if (!confirmedOnly && bound.state === 'session-behind') {
      try { return { ok: true, environment: await deps.sessionEnvironment('claude', recorded.selection, recorded.binding) } }
      catch (error) { logger.debug(`[setup-token-switch] recorded binding unusable for ${sessionId}; asking Studio: ${(error as Error)?.message}`) }
    }
    if (!deps.studioOrigin) return failure('STUDIO_UNAVAILABLE', 'rebind: Studio origin is not configured')
    const binding = recorded.binding
    const tokenProof = !isMachineSetupTokenBinding(binding) && !!binding.tokenProof
    let grant: Record<string, unknown>
    const proof = { machineId: deps.machineId, sessionId, companyId: binding.companyId, bindingNonce: binding.nonce }
    // Candidates checked in this switch; a switch to another account (not a return) offers to check.
    let measured: string[] | null = deps.measure && !confirmedOnly ? [] : null
    try {
      let response: Response, body: Record<string, unknown> | null
      while (true) {
        response = await post(confirmedOnly ? 'return' : 'rebind', { ...proof,
          ...(tokenProof ? { credentialProofVersion: 1 } : {}), ...(organizationFailure ? { organizationFailure } : {}), ...(measured ? { measureVersion: 1, measured: [...measured] } : {}) })
        body = await response.json().catch(() => null) as Record<string, unknown> | null
        // A Studio from before candidate checks refuses the fields it does not know: ask again as before, once.
        if (response.status === 400 && measured) {
          logger.debug('[setup-token-switch] Studio refused candidate checks; asking again without them')
          measured = null
          continue
        }
        if (response.status !== 409 || body?.error !== 'SETUP_TOKEN_DAEMON_MEASURE_REQUIRED') break
        const candidate = { managedAccountId: body.managedAccountId, credentialGeneration: body.credentialGeneration }
        if (!measured || measured.length >= MAX_CHECKS_PER_SWITCH || typeof candidate.managedAccountId !== 'string' || !UUID.test(candidate.managedAccountId)
          || !Number.isSafeInteger(candidate.credentialGeneration)) return failure('NO_ACCOUNT', `rebind: stopped checking candidates after ${measured?.length ?? 0}`)
        measured.push(candidate.managedAccountId)
        await checkCandidate('measure', proof, candidate as { managedAccountId: string; credentialGeneration: number })
      }
      if (response.status === 409 && body?.error === 'SETUP_TOKEN_DAEMON_NO_ACCOUNT') {
        // Studio says when the first candidate recovers; the session does not ask again before then.
        const earliest = body.earliestUsableAt
        return { ok: false, reason: 'NO_ACCOUNT', ...(typeof earliest === 'number' && Number.isSafeInteger(earliest) ? { retryAfterMs: Math.max(0, earliest - Date.now()) } : {}) }
      }
      if (response.status === 409 && body?.error === 'SETUP_TOKEN_DAEMON_APPLY_REQUIRED') return { ok: false, reason: 'APPLY_REQUIRED' }
      if (!response.ok || !body) return failure(refusal(response.status), `rebind ${response.status} ${String(body?.error ?? '')}`)
      grant = body
    } catch (error) { return failure('REQUEST_FAILED', `rebind ${(error as Error)?.name ?? 'error'}`) }
    if (grant.version !== 1 || typeof grant.bindingGrant !== 'string' || typeof grant.managedAccountId !== 'string' || !UUID.test(grant.managedAccountId)
      || !Number.isSafeInteger(grant.credentialGeneration) || Number(grant.credentialGeneration) < 1
      || (tokenProof && grant.credentialProofVersion !== 1)) return failure('REQUEST_FAILED', 'rebind answered an unreadable grant')
    let environment: Record<string, string>
    try {
      environment = await deps.sessionEnvironment('claude', { kind: 'claude-setup-token', managedAccountId: grant.managedAccountId,
        groupScope: binding.groupScope, credentialGeneration: grant.credentialGeneration as number, bindingGrant: grant.bindingGrant,
        ...(tokenProof ? { credentialProofVersion: 1 } : {}), ...(organizationFailure ? { organizationFailure } : {}) })
    } catch (error) { return failure('BINDING_REJECTED', `grant verification: ${(error as Error)?.message}`) }
    // The session stays with its member and organization; only the account changes.
    const next = parseBinding(environment[SETUP_TOKEN_BINDING_ENV])?.binding
    if (!next || isMachineSetupTokenBinding(next) || isMachineSetupTokenBinding(binding) || next.userId !== binding.userId || next.companyId !== binding.companyId || next.machineId !== binding.machineId || !environment.CLAUDE_CODE_OAUTH_TOKEN || (tokenProof && !next.tokenProof)) {
      return failure('BINDING_REJECTED', 'the new binding changes member, machine or organization')
    }
    pendingSaves.set(session, { running, committed, nextBinding: environment[SETUP_TOKEN_BINDING_ENV], indeterminate: false })
    return savePending(sessionId, session, environment)
  }

  /**
   * The account an unbound shared-PC session runs on. Null: `running` is a binding record, not a shared-PC account;
   * undefined: not an account this daemon handed that session (the request body alone proves nothing). `behind`: the
   * daemon already moved the session off it, and the session missed that answer.
   */
  function sharedSession(sessionId: string, running: string) {
    const managedAccountId = parseSharedMachineSetupTokenAuthority(running)
    if (!managedAccountId) return null
    const session = deps.findSession(sessionId)
    const recorded = session?.sharedSetupTokenAccount
    if (!session || !recorded || !deps.sharedMachine) return undefined
    const behind = recorded !== managedAccountId
    if (behind && !session.sharedSetupTokenAccountsLeft?.includes(managedAccountId)) return undefined
    return { session, managedAccountId, recorded, behind, sharedMachine: deps.sharedMachine }
  }

  async function sharedRebindOnce(sessionId: string, shared: NonNullable<ReturnType<typeof sharedSession>>, observation?: SetupTokenUsageObservation): Promise<RebindResult> {
    const { session, recorded } = shared
    let environment: Record<string, string> | null
    try {
      // Catching up is not another move: the session gets the account it was already moved to, while that one lasts.
      environment = shared.behind ? await shared.sharedMachine.environment(recorded) : null
      if (!environment) environment = await shared.sharedMachine.rebind(recorded, shared.behind ? undefined : observation)
    } catch (error) { return failure('REQUEST_FAILED', `shared rebind ${(error as Error)?.message}`) }
    if (!environment) return { ok: false, reason: 'NO_ACCOUNT' }
    // The session may have ended or moved while the account was prepared: it gets no token then.
    if (deps.findSession(sessionId) !== session || session.sharedSetupTokenAccount !== recorded) {
      return failure('NOT_BOUND', `shared rebind: session ${sessionId} changed while its account was prepared`)
    }
    const next = sharedMachineSetupTokenAccount(environment)
    if (!next || !environment.CLAUDE_CODE_OAUTH_TOKEN) return failure('REQUEST_FAILED', 'shared rebind answered no shared account')
    if (next !== recorded) {
      session.sharedSetupTokenAccountsLeft = [...(session.sharedSetupTokenAccountsLeft ?? []).filter(id => id !== next), recorded]
      session.sharedSetupTokenAccount = next
      shared.sharedMachine.moved()
    }
    return { ok: true, environment }
  }

  return {
    async availability(sessionId: string, running: string, personalConsent?: { proof: string; accountRef: string; nonce: string }, organizationFailure?: { kind: 'authentication'; observedAt: number }) {
      const bound = boundSession(deps, sessionId, running)
      if (!bound || isMachineSetupTokenBinding(bound.recorded.binding) || !deps.studioOrigin) return { ok: false as const, reason: 'NOT_BOUND' }
      const binding = bound.recorded.binding
      try {
        const response = await post('availability', { machineId: deps.machineId, sessionId, companyId: binding.companyId,
          bindingNonce: binding.nonce, ...(organizationFailure ? { organizationFailure } : {}), ...(personalConsent ? { personalConsent } : {}), ...(binding.tokenProof ? { credentialProofVersion: 1 } : {}) })
        const body = await response.json() as Record<string, unknown>
        if (body.fallbackReason !== undefined && (typeof body.fallbackReason !== 'string' || !['quota-exhausted', 'organization-authentication', 'organization-lookup'].includes(body.fallbackReason))) return { ok: false as const, reason: 'REQUEST_FAILED' as const }
        if (!response.ok || body.version !== 1 || typeof body.allLimited !== 'boolean' || !Array.isArray(body.availableAccountIds)
          || !body.availableAccountIds.every(id => typeof id === 'string' && UUID.test(id))) return { ok: false as const, reason: refusal(response.status) }
        return { ok: true as const, allLimited: body.allLimited, availableAccountIds: body.availableAccountIds as string[], consentApproved: body.consentApproved === true, ...(body.fallbackReason ? { fallbackReason: body.fallbackReason as 'quota-exhausted' | 'organization-authentication' | 'organization-lookup' } : {}) }
      } catch { return { ok: false as const, reason: 'REQUEST_FAILED' } }
    },
    async returnFromPersonal(sessionId: string, running: string, organizationFailure?: { kind: 'authentication'; observedAt: number }) {
      if (inFlight.has(sessionId)) await inFlight.get(sessionId)
      return rebindOnce(sessionId, running, true, organizationFailure)
    },
    /** `running`: the binding record the session itself runs with, so usage is never booked to another account. */
    async reportUsage(sessionId: string, running: string, observation: SetupTokenUsageObservation, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; reason: SwitchFailure }> {
      const shared = sharedSession(sessionId, running)
      if (shared === undefined) return failure('NOT_BOUND', `usage: session ${sessionId} is not an unbound shared-PC session`)
      if (shared) {
        try { await shared.sharedMachine.reportUsage(shared.managedAccountId, observation); return { ok: true } }
        catch (error) { return failure('REQUEST_FAILED', `shared usage ${(error as Error)?.message}`) }
      }
      const parsed = parseBinding(running)
      if (parsed && isMachineSetupTokenBinding(parsed.binding)) {
        try { const runtime = await deps.machineRuntime?.(parsed.binding.companyId); if (!runtime) return failure('STUDIO_UNAVAILABLE', 'machine runtime absent')
          return await runtime.reportUsage(sessionId, running, observation, signal) }
        catch (error) { return machineFailure(error) }
      }
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

    /**
     * Saycode specs/setup-token-switch-usage-check Phase 4 — which of the accounts this shared PC holds to use, chosen by
     * Studio. A move (`measure`) checks a candidate nobody measured recently first; a launch is not held up by a probe.
     * The account, null when Studio has none usable, undefined when Studio could not answer (the caller chooses locally).
     */
    async sharedChoose(input: { companyId: string; candidates: Array<{ managedAccountId: string; credentialGeneration: number }>; exclude: string[]; measure: boolean }): Promise<string | null | undefined> {
      if (!deps.studioOrigin) return undefined
      const proof = { machineId: deps.machineId, companyId: input.companyId }
      const measured: string[] = []
      try {
        while (true) {
          const response = await post('shared/select', { ...proof, candidates: input.candidates, exclude: input.exclude, measure: input.measure, measured: [...measured] })
          const body = await response.json().catch(() => null) as Record<string, unknown> | null
          if (response.ok && typeof body?.managedAccountId === 'string') return body.managedAccountId
          if (response.status === 409 && body?.error === 'SETUP_TOKEN_DAEMON_NO_ACCOUNT') return null
          const candidate = { managedAccountId: body?.managedAccountId, credentialGeneration: body?.credentialGeneration }
          if (response.status !== 409 || body?.error !== 'SETUP_TOKEN_DAEMON_MEASURE_REQUIRED') {
            logger.debug(`[setup-token-switch] shared choice: Studio answered ${response.status} ${String(body?.error ?? '')}; choosing locally`)
            return undefined
          }
          if (!deps.measure || measured.length >= MAX_CHECKS_PER_SWITCH || typeof candidate.managedAccountId !== 'string' || !UUID.test(candidate.managedAccountId)
            || !Number.isSafeInteger(candidate.credentialGeneration)) return null
          measured.push(candidate.managedAccountId)
          await checkCandidate('shared/measure', proof, candidate as { managedAccountId: string; credentialGeneration: number })
        }
      } catch (error) {
        logger.debug(`[setup-token-switch] shared choice: Studio unreachable (${(error as Error)?.name ?? 'error'}); choosing locally`)
        return undefined
      }
    },
    /** One switch per session at a time; a second request while one runs gets that one's answer. */
    rebind(sessionId: string, running: string, observation?: SetupTokenUsageObservation, signal?: AbortSignal): Promise<RebindResult> {
      const shared = sharedSession(sessionId, running)
      if (shared === undefined) return Promise.resolve(failure('NOT_BOUND', `rebind: session ${sessionId} is not an unbound shared-PC session`))
      const parsed = parseBinding(running)
      if (parsed && isMachineSetupTokenBinding(parsed.binding)) {
        const binding = parsed.binding
        return Promise.resolve(deps.machineRuntime?.(binding.companyId)).then(runtime => runtime
          ? runtime.rebind(sessionId, running, observation, signal).then(environment => ({ ok: true as const, environment }), machineFailure)
          : failure('STUDIO_UNAVAILABLE', 'machine runtime absent'), machineFailure)
      }
      const pending = inFlight.get(sessionId)
      if (pending) return pending
      const started = (shared ? sharedRebindOnce(sessionId, shared, observation) : rebindOnce(sessionId, running, false, observation?.reason === 'authentication-failed' ? { kind: 'authentication', observedAt: observation.observedAt } : undefined)).finally(() => inFlight.delete(sessionId))
      inFlight.set(sessionId, started)
      return started
    },
  }
}
function machineFailure(error: unknown) { return { ok: false as const, reason: (error instanceof MachineRotationError ? error.reason : 'REQUEST_FAILED') as SwitchFailure, ...(error instanceof MachineRotationError && error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) } }
export type RebindResult = { ok: true; environment: Record<string, string> } | { ok: false; reason: SwitchFailure; retryAfterMs?: number }
export type SetupTokenAccountSwitch = ReturnType<typeof createSetupTokenAccountSwitch>
