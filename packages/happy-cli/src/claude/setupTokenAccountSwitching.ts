import type { SetupTokenRotationState } from '@/api/types'
/**
 * Moves a setup-token-bound Claude session off a used-up organization account (Saycode
 * specs/claude-setup-token-account-selection, stage 3).
 *
 * The provider's own `rate_limit_event`s say how full the bound account is. Once a window reaches
 * 95% or a request is refused, the next turn boundary asks the daemon for another account; Studio
 * chooses it and the daemon verifies the grant like a launch. The launcher then restarts the provider
 * on the same Claude conversation with the new token. A refused turn is continued automatically.
 *
 * When a refused turn finds no usable account yet (the newly assigned one is still being applied to this PC, or
 * none has quota), it keeps asking in the background for a while and continues once one is bound
 * (Saycode specs/claude-setup-token-managed-sync R7).
 */
import type { SetupTokenUsageObservation } from '@/daemon/setupTokenAccountSwitch'
import { createSetupTokenUsageTracker, isSetupTokenAccountRefusal } from './setupTokenUsageTracker'
import { logger } from '@/ui/logger'

type Outcome = { ok: true } | { ok: false; reason: string }
export type SetupTokenAccountSwitchingDeps = {
  sessionId(): string | null
  /** The binding record the running provider started with; the daemon books usage and switches against exactly it. */
  binding(): string | undefined
  report(sessionId: string, binding: string, observation: SetupTokenUsageObservation, signal?: AbortSignal): Promise<Outcome>
  rebind(sessionId: string, binding: string, observation?: SetupTokenUsageObservation, signal?: AbortSignal): Promise<{ ok: true; environment: Record<string, string> } | { ok: false; reason: string; retryAfterMs?: number }>
  applyEnvironment(environment: Record<string, string>): void
  notify(message: string): void
  notifyState?(message: string, state: SetupTokenRotationState): void
  now?: () => number
  /** Background retry cadence and how long a refused turn waits for an account; injectable for tests. */
  retryIntervalMs?: number
  retryWindowMs?: number
  retryJitterMs?: () => number
}

const REPORT_INTERVAL_MS = 60_000
/** Enough for a few accounts; a session that keeps exhausting accounts stops trying instead of cycling. */
const MAX_SWITCHES = 5
/** Failures that will not pass by asking again with the same binding. */
const PERMANENT = new Set(['FORBIDDEN', 'NOT_BOUND', 'STUDIO_UNAVAILABLE', 'UNSUPPORTED', 'ROTATION_LIMIT'])
/** Failures a refused turn waits out in the background: no applied account usable yet, or none with quota. */
const AWAITED = new Set(['APPLY_REQUIRED', 'NO_ACCOUNT', 'BINDING_REJECTED', 'REQUEST_FAILED', 'STUDIO_BUDGET', 'PERSISTENCE_FAILED', 'PERSISTENCE_INDETERMINATE'])
/** Once a minute stays far below Studio's 30 grants a minute per machine. */
const RETRY_INTERVAL_MS = 60_000
const RETRY_WINDOW_MS = 30 * 60_000
export const SWITCHED_NOTICE = 'This organization Claude account reached its usage limit, so the session moved to another organization account.'
export const NO_ACCOUNT_NOTICE = 'This organization Claude account reached its usage limit and no other organization account has quota left.'
export const APPLY_REQUIRED_NOTICE = 'This organization Claude account reached its usage limit. A newly assigned organization account is being applied to this PC; the session continues automatically once it is ready.'
export const FORBIDDEN_NOTICE = 'Saycode can no longer manage this session\'s organization Claude account, so it will not switch accounts. Start a new conversation to use the organization accounts assigned to you now.'
/** Saycode specs/managed-account-session-continuation — the account this conversation ran on left the PC; it resumed on another. */
export const RESUME_REBOUND_NOTICE = 'The organization Claude account this conversation used is no longer assigned to this PC, so it continues on another organization account.'
export const CONTINUE_PROMPT = 'The previous request stopped because the organization Claude account reached its usage limit. The session now uses another account — continue from where you stopped.'

