import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DifficultyRoutingClassifierHost } from './difficultyRoutingClassifierHost'
import { startDifficultyRoutingElectionPoll } from './run'

/**
 * The election poll runs in every daemon, with the account bearer attached, and
 * it aims at an A+ route that a self-hosted or OSS deployment does not serve at
 * all (the origin then falls back to `configuration.webappUrl`). A fixed 15s
 * interval that never notices the route is missing keeps issuing that request
 * for the whole life of the daemon, so a permanently unavailable route must
 * cost progressively less, while a route that answers keeps its steady cadence.
 */

function fakeHost() {
  const enabled: boolean[] = []
  return {
    enabled,
    host: { setEnabled: (value: boolean) => { enabled.push(value) } } as unknown as DifficultyRoutingClassifierHost,
  }
}

describe('difficulty routing host-election poll', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('stops hammering an origin that never serves the route', async () => {
    const fetchSpy = vi.fn(async () => new Response('not found', { status: 404 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { host, enabled } = fakeHost()

    const dispose = startDifficultyRoutingElectionPoll({ host, machineId: 'm1', hostProcessKeyId: 'k1', token: 't1' })
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    dispose()

    // A flat 15s interval would have issued 241 requests in that hour.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(12)
    expect(enabled.every((value) => value === false)).toBe(true)
  })

  it('keeps the steady cadence while the route answers, elected or not', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true, enabled: false }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { host, enabled } = fakeHost()

    const dispose = startDifficultyRoutingElectionPoll({ host, machineId: 'm1', hostProcessKeyId: 'k1', token: 't1' })
    await vi.advanceTimersByTimeAsync(60_000)
    dispose()

    // Immediate call plus one per 15s: a definite "not elected" is an answer,
    // not a failure, so it must not slow the poll down.
    expect(fetchSpy.mock.calls.length).toBe(5)
    expect(enabled.every((value) => value === false)).toBe(true)
  })

  it('returns to the steady cadence once the route recovers', async () => {
    let failing = true
    const fetchSpy = vi.fn(async () => (failing
      ? new Response('not found', { status: 404 })
      : new Response(JSON.stringify({ ok: true, enabled: true }), { status: 200 })))
    vi.stubGlobal('fetch', fetchSpy)
    const { host, enabled } = fakeHost()

    const dispose = startDifficultyRoutingElectionPoll({ host, machineId: 'm1', hostProcessKeyId: 'k1', token: 't1' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const whileFailing = fetchSpy.mock.calls.length
    failing = false
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const afterRecovery = fetchSpy.mock.calls.length - whileFailing
    dispose()

    expect(enabled).toContain(true)
    // Back at 15s, ten minutes is ~40 polls; the backed-off run was far fewer.
    expect(afterRecovery).toBeGreaterThan(whileFailing)
  })
})
