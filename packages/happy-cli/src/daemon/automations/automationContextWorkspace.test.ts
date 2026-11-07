import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAutomationContextWorkspace } from './automationContextWorkspace'

const test = it.skipIf(process.platform === 'win32')
let home: string, directory: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'context-workspace-')); directory = join(home, 'workspace'); await mkdir(directory) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })
const finished = { providerExitedCleanly: true, foregroundDrained: true, backgroundDrained: true, writeProducersDrained: true } as const
const setup = (isTracked = vi.fn(async (_roots: readonly string[]) => false as boolean | 'unconfirmed')) =>
  createAutomationContextWorkspace({ home, isTracked })

test('defers an automatic run for an existing live or unconfirmed manual process without changing the manual process', async () => {
  for (const status of [true, 'unconfirmed'] as const) {
    const isTracked = vi.fn(async () => status)
    expect(await setup(isTracked).acquireAutomation({ runId: 'r1', roots: [directory] })).toEqual({ acquired: false, reason: 'tracked-session-busy' })
    expect(isTracked).toHaveBeenCalledTimes(1)
  }
})

test('rechecks tracked processes after acquiring the lock so a manual launch cannot slip between checking and starting', async () => {
  const isTracked = vi.fn(async () => false as boolean | 'unconfirmed').mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  expect(await setup(isTracked).acquireAutomation({ runId: 'r1', roots: [directory] })).toEqual({ acquired: false, reason: 'tracked-session-busy' })
  const manual = await setup().beginManualLaunch([directory])
  expect(manual.acquired).toBe(true)
  if (manual.acquired) expect(await manual.finish({ submitted: false, tracked: false })).toBe(true)
})

test('holds new manual launches until the owned automatic provider, background and producers all have positive exit evidence', async () => {
  const workspace = setup(), automatic = await workspace.acquireAutomation({ runId: 'r1', roots: [directory] })
  expect(automatic.acquired).toBe(true)
  if (!automatic.acquired) throw new Error('Expected workspace ownership')
  expect(await workspace.beginManualLaunch([directory])).toMatchObject({ acquired: false })
  for (const field of Object.keys(finished) as Array<keyof typeof finished>) {
    expect(await automatic.releaseAfterObservedExit({ ...finished, [field]: false })).toBe(false)
    expect(await workspace.beginManualLaunch([directory])).toMatchObject({ acquired: false })
  }
  expect(await automatic.releaseAfterObservedExit(finished)).toBe(true)
  expect(await workspace.beginManualLaunch([directory])).toMatchObject({ acquired: true })
})

test('holds automatic admission through manual tracking until a positive runtime drain is supplied', async () => {
  const workspace = setup(), manual = await workspace.beginManualLaunch([directory])
  if (!manual.acquired) throw new Error('Expected preparation reservation')
  expect(await workspace.acquireAutomation({ runId: 'r1', roots: [directory] })).toMatchObject({ acquired: false })
  expect(await manual.finish({ submitted: true, tracked: false })).toBe(false)
  expect(await setup().acquireAutomation({ runId: 'r2', roots: [directory] })).toMatchObject({ acquired: false })
  // Uncertainty must only hold automation; the previous manual/manual behavior is preserved.
  expect(await workspace.beginManualLaunch([directory])).toMatchObject({ acquired: true })
  expect(await manual.finish({ submitted: true, tracked: true }, finished)).toBe(true)
})

test('retains manual ownership while a tracked process still owns the directory', async () => {
  let tracked = false
  const workspace = setup(vi.fn(async () => tracked)), manual = await workspace.beginManualLaunch([directory])
  if (!manual.acquired) throw new Error('Expected preparation reservation')
  tracked = true
  expect(await manual.finish({ submitted: true, tracked: true })).toBe(false)
  expect(await workspace.acquireAutomation({ runId: 'r1', roots: [directory] })).toEqual({ acquired: false, reason: 'tracked-session-busy' })
})

test('retains submitted manual custody after root tracking disappears and a coordinator restarts without positive drain evidence', async () => {
  let tracked = true
  const workspace = setup(vi.fn(async () => tracked)), manual = await workspace.beginManualLaunch([directory])
  if (!manual.acquired) throw new Error('Expected manual ownership')
  expect(await manual.finish({ submitted: true, tracked: true })).toBe(false)
  tracked = false
  expect(await workspace.acquireAutomation({ runId: 'r1', roots: [directory] })).toMatchObject({ acquired: false })
  expect(await setup().acquireAutomation({ runId: 'r2', roots: [directory] })).toMatchObject({ acquired: false })
  const otherManual = await setup().beginManualLaunch([directory])
  expect(otherManual.acquired).toBe(true)
  if (otherManual.acquired) expect(await otherManual.finish({ submitted: false, tracked: false })).toBe(true)
})

test('releases a submitted manual owner only with tracking and all positive drain evidence', async () => {
  const workspace = setup(), manual = await workspace.beginManualLaunch([directory])
  if (!manual.acquired) throw new Error('Expected manual ownership')
  expect(await manual.finish({ submitted: true, tracked: false }, finished)).toBe(false)
  for (const field of Object.keys(finished) as Array<keyof typeof finished>) {
    expect(await manual.finish({ submitted: true, tracked: true }, { ...finished, [field]: false })).toBe(false)
    expect(await setup().acquireAutomation({ runId: 'r1', roots: [directory] })).toMatchObject({ acquired: false })
  }
  expect(await manual.finish({ submitted: true, tracked: true }, finished)).toBe(true)
  expect(await setup().acquireAutomation({ runId: 'r1', roots: [directory] })).toMatchObject({ acquired: true })
})

test('keeps an unknown automatic owner across coordinator restart and permits an unrelated workspace', async () => {
  const workspace = setup()
  expect(await workspace.acquireAutomation({ runId: 'r1', roots: [directory] })).toMatchObject({ acquired: true })
  expect(await setup().beginManualLaunch([directory])).toMatchObject({ acquired: false })
  const other = join(home, 'other'); await mkdir(other)
  expect(await setup().beginManualLaunch([other])).toMatchObject({ acquired: true })
})

test('releases the original saved automatic ownership after restart only with all positive exit evidence', async () => {
  const ownerToken = '62a6d741-550e-465e-b4df-876619327418'
  expect(await setup().acquireAutomation({ runId: 'r1', roots: [directory], ownerToken })).toMatchObject({ acquired: true })
  const restarted = setup()
  for (const field of Object.keys(finished) as Array<keyof typeof finished>) {
    expect(await restarted.recoverAutomationExit({ runId: 'r1', roots: [directory], ownerToken, evidence: { ...finished, [field]: false } })).toBe(false)
    expect(await restarted.beginManualLaunch([directory])).toMatchObject({ acquired: false })
  }
  expect(await restarted.recoverAutomationExit({ runId: 'r1', roots: [directory], ownerToken, evidence: finished })).toBe(true)
  expect(await restarted.beginManualLaunch([directory])).toMatchObject({ acquired: true })
})
