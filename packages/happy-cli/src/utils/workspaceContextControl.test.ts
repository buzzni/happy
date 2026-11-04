import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeProducerGate } from '@/sessionDrain/runtimeProducerGate'
import { createWorkspaceContextControl, observeWorkspaceContextChild } from './workspaceContextControl'

vi.mock('@/ui/logger', () => ({ logger: { warn: vi.fn() } }))
afterEach(() => vi.useRealTimers())
const evidence = () => ({ foregroundDrained: true, backgroundDrained: true, providerExitedCleanly: true, writeProducersDrained: true })
const launchId = 'owned-manual-launch'

function fixture() {
  const child = Object.assign(new EventEmitter(), { connected: true, killed: false, exitCode: null as number | null, signalCode: null as string | null,
    send: vi.fn((value: unknown, done: (error: Error | null) => void) => { queueMicrotask(() => { incoming.emit('message', value); done(null) }); return true }) })
  const incoming = Object.assign(new EventEmitter(), { connected: true,
    send: vi.fn((value: unknown, done: (error: Error | null) => void) => { queueMicrotask(() => { child.emit('message', value); done(null) }); return true }) })
  let queued = false, frozen = false
  const runtime = new RuntimeProducerGate({ hasUndeliveredInput: () => queued, canFreezeInbound: () => true,
    freezeInbound: () => true, stopLoop: () => queueMicrotask(() => runtime.loopExited()) })
  const provider = { freezeInputForShutdown: vi.fn(() => { frozen = true; return true }), interruptTurn: vi.fn(async () => {}),
    endInputAndAwaitExit: vi.fn(async () => ({ exited: true, code: 0, signal: null })), waitForOutputDrain: vi.fn(async () => {}),
    cancelOutputDrain: vi.fn(), finishShutdownObservation: vi.fn() }
  const proof = { stored: true as const, revision: 1 }
  const storage = { tracksShutdownStorage: true, flushForShutdown: vi.fn(async () => proof), isStorageConfirmationCurrent: vi.fn(() => true) }
  const prepare = vi.fn(async () => true), persist = vi.fn(async () => {})
  const parent = observeWorkspaceContextChild({ child: child as unknown as ChildProcess, launchId, persist })
  const control = createWorkspaceContextControl({ launchId, transport: incoming })
  control.bind({ provider, storage, runtime, prepareWorkspaceDrain: prepare })
  const close = async (flags = evidence(), code = 0) => {
    await control.reportExit(flags); control.close()
    child.exitCode = code; child.emit('close', code, null)
  }
  return { child, incoming, parent, control, prepare, provider, persist, storage, runtime, close,
    queue: () => { queued = true }, frozen: () => frozen }
}

it('joins the existing provider/storage release protocol and requires an owned clean close before releasing workspace custody', async () => {
  const f = fixture(), controller = new AbortController()
  await vi.waitFor(() => expect(f.child.listenerCount('message')).toBeGreaterThan(0))
  const operation = f.parent.drain(controller.signal, 1000)
  await vi.waitFor(() => expect(f.runtime.isFrozen()).toBe(true))
  await vi.waitFor(() => expect(f.runtime.isShutdownBlocked()).toBe(false))
  expect(f.persist).not.toHaveBeenCalled()
  await f.close()
  expect(await operation).toBe(true); expect(await f.parent.closed).toBe(true)
  expect(f.persist).toHaveBeenCalledOnce()
  expect(f.provider.endInputAndAwaitExit).toHaveBeenCalledOnce()
})

it.each(['background', 'queued-before', 'queued-during', 'preflight-rejected'] as const)(
  'refuses manual shutdown without changing input when %s', async state => {
    const f = fixture()
    if (state === 'queued-before') f.queue()
    f.prepare.mockImplementation(async () => {
      if (state === 'queued-during') f.queue()
      if (state === 'preflight-rejected') throw new Error('PRIVATE_MATERIAL_MUST_NOT_BE_LOGGED')
      return state !== 'background'
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await f.parent.drain(new AbortController().signal, 1000)).toBe(false)
    expect(f.frozen()).toBe(false); expect(f.provider.interruptTurn).not.toHaveBeenCalled()
    expect(f.provider.endInputAndAwaitExit).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled()
    f.control.close(); f.child.emit('close', 1, null)
    expect(await f.parent.closed).toBe(false)
  })

it('does not freeze a manual turn after its preflight loses the parent channel', async () => {
  const f = fixture()
  let release!: () => void
  f.prepare.mockImplementation(() => new Promise(resolve => { release = () => resolve(true) }))
  await new Promise(resolve => setTimeout(resolve, 0))
  const operation = f.parent.drain(new AbortController().signal, 1000)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  f.incoming.connected = false; f.incoming.emit('disconnect'); f.child.connected = false; f.child.emit('disconnect')
  release(); expect(await operation).toBe(false)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.frozen()).toBe(false); expect(f.provider.endInputAndAwaitExit).not.toHaveBeenCalled()
  f.control.close(); f.child.emit('close', 1, null); expect(await f.parent.closed).toBe(false)
})

it.each(['clean', 'missing', 'foreign', 'partial', 'truthy', 'extra', 'killed', 'nonzero', 'persist-failed'] as const)(
  'requires bounded matching evidence and the kernel close, never PID disappearance alone (%s)', async state => {
    const message: any = { type: 'workspace-context-exit', version: 1, launchId, evidence: evidence() }
    if (state === 'foreign') message.launchId = 'another-launch'
    if (state === 'partial') message.evidence.backgroundDrained = false
    if (state === 'truthy') message.evidence.foregroundDrained = 1
    if (state === 'extra') message.prompt = 'private'
    const child = spawn(process.execPath, ['-e', `
      ${state === 'missing' ? '' : `process.send(${JSON.stringify(message)});`}
      process.exitCode = ${state === 'nonzero' ? 1 : 0}; process.disconnect();
    `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    if (state === 'killed') Object.defineProperty(child, 'killed', { value: true })
    const persist = vi.fn(async () => { if (state === 'persist-failed') throw new Error('fsync failed') })
    const parent = observeWorkspaceContextChild({ child, launchId, persist })
    expect(await parent.closed).toBe(state === 'clean')
    expect(persist).toHaveBeenCalledTimes(state === 'clean' || state === 'persist-failed' ? 1 : 0)
  })
