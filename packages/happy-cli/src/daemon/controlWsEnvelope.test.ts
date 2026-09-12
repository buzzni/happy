import { describe, expect, it, vi } from 'vitest'
import { createPendingRequestTracker } from './controlWsEnvelope'

describe('createPendingRequestTracker', () => {
  it('resolves a tracked request when a matching response arrives', async () => {
    const tracker = createPendingRequestTracker()
    const promise = tracker.track('req-1', 5_000)

    tracker.resolve({ reqId: 'req-1', data: { ok: true } })

    await expect(promise).resolves.toEqual({ reqId: 'req-1', data: { ok: true } })
  })

  it('ignores a response whose reqId has no pending entry', async () => {
    const tracker = createPendingRequestTracker()
    const promise = tracker.track('req-1', 5_000)

    // A response for a different (unknown) reqId must not resolve req-1.
    tracker.resolve({ reqId: 'req-unknown', data: {} })
    expect(tracker.pendingCount()).toBe(1)

    tracker.resolve({ reqId: 'req-1', data: { ok: true } })
    await expect(promise).resolves.toEqual({ reqId: 'req-1', data: { ok: true } })
  })

  it('drops a duplicate response instead of resolving twice', async () => {
    const tracker = createPendingRequestTracker()
    const promise = tracker.track('req-1', 5_000)

    tracker.resolve({ reqId: 'req-1', data: { first: true } })
    // A second delivery for the same reqId (retried send, replayed frame) must
    // not throw or resolve a settled promise a second time.
    expect(() => tracker.resolve({ reqId: 'req-1', data: { second: true } })).not.toThrow()

    await expect(promise).resolves.toEqual({ reqId: 'req-1', data: { first: true } })
  })

  it('rejects when the timeout elapses with no response', async () => {
    vi.useFakeTimers()
    try {
      const tracker = createPendingRequestTracker()
      const promise = tracker.track('req-1', 1_000)
      const assertion = expect(promise).rejects.toThrow(/timed out/)

      await vi.advanceTimersByTimeAsync(1_000)
      await assertion
      expect(tracker.pendingCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the timer once resolved, so it never fires later', async () => {
    vi.useFakeTimers()
    try {
      const tracker = createPendingRequestTracker()
      const promise = tracker.track('req-1', 1_000)
      tracker.resolve({ reqId: 'req-1', data: {} })

      await vi.advanceTimersByTimeAsync(2_000)
      await expect(promise).resolves.toEqual({ reqId: 'req-1', data: {} })
    } finally {
      vi.useRealTimers()
    }
  })

  it('throws when the same reqId is tracked twice while still pending', () => {
    const tracker = createPendingRequestTracker()
    tracker.track('req-1', 5_000).catch(() => {})

    expect(() => tracker.track('req-1', 5_000)).toThrow(/already pending/)
  })

  it('rejects every pending request on rejectAll, e.g. when the socket closes', async () => {
    const tracker = createPendingRequestTracker()
    const a = tracker.track('req-a', 5_000)
    const b = tracker.track('req-b', 5_000)

    tracker.rejectAll(new Error('socket closed'))

    await expect(a).rejects.toThrow('socket closed')
    await expect(b).rejects.toThrow('socket closed')
    expect(tracker.pendingCount()).toBe(0)
  })

  it('reports how many requests are still pending', () => {
    const tracker = createPendingRequestTracker()
    expect(tracker.pendingCount()).toBe(0)

    tracker.track('req-1', 5_000).catch(() => {})
    tracker.track('req-2', 5_000).catch(() => {})
    expect(tracker.pendingCount()).toBe(2)

    tracker.resolve({ reqId: 'req-1', data: {} })
    expect(tracker.pendingCount()).toBe(1)
  })
})
