import { describe, expect, it } from 'vitest'

import { resolveDaemonStateOwnership } from './daemonStateOwnership'

const OWN_PID = 2901432
const LIVE_FOREIGN_PID = 3100000
const DEAD_FOREIGN_PID = 3058947

const isProcessAlive = (pid: number) => pid === OWN_PID || pid === LIVE_FOREIGN_PID

describe('resolveDaemonStateOwnership', () => {
  it('keeps running when the state file records our own pid', () => {
    expect(resolveDaemonStateOwnership({
      recordedPid: OWN_PID,
      ownPid: OWN_PID,
      lockHolderPid: OWN_PID,
      isProcessAlive,
    })).toEqual({ yield: false, reason: 'own' })
  })

  it('keeps running when there is no state file', () => {
    expect(resolveDaemonStateOwnership({
      recordedPid: null,
      ownPid: OWN_PID,
      lockHolderPid: OWN_PID,
      isProcessAlive,
    })).toEqual({ yield: false, reason: 'unrecorded' })
  })

  it('yields when another daemon took the lock and owns the state file', () => {
    expect(resolveDaemonStateOwnership({
      recordedPid: LIVE_FOREIGN_PID,
      ownPid: OWN_PID,
      lockHolderPid: LIVE_FOREIGN_PID,
      isProcessAlive,
    })).toEqual({ yield: true, reason: 'foreign-daemon' })
  })

  it('keeps running when the recorded pid belongs to a process that already died', () => {
    // Regression: during a bundle handoff, `ensureDaemonRunning()` pollers write the
    // previous daemon's dead pid back into daemon.state.json. Yielding here shut down
    // the only healthy daemon and left the machine offline until a manual restart.
    expect(resolveDaemonStateOwnership({
      recordedPid: DEAD_FOREIGN_PID,
      ownPid: OWN_PID,
      lockHolderPid: OWN_PID,
      isProcessAlive,
    })).toEqual({ yield: false, reason: 'foreign-dead' })
  })

  it('keeps running when a live non-daemon process wrote the state file while we still hold the lock', () => {
    // Regression (2026-09-10): a vitest worker called writeDaemonState() against the
    // developer's real HAPPY_HOME with its own live pid. The daemon saw "live foreign
    // pid" and shut itself down although nothing had taken the daemon lock from it.
    expect(resolveDaemonStateOwnership({
      recordedPid: LIVE_FOREIGN_PID,
      ownPid: OWN_PID,
      lockHolderPid: OWN_PID,
      isProcessAlive,
    })).toEqual({ yield: false, reason: 'foreign-without-lock' })
  })

  it('falls back to liveness when the lock is not ours and not the recorded pid', () => {
    // We released the lock for a handoff, or something removed it. Without the lock
    // as evidence, a live foreign pid keeps the historical meaning: another daemon.
    expect(resolveDaemonStateOwnership({
      recordedPid: LIVE_FOREIGN_PID,
      ownPid: OWN_PID,
      lockHolderPid: null,
      isProcessAlive,
    })).toEqual({ yield: true, reason: 'foreign-daemon' })
  })
})
