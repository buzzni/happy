import { describe, expect, it } from 'vitest'

import { MachineRotationError } from '../machineSetupTokenProtocol'
import { createAutomationContextAccount } from './automationContextAccount'

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

  it('asks the server only until it has the account', async () => {
    let calls = 0
    const account = createAutomationContextAccount({ lookup: async () => { calls++; return 'account-1' }, log: () => {} })

    await account.get()
    await account.get()
    expect(calls).toBe(1)
  })
})
