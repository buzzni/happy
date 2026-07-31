import { describe, it, expect } from 'vitest'
import { resolveOrphanAdoption, collectStartupOrphans, EXTERNAL_SESSION_STARTED_BY } from './orphanAdoption'
import type { PersistedSession } from '@/persistence'
import type { Metadata } from '@/api/types'

const NOW = 1_800_000_000_000

function persisted(overrides: {
  startedBy?: Metadata['startedBy']
  hostPid?: number
  savedAt?: number
} = {}): PersistedSession {
  return {
    encryptionKey: 'a2V5',
    encryptionVariant: 'dataKey',
    seq: 1,
    metadataVersion: 1,
    agentStateVersion: 1,
    savedAt: overrides.savedAt ?? NOW - 60_000,
    metadata: {
      path: '/work/project',
      host: 'test-host',
      ...(overrides.startedBy !== undefined ? { startedBy: overrides.startedBy } : {}),
      ...(overrides.hostPid !== undefined ? { hostPid: overrides.hostPid } : {}),
    } as Metadata,
  }
}

describe('resolveOrphanAdoption', () => {
  const alive = (pid: number) => pid === 4242

  it('adopts a live session that reported its own PID', () => {
    const result = resolveOrphanAdoption({
      sessionId: 'sess-1',
      hostPid: 4242,
      persistedSessions: { 'sess-1': persisted({ startedBy: 'terminal' }) },
      isPidAlive: alive,
      now: NOW,
    })

    expect(result.adopted).toBe(true)
    if (!result.adopted) return
    expect(result.session.pid).toBe(4242)
    expect(result.session.happySessionId).toBe('sess-1')
  })

  // The idle guard's local-session protection keys off startedBy !== 'daemon'.
  // Adopting a daemon-spawned session under any other label would make the
  // daemon treat it as a terminal the user is sitting at — protected forever.
  it('restores daemon provenance so the idle guard keeps its meaning', () => {
    const result = resolveOrphanAdoption({
      sessionId: 'sess-1',
      hostPid: 4242,
      persistedSessions: { 'sess-1': persisted({ startedBy: 'daemon' }) },
      isPidAlive: alive,
      now: NOW,
    })

    expect(result.adopted && result.session.startedBy).toBe('daemon')
  })

  it('labels a terminal-started session as externally started', () => {
    const result = resolveOrphanAdoption({
      sessionId: 'sess-1',
      hostPid: 4242,
      persistedSessions: { 'sess-1': persisted({ startedBy: 'terminal' }) },
      isPidAlive: alive,
      now: NOW,
    })

    expect(result.adopted && result.session.startedBy).toBe(EXTERNAL_SESSION_STARTED_BY)
  })

  // Age drives every reaper policy (min session age, hard cap, empty reap).
  // Restarting the clock on adoption would make a long-lived orphan immortal
  // as long as daemons keep restarting.
  it('keeps the original session age instead of restarting the clock', () => {
    const startedLongAgo = NOW - 15 * 60 * 60 * 1000
    const result = resolveOrphanAdoption({
      sessionId: 'sess-1',
      hostPid: 4242,
      persistedSessions: { 'sess-1': persisted({ savedAt: startedLongAgo }) },
      isPidAlive: alive,
      now: NOW,
    })

    expect(result.adopted && result.startedAt).toBe(startedLongAgo)
  })

  // Older sessions don't send hostPid — fall back to the persisted record.
  it('falls back to the persisted hostPid when the report omits one', () => {
    const result = resolveOrphanAdoption({
      sessionId: 'sess-1',
      persistedSessions: { 'sess-1': persisted({ hostPid: 4242 }) },
      isPidAlive: alive,
      now: NOW,
    })

    expect(result.adopted && result.session.pid).toBe(4242)
  })

  it('refuses to adopt a PID that is no longer alive', () => {
    const result = resolveOrphanAdoption({
      sessionId: 'sess-1',
      persistedSessions: { 'sess-1': persisted({ hostPid: 9999 }) },
      isPidAlive: alive,
      now: NOW,
    })

    expect(result).toEqual({ adopted: false, reason: 'pid-dead' })
  })

  it('refuses to adopt when no PID can be determined', () => {
    const result = resolveOrphanAdoption({
      sessionId: 'sess-1',
      persistedSessions: {},
      isPidAlive: alive,
      now: NOW,
    })

    expect(result).toEqual({ adopted: false, reason: 'no-pid' })
  })

  // A live process reporting its own PID is authoritative even with no
  // persisted record: adopting makes it visible, prunable, and reapable
  // instead of invisible forever. Provenance falls back to the protective side.
  it('adopts a live reporter with no persisted record, conservatively', () => {
    const result = resolveOrphanAdoption({
      sessionId: 'sess-1',
      hostPid: 4242,
      persistedSessions: {},
      isPidAlive: alive,
      now: NOW,
    })

    expect(result.adopted).toBe(true)
    if (!result.adopted) return
    expect(result.session.startedBy).toBe(EXTERNAL_SESSION_STARTED_BY)
    expect(result.startedAt).toBe(NOW)
    expect(result.session.happySessionMetadataFromLocalWebhook).toBeUndefined()
  })

  // The reporting process's own PID is ground truth; a 14-day-old persisted
  // record can point at a recycled PID.
  it('prefers the reported PID over the persisted one', () => {
    const result = resolveOrphanAdoption({
      sessionId: 'sess-1',
      hostPid: 4242,
      persistedSessions: { 'sess-1': persisted({ hostPid: 1111 }) },
      isPidAlive: (pid) => pid === 4242 || pid === 1111,
      now: NOW,
    })

    expect(result.adopted && result.session.pid).toBe(4242)
  })
})

