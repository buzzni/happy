import { describe, expect, it, vi } from 'vitest'

import { MachineRotationError } from '../machineSetupTokenProtocol'
import { AccountProfileUnavailableError, createAutomationContextAccount, createLateAutomationContext } from './automationContextAccount'
import { prepareAutomationContextTick } from './automationContextHost'

/** What Node's fetch throws when DNS is not up yet (seen right after a wake from sleep). */
const offline = () => new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND saycode.ai'), { code: 'ENOTFOUND' }) })

describe('createAutomationContextAccount', () => {
  it('answers null while the server is unreachable and the account once it answers', async () => {
    const answers: Array<() => Promise<string>> = [() => Promise.reject(offline()), () => Promise.resolve('account-1')]
    const logs: string[] = []
    const account = createAutomationContextAccount({ lookup: () => answers.shift()!(), log: message => logs.push(message) })

    await expect(account.get()).resolves.toBeNull()
    await expect(account.get()).resolves.toBe('account-1')
    expect(logs).toHaveLength(1)
  })

  it('treats a lookup timeout as unreachable', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    const account = createAutomationContextAccount({ lookup: () => Promise.reject(timeout), log: () => {} })

    await expect(account.get()).resolves.toBeNull()
  })

  it('reports an unreachable server once, not on every retry', async () => {
    const logs: string[] = []
    const account = createAutomationContextAccount({ lookup: () => Promise.reject(offline()), log: message => logs.push(message) })

    await account.get()
    await account.get()
    await account.get()
    expect(logs).toHaveLength(1)
  })

  it('keeps a rejected credential fatal instead of waiting it out', async () => {
    const account = createAutomationContextAccount({ lookup: () => Promise.reject(new MachineRotationError('FORBIDDEN')), log: () => {} })

    await expect(account.get()).rejects.toBeInstanceOf(MachineRotationError)
  })

  it('treats a server that is up but not ready as unreachable (5xx, captive portal page, refused redirect)', async () => {
    const shapes = [
      new AccountProfileUnavailableError('HTTP 503'),
      new AccountProfileUnavailableError('response is not JSON'),
      new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
    ]
    for (const error of shapes) {
      const account = createAutomationContextAccount({ lookup: () => Promise.reject(error), log: () => {} })
      await expect(account.get()).resolves.toBeNull()
    }
  })

  it('asks the server only until it has the account', async () => {
    let calls = 0
    const account = createAutomationContextAccount({ lookup: async () => { calls++; return 'account-1' }, log: () => {} })

    await account.get()
    await account.get()
    expect(calls).toBe(1)
  })
})

describe('createLateAutomationContext', () => {
  const fixture = (answers: Array<() => Promise<string | null>>) => {
    const builds: string[] = []
    const logs: string[] = []
    const worker = { ready: vi.fn(async () => {}), maintain: vi.fn(async () => {}) }
    const host = { maintain: vi.fn(async () => {}), dispatch: vi.fn() }
    const late = createLateAutomationContext({
      accountId: () => answers.length > 1 ? answers.shift()!() : answers[0](),
      build: accountId => { builds.push(accountId); return { host, worker } },
      log: message => logs.push(message),
    })
    return { late, builds, logs, worker, host }
  }
  const admission = async (late: ReturnType<typeof fixture>['late']) =>
    (await prepareAutomationContextTick(late.host(), new AbortController().signal, () => {}, late.worker())).isolatedContextReady

  it('opens isolated admission only after a later tick learns the account (offline start → failing tick → answering tick)', async () => {
    const { late, builds, worker } = fixture([async () => null, async () => null, async () => 'account-1'])

    await late.establish()
    expect(late.host()).toBeNull()
    expect(await admission(late)).toBe(false)

    await late.retry()
    expect(await admission(late)).toBe(false)
    expect(late.worker()).toBeNull()

    await late.retry()
    expect(builds).toEqual(['account-1'])
    expect(await admission(late)).toBe(true)
    // The question runner, wired before the worker existed, now reaches it.
    expect(late.worker()).not.toBeNull()
    await late.questions.ready()
    expect(worker.ready).toHaveBeenCalled()

    await late.retry()
    expect(builds).toEqual(['account-1'])
  })

  it('lets a refusal fail the start but only reports it once per message on ticks', async () => {
    const refusal = () => Promise.reject(new MachineRotationError('FORBIDDEN'))
    const { late, logs } = fixture([refusal])

    await expect(late.establish()).rejects.toBeInstanceOf(MachineRotationError)
    await late.retry()
    await late.retry()
    expect(logs).toEqual(['[automation-context] Account lookup failed: Machine setup-token rotation: FORBIDDEN'])
    expect(late.host()).toBeNull()
  })

  it('builds once when a tick is abandoned while its lookup is still pending', async () => {
    let answer!: (value: string) => void
    const { late, builds } = fixture([() => new Promise(resolve => { answer = resolve })])

    const first = late.retry()
    const second = late.retry()
    answer('account-1')
    await Promise.all([first, second])
    expect(builds).toEqual(['account-1'])
  })
})
