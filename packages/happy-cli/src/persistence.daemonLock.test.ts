/**
 * `configuration` freezes HAPPY_HOME_DIR at import time, so the env is fixed
 * before the dynamic import (same pattern as persistence.provision.test.ts).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'happy-daemon-lock-'))
process.env.HAPPY_HOME_DIR = home

const { readDaemonLockHolderPid } = await import('./persistence')

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
