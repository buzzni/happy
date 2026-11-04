import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { AutomationPayload } from '@slopus/happy-wire'
import { ApiClient } from '@/api/api'
import { decodeBase64, decrypt } from '@/api/encryption'
import type { Session } from '@/api/types'
import { OwnedStartRefused } from '../ownedSpawn'
import { FileLockHeldError } from '@/utils/ownedFileLock'
import { createAutomationContextLaunchJournal } from './automationContextLaunchJournal'
import { createAutomationContextLauncher, type AutomationContextLaunchDependencies, type AutomationContextLaunchRequest } from './automationContextLaunch'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'automation-context-launch-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })
function request(runId = 'r1'): AutomationContextLaunchRequest {
  const payload: AutomationPayload = { name: 'Task', prompt: 'Current occurrence only', directory: '/work',
    agent: 'codex', scriptCommand: null, suppressSilent: false, schedule: { kind: 'interval', minutes: 60 },
    conversation: { sessionId: 'manual' }, contextPolicy: { kind: 'isolated', reference: null } }
  return { automationId: 'a1', generation: 1, revision: 1, runId, payload }
}
async function setup() {
  const api = await ApiClient.create({ token: 'fixture-bearer', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } })
  const prepare = vi.spyOn(api, 'prepareSessionCreation')
  const sessions = new Map<string, Session>()
  const register = vi.fn<AutomationContextLaunchDependencies['register']>(async (_request, snapshot) => {
    const id = snapshot.body.tag
    if (!sessions.has(id)) sessions.set(id, { id, seq: 0, metadataVersion: 0, agentStateVersion: 0,
      encryptionKey: decodeBase64(snapshot.encryptionKey), encryptionVariant: snapshot.encryptionVariant,
      metadata: decrypt(decodeBase64(snapshot.encryptionKey), snapshot.encryptionVariant, decodeBase64(snapshot.body.metadata)) as Session['metadata'],
      agentState: { controlledByUser: false } })
    return sessions.get(id)!
  })
  const start = vi.fn<AutomationContextLaunchDependencies['start']>(async options => ({ type: 'success', sessionId: options.reconnectEnvironment!.HAPPY_RECONNECT_SESSION_ID }))
  const discover = vi.fn<AutomationContextLaunchDependencies['discover']>(async () => 'unconfirmed')
  const deps: AutomationContextLaunchDependencies = { accountId: 'owner', machineId: 'm1', happyOrigin: 'https://happy.example',
    api, journal: createAutomationContextLaunchJournal(home), register, start, discover }
  return { deps, prepare, register, start, discover, sessions, launcher: createAutomationContextLauncher(deps) }
}

it('prepares two fresh contexts for the same display chat with no native resume or copied input state', async () => {
  const f = await setup()
  for (const agent of ['claude', 'codex'] as const) {
    const input = request(agent)
    input.payload.agent = agent
    expect(await f.launcher.launch(input)).toMatchObject({ state: 'started', sessionId: `automation-run:${agent}`, displaySessionId: 'manual' })
  }
  expect(f.start).toHaveBeenCalledTimes(2)
  for (const [options] of f.start.mock.calls) {
    expect(options.exitAfterFirstTurn).toBe(true)
    expect(options.initialPrompt).toContain('Current occurrence only')
    expect(options.reconnectEnvironment).toMatchObject({ HAPPY_RECONNECT_FRESH_LAUNCH: '1' })
    const session = f.sessions.get(options.reconnectEnvironment!.HAPPY_RECONNECT_SESSION_ID)!
    expect(session.metadata).toMatchObject({ path: '/work', source: 'schedule', machineId: 'm1' })
    expect(session.metadata).toHaveProperty('automationExecutionSeed', {
      version: 1, automationId: 'a1', runId: options.agent, generation: 1, revision: 1, displaySessionId: 'manual',
      question: 'Current occurrence only', inputBytes: Buffer.byteLength(options.initialPrompt!, 'utf8'),
      referenceBytes: 0, references: [], inputSha256: createHash('sha256').update(options.initialPrompt!).digest('hex'),
      wholeContextTokens: 'unknown',
    })
    expect(session.metadata).not.toHaveProperty('claudeSessionId')
    expect(session.metadata).not.toHaveProperty('codexThreadId')
    expect(session.metadata).not.toHaveProperty('parentSessionId')
    expect(session.agentState).toEqual({ controlledByUser: false })
  }
})

