import { describe, expect, it, vi } from 'vitest'
import { createSetupTokenAccountSwitching, type SetupTokenAccountSwitchingDeps } from './setupTokenAccountSwitching'

const NOW = 1_800_000_000_000
const reset = Math.floor((NOW + 3_600_000) / 1000)
const near = { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.97, resetsAt: reset }
const fine = { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4, resetsAt: reset }
const refused = { status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset }

function setup(extra: Partial<SetupTokenAccountSwitchingDeps> = {}) {
  let now = NOW
  const deps: SetupTokenAccountSwitchingDeps = {
    sessionId: () => 'session-a',
    binding: () => 'binding-a',
    report: vi.fn(async () => {}),
    rebind: vi.fn(async () => ({ ok: true as const, environment: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next' } })),
    applyEnvironment: vi.fn(),
    notify: vi.fn(),
    now: () => now,
    ...extra,
  }
  return { deps, switching: createSetupTokenAccountSwitching(deps), advance: (ms: number) => { now += ms } }
}

describe('setup-token account switching in a running session', () => {
  it('reports observed usage, at most once a minute unless the account became used up', async () => {
    const { deps, switching, advance } = setup()
    switching.onRateLimitEvent(fine)
    switching.onRateLimitEvent(fine)
    expect(deps.report).toHaveBeenCalledTimes(1)
    advance(60_000)
    switching.onRateLimitEvent(fine)
    expect(deps.report).toHaveBeenCalledTimes(2)
    switching.onRateLimitEvent(near)
    expect(deps.report).toHaveBeenCalledTimes(3)
    expect(deps.report).toHaveBeenLastCalledWith('session-a', 'binding-a', expect.objectContaining({ windows: [expect.objectContaining({ pct: 97 })] }))
  })

  it('does not switch while the account still has quota', async () => {
    const { deps, switching } = setup()
    switching.onRateLimitEvent(fine)
    expect(await switching.switchIfWanted()).toEqual({ switched: false, continueAfter: false })
    expect(deps.rebind).not.toHaveBeenCalled()
  })

  it('moves to another account at the turn boundary once 95% is reached, and only once per need', async () => {
    const { deps, switching } = setup()
    switching.onRateLimitEvent(near)
    expect(await switching.switchIfWanted()).toEqual({ switched: true, continueAfter: false })
    expect(deps.rebind).toHaveBeenCalledWith('session-a', 'binding-a')
    expect(deps.applyEnvironment).toHaveBeenCalledWith({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next' })
    expect(deps.notify).toHaveBeenCalledOnce()
    expect(await switching.switchIfWanted()).toEqual({ switched: false, continueAfter: false })
    expect(deps.rebind).toHaveBeenCalledOnce()
  })

  it('continues the refused turn after moving off a refused account', async () => {
    const { switching } = setup()
    switching.onRateLimitEvent(refused)
    expect(await switching.switchIfWanted()).toEqual({ switched: true, continueAfter: true })
  })

  it('stays on the account and says so once when no other account has quota', async () => {
    const { deps, switching } = setup({ rebind: vi.fn(async () => ({ ok: false as const, reason: 'NO_ACCOUNT' })) })
    switching.onRateLimitEvent(refused)
    expect(await switching.switchIfWanted()).toEqual({ switched: false, continueAfter: false })
    switching.onRateLimitEvent(refused)
    await switching.switchIfWanted()
    expect(deps.applyEnvironment).not.toHaveBeenCalled()
    expect(deps.notify).toHaveBeenCalledOnce()
  })

  it('stops switching after a bounded number of moves in one session', async () => {
    const { deps, switching } = setup()
    for (let i = 0; i < 8; i++) { switching.onRateLimitEvent(near); await switching.switchIfWanted() }
    expect(deps.rebind).toHaveBeenCalledTimes(5)
  })

  it('continues only a turn whose last word was a refusal', async () => {
    // A refusal, then the window recovered and requests went through, then a 95% warning: nothing was cut short.
    const { switching } = setup()
    switching.onRateLimitEvent(refused); switching.onRateLimitEvent(fine); switching.onRateLimitEvent(near)
    expect(await switching.switchIfWanted()).toEqual({ switched: true, continueAfter: false })
  })
})
