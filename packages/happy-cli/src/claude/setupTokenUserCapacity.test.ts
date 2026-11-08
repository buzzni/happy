import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createSetupTokenCapacityRuntime } from './setupTokenUserCapacity'
const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
const actor = { companyId: 'co', machineId: 'pc', sessionId: 's', requestId: 'r', contentHash: 'a'.repeat(64), proof: 'signed.proof' }
it('continues a known failed result under the original actor and a distinct attempt, without reopening an uncertain delivery', async () => {
  const request = vi.fn(async (operation: string, _actor: unknown, _runtime: string, extra?: Record<string, unknown>) => operation === 'reserve'
    ? { state: 'reserved', managedAccountId: 'a', credentialGeneration: 1, epoch: 1, validForMs: 15000 }
    : { state: operation === 'claim' ? 'claimed' : operation === 'finish' ? 'finished' : String(extra?.deliveryState) })
  const runtime = createSetupTokenCapacityRuntime({ directory: await directory(), request, notify: () => {}, move: async () => false })
  await runtime.admit(actor, new AbortController().signal)
  await expect(runtime.retry(actor)).rejects.toThrow('CAPACITY_RETRY_UNCONFIRMED')
  await runtime.result({ type: 'result', subtype: 'error_during_execution', is_error: true }, false)
  await runtime.retry(actor)
  expect(await runtime.admit(actor, new AbortController().signal)).toEqual({ state: 'admitted' })
  expect(request.mock.calls.filter(call => call[0] === 'claim').map(call => call[3]?.attempt)).toEqual([0, 1])
})
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'capacity-runtime-')); directories.push(dir); return dir }
it('refuses an unacknowledged claim instead of treating any JSON response as permission', async () => {
  const request = vi.fn(async (operation: string) => operation === 'reserve' ? { state: 'reserved', managedAccountId: 'a', credentialGeneration: 1, epoch: 1, validForMs: 15000 } : { state: 'wait' })
  const runtime = createSetupTokenCapacityRuntime({ directory: await directory(), request, notify: () => {}, move: async () => false })
  await expect(runtime.admit(actor, new AbortController().signal)).rejects.toThrow('CAPACITY_CLAIM_UNCONFIRMED')
  expect(request.mock.calls.map(call => call[0])).toEqual(['reserve', 'claim', 'lost'])
})
it('claims before dispatch, preserves the input identity through waiting and cancels unstarted work', async () => {
  const operations: string[] = []
  const request = vi.fn(async (operation: string) => { operations.push(operation); return operation === 'reserve' ? { state: 'reserved', managedAccountId: 'a', credentialGeneration: 1, epoch: 1, validForMs: 15000 } : { state: operation === 'claim' ? 'claimed' : 'attempting' } })
  const runtime = createSetupTokenCapacityRuntime({ directory: await directory(), request, notify: () => {}, move: async () => false })
  expect(await runtime.admit(actor, new AbortController().signal)).toEqual({ state: 'admitted' })
  expect(operations).toEqual(['reserve', 'claim', 'delivery'])
  const aborted = new AbortController(); aborted.abort()
  await expect(runtime.admit({ ...actor, requestId: 'cancelled' }, aborted.signal)).rejects.toThrow()
  expect(operations).toEqual(['reserve', 'claim', 'delivery'])
})
it('never redispatches after a lost claim response and restores a durably cached result without another claim', async () => {
  const dir = await directory()
  const request = vi.fn(async (operation: string) => {
    if (operation === 'reserve') return { state: 'reserved', managedAccountId: 'a', credentialGeneration: 1, epoch: 1, validForMs: 15000 }
    if (operation === 'claim') throw new Error('lost response')
    return { state: 'delivery_unknown' }
  })
  const deps = { directory: dir, request, notify: () => {}, move: async () => false }
  await expect(createSetupTokenCapacityRuntime(deps).admit(actor, new AbortController().signal)).rejects.toThrow('lost response')
  request.mockClear()
  await expect(createSetupTokenCapacityRuntime(deps).admit(actor, new AbortController().signal)).rejects.toThrow('CAPACITY_DELIVERY_UNKNOWN')
  expect(request.mock.calls.map(call => call[0])).toEqual(['lost', 'recover'])
  const fresh = { ...actor, requestId: 'finished' }
  request.mockImplementation(async operation => operation === 'reserve' ? { state: 'reserved', managedAccountId: 'a', credentialGeneration: 1, epoch: 1, validForMs: 15000 } : { state: operation === 'claim' ? 'claimed' : operation === 'finish' ? 'finished' : 'attempting' })
  const runtime = createSetupTokenCapacityRuntime(deps)
  await runtime.admit(fresh, new AbortController().signal)
  const result = { type: 'result', subtype: 'success', result: 'cached answer' }
  await runtime.result(result, true)
  request.mockClear()
  expect(await createSetupTokenCapacityRuntime(deps).admit(fresh, new AbortController().signal)).toEqual({ state: 'result', result })
  expect(request.mock.calls.every(call => call[0] === 'lost')).toBe(true)
})
it('does not release provider background work on result and releases it on authoritative provider exit', async () => {
  const operations: string[] = []
  const runtime = createSetupTokenCapacityRuntime({ directory: await directory(), notify: () => {}, move: async () => false,
    request: async operation => { operations.push(operation); return operation === 'reserve' ? { state: 'reserved', managedAccountId: 'a', credentialGeneration: 1, epoch: 1, validForMs: 15000 } : { state: operation === 'claim' ? 'claimed' : operation === 'finish' ? 'finished' : 'attempting' } } })
  await runtime.admit(actor, new AbortController().signal)
  await runtime.result({ result: 'done' }, true)
  expect(operations).not.toContain('finish')
  await runtime.providerStopped(true)
  expect(operations.at(-1)).toBe('finish')
})
it('restores a result cached just before a journal crash without submitting the input again', async () => {
  const dir = await directory()
  const request = vi.fn(async (operation: string, _actor: unknown, _runtime: string, extra?: Record<string, unknown>) => operation === 'reserve'
    ? { state: 'reserved', managedAccountId: 'a', credentialGeneration: 1, epoch: 1, validForMs: 15000 }
    : { state: operation === 'claim' ? 'claimed' : operation === 'finish' ? 'finished' : String(extra?.deliveryState) })
  const deps = { directory: dir, request, notify: () => {}, move: async () => false }
  const runtime = createSetupTokenCapacityRuntime(deps)
  await runtime.admit(actor, new AbortController().signal)
  await runtime.result({ type: 'result', subtype: 'success', result: 'durable answer' }, false)
  const name = (await readdir(dir)).find(name => /^[a-f0-9]{64}\.json$/.test(name))!
  const entry = JSON.parse(await readFile(join(dir, name), 'utf8'))
  entry.phase = 'attempting'; delete entry.result
  await writeFile(join(dir, name), JSON.stringify(entry))
  request.mockClear()
  expect(await createSetupTokenCapacityRuntime(deps).admit(actor, new AbortController().signal)).toMatchObject({ state: 'result', result: { result: 'durable answer' } })
  expect(request.mock.calls.every(call => call[0] === 'lost')).toBe(true)
})
