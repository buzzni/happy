import { afterEach, describe, expect, it, vi } from 'vitest'
import { APPLY_REQUIRED_NOTICE, createSetupTokenAccountSwitching, FORBIDDEN_NOTICE, NO_ACCOUNT_NOTICE, type SetupTokenAccountSwitchingDeps } from './setupTokenAccountSwitching'

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
    report: vi.fn(async () => ({ ok: true as const })),
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
    expect(deps.notify).toHaveBeenCalledWith(NO_ACCOUNT_NOTICE)
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

  it('tries again at the next turn boundary after a failure that may pass', async () => {
    const rebind = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'REQUEST_FAILED' })
      .mockResolvedValue({ ok: true, environment: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next' } })
    const { switching } = setup({ rebind })
    switching.onRateLimitEvent(near)
    expect(await switching.switchIfWanted()).toEqual({ switched: false, continueAfter: false })
    expect(await switching.switchIfWanted()).toEqual({ switched: true, continueAfter: false })
  })

  it('stops reporting and switching once Studio refuses this binding, and says so once', async () => {
    const report = vi.fn(async () => ({ ok: false as const, reason: 'FORBIDDEN' }))
    const { deps, switching, advance } = setup({ report })
    switching.onRateLimitEvent(near)
    await vi.waitFor(() => expect(deps.notify).toHaveBeenCalledWith(FORBIDDEN_NOTICE))
    advance(120_000)
    switching.onRateLimitEvent(near)
    expect(report).toHaveBeenCalledOnce()
    expect(await switching.switchIfWanted()).toEqual({ switched: false, continueAfter: false })
    expect(deps.rebind).not.toHaveBeenCalled()
    expect(deps.notify).toHaveBeenCalledOnce()
  })

  it('stops after Studio refuses a switch for this binding', async () => {
    const { deps, switching } = setup({ rebind: vi.fn(async () => ({ ok: false as const, reason: 'FORBIDDEN' })) })
    switching.onRateLimitEvent(near)
    await switching.switchIfWanted()
    switching.onRateLimitEvent(near)
    await switching.switchIfWanted()
    expect(deps.rebind).toHaveBeenCalledOnce()
    expect(deps.notify).toHaveBeenCalledWith(FORBIDDEN_NOTICE)
  })

  it('answers concurrent turn boundaries with one switch', async () => {
    const { deps, switching } = setup()
    switching.onRateLimitEvent(near)
    const [first, second] = await Promise.all([switching.switchIfWanted(), switching.switchIfWanted()])
    expect(deps.rebind).toHaveBeenCalledOnce()
    expect([first.switched, second.switched]).toEqual([true, true])
  })
})

