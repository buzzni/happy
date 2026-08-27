import { describe, expect, it } from 'vitest'

import { createAutomationTickRunner } from './automations/automationTickRunner'
import {
  decideAutomationAwareHandoff,
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

describe('decideAutomationAwareHandoff', () => {
  it('shouldRunAutomationsWhenTheBundleWasNotReplaced', () => {
    expect(decideAutomationAwareHandoff({
      bundleReplaced: false,
      legacyAutomationRunning: false,
      serverAutomationRunning: false,
    })).toBe('run-automations')
  })

  it.each([
    { legacyAutomationRunning: true, serverAutomationRunning: false },
    { legacyAutomationRunning: false, serverAutomationRunning: true },
    { legacyAutomationRunning: true, serverAutomationRunning: true },
  ])('shouldDeferHandoffWhileAnAutomationTickIsRunning (%o)', (running) => {
    expect(decideAutomationAwareHandoff({
      bundleReplaced: true,
      ...running,
    })).toBe('defer-handoff')
  })

  it('shouldHandoffAfterEveryAutomationTickBecomesIdle', () => {
    expect(decideAutomationAwareHandoff({
      bundleReplaced: true,
      legacyAutomationRunning: false,
      serverAutomationRunning: false,
    })).toBe('handoff')
  })

  it('shouldDeferHandoffWhileAnAgentTaskLeaseIsActive', () => {
    expect(decideAutomationAwareHandoff({
      bundleReplaced: true,
      legacyAutomationRunning: false,
      serverAutomationRunning: false,
      serverAutomationLeaseRunning: true,
    })).toBe('defer-handoff')
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

    expect(decideAutomationAwareHandoff({
      bundleReplaced: true,
      legacyAutomationRunning: false,
      serverAutomationRunning: runner.isRunning(),
    })).toBe('defer-handoff')
    runner.trigger()
    expect(events).toEqual(['claim', 'spawn'])

    webhook.resolve()
    await settle()
    expect(events).toEqual(['claim', 'spawn', 'webhook', 'report', 'link'])
    expect(decideAutomationAwareHandoff({
      bundleReplaced: true,
      legacyAutomationRunning: false,
      serverAutomationRunning: runner.isRunning(),
    })).toBe('handoff')
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
