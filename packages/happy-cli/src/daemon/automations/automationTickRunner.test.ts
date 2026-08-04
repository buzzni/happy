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
})
