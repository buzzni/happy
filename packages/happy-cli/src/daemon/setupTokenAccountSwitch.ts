import { MANUAL_PERSONAL_ENV } from './manualPersonalClaude'
import { randomUUID } from 'node:crypto'
import type { SetupTokenActivity } from '@slopus/happy-wire'
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
import { formatSetupTokenBinding, isMachineSetupTokenBinding } from './sessionEnv'
import type { AiAuthSelection, SetupTokenBinding } from './sessionEnv'
import { parseSharedMachineSetupTokenAuthority, readSetupTokenResumeSelection, SETUP_TOKEN_BINDING_ENV, sharedMachineSetupTokenAccount } from './sessionEnv'
import type { TrackedSession } from './types'
import type { SessionPersistenceResult } from '@/persistence'
import { logger } from '@/ui/logger'
import { studioMachineRouteUrl, type StudioCapacityOperation, type StudioDaemonRoute } from './studioMachineRoutes'

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
  /** PC-local disabled slots restrict server choices; never re-enable them to rotate. */
  disabledSetupTokenAccounts?(): Promise<string[]>
  /** Every organization account this PC holds; a move to the member's choice excludes the others. */
  setupTokenAccountIds?(): Promise<string[]>
  capacityFenced?(managedAccountId: string): Promise<boolean>
  /** A new grant (a switch), or the daemon's recorded binding (catching up a session that missed a switch). */
  sessionEnvironment(agent: string, selection: AiAuthSelection, recorded?: SetupTokenBinding): Promise<Record<string, string>>
  /**
   * Measures a candidate with the switch permit Studio reserved for it, as the periodic collector would
   * (Saycode specs/setup-token-switch-usage-check). The reading to publish, or null when the check told nothing.
   * Without it the daemon does not offer to check candidates and Studio answers as before.
   */
  measure?(input: { companyId: string; machineId: string; managedAccountId: string; credentialGeneration: number; permit: Record<string, unknown> }): Promise<Record<string, unknown> | null>
  /** Durable ACK required; change committed memory only after publication succeeds. */
  recordAgentEnvironment(session: TrackedSession, binding: string, manualRef?: string | null): SessionPersistenceResult | Promise<SessionPersistenceResult>
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
    /** The company and credential generation this PC holds the account at, for asking Studio to start a turn; null when not held. */
    startProof?(managedAccountId: string): Promise<{ companyId: string; credentialGeneration: number } | null>
    /** A held, usable account among those Studio said have start budget left, other than `managedAccountId`; null when none. */
    startBudgetMove?(managedAccountId: string, preferred: string[]): Promise<Record<string, string> | null>
  }
}
/**
 * FORBIDDEN: Studio refuses this binding for good (PC reassigned, unknown binding); the session stops asking.
 * APPLY_REQUIRED: the account Studio would choose is not applied on this PC yet (specs/claude-setup-token-managed-sync R6).
 */