it('persists exact encrypted preparation before registration and reuses it after a lost registration ACK', async () => {
  const f = await setup(), commit = f.register.getMockImplementation()!
  f.register.mockImplementationOnce(async (input, snapshot) => {
    expect(await f.deps.journal.read(input.runId)).toMatchObject({ phase: 'prepared', prepared: snapshot })
    await commit(input, snapshot); throw new Error('lost-registration-ACK')
  })
  await expect(f.launcher.launch(request())).rejects.toThrow('lost-registration-ACK')
  expect(f.start).not.toHaveBeenCalled()
  const restarted = createAutomationContextLauncher({ ...f.deps, journal: createAutomationContextLaunchJournal(home) })
  expect(await restarted.launch(request())).toMatchObject({ state: 'started' })
  expect(f.prepare).toHaveBeenCalledTimes(1)
  expect(f.register.mock.calls[1]![1]).toEqual(f.register.mock.calls[0]![1])
  expect(f.start).toHaveBeenCalledTimes(1)
})

it('reconciles a lost provider-start ACK after restart without launching a second process', async () => {
  const f = await setup()
  f.start.mockImplementationOnce(async () => {
    expect(await f.deps.journal.read('r1')).toMatchObject({ phase: 'submitted' })
    throw new Error('lost-provider-ACK')
  })
  await expect(f.launcher.launch(request())).rejects.toThrow('lost-provider-ACK')
  f.discover.mockResolvedValue('running')
  expect(await createAutomationContextLauncher(f.deps).launch(request())).toMatchObject({ state: 'started' })
  expect(f.start).toHaveBeenCalledTimes(1)
  expect(f.discover).toHaveBeenCalledWith('automation-run:r1')
})

it('keeps an unknown start pending instead of guessing that absence means it never started', async () => {
  const f = await setup()
  f.start.mockRejectedValueOnce(new Error('transport unavailable'))
  await expect(f.launcher.launch(request())).rejects.toThrow('transport unavailable')
  expect(await createAutomationContextLauncher(f.deps).launch(request()))
    .toEqual({ state: 'needs-attention', sessionId: 'automation-run:r1', displaySessionId: 'manual' })
  expect(f.start).toHaveBeenCalledTimes(1)
  expect((await f.deps.journal.read('r1'))!.phase).toBe('submitted')
})

it('only retries a start that the trusted dispatch guard proves was refused before submission', async () => {
  const f = await setup()
  f.start.mockRejectedValueOnce(new OwnedStartRefused('daemon-restarting'))
  await expect(f.launcher.launch(request())).rejects.toThrow()
  expect((await f.deps.journal.read('r1'))!.phase).toBe('registered')
  expect(await f.launcher.launch(request())).toMatchObject({ state: 'started' })
  expect(f.prepare).toHaveBeenCalledTimes(1)
  expect(f.start).toHaveBeenCalledTimes(2)
})

it.each(['request', 'account', 'machine', 'origin'])(
  'does not reinterpret an existing launch under changed %s authority or input', async change => {
    const f = await setup()
    await f.launcher.launch(request())
    const input = request(), deps = { ...f.deps }
    if (change === 'request') input.payload.prompt = 'another instruction'
    if (change === 'account') deps.accountId = 'other'
    if (change === 'machine') deps.machineId = 'm2'
    if (change === 'origin') deps.happyOrigin = 'https://other.example'
    await expect(createAutomationContextLauncher(deps).launch(input)).rejects.toThrow('AUTOMATION_LAUNCH_IDENTITY_CONFLICT')
    expect(f.start).toHaveBeenCalledTimes(1)
  })

it('serializes two coordinators through the shared process-owned file lock', async () => {
  const f = await setup()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  f.start.mockImplementationOnce(async options => { entered(); await held; return { type: 'success', sessionId: options.reconnectEnvironment!.HAPPY_RECONNECT_SESSION_ID } })
  const first = f.launcher.launch(request())
  await Promise.race([started, first])
  try {
    await expect(createAutomationContextLauncher({ ...f.deps, journal: createAutomationContextLaunchJournal(home) }).launch(request())).rejects.toBeInstanceOf(FileLockHeldError)
  } finally { release() }
  await first
  expect(f.start).toHaveBeenCalledTimes(1)
})

it('keeps private key material on a private journal and refuses corruption without a new launch', async () => {
  const f = await setup()
  const result = await f.launcher.launch(request())
  const directory = join(home, 'automation-context-launches.v1')
  const name = (await readdir(directory)).find(file => file.endsWith('.json'))!
  const file = join(directory, name)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(JSON.stringify(result)).not.toContain('encryptionKey')
  expect(await readFile(file, 'utf8')).toContain('encryptionKey')
  await writeFile(file, '{invalid', { mode: 0o600 })
  await expect(createAutomationContextLauncher(f.deps).launch(request())).rejects.toThrow()
  expect(f.prepare).toHaveBeenCalledTimes(1)
  expect(f.start).toHaveBeenCalledTimes(1)
})
