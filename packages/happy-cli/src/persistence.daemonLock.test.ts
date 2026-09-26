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
