const mocks = vi.hoisted(() => ({ debug: vi.fn() }))
vi.mock('@/ui/logger', () => ({ logger: { debug: mocks.debug } }))

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalOutputCoalescer } from './terminalOutputCoalescer'

beforeEach(() => {
  mocks.debug.mockClear()
})

function coalescerWithFakeTimers(opts: { flushMs?: number; maxBytes?: number; sessionId?: string } = {}) {
  const frames: string[] = []
  const timers: { cb: () => void; ms: number }[] = []
  const coalescer = createTerminalOutputCoalescer({
    emit: (chunk) => frames.push(chunk),
    sessionId: opts.sessionId,
    flushMs: opts.flushMs,
    maxBytes: opts.maxBytes,
    setTimer: (cb, ms) => { timers.push({ cb, ms }); return timers.length },
    clearTimer: () => {},
  })
  const fire = () => { const t = timers.shift(); t?.cb() }
  return { coalescer, frames, timers, fire }
}

describe('terminalOutputCoalescer', () => {
  it('emits output that arrives after a quiet period right away, so a keystroke echo never waits for the window', () => {
    const { coalescer, frames, timers } = coalescerWithFakeTimers({ flushMs: 8 })
    coalescer.push('l')

    expect(frames).toEqual(['l'])
    expect(timers).toHaveLength(1)
  })

  it('buffers chunks that arrive inside the window and emits them as one frame when it ends', () => {
    const { coalescer, frames, timers, fire } = coalescerWithFakeTimers({ flushMs: 8 })
    coalescer.push('a')
    coalescer.push('b')
    coalescer.push('c')

    expect(frames).toEqual(['a'])
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(8)
    fire()
    expect(frames).toEqual(['a', 'bc'])
  })

  it('keeps batching a continuous stream: a window that flushed output opens the next one', () => {
    const { coalescer, frames, timers, fire } = coalescerWithFakeTimers()
    coalescer.push('a')
    coalescer.push('b')
    fire()
    coalescer.push('c')
    coalescer.push('d')

    expect(frames).toEqual(['a', 'b'])
    expect(timers).toHaveLength(1)
    fire()
    expect(frames).toEqual(['a', 'b', 'cd'])
  })

  it('goes quiet when a window ends with nothing buffered, so the next output is sent at once', () => {
    const { coalescer, frames, timers, fire } = coalescerWithFakeTimers()
    coalescer.push('a')
    fire()
    expect(timers).toHaveLength(0)

    coalescer.push('b')
    expect(frames).toEqual(['a', 'b'])
  })

  it('flushes immediately once buffered bytes reach maxBytes, without waiting for the timer', () => {
    const { coalescer, frames } = coalescerWithFakeTimers({ maxBytes: 4 })
    coalescer.push('x')
    coalescer.push('ab')
    coalescer.push('cd')
    expect(frames).toEqual(['x', 'abcd'])

    coalescer.push('e')
    expect(frames).toEqual(['x', 'abcd'])
  })

  it('does not schedule a second timer while one is already pending', () => {
    const { coalescer, timers } = coalescerWithFakeTimers()
    coalescer.push('a')
    coalescer.push('b')
    coalescer.push('c')
    expect(timers).toHaveLength(1)
  })

  it('starts a fresh timer after each flush', () => {
    const { coalescer, frames, fire, timers } = coalescerWithFakeTimers()
    coalescer.push('a')
    coalescer.flush()
    coalescer.push('b')
    expect(frames).toEqual(['a', 'b'])
    expect(timers).toHaveLength(2)
  })

  it('ignores empty chunks without starting a timer', () => {
    const { coalescer, timers } = coalescerWithFakeTimers()
    coalescer.push('')
    expect(timers).toHaveLength(0)
  })

  it('flush() is a no-op when nothing is buffered', () => {
    const { coalescer, frames } = coalescerWithFakeTimers()
    coalescer.flush()
    expect(frames).toEqual([])
  })

  it('manual flush() emits and clears the pending timer', () => {
    const { coalescer, frames, fire } = coalescerWithFakeTimers()
    coalescer.push('a')
    coalescer.push('b')
    coalescer.flush()
    expect(frames).toEqual(['a', 'b'])
    // The timer that was scheduled for the push above must not double-flush later.
    fire()
    expect(frames).toEqual(['a', 'b'])
  })

  it('dispose() drops buffered output and ignores further pushes', () => {
    const { coalescer, frames, fire } = coalescerWithFakeTimers()
    coalescer.push('a')
    coalescer.push('b')
    coalescer.dispose()
    fire()
    coalescer.push('c')
    expect(frames).toEqual(['a'])
  })

  it('logs a debug line (including the sessionId) when a chunk arrives after dispose, instead of dropping it silently', () => {
    // node-pty's exit/reap signal and its last onData delivery are two
    // separate mechanisms with no ordering guarantee across platforms — a
    // process's final output burst can arrive after pty.onExit already
    // flushed+disposed the coalescer. That output is unrecoverable either
    // way (the session is gone), but it must leave a trace so a "last
    // output missing" report is diagnosable instead of invisible, and
    // correlatable with the session's other [REMOTE-TERMINAL] log lines
    // when multiple terminals close around the same time.
    const { coalescer } = coalescerWithFakeTimers({ sessionId: 'session-abc' })
    coalescer.dispose()

    coalescer.push('late output')

    expect(mocks.debug).toHaveBeenCalledTimes(1)
    expect(mocks.debug.mock.calls[0][0]).toMatch(/session-abc.*dropped.*11.*disposed/i)
  })

  it('does not log for an empty chunk pushed after dispose', () => {
    const { coalescer } = coalescerWithFakeTimers()
    coalescer.dispose()
    coalescer.push('')
    expect(mocks.debug).not.toHaveBeenCalled()
  })

  it('does not log when dispose() itself is called with nothing buffered', () => {
    const { coalescer } = coalescerWithFakeTimers()
    coalescer.dispose()
    expect(mocks.debug).not.toHaveBeenCalled()
  })

  it('uses real timers by default', () => {
    vi.useFakeTimers()
    try {
      const frames: string[] = []
      const coalescer = createTerminalOutputCoalescer({ emit: (c) => frames.push(c), flushMs: 8 })
      coalescer.push('x')
      coalescer.push('y')
      vi.advanceTimersByTime(7)
      expect(frames).toEqual(['x'])
      vi.advanceTimersByTime(1)
      expect(frames).toEqual(['x', 'y'])
    } finally {
      vi.useRealTimers()
    }
  })
})
