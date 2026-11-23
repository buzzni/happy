import { describe, expect, it, vi } from 'vitest'
import { createProviderDraftRunnerSlots, DraftRunnerSlot } from './draftRunnerSlot'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function child() {
  const exit = deferred()
  return { exited: exit.promise, exit: exit.resolve, stop: vi.fn() }
}

describe('draft runner ownership', () => {
  it('allows one idle worker for each connected provider and closes both on shutdown', async () => {
    const claude = child(), codex = child()
    const start = vi.fn(provider => provider === 'claude' ? claude : codex)
    const slots = createProviderDraftRunnerSlots(start, 100_000)
    try {
      expect(await slots.claude.prepare('same-draft', 'claude')).toBe(true)
      expect(await slots.codex.prepare('same-draft', 'codex')).toBe(true)
      expect(await slots.claude.prepare('same-draft', 'claude')).toBe(true)
      expect(start.mock.calls).toEqual([['claude'], ['codex']])
      expect(claude.stop).not.toHaveBeenCalled()
      expect(codex.stop).not.toHaveBeenCalled()
      const shutdown = slots.close()
      expect(claude.stop).toHaveBeenCalledTimes(1)
      expect(codex.stop).toHaveBeenCalledTimes(1)
      claude.exit()
      codex.exit()
      await shutdown
      expect(await slots.codex.prepare('another')).toBe(false)
    } finally {
      claude.exit()
      codex.exit()
      await slots.close()
    }
  })

  it('transfers one idle process to a compatible draft with a new owner and expiry', async () => {
    vi.useFakeTimers()
    const runner = child()
    const start = vi.fn(() => runner)
    const slot = new DraftRunnerSlot(start, 100)
    try {
      await slot.prepare('first-tab', 'codex')
      await vi.advanceTimersByTimeAsync(70)
      const moved = slot.prepare('second-tab', 'codex')
      expect(runner.stop).not.toHaveBeenCalled()
      expect(await moved).toBe(true)
      slot.release('first-tab')
      expect(slot.renew('first-tab')).toBe(false)
      expect(slot.claim('first-tab')).toBeNull()
      await vi.advanceTimersByTimeAsync(50)
      expect(start).toHaveBeenCalledTimes(1)
      expect(runner.stop).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(50)
      expect(runner.stop).toHaveBeenCalledTimes(1)
      expect(slot.claim('second-tab')).toBeNull()
    } finally {
      runner.exit()
      await slot.close()
      vi.useRealTimers()
    }
  })

  it('keeps a submitted draft for its original sender when another composer opens', async () => {
    const runner = child()
    const start = vi.fn(() => runner)
    const slot = new DraftRunnerSlot(start, 100_000)
    await slot.prepare('submitting', 'claude')
    expect(slot.renew('submitting')).toBe(true)
    // Resolve any attempted replacement in the old implementation so this test fails promptly.
    const moved = slot.prepare('next-tab', 'claude')
    if (runner.stop.mock.calls.length) runner.exit()
    expect(await moved).toBe(false)
    expect(await slot.claim('submitting')).toBe(runner)
    expect(start).toHaveBeenCalledTimes(1)
    expect(runner.stop).not.toHaveBeenCalled()
    runner.exit()
    await slot.close()
  })

  it('does not allocate a replacement if exit could not be proven', async () => {
    let failed!: (error: Error) => void
    const start = vi.fn(() => ({ exited: new Promise<void>((_, reject) => { failed = reject }), stop: vi.fn() }))
    const slot = new DraftRunnerSlot(start, 30_000)
    await slot.prepare('original')
    failed(Error('missing native receipt'))
    await Promise.resolve()
    expect(await slot.prepare('replacement')).toBe(false)
    expect(slot.claim('original')).toBeNull()
    expect(start).toHaveBeenCalledTimes(1)
    await expect(slot.close()).rejects.toThrow('missing native receipt')
  })
  it('shares preparation and gives a starting runner to exactly one matching sender', async () => {
    const runner = child()
    const start = vi.fn(() => runner)
    const slot = new DraftRunnerSlot(start, 30_000)
    const first = slot.prepare('draft-a')
    const duplicate = slot.prepare('draft-a')
    const sender = slot.claim('draft-a')
    expect(slot.claim('draft-a')).toBeNull()
    expect(slot.claim('draft-b')).toBeNull()
    await Promise.all([first, duplicate])
    expect(await sender).toBe(runner)
    await slot.close()
    expect(start).toHaveBeenCalledTimes(1)
    expect(runner.stop).not.toHaveBeenCalled()
  })

  it('waits for exit before replacement, including an intervening tab that was closed', async () => {
    const a = child(), c = child()
    const start = vi.fn((key: string) => key === 'a' ? a : c)
    const slot = new DraftRunnerSlot(start, 30_000)
    await slot.prepare('a')
    const b = slot.prepare('b')
    const last = slot.prepare('c')
    slot.release('b')
    expect(a.stop).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
    a.exit()
    await Promise.all([b, last])
    expect(start.mock.calls.map(([key]) => key)).toEqual(['a', 'c'])
    const closed = slot.close()
    expect(c.stop).toHaveBeenCalledTimes(1)
    c.exit()
    await closed
    expect(await slot.prepare('late')).toBe(false)
  })

  it('retires an idle or crashed child and allows a fresh attempt after startup failure', async () => {
    vi.useFakeTimers()
    try {
      const a = child(), b = child()
      const start = vi.fn(() => b).mockImplementationOnce(() => { throw Error('spawn failed') }).mockReturnValueOnce(a)
      const slot = new DraftRunnerSlot(start, 100)
      expect(await slot.prepare('a')).toBe(false)
      expect(await slot.prepare('a')).toBe(true)
      await vi.advanceTimersByTimeAsync(100)
      expect(slot.claim('a')).toBeNull()
      expect(a.stop).toHaveBeenCalledTimes(1)
      a.exit()
      await slot.prepare('b')
      b.exit()
      await b.exited
      expect(slot.claim('b')).toBeNull()
      await slot.close()
    } finally { vi.useRealTimers() }
  })

  it('extends the same active draft until a full idle interval elapses', async () => {
    vi.useFakeTimers()
    const runner = child()
    const start = vi.fn(() => runner)
    const slot = new DraftRunnerSlot(start, 100)
    try {
      await slot.prepare('typing')
      await vi.advanceTimersByTimeAsync(70)
      expect(slot.renew('other')).toBe(false)
      expect(slot.renew('typing')).toBe(true)
      await vi.advanceTimersByTimeAsync(60)
      expect(runner.stop).not.toHaveBeenCalled()
      expect(start).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(40)
      expect(runner.stop).toHaveBeenCalledTimes(1)
      expect(slot.renew('typing')).toBe(false)
      expect(slot.claim('typing')).toBeNull()
      expect(start).toHaveBeenCalledTimes(1)
    } finally {
      runner.exit()
      await slot.close()
      vi.useRealTimers()
    }
  })
})
