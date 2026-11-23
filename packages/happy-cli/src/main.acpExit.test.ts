import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  runAcp: vi.fn(),
  order: [] as string[],
  providerImports: [] as string[],
  commandImports: [] as string[],
  connectCommand: vi.fn(),
}))

// Exercise the real CLI dispatch for `happy acp`, but never start a daemon or an agent.
vi.mock('@/claude/runClaude', () => { mocks.providerImports.push('claude'); return {} })
vi.mock('@/codex/runCodex', () => { mocks.providerImports.push('codex'); return {} })
vi.mock('@/api/apiMachine', () => { mocks.commandImports.push('machine RPC'); return { ApiMachineClient: vi.fn() } })
vi.mock('./commands/browser', () => { mocks.commandImports.push('browser'); return { handleBrowserCommand: vi.fn() } })
vi.mock('./commands/device', () => { mocks.commandImports.push('device'); return { handleDeviceCommand: vi.fn() } })
vi.mock('./daemon/install', () => { mocks.commandImports.push('install'); return { install: vi.fn() } })
vi.mock('./commands/connect', () => { mocks.commandImports.push('connect'); return { handleConnectCommand: mocks.connectCommand } })
vi.mock('@/resume/handleResumeCommand', () => { mocks.commandImports.push('resume'); return { handleResumeCommand: vi.fn() } })
vi.mock('./ui/auth', () => ({ authAndSetupMachineIfNeeded: async () => ({ credentials: { token: 'token' } }) }))
vi.mock('./daemon/ensureDaemonRunning', () => ({ ensureDaemonRunning: async () => undefined }))
vi.mock('@/agent/acp', async () => {
  const actual = await vi.importActual<typeof import('@/agent/acp')>('@/agent/acp')
  return { ...actual, runAcp: mocks.runAcp }
})

const originalArgv = process.argv
let testDirectory: string
beforeEach(() => {
  vi.resetModules()
  mocks.order.length = 0
  mocks.providerImports.length = 0
  mocks.commandImports.length = 0
  testDirectory = mkdtempSync(join(tmpdir(), 'happy-acp-exit-'))
  vi.stubEnv('HAPPY_HOME_DIR', join(testDirectory, 'home'))
  mocks.runAcp.mockImplementation(async () => { mocks.order.push('runAcp-finished') })
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => {
  process.argv = originalArgv
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(testDirectory, { recursive: true, force: true })
})

it('can load the CLI without dispatching a command before a draft is sent', async () => {
  process.argv = ['node', 'happy', '--version']
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  await import('./main')
  expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('happy version:'))
  expect(exit).not.toHaveBeenCalled()
  expect(mocks.providerImports).toEqual([])
  expect(mocks.commandImports).toEqual([])
}, 90_000)

it('loads the account connection command on demand and forwards its arguments', async () => {
  process.argv = ['node', 'happy', 'connect', '--help']
  await (await import('./main')).runHappyCli()
  expect(mocks.connectCommand).toHaveBeenCalledWith(['--help'])
}, 90_000)

it('leaves the process as soon as an ACP runner has closed its session', async () => {
  const exited = new Promise<void>(resolve => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      mocks.order.push(`exit ${code}`)
      resolve()
    }) as never)
  })
  process.argv = ['node', 'happy', 'acp', 'opencode']
  await (await import('./main')).runHappyCli()
  await exited
  expect(mocks.order).toEqual(['runAcp-finished', 'exit 0'])
  expect(mocks.runAcp).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'opencode' }))
}, 90_000)
