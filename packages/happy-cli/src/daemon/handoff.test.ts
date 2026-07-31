import { describe, expect, it, vi } from 'vitest'
import { handoffToReplacedBundle, prepareDaemonStartup, resolveStatePreservation } from './handoff'

describe('prepareDaemonStartup', () => {
  it('does not inspect or stop the running daemon when candidate preflight fails', async () => {
    const events: string[] = []
    const preflightCandidate = vi.fn(async () => {
      events.push('preflight')
      throw new Error('candidate runtime is incomplete')
    })
    const runningVersionMatches = vi.fn(async () => {
      events.push('version-check')
      return false
    })
    const stopRunningDaemon = vi.fn(async () => {
      events.push('stop')
    })

    await expect(prepareDaemonStartup({
      preflightCandidate,
      runningVersionMatches,
      stopRunningDaemon,
    })).rejects.toThrow('candidate runtime is incomplete')

    expect(events).toEqual(['preflight'])
    expect(runningVersionMatches).not.toHaveBeenCalled()
    expect(stopRunningDaemon).not.toHaveBeenCalled()
  })

  it('preflights before stopping a daemon with a different version', async () => {
    const events: string[] = []

    const result = await prepareDaemonStartup({
      preflightCandidate: async () => { events.push('preflight') },
      runningVersionMatches: async () => { events.push('version-check'); return false },
      stopRunningDaemon: async () => { events.push('stop') },
    })

    expect(result).toBe('start')
    expect(events).toEqual(['preflight', 'version-check', 'stop'])
  })
})

describe('resolveStatePreservation', () => {
  const withSessions = {
    pid: 1094,
    httpPort: 42001,
    startTime: 'x',
    startedWithCliVersion: '1.1.9',
    state: 'running' as const,
    trackedSessions: [{ pid: 117331, startedBy: 'daemon', startedAt: 1 }],
  }

  // Daemons at or below 1.1.9 unlink the state file when told to stop, taking
  // their live children's only record with them. That code runs inside the OLD
  // process, so the replacement can't fix it there — it has to restore the
  // snapshot it took before asking the old daemon to die.
  it('restores the pre-stop snapshot when the old daemon deleted the state file', () => {
    expect(resolveStatePreservation({ before: withSessions, after: null }))
      .toEqual({ ...withSessions, state: 'stopped' })
  })

  it('leaves a state file the old daemon preserved alone', () => {
    const after = { ...withSessions, state: 'stopped' as const }
    expect(resolveStatePreservation({ before: withSessions, after })).toBeNull()
  })

  it('has nothing to restore when the old daemon tracked no sessions', () => {
    expect(resolveStatePreservation({
      before: { ...withSessions, trackedSessions: [] },
      after: null,
    })).toBeNull()
  })

  it('has nothing to restore when there was no daemon to begin with', () => {
    expect(resolveStatePreservation({ before: null, after: null })).toBeNull()
  })
})

describe('handoffToReplacedBundle', () => {
  it('keeps all current daemon resources when the new bundle preflight fails', async () => {
    const teardownCurrentDaemon = vi.fn(async () => {})
    const spawnReplacement = vi.fn()

    const result = await handoffToReplacedBundle({
      preflightReplacement: async () => false,
      teardownCurrentDaemon,
      spawnReplacement,
    })

    expect(result).toBe('kept-current')
    expect(teardownCurrentDaemon).not.toHaveBeenCalled()
    expect(spawnReplacement).not.toHaveBeenCalled()
  })

  it('tears down and spawns only after the new bundle preflight succeeds', async () => {
    const events: string[] = []

    const result = await handoffToReplacedBundle({
      preflightReplacement: async () => { events.push('preflight'); return true },
      teardownCurrentDaemon: async () => { events.push('teardown') },
      spawnReplacement: () => { events.push('spawn') },
    })

    expect(result).toBe('handed-off')
    expect(events).toEqual(['preflight', 'teardown', 'spawn'])
  })
})
