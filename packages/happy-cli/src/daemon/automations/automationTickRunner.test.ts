import { describe, expect, it } from 'vitest'

import { createAutomationTickRunner } from './automationTickRunner'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const settle = () => new Promise<void>((res) => setTimeout(res, 0))

describe('createAutomationTickRunner', () => {
  it('shouldNotStartANewTickWhilePaused', async () => {
    let runs = 0
    const logs: string[] = []
    const runner = createAutomationTickRunner({
      runTick: async () => {
        runs += 1
      },
      logDebug: (message) => logs.push(message),
    })

    runner.pause()
    runner.trigger()
    await settle()

    expect(runs).toBe(0)
    expect(logs.some((line) => line.includes('runner paused'))).toBe(true)
  })

  it('shouldRunATickImmediatelyWhenRequestedOnResume', async () => {
    let runs = 0
    const runner = createAutomationTickRunner({
      runTick: async () => {
        runs += 1
      },
    })

    runner.pause()
    runner.resume({ trigger: true })
    await settle()

    expect(runs).toBe(1)
  })

  it('shouldNotRequireAMethodReceiverWhenResumeIsPassedAsACallback', async () => {
    let runs = 0
    const runner = createAutomationTickRunner({
      runTick: async () => {
        runs += 1
      },
    })
    runner.pause()

    const resume = runner.resume
    resume({ trigger: true })
    await settle()

    expect(runs).toBe(1)
  })

  it('shouldSkipTriggerWhileTickIsStillRunning', async () => {
    const gate = deferred()
    let runs = 0
    const logs: string[] = []
    const runner = createAutomationTickRunner({
      runTick: () => {
        runs += 1
        return gate.promise
      },
      logDebug: (message) => logs.push(message),
    })

    runner.trigger()
    await settle()
    expect(runner.isRunning()).toBe(true)

    // 하트비트가 60초를 넘긴 tick 위로 다시 발화해도 중복 기동하지 않는다.
    runner.trigger()
    runner.trigger()
    expect(runs).toBe(1)
    expect(logs.some((line) => line.includes('skipping this heartbeat'))).toBe(true)
  })

  it('shouldAllowNextTriggerAfterTickCompletes', async () => {
    const first = deferred()
    let runs = 0
    const runner = createAutomationTickRunner({
      runTick: () => {
        runs += 1
        return runs === 1 ? first.promise : Promise.resolve()
      },
    })

    runner.trigger()
    first.resolve()
    await settle()
    expect(runner.isRunning()).toBe(false)

    runner.trigger()
    await settle()
    expect(runs).toBe(2)
  })

  it('shouldReleaseGuardAndLogWhenTickRejects', async () => {
    const logs: string[] = []
    let runs = 0
    const runner = createAutomationTickRunner({
      runTick: () => {
        runs += 1
        return runs === 1 ? Promise.reject(new Error('boom')) : Promise.resolve()
      },
      logDebug: (message) => logs.push(message),
    })

    // reject가 unhandled rejection이 되거나 가드를 잠근 채 남지 않는다.
    runner.trigger()
    await settle()
    expect(runner.isRunning()).toBe(false)
    expect(logs.some((line) => line.includes('tick failed: boom'))).toBe(true)

    runner.trigger()
    await settle()
    expect(runs).toBe(2)
  })

  it('shouldReleaseGuardWhenRunTickThrowsSynchronously', async () => {
    const logs: string[] = []
    const runner = createAutomationTickRunner({
      runTick: () => {
        throw new Error('sync-boom')
      },
      logDebug: (message) => logs.push(message),
    })

    expect(() => runner.trigger()).not.toThrow()
    await settle()
    expect(runner.isRunning()).toBe(false)
    expect(logs.some((line) => line.includes('tick failed: sync-boom'))).toBe(true)
  })

  it('shouldSayHowLongTheRunningTickHasBeenGoingWhenSkipping', async () => {
    const gate = deferred()
    const logs: string[] = []
    let now = 1_000_000
    const runner = createAutomationTickRunner({
      runTick: () => gate.promise,
      logDebug: (message) => logs.push(message),
      now: () => now,
    })

    runner.trigger()
    now += 125_000
    runner.trigger()

    // 매분 같은 문구만 찍히면 "멈춘 지 7시간" 과 "방금 시작" 을 로그로 구분할 수 없다.
    expect(logs.at(-1)).toContain('still running for 125s')
  })

  it('shouldKeepSkippingBeforeTheStallThreshold', async () => {
    const gate = deferred()
    const logs: string[] = []
    let now = 1_000_000
    let runs = 0
    const runner = createAutomationTickRunner({
      runTick: () => {
        runs += 1
        return gate.promise
      },
      logDebug: (message) => logs.push(message),
      now: () => now,
      stalledAfterMs: 600_000,
    })

    runner.trigger()
    now += 599_000
    runner.trigger()
    await settle()

    expect(runs).toBe(1)
    expect(logs.some((line) => line.includes('stalled'))).toBe(false)
  })

  it('shouldAbandonAStalledTickAndStartTheNextOne', async () => {
    const first = deferred()
    const second = deferred()
    const logs: string[] = []
    let now = 1_000_000
    let runs = 0
    const runner = createAutomationTickRunner({
      runTick: () => {
        runs += 1
        return runs === 1 ? first.promise : second.promise
      },
      logDebug: (message) => logs.push(message),
      now: () => now,
      stalledAfterMs: 600_000,
    })

    runner.trigger()
    await settle()
    now += 600_000
    runner.trigger()
    await settle()

    expect(runs).toBe(2)
    expect(logs.some((line) => line.includes('stalled for 600s'))).toBe(true)

    // 버려진 tick 이 나중에 끝나도 지금 도는 tick 의 가드를 풀면 안 된다.
    first.resolve()
    await settle()
    expect(runner.isRunning()).toBe(true)

    second.resolve()
    await settle()
    expect(runner.isRunning()).toBe(false)
  })
})
