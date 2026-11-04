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

test('holds automatic admission while a manual spawn is pending and transfers it only after tracking or proven non-submission', async () => {
  const workspace = setup(), manual = await workspace.beginManualLaunch([directory])
  if (!manual.acquired) throw new Error('Expected preparation reservation')
  expect(await workspace.acquireAutomation({ runId: 'r1', roots: [directory] })).toMatchObject({ acquired: false })
  expect(await manual.finish({ submitted: true, tracked: false })).toBe(false)
  expect(await setup().acquireAutomation({ runId: 'r2', roots: [directory] })).toMatchObject({ acquired: false })
  // Uncertainty must only hold automation; the previous manual/manual behavior is preserved.
  expect(await workspace.beginManualLaunch([directory])).toMatchObject({ acquired: true })
  expect(await manual.finish({ submitted: true, tracked: true })).toBe(true)
})

test('hands a tracked manual session to the directory gate rather than treating the released preparation as idle', async () => {
  let tracked = false
  const workspace = setup(vi.fn(async () => tracked)), manual = await workspace.beginManualLaunch([directory])
  if (!manual.acquired) throw new Error('Expected preparation reservation')
  tracked = true
  expect(await manual.finish({ submitted: true, tracked: true })).toBe(true)
  expect(await workspace.acquireAutomation({ runId: 'r1', roots: [directory] })).toEqual({ acquired: false, reason: 'tracked-session-busy' })
})

test('keeps an unknown automatic owner across coordinator restart and permits an unrelated workspace', async () => {
  const workspace = setup()
  expect(await workspace.acquireAutomation({ runId: 'r1', roots: [directory] })).toMatchObject({ acquired: true })
  expect(await setup().beginManualLaunch([directory])).toMatchObject({ acquired: false })
  const other = join(home, 'other'); await mkdir(other)
  expect(await setup().beginManualLaunch([other])).toMatchObject({ acquired: true })
})