export type SwitchFailure = 'NOT_BOUND' | 'STALE' | 'STUDIO_UNAVAILABLE' | 'NO_ACCOUNT' | 'APPLY_REQUIRED' | 'FORBIDDEN' | 'REQUEST_FAILED' | 'BINDING_REJECTED' | 'PERSISTENCE_FAILED' | 'PERSISTENCE_INDETERMINATE' | 'STUDIO_BUDGET' | 'UNSUPPORTED' | 'ROTATION_LIMIT' | 'START_ACCOUNT_EXHAUSTED' | 'CAPACITY_ACTOR_REQUIRED'

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
  const capacityTargets = new Map<string, { requestId: string; target: string }>();
  const post = (route: StudioDaemonRoute, body: object) => deps.fetch(studioMachineRouteUrl(String(deps.studioOrigin), `daemon/${route}`), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${deps.bearer()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const inFlight = new Map<string, Promise<RebindResult>>()
  // Retain a consumed grant's verified result until saved; retrying storage must not mint more grants.
  // This is process-local recovery only. A crash between nonce consumption and publication needs
  // the future server operation journal, not an invented rollback guarantee here.
  const pendingSaves = new WeakMap<TrackedSession, { running: string; committed: string; nextBinding: string; clearManual: boolean; indeterminate: boolean }>()

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
    try { result = await deps.recordAgentEnvironment(session, pending.nextBinding, pending.clearManual ? null : undefined) }
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

  const selectionRequests = new Map<string, {id:string; expiresAt:number}>()
  /**
   * `target`: the account the member chose (Saycode specs/usage-org-account-current-chat); Studio may answer only that one.
   * `targetExclude`: other assigned accounts the member's app knows, which this PC may not hold yet.
   */
  async function rebindOnce(sessionId: string, running: string, confirmedOnly = false, organizationFailure?: { kind: 'authentication'; observedAt: number }, startBudget = false, startExhausted = false, target?: string, targetExclude: readonly string[] = []): Promise<RebindResult> {
    const bound = boundSession(deps, sessionId, running)
    if (!bound) return failure('NOT_BOUND', `rebind: no binding recorded for session ${sessionId}`)
    const { session, recorded } = bound
    const committed = session.agentEnvironment![SETUP_TOKEN_BINDING_ENV]!
    const pending = pendingSaves.get(session)
    if (pending) {
      // Do not apply a retained grant to a replacement session or a different running authority.
      if (pending.running !== running || pending.committed !== session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV]) return failure('STALE', 'pending save belongs to another session authority')
      // The retained grant is saved again when its account is chosen again; another choice waits for it.
      if (target) {
        const retained = parseBinding(pending.nextBinding)?.binding
        if (pending.clearManual || !retained || isMachineSetupTokenBinding(retained) || retained.managedAccountId !== target) return failure('STALE', 'an earlier switch is still being saved')
        return savePending(sessionId, session)
      }
      if (pending.clearManual === confirmedOnly) return savePending(sessionId, session)
      if (!confirmedOnly) return failure('STALE', 'pending save belongs to another source transition')
      if (pending.indeterminate) return failure('PERSISTENCE_INDETERMINATE', 'resume authority requires recovery')
      // An ordinary grant may target an unconfirmed account. A deliberate return must
      // select again with confirmedOnly, using the still-committed original authority.
      pendingSaves.delete(session)
    }
    // Never move a session back onto a binding older than the one it runs.
    if (bound.state === 'daemon-behind') return failure('STALE', `session ${sessionId} runs a newer binding than this daemon records`)
    // The session missed a switch this daemon finished (its request timed out): catch it up, no new grant.
    if (!confirmedOnly && bound.state === 'session-behind' && (!target || (!isMachineSetupTokenBinding(recorded.binding) && recorded.binding.managedAccountId === target))) {
      try { return { ok: true, environment: await deps.sessionEnvironment('claude', recorded.selection, recorded.binding) } }
      catch (error) { logger.debug(`[setup-token-switch] recorded binding unusable for ${sessionId}; asking Studio: ${(error as Error)?.message}`) }
    }
    if (!deps.studioOrigin) return failure('STUDIO_UNAVAILABLE', 'rebind: Studio origin is not configured')
    const binding = recorded.binding
    const requestKey = `${sessionId}-${binding.nonce}-${confirmedOnly}`
    // Which accounts have start budget changes between asks: each start-budget switch is its own selection.
    // So does a move to the member's choice: its only candidate is not the automatic one.
    const fresh = startBudget || !!target
    let selectionRequest = fresh ? { id: randomUUID(), expiresAt: 0 } : selectionRequests.get(requestKey)
    if (!selectionRequest || (!fresh && selectionRequest.expiresAt <= Date.now())) {
      for (const [key, value] of selectionRequests) if (value.expiresAt <= Date.now()) selectionRequests.delete(key)
      selectionRequest = {id:randomUUID(), expiresAt:Date.now()+120_000}; selectionRequests.set(requestKey, selectionRequest)
    }
    let selectionRequestId: string | undefined = selectionRequest.id
    const tokenProof = !isMachineSetupTokenBinding(binding) && !!binding.tokenProof
    let grant: Record<string, unknown>
    const proof = { machineId: deps.machineId, sessionId, companyId: binding.companyId, bindingNonce: binding.nonce }
    // Candidates checked in this switch; a switch to another account (not a return) offers to check.
    let measured: string[] | null = deps.measure && !confirmedOnly ? [] : null
    try {
      const disabled = await deps.disabledSetupTokenAccounts?.() ?? []
      let exclude = disabled
      if (target) {
        const held = await deps.setupTokenAccountIds!()
        if (!held.includes(target)) return { ok: false, reason: 'APPLY_REQUIRED' }
        if (disabled.includes(target)) return failure('NO_ACCOUNT', 'rebind: the chosen account is disabled on this PC')
        exclude = [...new Set([...disabled, ...held, ...targetExclude].filter(id => id !== target))]
      }
      let response: Response, body: Record<string, unknown> | null
      while (true) {
        response = await post(confirmedOnly ? 'return' : 'rebind', { ...proof, ...(selectionRequestId ? { selectionRequestId } : {}),
          ...(tokenProof ? { credentialProofVersion: 1 } : {}), ...(organizationFailure ? { organizationFailure } : {}), ...(measured ? { measureVersion: 1, measured: [...measured] } : {}),
          ...(startBudget ? { startBudget: true, ...(capacityTargets.get(sessionId) ? { capacityRequestId: capacityTargets.get(sessionId)!.requestId } : {}) } : {}), ...(startExhausted ? { startExhausted: true } : {}), ...(exclude.length ? { excludeManagedAccountIds: exclude } : {}) })
        body = await response.json().catch(() => null) as Record<string, unknown> | null
        // A Studio from before candidate checks refuses the fields it does not know: ask again as before, once.
        if (response.status === 400 && (measured || selectionRequestId)) {
          logger.debug('[setup-token-switch] Studio refused candidate checks; asking again without them')
          measured = null
          selectionRequestId = undefined
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
    if (target && grant.managedAccountId !== target) return failure('NO_ACCOUNT', 'rebind answered another account than the chosen one')
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
    pendingSaves.set(session, { running, committed, nextBinding: environment[SETUP_TOKEN_BINDING_ENV], clearManual: confirmedOnly, indeterminate: false })
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

  /** `move`: the next account's environment from the recorded one, null when none is usable. */
  async function sharedRebindOnce(sessionId: string, shared: NonNullable<ReturnType<typeof sharedSession>>, move: () => Promise<Record<string, string> | null>): Promise<RebindResult> {
    const { session, recorded } = shared
    let environment: Record<string, string> | null
    try {
      // Catching up is not another move: the session gets the account it was already moved to, while that one lasts.
      environment = shared.behind ? await shared.sharedMachine.environment(recorded) : null
      if (!environment) environment = await move()
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

  /**
   * Saycode specs/shared-pc-start-budget — a shared-PC session asks Studio with the machine's own token. Only a decision
   * Studio actually answers holds the turn: an older Studio, a failure, a refusal or no answer cannot prove that the person-capacity policy is off.
   */
  /**
   * The accounts Studio last said have start budget left, per waiting shared-PC session: where a start-budget move goes.
   * Keyed by the tracked session, so an ended session's entry goes with it; any other outcome than such a wait clears it.
   */
  const sharedStartPreferred = new WeakMap<TrackedSession, string[]>()
  /** A waiting shared-PC session moves within this PC's accounts onto one Studio said has start budget left; null: none. */
  async function sharedStartBudgetMove(sessionId: string, shared: NonNullable<ReturnType<typeof sharedSession>>) {
    const preferred = sharedStartPreferred.get(shared.session) ?? []
    if (!preferred.length || !shared.sharedMachine.startBudgetMove) return null
    const environment = await shared.sharedMachine.startBudgetMove(shared.recorded, preferred)
    if (environment) sharedStartPreferred.delete(shared.session)
    return environment
  }
  async function sharedStart(sessionId: string, shared: ReturnType<typeof sharedSession>, requestId: string, signal?: AbortSignal) {
    let fenced = false;
    try { fenced = shared ? await deps.capacityFenced?.(shared.recorded) ?? false : false; }
    catch { return failure('CAPACITY_ACTOR_REQUIRED', 'capacity fence cannot be read'); }
    const open = (detail: string) => {
      if (fenced) return failure('CAPACITY_ACTOR_REQUIRED', `fenced account requires a positive server decision: ${detail}`);
      if (shared) sharedStartPreferred.delete(shared.session)
      return failure('REQUEST_FAILED', `shared start for ${sessionId} has no positive Studio decision: ${detail}`)
    }
    if (!shared) return open('no shared account handed to this session')
    if (!deps.studioOrigin || !shared.sharedMachine.startProof) return open('Studio or account proof unavailable')
    try {
      signal?.throwIfAborted()
      const proof = await shared.sharedMachine.startProof(shared.managedAccountId)
      if (!proof) {
        // A later sync took the account off this PC: the session moves to one it holds, as off a used-up account.
        if (!await shared.sharedMachine.environment(shared.managedAccountId)) {
          sharedStartPreferred.delete(shared.session)
          return failure('START_ACCOUNT_EXHAUSTED', `shared start for ${sessionId}: account no longer held by this PC`)
        }
        return open('account not held by this PC')
      }
      const response = await post('shared/start', { machineId: deps.machineId, companyId: proof.companyId, sessionId,
        managedAccountId: shared.managedAccountId, credentialGeneration: proof.credentialGeneration, requestId })
      if (!response.ok) {
        const refusal = await response.json().catch(() => null) as { error?: string } | null;
        if (refusal?.error?.includes('CAPACITY_')) return failure('CAPACITY_ACTOR_REQUIRED', 'An authenticated input actor is required');
        return open(`Studio answered ${response.status}`);
      }
      const admission = await response.json() as { state?: unknown; preferredAccountIds?: unknown }
      const preferred = admission?.state === 'wait' && Array.isArray(admission.preferredAccountIds)
        ? admission.preferredAccountIds.filter((id: unknown): id is string => typeof id === 'string' && UUID.test(id)) : []
      if (preferred.length) sharedStartPreferred.set(shared.session, preferred)
      else sharedStartPreferred.delete(shared.session)
      return { ok: true as const, admission }
    } catch (error) {
      if (signal?.aborted) { sharedStartPreferred.delete(shared.session); return failure('REQUEST_FAILED', 'shared start cancelled') }
      return open(`${(error as Error)?.name ?? 'error'}`)
    }
  }

  return {
    async capacity(sessionId: string, running: string, operation: StudioCapacityOperation, actor: import('../claude/setupTokenUserCapacity').SetupTokenCapacityActor, runtimeId: string, extra?: Record<string, unknown>, signal?: AbortSignal) {
      if (!deps.studioOrigin || actor.machineId !== deps.machineId || actor.sessionId !== sessionId) return { ok: false as const, reason: 'CAPACITY_ACTOR_FORBIDDEN' };
      const parsed = parseBinding(running);
      const shared = sharedSession(sessionId, running);
      const session = deps.findSession(sessionId);
      const currentId = parsed?.binding.managedAccountId ?? (shared ? shared.recorded : undefined);
      if (!session || !currentId || parsed && session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV] !== running) return { ok: false as const, reason: 'CAPACITY_STALE_BINDING' };
      let stage: 'prepare' | 'request' | 'response' = 'prepare';
      try {
        let generation: number | undefined;
        if (operation === 'reserve' || operation === 'claim' || operation === 'observe') {
          const authority = parsed?.binding ?? (shared ? await shared.sharedMachine.startProof?.(shared.recorded) : undefined);
          if (!authority || authority.companyId !== actor.companyId) return { ok: false as const, reason: 'CAPACITY_BINDING_FORBIDDEN' };
          generation = authority.credentialGeneration;
          if (operation === 'observe') extra = { ...extra, managedAccountId: currentId, credentialGeneration: generation, startSource: parsed ? 'bound' : 'legacy' };
          const disabled = await deps.disabledSetupTokenAccounts?.() ?? [];
          if (operation === 'claim' && (extra?.managedAccountId !== currentId || extra?.credentialGeneration !== generation || disabled.includes(currentId))) return { ok: false as const, reason: 'CAPACITY_BINDING_FORBIDDEN' };
          if (operation === 'reserve') extra = { ...extra, excludeManagedAccountIds: disabled };
        }
        const body = JSON.stringify({ ...extra, companyId: actor.companyId, machineId: deps.machineId, sessionId, requestId: actor.requestId, contentHash: actor.contentHash, actorProof: actor.proof, runtimeId });
        const authorization = `Bearer ${deps.bearer()}`;
        stage = 'request';
        const response = await deps.fetch(studioMachineRouteUrl(deps.studioOrigin, `capacity/${operation}`), {
          method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
          headers: { Authorization: authorization, 'Content-Type': 'application/json' },
          body,
        });
        stage = 'response';
        if (!response.ok) {
          // Only the capacity handler speaks CAPACITY_*; anything else (the global auth gate, a proxy) is named by its status.
          const refusal = await response.json().catch(() => null) as { error?: unknown } | null;
          return { ok: false as const, reason: typeof refusal?.error === 'string' && /^CAPACITY_[A-Z0-9_]+$/.test(refusal.error) ? refusal.error : `CAPACITY_HTTP_${response.status}` };
        }
        const admission = await response.json() as Record<string, unknown>;
        if (operation === 'reserve' && admission.state !== 'reserved' || ['claim', 'finish', 'cancel', 'lost'].includes(operation) && capacityTargets.get(sessionId)?.requestId === admission.executionRequestId) {
          capacityTargets.delete(sessionId);
          if (shared) sharedStartPreferred.delete(shared.session);
        }
        if (operation === 'reserve' && admission.state === 'reserved' && typeof admission.managedAccountId === 'string') {
          if (admission.managedAccountId === currentId && admission.credentialGeneration !== generation) return { ok: false as const, reason: 'CAPACITY_GENERATION_CHANGED' };
          capacityTargets.set(sessionId, { requestId: typeof admission.executionRequestId === 'string' ? admission.executionRequestId : actor.requestId, target: admission.managedAccountId });
          if (shared) sharedStartPreferred.set(shared.session, [admission.managedAccountId]);
          admission.requiresMove = admission.managedAccountId !== currentId;
        }
        return { ok: true as const, admission };
      } catch (error) {
        // Only a request that left this PC can blame Studio; the caller giving up is not Studio being slow.
        const reason = stage !== 'request' || signal?.aborted ? 'CAPACITY_UNAVAILABLE'
          : (error as Error)?.name === 'TimeoutError' ? 'CAPACITY_STUDIO_TIMEOUT' : 'CAPACITY_STUDIO_UNREACHABLE';
        // fetch's own message is just "fetch failed"; the socket error code (ECONNRESET, ENOTFOUND...) is on its cause.
        const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
        logger.debug(`[setup-token-switch] capacity ${operation} for ${sessionId} failed at ${stage}: ${(error as Error)?.name ?? 'error'}: ${(error as Error)?.message ?? ''}${typeof cause === 'string' ? ` (${cause})` : ''} -> ${reason}`);
        return { ok: false as const, reason };
      }
    },
    async requestStart(sessionId: string, running: string, requestId: string, signal?: AbortSignal) {
      const shared = sharedSession(sessionId, running)
      if (shared !== null) return sharedStart(sessionId, shared, requestId, signal)
      const parsed = parseBinding(running)
      if (parsed && isMachineSetupTokenBinding(parsed.binding)) {
        try {
          const runtime = await deps.machineRuntime?.(parsed.binding.companyId)
          return runtime ? await runtime.requestStart(sessionId, running, requestId, signal) : failure('STUDIO_UNAVAILABLE', 'start runtime absent')
        } catch (error) { return machineFailure(error) }
      }
      const bound = boundSession(deps, sessionId, running)
      if (!bound || !deps.studioOrigin || bound.state !== 'same') return failure('NOT_BOUND', 'start: current binding absent')
      const binding = parsed!.binding
      try {
        signal?.throwIfAborted()
        const disabled = await deps.disabledSetupTokenAccounts?.() ?? []
        const response = await post('start', { machineId: deps.machineId, sessionId, companyId: binding.companyId, bindingNonce: binding.nonce, requestId, ...(disabled.length ? { excludeManagedAccountIds: disabled } : {}) })
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: unknown } | null
          const code = typeof body?.error === 'string' && /^SETUP_TOKEN_DAEMON_[A-Z_]+$/.test(body.error) ? body.error : 'UNKNOWN'
          if (code.includes('CAPACITY_')) return failure('CAPACITY_ACTOR_REQUIRED', 'An authenticated input actor is required');
          return failure(response.status === 409 && code === 'SETUP_TOKEN_DAEMON_START_ACCOUNT_EXHAUSTED' ? 'START_ACCOUNT_EXHAUSTED' : refusal(response.status), `start refused: HTTP ${response.status} ${code}`)
        }
        return { ok: true as const, admission: await response.json() }
      } catch { return failure('REQUEST_FAILED', 'start unavailable') }
    },
    async reportActivity(sessionId: string, running: string, activity: SetupTokenActivity, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; reason: SwitchFailure }> {
      const parsed = parseBinding(running)
      if (parsed && isMachineSetupTokenBinding(parsed.binding)) {
        try { const runtime = await deps.machineRuntime?.(parsed.binding.companyId)
          return runtime ? await runtime.reportActivity(sessionId, running, activity, signal) : failure('STUDIO_UNAVAILABLE', 'activity runtime absent')
        } catch (error) { return machineFailure(error) }
      }
      // Legacy unbound shared authority is never promoted into a binding proof.
      const bound = boundSession(deps, sessionId, running)
      if (!bound || !deps.studioOrigin) return failure('NOT_BOUND', 'activity: binding absent')
      if (bound.state !== 'same' && activity.state !== 'finished') return failure('STALE', 'activity: provider binding changed')
      const binding = parsed!.binding
      try {
        const response = await post('usage', { machineId: deps.machineId, sessionId, companyId: binding.companyId, bindingNonce: binding.nonce, activity })
        return response.ok ? { ok: true } : failure(refusal(response.status), `activity ${response.status}`)
      } catch { return failure('REQUEST_FAILED', 'activity report failed') }
    },
    async availability(sessionId: string, running: string, personalConsent?: { proof: string; accountRef: string; nonce: string; purpose?: 'manual'; commit?: true }, organizationFailure?: { kind: 'authentication'; observedAt: number }) {
      const bound = boundSession(deps, sessionId, running)
      if (!bound || isMachineSetupTokenBinding(bound.recorded.binding) || !deps.studioOrigin) return { ok: false as const, reason: 'NOT_BOUND' }
      const binding = bound.recorded.binding
      try {
        const response = await post('availability', { machineId: deps.machineId, sessionId, companyId: binding.companyId,
          bindingNonce: binding.nonce, ...(organizationFailure ? { organizationFailure } : {}), ...(personalConsent ? { personalConsent: { proof: personalConsent.proof, accountRef: personalConsent.accountRef, nonce: personalConsent.nonce, ...(personalConsent.purpose ? { purpose: personalConsent.purpose } : {}) } } : {}), ...(bound.session.agentEnvironment?.[MANUAL_PERSONAL_ENV] ? { manualSelection: true } : {}), ...(binding.tokenProof ? { credentialProofVersion: 1 } : {}) })
        const body = await response.json() as Record<string, unknown>
        if (body.fallbackReason !== undefined && (typeof body.fallbackReason !== 'string' || !['quota-exhausted', 'organization-authentication', 'organization-lookup'].includes(body.fallbackReason))) return { ok: false as const, reason: 'REQUEST_FAILED' as const }
        if (!response.ok || body.version !== 1 || typeof body.allLimited !== 'boolean' || !Array.isArray(body.availableAccountIds)
          || !body.availableAccountIds.every(id => typeof id === 'string' && UUID.test(id))) return { ok: false as const, reason: refusal(response.status) }
        if (personalConsent?.purpose === 'manual' && personalConsent.commit === true && body.consentApproved === true) {
          const current = boundSession(deps, sessionId, running)
          if (!current || current.session !== bound.session || current.recorded.binding.nonce !== bound.recorded.binding.nonce) return { ok: false as const, reason: 'STALE' as const }
          const result = await deps.recordAgentEnvironment(bound.session, formatSetupTokenBinding(bound.recorded.binding), personalConsent.accountRef)
          if (result.status !== 'committed') return { ok: false as const, reason: 'REQUEST_FAILED' as const }
        }
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
      let selectionRequestId: string | undefined = randomUUID()
      try {
        while (true) {
          const response = await post('shared/select', { ...proof, ...(selectionRequestId ? { selectionRequestId } : {}), candidates: input.candidates, exclude: input.exclude, measure: input.measure, measured: [...measured] })
          const body = await response.json().catch(() => null) as Record<string, unknown> | null
          // A Studio from before selection requests refuses the field it does not know: ask again without it, once.
          if (response.status === 400 && selectionRequestId) {
            logger.debug('[setup-token-switch] shared choice: Studio refused selectionRequestId; asking again without it')
            selectionRequestId = undefined
            continue
          }
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
    rebind(sessionId: string, running: string, observation?: SetupTokenUsageObservation, signal?: AbortSignal, options: { startBudget?: true; startExhausted?: true; managedAccountId?: string; excludeManagedAccountIds?: string[] } = {}): Promise<RebindResult> {
      const shared = sharedSession(sessionId, running)
      if (shared === undefined) return Promise.resolve(failure('NOT_BOUND', `rebind: session ${sessionId} is not an unbound shared-PC session`))
      const parsed = parseBinding(running)
      // Only a member's own binding moves to the account they chose; shared-PC and machine bindings rotate by themselves.
      if (options.managedAccountId && (shared || !parsed || isMachineSetupTokenBinding(parsed.binding) || !deps.setupTokenAccountIds)) return Promise.resolve({ ok: false as const, reason: 'UNSUPPORTED' as const })
      // An unbound shared-PC session moves off a refused account within this PC, without Studio's exhaustion check.
      if (options.startExhausted && !shared && !parsed) return Promise.resolve({ ok: false as const, reason: 'UNSUPPORTED' as const })
      if (options.startBudget && !shared && !parsed) return Promise.resolve({ ok: false as const, reason: 'UNSUPPORTED' as const })
      if (parsed && isMachineSetupTokenBinding(parsed.binding)) {
        const binding = parsed.binding
        return Promise.resolve(deps.machineRuntime?.(binding.companyId)).then(runtime => runtime
          ? (options.startBudget || options.startExhausted ? runtime.rebind(sessionId, running, observation, signal, { ...options, ...(options.startBudget && capacityTargets.get(sessionId) ? { capacityRequestId: capacityTargets.get(sessionId)!.requestId } : {}) }) : runtime.rebind(sessionId, running, observation, signal))
            .then(environment => ({ ok: true as const, environment }), machineFailure)
          : failure('STUDIO_UNAVAILABLE', 'machine runtime absent'), machineFailure)
      }
      const pending = inFlight.get(sessionId)
      // The running switch is not for the account the member chose: they ask again once it ends.
      if (pending) return options.managedAccountId ? Promise.resolve(failure('STALE', `rebind: session ${sessionId} is already switching`)) : pending
      const started = (shared ? sharedRebindOnce(sessionId, shared, options.startBudget ? () => sharedStartBudgetMove(sessionId, shared)
        : () => shared.sharedMachine.rebind(shared.recorded, shared.behind ? undefined : observation)) : rebindOnce(sessionId, running, false, observation?.reason === 'authentication-failed' ? { kind: 'authentication', observedAt: observation.observedAt } : undefined, !!options.startBudget, !!options.startExhausted, options.managedAccountId, options.excludeManagedAccountIds)).finally(() => inFlight.delete(sessionId))
      inFlight.set(sessionId, started)
      return started
    },
  }
}
function machineFailure(error: unknown) { return { ok: false as const, reason: (error instanceof MachineRotationError ? error.reason : 'REQUEST_FAILED') as SwitchFailure, ...(error instanceof MachineRotationError && error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) } }
export type RebindResult = { ok: true; environment: Record<string, string> } | { ok: false; reason: SwitchFailure; retryAfterMs?: number }
export type SetupTokenAccountSwitch = ReturnType<typeof createSetupTokenAccountSwitch>
