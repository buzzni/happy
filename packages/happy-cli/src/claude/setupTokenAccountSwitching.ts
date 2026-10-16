/**
 * Moves a setup-token-bound Claude session off a used-up organization account (Saycode
 * specs/claude-setup-token-account-selection, stage 3).
 *
 * The provider's own `rate_limit_event`s say how full the bound account is. Once a window reaches
 * 95% or a request is refused, the next turn boundary asks the daemon for another account; Studio
 * chooses it and the daemon verifies the grant like a launch. The launcher then restarts the provider
 * on the same Claude conversation with the new token. A refused turn is continued automatically.
 */
import type { SetupTokenUsageObservation } from '@/daemon/setupTokenAccountSwitch'
import { createSetupTokenUsageTracker } from './setupTokenUsageTracker'
import { logger } from '@/ui/logger'

type Outcome = { ok: true } | { ok: false; reason: string }
export type SetupTokenAccountSwitchingDeps = {
  sessionId(): string | null
  /** The binding record the running provider started with; the daemon books usage and switches against exactly it. */
  binding(): string | undefined
  report(sessionId: string, binding: string, observation: SetupTokenUsageObservation): Promise<Outcome>
  rebind(sessionId: string, binding: string): Promise<{ ok: true; environment: Record<string, string> } | { ok: false; reason: string }>
  applyEnvironment(environment: Record<string, string>): void
  notify(message: string): void
  now?: () => number
}

const REPORT_INTERVAL_MS = 60_000
/** Enough for a few accounts; a session that keeps exhausting accounts stops trying instead of cycling. */
const MAX_SWITCHES = 5
/** Failures that will not pass by asking again with the same binding. */
const PERMANENT = new Set(['FORBIDDEN', 'NOT_BOUND', 'STUDIO_UNAVAILABLE'])
export const SWITCHED_NOTICE = 'This organization Claude account reached its usage limit, so the session moved to another organization account.'
export const NO_ACCOUNT_NOTICE = 'This organization Claude account reached its usage limit and no other organization account has quota left.'
export const FORBIDDEN_NOTICE = 'Saycode can no longer manage this session\'s organization Claude account, so it will not switch accounts. Start a new conversation to use the organization accounts assigned to you now.'
export const CONTINUE_PROMPT = 'The previous request stopped because the organization Claude account reached its usage limit. The session now uses another account — continue from where you stopped.'

export function createSetupTokenAccountSwitching(deps: SetupTokenAccountSwitchingDeps) {
  const now = deps.now ?? Date.now
  const tracker = createSetupTokenUsageTracker(now)
  let lastReportAt = -Infinity, lastReportedExhausted = false
  let wanted = false, refused = false, switches = 0, toldNoAccount = false, stopped = false
  let inFlight: Promise<{ switched: boolean; continueAfter: boolean }> | null = null
  const stop = () => {
    if (stopped) return
    stopped = true
    deps.notify(FORBIDDEN_NOTICE)
  }

  async function switchOnce(sessionId: string, binding: string) {
    const result = await deps.rebind(sessionId, binding).catch(() => ({ ok: false as const, reason: 'REQUEST_FAILED' }))
    if (!result.ok) {
      logger.debug(`[setup-token-switch] session ${sessionId} could not switch accounts: ${result.reason}`)
      if (result.reason === 'NO_ACCOUNT') {
        wanted = false
        if (!toldNoAccount) { toldNoAccount = true; deps.notify(NO_ACCOUNT_NOTICE) }
      } else if (PERMANENT.has(result.reason)) {
        wanted = false
        if (result.reason === 'FORBIDDEN') stop()
      }
      // Anything else may pass: the next turn boundary asks again.
      return { switched: false, continueAfter: false }
    }
    wanted = false
    deps.applyEnvironment(result.environment)
    tracker.reset()
    switches++; toldNoAccount = false; lastReportAt = -Infinity; lastReportedExhausted = false
    logger.debug(`[setup-token-switch] session ${sessionId} moved to another organization account (${switches} of ${MAX_SWITCHES})`)
    const continueAfter = refused
    refused = false
    deps.notify(SWITCHED_NOTICE)
    return { switched: true, continueAfter }
  }

  return {
    onRateLimitEvent(info: unknown) {
      // The latest word decides: a refusal later followed by allowed requests cut nothing short.
      const status = (info as { status?: unknown } | null)?.status
      if (status !== undefined) refused = status === 'rejected'
      const update = tracker.observe(info as Parameters<typeof tracker.observe>[0])
      if (!update || stopped) return
      if (update.exhausted) wanted = true
      const sessionId = deps.sessionId(), binding = deps.binding()
      if (!update.observation || !sessionId || !binding) return
      if (now() - lastReportAt < REPORT_INTERVAL_MS && update.exhausted === lastReportedExhausted) return
      lastReportAt = now(); lastReportedExhausted = update.exhausted
      void deps.report(sessionId, binding, update.observation)
        .then(outcome => { if (!outcome.ok && outcome.reason === 'FORBIDDEN') { wanted = false; stop() } })
        .catch(() => undefined)
    },
    /** Called at a turn boundary; concurrent boundaries share one switch. `continueAfter`: the last turn was refused. */
    switchIfWanted(): Promise<{ switched: boolean; continueAfter: boolean }> {
      if (inFlight) return inFlight
      const sessionId = deps.sessionId(), binding = deps.binding()
      if (stopped || !wanted || !sessionId || !binding || switches >= MAX_SWITCHES) return Promise.resolve({ switched: false, continueAfter: false })
      inFlight = switchOnce(sessionId, binding).finally(() => { inFlight = null })
      return inFlight
    },
  }
}
