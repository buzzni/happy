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

  // 2026-09-03: 대화형 세션은 몇 시간씩 살아 있다. 그동안 runner 를 멈추면 서버 이관
  // 반복 리뷰(session follow-up)가 세션이 모두 끝날 때까지 굶는다 — 교대는 미루되 automation 은 계속.
  it.each([
    { legacyAutomationRunning: false, serverAutomationRunning: false },
    { legacyAutomationRunning: false, serverAutomationRunning: true },
    { legacyAutomationRunning: true, serverAutomationRunning: false, serverAutomationLeaseRunning: true },
  ])('shouldKeepRunningAutomationsWhileAnInteractiveOrTerminalSessionDefersHandoff (%o)', (running) => {
    expect(decideAutomationAwareHandoff({
      bundleReplaced: true,
      ...running,
      activeSessionCount: 1,
    })).toBe('run-automations')
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
