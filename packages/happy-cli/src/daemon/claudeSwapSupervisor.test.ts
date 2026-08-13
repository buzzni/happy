import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeSwapSupervisor, type ClaudeSwapChild } from './claudeSwapSupervisor'

function child(): ClaudeSwapChild & { emit: EventEmitter['emit']; stdout: EventEmitter; stderr: EventEmitter } {
  const processEvents = new EventEmitter()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  return {
    pid: 123,
    stdout,
    stderr,
    kill: vi.fn(),
    on: processEvents.on.bind(processEvents),
    emit: processEvents.emit.bind(processEvents),
  }
}

function setup(enabled = false) {
  const children: ReturnType<typeof child>[] = []
  const scheduled: Array<{ callback: () => void; delay: number }> = []
  const spawn = vi.fn(() => {
    const next = child()
    children.push(next)
    return next
  })
  const writeEnabled = vi.fn(async () => undefined)
  const supervisor = new ClaudeSwapSupervisor({
    readEnabled: vi.fn(async () => enabled),
    writeEnabled,
    spawn,
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay })
      return callback
    },
    clearSchedule: vi.fn(),
  })
  return { supervisor, spawn, children, scheduled, writeEnabled }
}

describe('Claude swap supervisor', () => {
  it('persists enablement and runs exactly one consume-first auto child', async () => {
    const { supervisor, spawn, writeEnabled } = setup()

    await supervisor.enable()
    await supervisor.enable()

    expect(writeEnabled).toHaveBeenCalledWith(true)
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith('cswap', ['auto', '--strategy', 'consume-first', '--json'])
    expect(supervisor.status()).toEqual({ state: 'running', lastErrorKind: null })
  })

  it('restores an enabled supervisor and restarts with bounded backoff after exit', async () => {
    const { supervisor, spawn, children, scheduled } = setup(true)

    await supervisor.restore()
    children[0].emit('exit', 1, null)

    expect(supervisor.status()).toEqual({ state: 'blocked', lastErrorKind: 'PROCESS_EXITED' })
    expect(scheduled[0].delay).toBe(1_000)
    scheduled[0].callback()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('stops the child and never exposes stdout credential fields in status', async () => {
    const { supervisor, children, writeEnabled } = setup()
    await supervisor.enable()
    children[0].stdout.emit('data', Buffer.from('{"email":"owner@example.com","accessToken":"secret"}\n'))

    expect(JSON.stringify(supervisor.status())).not.toContain('secret')
    expect(JSON.stringify(supervisor.status())).not.toContain('owner@example.com')

    await supervisor.stop()
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM')
    expect(writeEnabled).toHaveBeenLastCalledWith(false)
    expect(supervisor.status()).toEqual({ state: 'stopped', lastErrorKind: null })
  })

  it('records only masked switch metadata from fragmented JSON events', async () => {
    const { supervisor, children } = setup()
    await supervisor.enable()
    children[0].stdout.emit('data', Buffer.from('{"schemaVersion":1,"event":"switch","ts":"2026-08-13T'))
    children[0].stdout.emit('data', Buffer.from('09:00:00Z","to":{"number":2,"email":"next@example.com"},"accessToken":"secret"}\n'))

    expect(supervisor.status()).toEqual({
      state: 'running',
      lastErrorKind: null,
      lastSwitchAt: '2026-08-13T09:00:00Z',
      activeAccount: 'n***@example.com',
    })
    expect(JSON.stringify(supervisor.status())).not.toContain('secret')
    expect(JSON.stringify(supervisor.status())).not.toContain('next@example.com')
  })

  it('keeps account exhaustion blocked through the next poll and clears on a healthy decision', async () => {
    const { supervisor, children } = setup()
    await supervisor.enable()

    children[0].stdout.emit('data', Buffer.from(
      '{"schemaVersion":1,"event":"all-exhausted","ts":"2026-08-13T09:00:00Z","earliestResetAt":null}\n',
    ))
    expect(supervisor.status()).toEqual({
      state: 'blocked',
      lastErrorKind: 'ALL_ACCOUNTS_EXHAUSTED',
    })

    children[0].stdout.emit('data', Buffer.from(
      '{"schemaVersion":1,"event":"poll","ts":"2026-08-13T09:01:00Z","active":{"number":1}}\n',
    ))
    expect(supervisor.status()).toEqual({
      state: 'blocked',
      lastErrorKind: 'ALL_ACCOUNTS_EXHAUSTED',
    })

    children[0].stdout.emit('data', Buffer.from(
      '{"schemaVersion":1,"event":"no-switch","ts":"2026-08-13T09:01:01Z","reason":"below-threshold"}\n',
    ))
    expect(supervisor.status()).toEqual({ state: 'running', lastErrorKind: null })
  })

  it('resets restart backoff after receiving a healthy poll', async () => {
    const { supervisor, children, scheduled } = setup(true)
    await supervisor.restore()
    children[0].emit('exit', 1, null)
    scheduled[0].callback()

    children[1].stdout.emit('data', Buffer.from(
      '{"schemaVersion":1,"event":"poll","ts":"2026-08-13T09:01:00Z","active":{"number":1}}\n',
    ))
    children[1].emit('exit', 1, null)

    expect(scheduled[1].delay).toBe(1_000)
  })

  it('shuts down the child without disabling restart persistence', async () => {
    const { supervisor, children, writeEnabled } = setup(true)
    await supervisor.restore()

    supervisor.shutdown()

    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM')
    expect(writeEnabled).not.toHaveBeenCalled()
    expect(supervisor.status()).toEqual({ state: 'stopped', lastErrorKind: null })
  })

  it('keeps restart enabled when persisting stop fails', async () => {
    const { supervisor, children, scheduled, writeEnabled } = setup()
    await supervisor.enable()
    writeEnabled.mockRejectedValueOnce(new Error('disk full'))

    await expect(supervisor.stop()).rejects.toThrow('disk full')
    children[0].emit('exit', 1, null)

    expect(scheduled).toHaveLength(1)
    expect(supervisor.status()).toEqual({ state: 'blocked', lastErrorKind: 'PROCESS_EXITED' })
  })
})