export function createSetupTokenAccountSwitching(deps: SetupTokenAccountSwitchingDeps) {
  const now = deps.now ?? Date.now
  const retryIntervalMs = deps.retryIntervalMs ?? RETRY_INTERVAL_MS
  const retryWindowMs = deps.retryWindowMs ?? RETRY_WINDOW_MS
  const tracker = createSetupTokenUsageTracker(now)
  let lastReportAt = -Infinity, lastReportedExhausted = false
  let wanted = false, refused = false, switches = 0, stopped = false
  /** The session ended: nothing switches, retries or speaks any more, not even an attempt already in flight. */
  let disposed = false, paused = false, cancelEpoch = 0, userEpoch = 0
  let cancellation = new AbortController()
  let latestObservation: SetupTokenUsageObservation | undefined
  let retryDeadline: number | null = null, retryAfterMs = 0, studioBudget = false
  const emit = (message: string, state: SetupTokenRotationState) => {
    if (disposed || paused) return
    if (deps.notifyState) deps.notifyState(message, state); else deps.notify(message)
  }
  /** Notices already given since the last switch: each is said once. */
  const told = new Set<string>()
  let inFlight: Promise<{ switched: boolean; continueAfter: boolean }> | null = null
  /**
   * A refused turn waiting in the background for an account. `done`: a finished switch the launcher has not taken
   * yet. `shared`: a turn boundary awaits the running attempt too, so its result is handed over there, not twice.
   */
  let background: { deadline: number; timer: ReturnType<typeof setTimeout> | null; wake: AbortController; shared: boolean; done: { switched: true; continueAfter: boolean } | null } | null = null
  const endBackground = () => {
    if (background?.timer) clearTimeout(background.timer)
    background = null
  }
  const tell = (notice: string, state: SetupTokenRotationState) => {
    if (told.has(notice)) return
    told.add(notice)
    emit(notice, state)
  }
  const stop = () => {
    if (stopped || disposed) return
    stopped = true
    endBackground()
    emit(FORBIDDEN_NOTICE, 'forbidden')
  }

  async function switchOnce(sessionId: string, binding: string) {
    const epoch = cancelEpoch, user = userEpoch
    if (refused) retryDeadline ??= now() + retryWindowMs
    if (deps.notifyState) tell('The session is switching organization Claude accounts.', 'switching')
    const result = await deps.rebind(sessionId, binding, latestObservation, cancellation.signal).catch(() => ({ ok: false as const, reason: 'REQUEST_FAILED' }))
    if (disposed || paused || epoch !== cancelEpoch) return { switched: false, continueAfter: false }
    if (!result.ok) {
      logger.debug(`[setup-token-switch] session ${sessionId} could not switch accounts: ${result.reason}`)
      studioBudget = result.reason === 'STUDIO_BUDGET'
      retryAfterMs = 'retryAfterMs' in result && typeof result.retryAfterMs === 'number' ? result.retryAfterMs : 0
      if (result.reason === 'NO_ACCOUNT') {
        wanted = false
        tell(NO_ACCOUNT_NOTICE, 'exhausted')
      } else if (PERMANENT.has(result.reason)) {
        wanted = false
        if (result.reason === 'FORBIDDEN') stop()
      }
      if (AWAITED.has(result.reason) && refused) {
        if (result.reason !== 'NO_ACCOUNT') tell(result.reason === 'APPLY_REQUIRED' || result.reason === 'BINDING_REJECTED' ? APPLY_REQUIRED_NOTICE : 'The organization account service is temporarily unavailable. The session will retry.', result.reason === 'APPLY_REQUIRED' || result.reason === 'BINDING_REJECTED' ? 'apply-required' : 'retrying')
        startBackground()
      }
      // Asking again with this binding cannot help: no background attempt either.
      if (result.reason === 'UNSUPPORTED') tell('This daemon cannot rotate this organization account. Start a new conversation after updating it.', 'unsupported')
      if (PERMANENT.has(result.reason) || result.reason === 'STALE') endBackground()
      if (result.reason === 'ROTATION_LIMIT' || result.reason === 'STALE' || result.reason === 'NOT_BOUND' || result.reason === 'STUDIO_UNAVAILABLE') tell('Organization account rotation could not continue. Retry manually or start a new conversation.', 'failed')
      // Anything else may pass: the next turn boundary (or background attempt) asks again.
      return { switched: false, continueAfter: false }
    }
    wanted = false
    if (result.environment.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING === binding) return { switched: false, continueAfter: false }
    deps.applyEnvironment(result.environment)
    tracker.reset()
    switches++; told.clear(); lastReportAt = -Infinity; lastReportedExhausted = false
    logger.debug(`[setup-token-switch] session ${sessionId} moved to another organization account (${switches} of ${MAX_SWITCHES})`)
    const continueAfter = refused && user === userEpoch
    refused = false; latestObservation = undefined; retryDeadline = null; retryAfterMs = 0
    emit(SWITCHED_NOTICE, 'switched')
    return { switched: true, continueAfter }
  }

  /** One switch per session at a time: a turn boundary and a background attempt share it. */
  function attempt(sessionId: string, binding: string) {
    inFlight ??= switchOnce(sessionId, binding).finally(() => { inFlight = null })
    return inFlight
  }

  function startBackground() {
    if (background || stopped || disposed || paused) return
    background = { deadline: retryDeadline ?? now() + retryWindowMs, timer: null, wake: new AbortController(), shared: false, done: null }
    scheduleBackground(background)
  }

  function scheduleBackground(current: NonNullable<typeof background>) {
    if (now() >= current.deadline) { tell('Organization account retry time expired. Retry manually to continue.', 'retry-expired'); endBackground(); return }
    const jitter = studioBudget ? Math.max(0, Math.min(1000, (deps.retryJitterMs ?? (() => Math.floor(Math.random() * 1000)))())) : 0
    const interval = Math.max(retryIntervalMs, retryAfterMs) + jitter
    current.timer = setTimeout(() => { void retryInBackground(current) }, Math.min(interval, current.deadline - now()))
    current.timer.unref?.()
  }

  async function retryInBackground(current: NonNullable<typeof background>) {
    current.timer = null
    if (now() >= current.deadline) { tell('Organization account retry time expired. Retry manually to continue.', 'retry-expired'); endBackground(); return }
    const sessionId = deps.sessionId(), binding = deps.binding()
    if (background !== current) return
    // Failed attempts bind nothing and do not count; only switches do.
    if (stopped || paused || disposed || !sessionId || !binding || switches >= MAX_SWITCHES) { endBackground(); return }
    current.shared = inFlight !== null
    const result = await attempt(sessionId, binding)
    if (background !== current) return
    if (result.switched) {
      if (current.shared) { endBackground(); return }
      current.done = { switched: true, continueAfter: result.continueAfter }
      current.wake.abort()
      return
    }
    scheduleBackground(current)
  }

  return {
    onRateLimitEvent(info: unknown) {
      if (disposed || stopped || paused) return
      // The latest word decides: a refusal later followed by allowed requests cut nothing short.
      const status = (info as { status?: unknown } | null)?.status
      if (status !== undefined) refused = isSetupTokenAccountRefusal(info as Parameters<typeof isSetupTokenAccountRefusal>[0])
      const update = tracker.observe(info as Parameters<typeof tracker.observe>[0])
      if (!update || stopped) return
      latestObservation = update.observation ?? latestObservation
      if (update.exhausted) wanted = true
      const sessionId = deps.sessionId(), binding = deps.binding()
      if (!update.observation || !sessionId || !binding) return
      if (now() - lastReportAt < REPORT_INTERVAL_MS && update.exhausted === lastReportedExhausted) return
      lastReportAt = now(); lastReportedExhausted = update.exhausted
      const reportEpoch = cancelEpoch;
      void deps.report(sessionId, binding, update.observation, cancellation.signal)
        .then(outcome => { if (!disposed && !paused && reportEpoch === cancelEpoch && deps.binding() === binding && !outcome.ok && outcome.reason === 'FORBIDDEN') { wanted = false; stop() } })
        .catch(() => undefined)
    },
    /**
     * Called at a turn boundary; concurrent boundaries share one switch. `continueAfter`: the last turn was refused.
     * A switch finished in the background is handed over here, once.
     */
    switchIfWanted(): Promise<{ switched: boolean; continueAfter: boolean }> {
      if (disposed || paused || stopped) return Promise.resolve({ switched: false, continueAfter: false })
      if (inFlight) {
        if (background) background.shared = true
        return inFlight
      }
      if (background?.done) {
        const done = background.done
        endBackground()
        return Promise.resolve(done)
      }
      const sessionId = deps.sessionId(), binding = deps.binding()
      if (disposed || paused || stopped || !wanted || !sessionId || !binding || switches >= MAX_SWITCHES) return Promise.resolve({ switched: false, continueAfter: false })
      return attempt(sessionId, binding).then(result => {
        // Switched at this boundary: nothing is left to wait for.
        if (result.switched) endBackground()
        return result
      })
    },
    /** Aborted when a background switch finished: the launcher stops waiting for input and takes it with `switchIfWanted`. */
    backgroundSignal(): AbortSignal | null {
      return background?.wake.signal ?? null
    },
    /** The user's own message replaces the automatic continuation: the background wait ends. */
    cancelBackground() { userEpoch++; refused = false; endBackground() },
    userTurnStarted() { if (paused) cancellation = new AbortController(); paused = false; userEpoch++; refused = false; endBackground() },
    hasAccountRefusal() { return refused && !paused && !disposed },
    cancelForStop() { cancellation.abort(); paused = true; cancelEpoch++; userEpoch++; wanted = false; refused = false; latestObservation = undefined; retryDeadline = null; endBackground() },
    /** The session ended: terminal, including for an attempt still in flight. */
    dispose() {
      disposed = true; cancellation.abort(); cancelEpoch++
      endBackground()
    },
  }
}