// Saycode specs/claude-setup-token-managed-sync R7: a refused turn waits for a usable account in the background.
describe('setup-token account switching while no applied account is usable', () => {
  afterEach(() => { vi.useRealTimers() })
  const ok = { ok: true as const, environment: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next' } }
  function background(rebind: SetupTokenAccountSwitchingDeps['rebind']) {
    vi.useFakeTimers({ now: NOW })
    return setup({ rebind, now: () => Date.now() })
  }

  it.each([['APPLY_REQUIRED', APPLY_REQUIRED_NOTICE], ['NO_ACCOUNT', NO_ACCOUNT_NOTICE], ['BINDING_REJECTED', APPLY_REQUIRED_NOTICE]])(
    'retries every minute after %s and hands the switch to the continuation of the refused turn', async (reason, notice) => {
    const rebind = vi.fn().mockResolvedValueOnce({ ok: false, reason }).mockResolvedValueOnce({ ok: false, reason }).mockResolvedValue(ok)
    const { deps, switching } = background(rebind)
    switching.onRateLimitEvent(refused)
    expect(await switching.switchIfWanted()).toEqual({ switched: false, continueAfter: false })
    const wake = switching.backgroundSignal()
    expect(wake?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(rebind).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(rebind).toHaveBeenCalledTimes(2)
    expect(wake?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rebind).toHaveBeenCalledTimes(3)
    expect(wake?.aborted).toBe(true)
    expect(deps.applyEnvironment).toHaveBeenCalledWith(ok.environment)
    // The finished switch is taken once, as a switch after a refused turn.
    expect(await switching.switchIfWanted()).toEqual({ switched: true, continueAfter: true })
    expect(await switching.switchIfWanted()).toEqual({ switched: false, continueAfter: false })
    expect(switching.backgroundSignal()).toBeNull()
    expect(vi.mocked(deps.notify).mock.calls.filter(([message]) => message === notice)).toHaveLength(1)
  })

  it('does not retry in the background when the last turn was not refused', async () => {
    const rebind = vi.fn(async () => ({ ok: false as const, reason: 'APPLY_REQUIRED' }))
    const { switching } = background(rebind)
    switching.onRateLimitEvent(near)
    await switching.switchIfWanted()
    expect(switching.backgroundSignal()).toBeNull()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(rebind).toHaveBeenCalledOnce()
  })

  it('gives up after thirty minutes, telling the user once', async () => {
    const rebind = vi.fn(async () => ({ ok: false as const, reason: 'APPLY_REQUIRED' }))
    const { deps, switching } = background(rebind)
    switching.onRateLimitEvent(refused)
    await switching.switchIfWanted()
    await vi.advanceTimersByTimeAsync(45 * 60_000)
    expect(rebind).toHaveBeenCalledTimes(31)
    expect(switching.backgroundSignal()).toBeNull()
    expect(deps.notify).toHaveBeenCalledOnce()
    expect(deps.notify).toHaveBeenCalledWith(APPLY_REQUIRED_NOTICE)
  })

  it.each(['user message', 'session end'] as const)('stops retrying on a %s', async (event) => {
    const rebind = vi.fn(async () => ({ ok: false as const, reason: 'NO_ACCOUNT' }))
    const { switching } = background(rebind)
    switching.onRateLimitEvent(refused)
    await switching.switchIfWanted()
    await vi.advanceTimersByTimeAsync(60_000)
    if (event === 'user message') switching.cancelBackground(); else switching.dispose()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(rebind).toHaveBeenCalledTimes(2)
    expect(switching.backgroundSignal()).toBeNull()
  })

  it.each([['an account still being applied', { ok: false as const, reason: 'APPLY_REQUIRED' }], ['a new account', ok]] as const)(
    'stays ended when an attempt in flight at session end answers with %s', async (_label, answer) => {
    let finish!: (value: typeof answer) => void
    const rebind = vi.fn(() => new Promise<typeof answer>(resolve => { finish = resolve }))
    const { deps, switching } = background(rebind)
    switching.onRateLimitEvent(refused)
    const boundary = switching.switchIfWanted()
    switching.dispose()
    finish(answer)
    expect(await boundary).toEqual({ switched: false, continueAfter: false })
    expect(switching.backgroundSignal()).toBeNull()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(rebind).toHaveBeenCalledOnce()
    expect(deps.applyEnvironment).not.toHaveBeenCalled()
    expect(deps.notify).not.toHaveBeenCalled()
    switching.onRateLimitEvent(refused)
    expect(await switching.switchIfWanted()).toEqual({ switched: false, continueAfter: false })
    expect(rebind).toHaveBeenCalledOnce()
  })

  it('stops retrying once Studio refuses the binding for good', async () => {
    const rebind = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'APPLY_REQUIRED' }).mockResolvedValue({ ok: false, reason: 'FORBIDDEN' })
    const { deps, switching } = background(rebind)
    switching.onRateLimitEvent(refused)
    await switching.switchIfWanted()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(rebind).toHaveBeenCalledTimes(2)
    expect(deps.notify).toHaveBeenCalledWith(FORBIDDEN_NOTICE)
  })

  it('keeps retrying after a failure that may pass', async () => {
    const rebind = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'APPLY_REQUIRED' }).mockResolvedValueOnce({ ok: false, reason: 'REQUEST_FAILED' }).mockResolvedValue(ok)
    const { switching } = background(rebind)
    switching.onRateLimitEvent(refused)
    await switching.switchIfWanted()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(rebind).toHaveBeenCalledTimes(3)
    expect(switching.backgroundSignal()?.aborted).toBe(true)
  })

  it('hands a switch over once when a turn boundary shares the background attempt', async () => {
    let finish!: (value: typeof ok) => void
    const rebind = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'APPLY_REQUIRED' }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { switching } = background(rebind)
    switching.onRateLimitEvent(refused)
    await switching.switchIfWanted()
    await vi.advanceTimersByTimeAsync(60_000)
    const boundary = switching.switchIfWanted()
    finish(ok)
    expect(await boundary).toEqual({ switched: true, continueAfter: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(switching.backgroundSignal()).toBeNull()
    expect(await switching.switchIfWanted()).toEqual({ switched: false, continueAfter: false })
  })

  it('does not count failed attempts against the switch cap, and stops at the cap', async () => {
    const rebind = vi.fn<SetupTokenAccountSwitchingDeps['rebind']>(async () => ({ ok: false, reason: 'APPLY_REQUIRED' }))
    const { switching } = background(rebind)
    for (let i = 0; i < 4; i++) { rebind.mockResolvedValueOnce(ok); switching.onRateLimitEvent(near); await switching.switchIfWanted() }
    switching.onRateLimitEvent(refused)
    await switching.switchIfWanted()
    rebind.mockClear()
    // Seven failed attempts, then the fifth switch still goes through.
    for (let i = 0; i < 7; i++) rebind.mockResolvedValueOnce({ ok: false, reason: 'APPLY_REQUIRED' })
    rebind.mockResolvedValueOnce(ok)
    await vi.advanceTimersByTimeAsync(8 * 60_000)
    expect(rebind).toHaveBeenCalledTimes(8)
    expect(await switching.switchIfWanted()).toEqual({ switched: true, continueAfter: true })
    // Five switches made: a later refusal no longer starts any retry.
    switching.onRateLimitEvent(refused)
    expect(await switching.switchIfWanted()).toEqual({ switched: false, continueAfter: false })
    expect(switching.backgroundSignal()).toBeNull()
  })
})
