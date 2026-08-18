import { describe, expect, it } from 'vitest'

import { shouldYieldDaemonStateOwnership } from './daemonStateOwnership'

const OWN_PID = 2901432
const FOREIGN_PID = 3100000

describe('shouldYieldDaemonStateOwnership', () => {
  it('keeps running when the state file records our own pid', () => {
    expect(shouldYieldDaemonStateOwnership({
      recordedPid: OWN_PID,
      ownPid: OWN_PID,
    })).toBe(false)
  })

  it('keeps running when there is no state file', () => {
    expect(shouldYieldDaemonStateOwnership({
      recordedPid: null,
      ownPid: OWN_PID,
    })).toBe(false)
  })

  it('yields when another daemon owns the state file', () => {
    expect(shouldYieldDaemonStateOwnership({
      recordedPid: FOREIGN_PID,
      ownPid: OWN_PID,
    })).toBe(true)
  })
})
