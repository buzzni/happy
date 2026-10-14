import { describe, expect, it } from 'vitest'
import { AUTH_POLL_MAX_CONSECUTIVE_FAILURES, authPollStep } from './authPollRetry'

// aplus-dev-studio-desktop specs/headless-standalone-server R30: waiting for the owner's approval
// must survive a busy server or a short network drop instead of ending the sign-in.
describe('authPollStep', () => {
  it('waits out a 429 for its Retry-After, bounded, without counting it as a failure', () => {
    expect(authPollStep({ status: 429, retryAfter: '7' }, 0)).toEqual({ action: 'retry', delayMs: 7_000, countsAsFailure: false })
    expect(authPollStep({ status: 429, retryAfter: '600' }, 0)).toEqual({ action: 'retry', delayMs: 60_000, countsAsFailure: false })
    expect(authPollStep({ status: 429 }, 0)).toEqual({ action: 'retry', delayMs: 5_000, countsAsFailure: false })
  })

  it('backs off on no answer or a 5xx and gives up after ten in a row', () => {
    expect(authPollStep({}, 1)).toEqual({ action: 'retry', delayMs: 1_000, countsAsFailure: true })
    expect(authPollStep({ status: 502 }, 3)).toEqual({ action: 'retry', delayMs: 4_000, countsAsFailure: true })
    expect(authPollStep({}, 9)).toEqual({ action: 'retry', delayMs: 30_000, countsAsFailure: true })
    expect(authPollStep({}, AUTH_POLL_MAX_CONSECUTIVE_FAILURES)).toEqual({ action: 'stop', message: expect.stringMatching(/could not reach/i) })
  })

  it('says an expired code expired, and stops on any other refusal', () => {
    expect(authPollStep({ status: 410 }, 0)).toEqual({ action: 'stop', message: expect.stringMatching(/expired.*happy auth login/i) })
    expect(authPollStep({ status: 400 }, 0)).toEqual({ action: 'stop', message: 'Failed to check authentication status. Please try again.' })
  })
})
