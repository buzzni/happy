/**
 * Usage a setup-token-bound Claude session observes for its account (Saycode
 * specs/claude-setup-token-account-selection).
 *
 * Claude Code emits `rate_limit_event` from the provider's rate-limit headers on real requests, so a
 * running session learns its account's 5-hour and 7-day utilization for free. Utilization is a 0..1
 * fraction (Claude Code renders `Math.floor(utilization * 100)`) and reset times are epoch seconds.
 * Model-specific weekly windows are not the account-wide limit the selection rule compares.
 */
import type { SetupTokenUsageObservation } from '@/daemon/setupTokenAccountSwitch'

/** Either window at or above this share means the account is used up; matches Studio's rule. */
const EXHAUSTED_PCT = 95

type Kind = 'unified5h' | 'unified7d'
type RawWindow = { utilization?: unknown; resetsAt?: unknown }
type RateLimitInfo = { status?: unknown; rateLimitType?: unknown; utilization?: unknown; resetsAt?: unknown; unifiedWindows?: { five_hour?: RawWindow; seven_day?: RawWindow } } | null | undefined

const KINDS = new Map<unknown, Kind>([['five_hour', 'unified5h'], ['seven_day', 'unified7d']])
/**
 * Refusals that stop every request on the account, with the window they hold full (null: none to report).
 * The overage-inclusive weekly window and overage itself are refused only once the plan's quota is gone too.
 */
const ACCOUNT_REFUSALS = new Map<unknown, Kind | null>([...KINDS, ['seven_day_overage_included', 'unified7d'], ['overage', null]])
// Slightly above 1 means full; anything far outside 0..1 is not this unit and is ignored.
const fraction = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1.5 ? Math.min(value, 1) : undefined
const seconds = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) * 1000 : undefined

export function createSetupTokenUsageTracker(now: () => number = Date.now) {
  const windows = new Map<Kind, { pct: number; resetsAt: number }>()
  const record = (kind: Kind | undefined, raw: RawWindow) => {
    const utilization = fraction(raw.utilization), resetsAt = seconds(raw.resetsAt)
    if (!kind || utilization === undefined || resetsAt === undefined) return false
    windows.set(kind, { pct: Math.round(utilization * 1000) / 10, resetsAt })
    return true
  }
  return {
    /** Null when the event says nothing; `observation` null when it only says the account was refused. */
    observe(info: RateLimitInfo): { observation: SetupTokenUsageObservation | null; exhausted: boolean } | null {
      if (!info || typeof info !== 'object') return null
      // A model-specific refusal (seven_day_opus, …) is not the account-wide limit Studio compares.
      const rejected = info.status === 'rejected' && (info.rateLimitType === undefined || ACCOUNT_REFUSALS.has(info.rateLimitType))
      let read = false
      if (info.unifiedWindows) for (const [name, raw] of Object.entries(info.unifiedWindows)) if (raw) read = record(KINDS.get(name), raw) || read
      if (typeof info.rateLimitType === 'string') read = record(KINDS.get(info.rateLimitType), info) || read
      // A refusal often carries no utilization: the refused window is full until its reset.
      const refusedWindow = rejected ? ACCOUNT_REFUSALS.get(info.rateLimitType) : undefined
      if (refusedWindow && seconds(info.resetsAt) !== undefined && fraction(info.utilization) === undefined) {
        read = record(refusedWindow, { utilization: 1, resetsAt: info.resetsAt }) || read
      }
      const observedAt = now()
      for (const [kind, window] of windows) if (window.resetsAt <= observedAt) windows.delete(kind)
      const retryAt = rejected ? seconds(info.resetsAt) ?? null : null
      if (!read && !rejected) return null
      const current = (['unified5h', 'unified7d'] as const).filter(kind => windows.has(kind))
      if (!current.length) return rejected ? { exhausted: true, observation: null } : null
      return {
        exhausted: rejected || current.some(kind => windows.get(kind)!.pct >= EXHAUSTED_PCT),
        observation: {
          observedAt, reason: rejected ? 'rate-limited' : 'ok', retryAt: retryAt !== null && retryAt > observedAt ? retryAt : null,
          windows: current.map(kind => ({ kind, pct: windows.get(kind)!.pct, resetsAt: windows.get(kind)!.resetsAt })),
        },
      }
    },
    reset() { windows.clear() },
  }
}
