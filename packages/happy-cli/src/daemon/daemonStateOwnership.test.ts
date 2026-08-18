import { describe, expect, it } from 'vitest'

import { shouldYieldDaemonStateOwnership } from './daemonStateOwnership'

const OWN_PID = 2901432
const LIVE_FOREIGN_PID = 3100000
const DEAD_FOREIGN_PID = 3058947

const isProcessAlive = (pid: number) => pid === OWN_PID || pid === LIVE_FOREIGN_PID

describe('shouldYieldDaemonStateOwnership', () => {
  it('keeps running when the state file records our own pid', () => {
    expect(shouldYieldDaemonStateOwnership({
      recordedPid: OWN_PID,
      ownPid: OWN_PID,
      isProcessAlive,
    })).toBe(false)
  })

  it('keeps running when there is no state file', () => {
    expect(shouldYieldDaemonStateOwnership({
      recordedPid: null,
      ownPid: OWN_PID,
      isProcessAlive,
    })).toBe(false)
  })

  it('yields when another daemon that is still alive owns the state file', () => {
    expect(shouldYieldDaemonStateOwnership({
      recordedPid: LIVE_FOREIGN_PID,
      ownPid: OWN_PID,
      isProcessAlive,
    })).toBe(true)
  })

  it('keeps running when the recorded pid belongs to a process that already died', () => {
    // Regression: during a bundle handoff, `ensureDaemonRunning()` pollers write the
    // previous daemon's dead pid back into daemon.state.json. Yielding here shut down
    // the only healthy daemon and left the machine offline until a manual restart.
    expect(shouldYieldDaemonStateOwnership({
      recordedPid: DEAD_FOREIGN_PID,
      ownPid: OWN_PID,
      isProcessAlive,
    })).toBe(false)
  })
})
