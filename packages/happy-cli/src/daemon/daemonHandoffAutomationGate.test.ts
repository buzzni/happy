import { describe, expect, it } from 'vitest'

import { createAutomationTickRunner } from './automations/automationTickRunner'
import {
  decideHandoffStep,
  readHandoffCaps,
  resumeAutomationRunnersAfterFailedHandoff,
} from './daemonHandoffAutomationGate'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const caps = { prewaitCapMs: 30 * 60_000, terminalCapMs: 24 * 60 * 60_000 }
const quiet = { inTurnCount: 0, automationCount: 0, busyTerminalCount: 0 }
function step(overrides: Partial<Parameters<typeof decideHandoffStep>[0]> = {}) {
  return decideHandoffStep({
    bundleReplaced: true, pending: { detectedAt: 0, busyTerminalCount: 0, forceAvailable: false },
    now: 60_000, drainOpen: false, ...quiet, ...caps, ...overrides,
  })
}

describe('decideHandoffStep (R4·R25)', () => {
  it('does nothing while the bundle was not replaced or a drain already owns the handoff', () => {
    expect(step({ bundleReplaced: false })).toBe('none')
    expect(step({ drainOpen: true })).toBe('none')
  })

  // #336 회귀: 장수 세션이 살아 있어도 진행 중 턴·자동화·사용 중 터미널이 0이면 교대한다.
  it('tries to hand off at the first quiet moment even with long-lived idle sessions alive', () => {
    expect(step()).toBe('try-now')
  })

  it('keeps waiting without closing admission while a turn or automation runs, until the 30 min cap', () => {
    expect(step({ inTurnCount: 1, now: 29 * 60_000 })).toBe('prewait')
    expect(step({ automationCount: 1, now: 29 * 60_000 })).toBe('prewait')
    expect(step({ inTurnCount: 1, now: 30 * 60_000 })).toBe('begin-cap-drain')
  })

  it('never enters the cap drain while a terminal is busy', () => {
    expect(step({ inTurnCount: 1, busyTerminalCount: 1, now: 31 * 60_000 })).toBe('prewait')
  })

  it('at the 24 h terminal cap publishes forceAvailable, then drains on the next beat', () => {
    const now = 24 * 60 * 60_000
    expect(step({ busyTerminalCount: 1, now })).toBe('publish-force-available')
    expect(step({ busyTerminalCount: 1, now, pending: { detectedAt: 0, busyTerminalCount: 1, forceAvailable: true } }))
      .toBe('begin-terminal-cap-drain')
  })

  it('reads both caps from env', () => {
    expect(readHandoffCaps({ HAPPY_DAEMON_HANDOFF_PREWAIT_CAP_MS: '5000', HAPPY_DAEMON_HANDOFF_TERMINAL_CAP_MS: '9000' }))
      .toEqual({ prewaitCapMs: 5000, terminalCapMs: 9000 })
    expect(readHandoffCaps({})).toEqual(caps)
  })

  it('shouldKeepTheDaemonUntilSpawnWebhookReportAndLinkFinish', async () => {
    const webhook = deferred()
    const events: string[] = []
    const runner = createAutomationTickRunner({
      runTick: async () => {
        events.push('claim')
        events.push('spawn')
        await webhook.promise
        events.push('webhook')
        events.push('report')
        events.push('link')
      },
    })

    runner.trigger()
    await settle()
    runner.pause()

    expect(step({ automationCount: Number(runner.isRunning()) })).toBe('prewait')
    runner.trigger()
    expect(events).toEqual(['claim', 'spawn'])

    webhook.resolve()
    await settle()
    expect(events).toEqual(['claim', 'spawn', 'webhook', 'report', 'link'])
    expect(step({ automationCount: Number(runner.isRunning()) })).toBe('try-now')
  })
})

describe('resumeAutomationRunnersAfterFailedHandoff', () => {
  it('shouldImmediatelyRunEnabledSchedulersBeforeTheNextHandoffRetry', async () => {
    const events: string[] = []
    const legacyRunner = createAutomationTickRunner({
      runTick: async () => { events.push('legacy') },
    })
    const serverRunner = createAutomationTickRunner({
      runTick: async () => { events.push('server') },
    })
    legacyRunner.pause()
    serverRunner.pause()

    resumeAutomationRunnersAfterFailedHandoff({
      legacyAutomationEnabled: true,
      legacyRunner,
      serverRunner,
    })
    await settle()

    expect(events).toEqual(['legacy', 'server'])
  })

  it('shouldResumeButNotRunTheDisabledLegacyScheduler', async () => {
    const events: string[] = []
    const legacyRunner = createAutomationTickRunner({
      runTick: async () => { events.push('legacy') },
    })
    const serverRunner = createAutomationTickRunner({
      runTick: async () => { events.push('server') },
    })
    legacyRunner.pause()
    serverRunner.pause()

    resumeAutomationRunnersAfterFailedHandoff({
      legacyAutomationEnabled: false,
      legacyRunner,
      serverRunner,
    })
    await settle()
    expect(events).toEqual(['server'])

    legacyRunner.trigger()
    await settle()
    expect(events).toEqual(['server', 'legacy'])
  })
})
