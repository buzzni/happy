import { describe, expect, it } from 'vitest'
import { createSetupTokenUsageTracker } from './setupTokenUsageTracker'

const NOW = 1_800_000_000_000
const inSeconds = (ms: number) => Math.floor((NOW + ms) / 1000)

describe('setup-token usage tracker (Saycode specs/claude-setup-token-account-selection)', () => {
  it('turns a rate_limit_event (utilization 0..1, reset in seconds) into a percent observation', () => {
    const tracker = createSetupTokenUsageTracker(() => NOW)
    const update = tracker.observe({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: inSeconds(3_600_000) })
    expect(update).toEqual({ exhausted: false, observation: { observedAt: NOW, reason: 'ok', retryAt: null,
      windows: [{ kind: 'unified5h', pct: 42, resetsAt: (inSeconds(3_600_000)) * 1000 }] } })
  })

  it('keeps the other window it saw earlier in the same report', () => {
    const tracker = createSetupTokenUsageTracker(() => NOW)
    tracker.observe({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.3, resetsAt: inSeconds(86_400_000) })
    const update = tracker.observe({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: inSeconds(3_600_000) })
    expect(update?.observation?.windows.map(window => [window.kind, window.pct])).toEqual([['unified5h', 50], ['unified7d', 30]])
  })

  it('reads both windows when the event carries them together', () => {
    const tracker = createSetupTokenUsageTracker(() => NOW)
    const update = tracker.observe({ status: 'allowed_warning', unifiedWindows: {
      five_hour: { utilization: 0.1, resetsAt: inSeconds(3_600_000) }, seven_day: { utilization: 0.96, resetsAt: inSeconds(86_400_000) } } })
    expect(update?.exhausted).toBe(true)
    expect(update?.observation?.windows.map(window => window.pct)).toEqual([10, 96])
  })

  it('treats 95% in either window, or a rejected request, as used up', () => {
    expect(createSetupTokenUsageTracker(() => NOW).observe({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.949, resetsAt: inSeconds(60_000) })?.exhausted).toBe(false)
    expect(createSetupTokenUsageTracker(() => NOW).observe({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.95, resetsAt: inSeconds(60_000) })?.exhausted).toBe(true)
    const rejected = createSetupTokenUsageTracker(() => NOW).observe({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: inSeconds(60_000) })
    expect(rejected).toEqual({ exhausted: true, observation: { observedAt: NOW, reason: 'rate-limited', retryAt: inSeconds(60_000) * 1000,
      windows: [{ kind: 'unified5h', pct: 100, resetsAt: inSeconds(60_000) * 1000 }] } })
    // Nothing reportable, but still a reason to move off the account.
    expect(createSetupTokenUsageTracker(() => NOW).observe({ status: 'rejected' })).toEqual({ exhausted: true, observation: null })
  })

  it('ignores model-specific windows and events it cannot read', () => {
    const tracker = createSetupTokenUsageTracker(() => NOW)
    expect(tracker.observe({ status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 0.99, resetsAt: inSeconds(60_000) })).toBeNull()
    expect(tracker.observe({ status: 'allowed', rateLimitType: 'five_hour', utilization: 7, resetsAt: inSeconds(60_000) })).toBeNull()
    expect(tracker.observe(null)).toBeNull()
  })

  it('drops a window whose reset already passed', () => {
    let now = NOW
    const tracker = createSetupTokenUsageTracker(() => now)
    tracker.observe({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.99, resetsAt: inSeconds(1_000) })
    now = NOW + 5_000
    const update = tracker.observe({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.2, resetsAt: inSeconds(86_400_000) })
    expect(update).toMatchObject({ exhausted: false })
    expect(update?.observation?.windows.map(window => window.kind)).toEqual(['unified7d'])
  })

  it('starts over after the session moves to another account', () => {
    const tracker = createSetupTokenUsageTracker(() => NOW)
    tracker.observe({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.99, resetsAt: inSeconds(60_000) })
    tracker.reset()
    expect(tracker.observe({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.1, resetsAt: inSeconds(60_000) })?.observation?.windows).toHaveLength(1)
  })

  it('does not treat a model-specific refusal as the whole account used up', () => {
    const tracker = createSetupTokenUsageTracker(() => NOW)
    expect(tracker.observe({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: inSeconds(86_400_000) })).toBeNull()
  })

  it('reads a utilization just above 1 as full', () => {
    const tracker = createSetupTokenUsageTracker(() => NOW)
    expect(tracker.observe({ status: 'allowed', rateLimitType: 'five_hour', utilization: 1.02, resetsAt: inSeconds(60_000) })?.observation?.windows[0].pct).toBe(100)
  })
})