describe('collectStartupOrphans', () => {
  // A session can be alive but silent (wedged runtime, or simply between
  // reports). The report-driven path never sees it, so startup has to look for
  // it — this is what finally lets the zombie sweep reach a stuck process.
  it('adopts a live persisted session that this daemon is not tracking', () => {
    const savedAt = NOW - 60_000
    const orphans = collectStartupOrphans({
      persistedSessions: { 'sess-1': persisted({ hostPid: 4242, savedAt }) },
      trackedPids: new Set<number>(),
      isPidAlive: (pid) => pid === 4242,
      getProcessStartedAt: () => savedAt - 1_000,
      now: NOW,
    })

    expect(orphans).toHaveLength(1)
    expect(orphans[0]).toMatchObject({ sessionId: 'sess-1', startedAt: savedAt })
    expect(orphans[0].session.pid).toBe(4242)
  })

  it('skips sessions already tracked by this daemon', () => {
    const savedAt = NOW - 60_000
    expect(collectStartupOrphans({
      persistedSessions: { 'sess-1': persisted({ hostPid: 4242, savedAt }) },
      trackedPids: new Set([4242]),
      isPidAlive: () => true,
      getProcessStartedAt: () => savedAt - 1_000,
      now: NOW,
    })).toEqual([])
  })

  it('skips sessions whose process is gone', () => {
    expect(collectStartupOrphans({
      persistedSessions: { 'sess-1': persisted({ hostPid: 4242 }) },
      trackedPids: new Set<number>(),
      isPidAlive: () => false,
      getProcessStartedAt: () => NOW - 120_000,
      now: NOW,
    })).toEqual([])
  })

  // Persisted records live for 14 days, so a recorded PID can belong to an
  // unrelated process by now. A process that started *after* the session record
  // was written cannot be that session — SIGTERM'ing it would kill a bystander.
  it('refuses a PID whose process started after the session was recorded', () => {
    const savedAt = NOW - 60_000
    expect(collectStartupOrphans({
      persistedSessions: { 'sess-1': persisted({ hostPid: 4242, savedAt }) },
      trackedPids: new Set<number>(),
      isPidAlive: () => true,
      getProcessStartedAt: () => savedAt + 1_000,
      now: NOW,
    })).toEqual([])
  })

  it('refuses to adopt when the process start time cannot be read', () => {
    expect(collectStartupOrphans({
      persistedSessions: { 'sess-1': persisted({ hostPid: 4242 }) },
      trackedPids: new Set<number>(),
      isPidAlive: () => true,
      getProcessStartedAt: () => undefined,
      now: NOW,
    })).toEqual([])
  })

  it('skips records that never captured a host PID', () => {
    expect(collectStartupOrphans({
      persistedSessions: { 'sess-1': persisted() },
      trackedPids: new Set<number>(),
      isPidAlive: () => true,
      getProcessStartedAt: () => NOW - 120_000,
      now: NOW,
    })).toEqual([])
  })
})
