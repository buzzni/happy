/**
 * `configuration` freezes HAPPY_HOME_DIR at import time, so the env is fixed
 * before the dynamic import (same pattern as persistence.provision.test.ts).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'happy-daemon-lock-'))
process.env.HAPPY_HOME_DIR = home

const { acquireDaemonLock, readDaemonLockHolderPid, releaseDaemonLock } = await import('./persistence')

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('readDaemonLockHolderPid', () => {
  it('returns null when no lock file exists', () => {
    expect(readDaemonLockHolderPid()).toBeNull()
  })

  it('returns the pid the lock holder wrote', () => {
    writeFileSync(join(home, 'daemon.state.json.lock'), '48213\n')
    expect(readDaemonLockHolderPid()).toBe(48213)
  })

  it('returns null when the lock file holds no pid', () => {
    writeFileSync(join(home, 'daemon.state.json.lock'), 'garbage')
    expect(readDaemonLockHolderPid()).toBeNull()
  })
})

describe('acquireDaemonLock with a lock left by a dead daemon', () => {
  const lockFile = join(home, 'daemon.state.json.lock')
  // A live pid that is not a daemon: the test runner itself.
  const writeLock = (writtenAt: number) => {
    writeFileSync(lockFile, String(process.pid))
    utimesSync(lockFile, writtenAt / 1000, writtenAt / 1000)
  }

  it('takes over when the pid now belongs to a process that started after the lock was written', async () => {
    const writtenAt = Date.now() - 60 * 60_000
    writeLock(writtenAt)
    // Removing the stale lock uses one attempt; the retry then takes it.
    const handle = await acquireDaemonLock(2, 0, { getProcessStartedAt: () => writtenAt + 30 * 60_000 })
    expect(handle).not.toBeNull()
    await releaseDaemonLock(handle!)
    expect(existsSync(lockFile)).toBe(false)
  })

  it('keeps the lock of a holder that started before it wrote the lock', async () => {
    const writtenAt = Date.now() - 60_000
    writeLock(writtenAt)
    const handle = await acquireDaemonLock(1, 0, { getProcessStartedAt: () => writtenAt - 3_000 })
    expect(handle).toBeNull()
    expect(readFileSync(lockFile, 'utf-8')).toBe(String(process.pid))
  })

  it('keeps the lock when the start time is within the clock slack of the write', async () => {
    const writtenAt = Date.now() - 60_000
    writeLock(writtenAt)
    expect(await acquireDaemonLock(1, 0, { getProcessStartedAt: () => writtenAt + 1_000 })).toBeNull()
  })

  it('keeps the lock when the start time cannot be read', async () => {
    writeLock(Date.now() - 60 * 60_000)
    expect(await acquireDaemonLock(1, 0, { getProcessStartedAt: () => undefined })).toBeNull()
    rmSync(lockFile, { force: true })
  })
})

describe('acquireDaemonLock reclaim safety', () => {
  const lockFile = join(home, 'daemon.state.json.lock')
  const staleLock = (pid: number, writtenAt: number) => {
    writeFileSync(lockFile, String(pid))
    utimesSync(lockFile, writtenAt / 1000, writtenAt / 1000)
  }

  it('lets only one of two concurrent starters reclaim the same stale lock', async () => {
    // The live pid (this runner) started 10 min ago; the stale lock is an hour old,
    // and whichever starter wins writes a fresh lock that the other must keep.
    const startedAt = Date.now() - 10 * 60_000
    staleLock(process.pid, Date.now() - 60 * 60_000)
    let arrived = 0
    let release!: () => void
    const bothLooking = new Promise<void>(resolve => { release = resolve })
    const deps = {
      getProcessStartedAt: async () => { if (++arrived === 2) release(); await bothLooking; return startedAt },
      answersAsDaemon: async () => false,
    }
    const handles = await Promise.all([acquireDaemonLock(3, 0, deps), acquireDaemonLock(3, 0, deps)])
    expect(handles.filter(Boolean)).toHaveLength(1)
    await releaseDaemonLock(handles.find(Boolean)!)
  })

  it('keeps a lock whose holder still answers as the daemon even if its start looks later', async () => {
    staleLock(process.pid, Date.now() - 60 * 60_000)
    const handle = await acquireDaemonLock(2, 0, { getProcessStartedAt: () => Date.now(), answersAsDaemon: async () => true })
    expect(handle).toBeNull()
    rmSync(lockFile, { force: true })
  })

  it('asks for the start time once per lock it sees, not once per retry', async () => {
    const writtenAt = Date.now() - 60_000
    staleLock(process.pid, writtenAt)
    let lookups = 0
    const handle = await acquireDaemonLock(4, 0, { getProcessStartedAt: () => { lookups++; return writtenAt - 5_000 } })
    expect(handle).toBeNull()
    expect(lookups).toBe(1)
    rmSync(lockFile, { force: true })
  })

  it('does not treat a holder it may not signal as dead', async () => {
    // pid 1 belongs to root: signalling it fails with EPERM for a normal user.
    const writtenAt = Date.now() - 60_000
    staleLock(1, writtenAt)
    const handle = await acquireDaemonLock(2, 0, { getProcessStartedAt: () => writtenAt - 5_000 })
    expect(handle).toBeNull()
    rmSync(lockFile, { force: true })
  })

  it('releases only the lock it still owns', async () => {
    const handle = await acquireDaemonLock(1, 0)
    expect(handle).not.toBeNull()
    writeFileSync(lockFile, '999999') // someone else's lock replaced ours
    await releaseDaemonLock(handle!)
    expect(readFileSync(lockFile, 'utf-8')).toBe('999999')
    rmSync(lockFile, { force: true })
  })
})

describe('acquireDaemonLock with daemon identity (aplus codexcli-daemon-restart-drain R19)', () => {
  const lockFile = join(home, 'daemon.state.json.lock')
  const stateFile = join(home, 'daemon.state.json')
  const writeLockAndIdentity = (identity: Record<string, unknown>) => {
    writeFileSync(lockFile, String(process.pid))
    const lockAt = Date.now() / 1000 - 5
    utimesSync(lockFile, lockAt, lockAt)
    writeFileSync(stateFile, JSON.stringify({ pid: process.pid, httpPort: 1, startTime: 'x', startedWithCliVersion: 'x', identity }))
  }

  it('ignores a recorded identity older than the lock (a new holder has not written its own yet)', async () => {
    writeFileSync(stateFile, JSON.stringify({ pid: process.pid, httpPort: 1, startTime: 'x', startedWithCliVersion: 'x', identity: { pid: process.pid, startedAt: 1 } }))
    const stateAt = Date.now() / 1000 - 60
    utimesSync(stateFile, stateAt, stateAt)
    writeFileSync(lockFile, String(process.pid))
    expect(await acquireDaemonLock(1, 0, { getProcessStartedAt: () => Date.now() - 1_000, readBootId: () => undefined })).toBeNull()
    rmSync(lockFile, { force: true })
  })

  it('takes over a fresh-looking lock when the recorded start time says the pid was reused', async () => {
    writeLockAndIdentity({ pid: process.pid, startedAt: Date.now() - 60 * 60_000 })
    const handle = await acquireDaemonLock(2, 0, { getProcessStartedAt: () => Date.now(), readBootId: () => undefined })
    expect(handle).not.toBeNull()
    await releaseDaemonLock(handle!)
  })

  it('takes over when the boot id changed (reboot)', async () => {
    const startedAt = Date.now() - 1_000
    writeLockAndIdentity({ pid: process.pid, startedAt, bootId: 'before-reboot' })
    const handle = await acquireDaemonLock(2, 0, { getProcessStartedAt: () => startedAt, readBootId: () => 'after-reboot' })
    expect(handle).not.toBeNull()
    await releaseDaemonLock(handle!)
  })

  it('keeps the lock of the recorded daemon even when its start time looks newer than the lock', async () => {
    const startedAt = Date.now()
    writeLockAndIdentity({ pid: process.pid, startedAt })
    utimesSync(lockFile, (startedAt - 60 * 60_000) / 1000, (startedAt - 60 * 60_000) / 1000)
    expect(await acquireDaemonLock(1, 0, { getProcessStartedAt: () => startedAt + 500, readBootId: () => undefined })).toBeNull()
    rmSync(lockFile, { force: true })
    rmSync(stateFile, { force: true })
  })
})

