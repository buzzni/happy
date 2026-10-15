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

export type SetupTokenAccountSwitchingDeps = {
  sessionId(): string | null
  /** The binding record this session runs with; the daemon books usage and switches against exactly it. */
  binding(): string | undefined
  report(sessionId: string, binding: string, observation: SetupTokenUsageObservation): Promise<unknown>
  rebind(sessionId: string, binding: string): Promise<{ ok: true; environment: Record<string, string> } | { ok: false; reason: string }>
  applyEnvironment(environment: Record<string, string>): void
  notify(message: string): void
  now?: () => number
}

const REPORT_INTERVAL_MS = 60_000
/** Enough for a few accounts; a session that keeps exhausting accounts stops trying instead of cycling. */
const MAX_SWITCHES = 5
export const SWITCHED_NOTICE = 'This organization Claude account reached its usage limit, so the session moved to another organization account.'
export const NO_ACCOUNT_NOTICE = 'This organization Claude account reached its usage limit and no other organization account has quota left.'
export const CONTINUE_PROMPT = 'The previous request stopped because the organization Claude account reached its usage limit. The session now uses another account — continue from where you stopped.'

export function createSetupTokenAccountSwitching(deps: SetupTokenAccountSwitchingDeps) {
  const now = deps.now ?? Date.now
  const tracker = createSetupTokenUsageTracker(now)
  let lastReportAt = -Infinity, lastReportedExhausted = false
  let wanted = false, refused = false, switches = 0, toldNoAccount = false
  return {
    onRateLimitEvent(info: unknown) {
      // The latest word decides: a refusal later followed by allowed requests cut nothing short.
      const status = (info as { status?: unknown } | null)?.status
      if (status !== undefined) refused = status === 'rejected'
      const update = tracker.observe(info as Parameters<typeof tracker.observe>[0])
      if (!update) return
      if (update.exhausted) wanted = true
      const sessionId = deps.sessionId(), binding = deps.binding()
      if (!update.observation || !sessionId || !binding) return
      if (now() - lastReportAt < REPORT_INTERVAL_MS && update.exhausted === lastReportedExhausted) return
      lastReportAt = now(); lastReportedExhausted = update.exhausted
      void deps.report(sessionId, binding, update.observation).catch(() => undefined)
    },
    /** Called at a turn boundary. `continueAfter`: the last turn was refused and should be resumed. */
    async switchIfWanted(): Promise<{ switched: boolean; continueAfter: boolean }> {
      const sessionId = deps.sessionId(), binding = deps.binding()
      if (!wanted || !sessionId || !binding || switches >= MAX_SWITCHES) return { switched: false, continueAfter: false }
      wanted = false
      const result = await deps.rebind(sessionId, binding).catch(() => ({ ok: false as const, reason: 'REQUEST_FAILED' }))
      if (!result.ok) {
        if (result.reason === 'NO_ACCOUNT' && !toldNoAccount) { toldNoAccount = true; deps.notify(NO_ACCOUNT_NOTICE) }
        return { switched: false, continueAfter: false }
      }
      deps.applyEnvironment(result.environment)
      tracker.reset()
      switches++; toldNoAccount = false; lastReportAt = -Infinity; lastReportedExhausted = false
      const continueAfter = refused
      refused = false
      deps.notify(SWITCHED_NOTICE)
      return { switched: true, continueAfter }
    },
  }
}
export type SetupTokenAccountSwitching = ReturnType<typeof createSetupTokenAccountSwitching>
