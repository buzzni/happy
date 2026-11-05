import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { chmod, link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readReconnectSessionEnvironment } from '../reconnectSessionEnv'
import { automationExecutionSeedArtifactSchema, type AutomationPayload } from '@slopus/happy-wire'
import { ApiClient } from '@/api/api'
import { decodeBase64, decrypt } from '@/api/encryption'
import type { Session } from '@/api/types'
import { OwnedStartRefused } from '../ownedSpawn'
import { FileLockHeldError } from '@/utils/ownedFileLock'
import { createAutomationContextLaunchJournal } from './automationContextLaunchJournal'
import { createAutomationContextLauncher, type AutomationContextLaunchDependencies, type AutomationContextLaunchRequest } from './automationContextLaunch'
import { createAutomationContextWorkspace } from './automationContextWorkspace'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'automation-context-launch-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })
function request(runId = 'r1'): AutomationContextLaunchRequest {
  const payload: AutomationPayload = { name: 'Task', prompt: 'Current occurrence only', directory: '/work',
    agent: 'codex', scriptCommand: null, suppressSilent: false, schedule: { kind: 'interval', minutes: 60 },
    conversation: { sessionId: 'manual' }, contextPolicy: { kind: 'isolated', reference: null } }
  return { automationId: 'a1', generation: 1, revision: 1, runId, claimToken: 'immutable-private-claim', payload }
}
async function setup() {
  const api = await ApiClient.create({ token: 'fixture-bearer', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } })
  const prepare = vi.spyOn(api, 'prepareSessionCreation')
  const sessions = new Map<string, Session>()
  const seedMessages = new Map<string, { localId: string; content: string }>()
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
  const persistSeed = vi.fn(async (session: Session, message: { localId: string; content: string }) => {
    const previous = seedMessages.get(session.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(message)) throw new Error('seed-conflict')
    seedMessages.set(session.id, structuredClone(message)); session.seq = 1
    return { ...message, seq: 1 }
  })
  const deps: AutomationContextLaunchDependencies = { accountId: 'owner', machineId: 'm1', happyOrigin: 'https://happy.example',
    api, journal: createAutomationContextLaunchJournal(home), register, start, discover, persistSeed }
  return { deps, prepare, register, start, discover, persistSeed, seedMessages, sessions, launcher: createAutomationContextLauncher(deps) }
}

async function workspaceSetup() {
  const f = await setup(), directory = join(home, 'workspace')
  await mkdir(directory)
  const workspace = createAutomationContextWorkspace({ home, isTracked: async () => false })
  f.deps.workspace = workspace
  const input = request(); input.payload.directory = directory
  return { ...f, directory, workspace, input }
}

it('preserves the existing independent preparation request digest when memo snapshots are added', async () => {
  const f = await setup()
  await f.launcher.launch(request())
  // Captured before memo support: adding data for a new mode must not invalidate old preparations.
  expect((await f.deps.journal.read('r1'))!.requestHash).toBe('2bca27ef0808f183b59d5a8d8704f862282df474a1ccc03d16abcc0a2744c84c')
  expect(await f.launcher.restoreRequest('r1')).toEqual(request())
})

it('keeps selected memo data in the E2EE seed, excludes it from creation metadata and ignores unselected prior results on retry', async () => {
  const f = await setup(), input = request()
  const reference = { kind: 'memo' as const, memoId: '9e990bba-e408-4eae-8369-ae73ef31962f', revision: 2,
    title: 'Chosen source', text: 'PRIVATE_MEMO_ONLY', maxBytes: 16384 }
  input.payload.contextPolicy = { kind: 'isolated', reference }
  input.previousResult = { automationId: 'a1', runId: 'prior', revision: 1, status: 'COMPLETED', question: 'Unselected old question', answer: 'PRIVATE_OLD_RESULT' }
  expect(await f.launcher.launch(input)).toHaveProperty('state', 'started')
  expect(f.start.mock.calls[0][0].initialPrompt).toContain(reference.text)
  expect(f.start.mock.calls[0][0].initialPrompt).not.toContain('PRIVATE_OLD_RESULT')
  const session = f.sessions.get('automation-run:r1')!, raw = f.seedMessages.get(session.id)!
  expect(JSON.stringify(session.metadata)).not.toContain(reference.text)
  const seed = automationExecutionSeedArtifactSchema.parse(decrypt(session.encryptionKey, session.encryptionVariant, decodeBase64(raw.content))).seed
  expect(seed).toHaveProperty('referenceSnapshots', [{ kind: 'memo', data: { automationId: 'a1', memoId: reference.memoId,
    revision: 2, title: reference.title, text: reference.text } }])
  expect(await createAutomationContextLauncher(f.deps).launch({ ...input, previousResult: { answer: 'DIFFERENT_UNSELECTED_SOURCE' } })).toHaveProperty('state', 'started')
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
  expect(await f.launcher.restoreRequest('r1')).not.toHaveProperty('previousResult')
})

it('keeps a workspace-busy run unsubmitted and retries its original preparation after manual work releases', async () => {
  const f = await workspaceSetup(), manual = await f.workspace.beginManualLaunch([f.directory])
  if (!manual.acquired) throw new Error('manual preparation refused')
  expect(await f.launcher.launch(f.input)).toMatchObject({ state: 'waiting', reason: 'workspace-busy' })
  expect(f.start).not.toHaveBeenCalled()
  expect(await f.deps.journal.read('r1')).toHaveProperty('phase', 'registered')
  await manual.finish({ submitted: false, tracked: false })
  expect(await f.launcher.launch(f.input)).toHaveProperty('state', 'started')
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
  expect(await f.workspace.beginManualLaunch([f.directory])).toMatchObject({ acquired: false })
})

it.each(['AUTOMATION_AUTHORITY_REVOKED', 'AUTOMATION_CONTEXT_REQUEST_UNCONFIRMED'])('rechecks authority after workspace admission without submitting on %s', async code => {
  const f = await workspaceSetup()
  let authorized = true
  const acquire = f.workspace.acquireAutomation.bind(f.workspace)
  vi.spyOn(f.workspace, 'acquireAutomation').mockImplementationOnce(async input => {
    const result = await acquire(input)
    authorized = false
    return result
  })
  const beforeStart = vi.fn(async (input: AutomationContextLaunchRequest) => {
    expect(input).toEqual(f.input)
    if (!authorized) throw new Error(code)
  })
  const deps = { ...f.deps, beforeStart }
  const launcher = createAutomationContextLauncher(deps)
  await expect(launcher.launch(f.input)).rejects.toThrow(code)
  expect(beforeStart).toHaveBeenCalledOnce()
  expect(f.start).not.toHaveBeenCalled()
  const original = (await f.deps.journal.read('r1'))!
  expect(original.phase).toBe('registered')
  const manual = await f.workspace.beginManualLaunch([f.directory])
  expect(manual.acquired).toBe(true)
  if (!manual.acquired) throw new Error('workspace was not released')
  await manual.finish({ submitted: false, tracked: false })
  authorized = true
  expect(await launcher.launch(f.input)).toHaveProperty('state', 'started')
  expect(f.prepare).toHaveBeenCalledOnce()
  expect((await f.deps.journal.read('r1'))!.prepared).toEqual(original.prepared)
  expect(f.start).toHaveBeenCalledOnce()
  expect(beforeStart).toHaveBeenCalledTimes(2)
})

it('holds an unknown native start across restart and releases only after a durable owned exit', async () => {
  const f = await workspaceSetup()
  f.start.mockRejectedValueOnce(new Error('lost-start-ACK'))
  await expect(f.launcher.launch(f.input)).rejects.toThrow('lost-start-ACK')
  const restarted = createAutomationContextLauncher({ ...f.deps, workspace: createAutomationContextWorkspace({ home, isTracked: async () => false }) })
  expect(await restarted.recover('r1')).toHaveProperty('state', 'needs-attention')
  expect(await restarted.launch(f.input)).toHaveProperty('state', 'needs-attention')
  expect(await f.workspace.beginManualLaunch([f.directory])).toMatchObject({ acquired: false })
  await restarted.recordOwnedExit({ runId: 'r1', sessionId: 'automation-run:r1', provider: 'codex' })
  expect(await restarted.recover('r1')).toHaveProperty('state', 'ended')
  expect(await f.workspace.beginManualLaunch([f.directory])).toMatchObject({ acquired: true })
  expect(f.start).toHaveBeenCalledOnce()
})

it('queues an early owned exit behind submission persistence instead of losing it to its own journal lock', async () => {
  const f = await workspaceSetup()
  let exit: Promise<unknown> | undefined
  f.start.mockImplementationOnce(async options => {
    exit = f.launcher.recordOwnedExit({ runId: 'r1', sessionId: 'automation-run:r1', provider: 'codex' })
      .then(() => ({ durable: true }), error => ({ durable: false, error }))
    return { type: 'success', sessionId: options.reconnectEnvironment!.HAPPY_RECONNECT_SESSION_ID }
  })
  expect(await f.launcher.launch(f.input)).toHaveProperty('state', 'started')
  expect(await exit).toEqual({ durable: true })
  expect(await f.launcher.recover('r1')).toHaveProperty('state', 'ended')
  expect(await f.workspace.beginManualLaunch([f.directory])).toHaveProperty('acquired', true)
})

it.each(['refused', 'journal-failed'])('releases workspace only on proven pre-submission failure (%s)', async kind => {
  const f = await workspaceSetup()
  if (kind === 'refused') f.start.mockRejectedValueOnce(new OwnedStartRefused('daemon-restarting'))
  else {
    const write = f.deps.journal.write.bind(f.deps.journal)
    vi.spyOn(f.deps.journal, 'write').mockImplementation(async record => {
      if (record.phase === 'submitted') throw new Error('journal-failed')
      await write(record)
    })
  }
  await expect(f.launcher.launch(f.input)).rejects.toThrow()
  expect(await f.deps.journal.read('r1')).toHaveProperty('phase', 'registered')
  expect(await f.workspace.beginManualLaunch([f.directory])).toMatchObject({ acquired: true })
  expect(f.start).toHaveBeenCalledTimes(kind === 'refused' ? 1 : 0)
})

it('recovers an acquired preparation after a pre-submission crash without launching a provider', async () => {
  const f = await workspaceSetup()
  f.register.mockRejectedValueOnce(new Error('preparation-only'))
  await expect(f.launcher.launch(f.input)).rejects.toThrow('preparation-only')
  const record = (await f.deps.journal.read('r1'))!
  expect(record.workspaceOwnerToken).toMatch(/^[a-f0-9-]{36}$/)
  expect(await f.workspace.acquireAutomation({ runId: 'r1', roots: [f.directory], ownerToken: record.workspaceOwnerToken })).toHaveProperty('acquired', true)
  const restarted = createAutomationContextLauncher(f.deps)
  expect(await restarted.recover('r1')).toHaveProperty('state', 'not-started')
  expect(await f.workspace.beginManualLaunch([f.directory])).toMatchObject({ acquired: true })
  expect(f.start).not.toHaveBeenCalled()
})

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
    const rawSeed = automationExecutionSeedArtifactSchema.parse(decrypt(session.encryptionKey, session.encryptionVariant, decodeBase64(f.seedMessages.get(session.id)!.content)))
    expect(rawSeed).toHaveProperty('seed.question', 'Current occurrence only')
    expect(session.metadata).toHaveProperty('automationExecutionSeedManifest', {
      version: 1, automationId: 'a1', runId: options.agent, generation: 1, revision: 1, displaySessionId: 'manual',
      inputBytes: Buffer.byteLength(options.initialPrompt!, 'utf8'),
      referenceBytes: 0, references: [], inputSha256: createHash('sha256').update(options.initialPrompt!).digest('hex'),
      wholeContextTokens: 'unknown',
      questionBytes: Buffer.byteLength('Current occurrence only'), seedSha256: createHash('sha256').update(JSON.stringify(rawSeed.seed)).digest('hex'),
    })
    expect(session.metadata).not.toHaveProperty('automationExecutionSeed')
    expect(readReconnectSessionEnvironment({ ...options.reconnectEnvironment! })?.seq).toBe(1)
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

it.each(['a', '가', '\\', '\u0001'])('preserves a budget-valid large authored question through encrypted creation (%j)', async character => {
  const f = await setup(), input = request()
  input.payload.prompt = character.repeat(Math.floor(60_000 / Buffer.byteLength(character, 'utf8')))
  expect(await f.launcher.launch(input)).toMatchObject({ state: 'started' })
  expect(f.prepare.mock.results[0].value.body.metadata.length).toBeLessThan(60_000)
  const session = f.sessions.get('automation-run:r1')!, message = f.seedMessages.get(session.id)!
  expect(message.content.length).toBeGreaterThan(60_000)
  expect(decrypt(session.encryptionKey, session.encryptionVariant, decodeBase64(message.content))).toHaveProperty('seed.question', input.payload.prompt)
  expect(Buffer.byteLength(f.start.mock.calls[0][0].initialPrompt!, 'utf8')).toBeLessThanOrEqual(65_536)
})

it('reuses the exact immutable seed after its storage ACK was lost without dispatching early', async () => {
  const f = await setup(), persist = f.persistSeed.getMockImplementation()!
  f.persistSeed.mockImplementationOnce(async (session, message) => { await persist(session, message); throw new Error('seed-ACK-lost') })
  await expect(f.launcher.launch(request())).rejects.toThrow('seed-ACK-lost')
  expect(f.start).not.toHaveBeenCalled()
  expect(await createAutomationContextLauncher(f.deps).launch(request())).toMatchObject({ state: 'started' })
  expect(f.prepare).toHaveBeenCalledTimes(1)
  expect(f.persistSeed.mock.calls[0][1]).toEqual(f.persistSeed.mock.calls[1][1])
  expect(f.start).toHaveBeenCalledTimes(1)
})

it.each(['sequence', 'identity', 'content'])('refuses a mismatched seed-storage %s receipt before starting the provider', async reason => {
  const f = await setup()
  f.persistSeed.mockImplementationOnce(async (_session, message) => ({ ...message, seq: reason === 'sequence' ? 2 : 1,
    ...(reason === 'identity' ? { localId: 'another-run' } : {}), ...(reason === 'content' ? { content: 'another-question' } : {}) }))
  await expect(f.launcher.launch(request())).rejects.toThrow('AUTOMATION_SEED_RECEIPT_CONFLICT')
  expect(f.start).not.toHaveBeenCalled()
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

it.each(['running', 'unconfirmed'] as const)('recovers the original %s execution after the definition changed without launching again', async observed => {
  const f = await setup()
  f.start.mockRejectedValueOnce(new Error('lost-provider-ACK'))
  await expect(f.launcher.launch(request())).rejects.toThrow('lost-provider-ACK')
  const edited = request(); edited.revision = 2; edited.generation = 2; edited.payload.prompt = 'new definition'
  await expect(f.launcher.launch(edited)).rejects.toThrow('AUTOMATION_LAUNCH_IDENTITY_CONFLICT')
  f.discover.mockResolvedValue(observed)
  const recovered = await createAutomationContextLauncher(f.deps).recover('r1')
  expect(recovered).toEqual({ state: observed === 'unconfirmed' ? 'needs-attention' : observed,
    sessionId: 'automation-run:r1', displaySessionId: 'manual', automationId: 'a1', generation: 1, revision: 1 })
  expect(f.discover).toHaveBeenCalledExactlyOnceWith('automation-run:r1')
  expect(f.start).toHaveBeenCalledTimes(1)
  expect(f.register).toHaveBeenCalledTimes(1)
})

it('recovers an owned exit receipt durably without inferring completion from PID absence', async () => {
  const f = await setup()
  await f.launcher.launch(request())
  expect(await f.launcher.recover('r1')).toHaveProperty('state', 'needs-attention')
  await f.launcher.recordOwnedExit({ runId: 'r1', sessionId: 'automation-run:r1', provider: 'codex' })
  f.discover.mockClear()
  expect(await createAutomationContextLauncher({ ...f.deps, journal: createAutomationContextLaunchJournal(home) }).recover('r1'))
    .toHaveProperty('state', 'ended')
  expect(f.discover).not.toHaveBeenCalled()
  expect(f.start).toHaveBeenCalledOnce()
})

it.each(['wrong-session', 'wrong-provider', 'not-submitted'])('rejects an exit receipt with %s', async kind => {
  const f = await setup()
  if (kind === 'not-submitted') f.register.mockRejectedValueOnce(new Error('not-submitted'))
  await f.launcher.launch(request()).catch(() => undefined)
  await expect(f.launcher.recordOwnedExit({ runId: 'r1', sessionId: kind === 'wrong-session' ? 'automation-run:other' : 'automation-run:r1',
    provider: kind === 'wrong-provider' ? 'claude' : 'codex' })).rejects.toThrow('AUTOMATION_EXIT_RECEIPT_CONFLICT')
  expect(await f.deps.journal.read('r1')).not.toHaveProperty('exitReceipt')
})

it('recovers a prepared receipt without claiming that a provider started or retrying registration', async () => {
  const f = await setup()
  expect(await f.launcher.recover('missing')).toBeNull()
  f.register.mockRejectedValueOnce(new Error('registration-ACK-lost'))
  await expect(f.launcher.launch(request())).rejects.toThrow('registration-ACK-lost')
  expect(await createAutomationContextLauncher(f.deps).recover('r1')).toMatchObject({
    state: 'not-started', sessionId: 'automation-run:r1', displaySessionId: 'manual',
  })
  expect(f.discover).not.toHaveBeenCalled()
  expect(f.start).not.toHaveBeenCalled()
  expect(f.register).toHaveBeenCalledTimes(1)
})

it('restores the exact encrypted run input and selected result independently of an edited or removed definition', async () => {
  const f = await setup(), input = request()
  input.payload.contextPolicy = { kind: 'isolated', reference: { kind: 'previous-result', maxBytes: 16_384 } }
  input.previousResult = { automationId: 'a1', runId: 'r0', revision: 1, status: 'COMPLETED', question: 'prior authored question', answer: 'private completed result' }
  const expected = structuredClone(input)
  f.register.mockRejectedValueOnce(new Error('offline'))
  await expect(f.launcher.launch(input)).rejects.toThrow('offline')
  input.payload.prompt = 'edited task'; input.claimToken = 'changed claim'; input.previousResult = undefined
  const restarted = createAutomationContextLauncher(f.deps)
  expect(await restarted.restoreRequest('r1')).toEqual(expected)
  expect(await restarted.restoreRequest('missing')).toBeNull()
  const name = (await readdir(join(home, 'automation-context-launches.v1'))).find(file => file.endsWith('.json'))!
  const disk = await readFile(join(home, 'automation-context-launches.v1', name), 'utf8')
  for (const secret of [expected.claimToken, expected.payload.prompt, 'private completed result']) expect(disk).not.toContain(secret)
  expect(f.register).toHaveBeenCalledTimes(1); expect(f.start).not.toHaveBeenCalled()
})

it('enumerates immutable old runs and reconciles them without dispatch or current definition lookup', async () => {
  const f = await setup()
  f.start.mockRejectedValueOnce(new Error('lost-start-ACK'))
  await expect(f.launcher.launch(request('submitted'))).rejects.toThrow('lost-start-ACK')
  f.register.mockRejectedValueOnce(new Error('lost-register-ACK'))
  await expect(f.launcher.launch(request('prepared'))).rejects.toThrow('lost-register-ACK')
  const restarted = createAutomationContextLauncher(f.deps)
  expect((await restarted.recoverAll()).sort((a, b) => a.runId.localeCompare(b.runId))).toEqual([
    { runId: 'prepared', state: 'not-started', automationId: 'a1', generation: 1, revision: 1, sessionId: 'automation-run:prepared', displaySessionId: 'manual' },
    { runId: 'submitted', state: 'needs-attention', automationId: 'a1', generation: 1, revision: 1, sessionId: 'automation-run:submitted', displaySessionId: 'manual' },
  ])
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.register).toHaveBeenCalledTimes(2)
  const directory = join(home, 'automation-context-launches.v1'), name = (await readdir(directory)).find(file => file.endsWith('.json'))!
  await writeFile(join(directory, name), '{broken', { mode: 0o600 })
  await expect(restarted.recoverAll()).rejects.toThrow()
  expect(f.start).toHaveBeenCalledTimes(1)
})

it('refuses a missing or changed immutable input snapshot instead of reconstructing from a new definition', async () => {
  const f = await setup()
  f.register.mockRejectedValueOnce(new Error('offline'))
  await expect(f.launcher.launch(request())).rejects.toThrow('offline')
  const original = (await f.deps.journal.read('r1'))!
  for (const requestCiphertext of [undefined, 'invalid-ciphertext']) {
    await f.deps.journal.write({ ...original, prepared: { ...original.prepared, requestCiphertext } })
    await expect(createAutomationContextLauncher(f.deps).restoreRequest('r1')).rejects.toThrow('AUTOMATION_LAUNCH_SNAPSHOT_INVALID')
  }
  expect(f.start).not.toHaveBeenCalled(); expect(f.discover).not.toHaveBeenCalled()
})

it('refuses recovery under another account or with a forged execution identity before discovery', async () => {
  const f = await setup()
  f.start.mockRejectedValueOnce(new Error('lost-provider-ACK'))
  await expect(f.launcher.launch(request())).rejects.toThrow()
  await expect(createAutomationContextLauncher({ ...f.deps, accountId: 'other' }).recover('r1'))
    .rejects.toThrow('AUTOMATION_LAUNCH_IDENTITY_CONFLICT')
  const receipt = (await f.deps.journal.read('r1'))!
  await f.deps.journal.write({ ...receipt, sessionId: 'manual' })
  await expect(createAutomationContextLauncher(f.deps).recover('r1')).rejects.toThrow('AUTOMATION_LAUNCH_IDENTITY_CONFLICT')
  expect(f.discover).not.toHaveBeenCalled()
  expect(f.start).toHaveBeenCalledTimes(1)
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


it.skipIf(process.platform === 'win32').each(['read', 'list'] as const)(
  'reads the owned replacement when an atomic journal write unlinks the opened snapshot (%s)', async operation => {
    const f = await setup(); await f.launcher.launch(request())
    const file = join(home, 'automation-context-launches.v1', createHash('sha256').update('r1').digest('hex') + '.json')
    const before = await stat(file), saved = (await f.deps.journal.read('r1'))!
    const next = { ...saved, exitReceipt: { provider: 'codex' as const, observedAt: 1234 } }
    const probe = await open(file, 'r'), prototype = Object.getPrototypeOf(probe), original = prototype.stat
    await probe.close()
    let replaced = false
    const observe = vi.spyOn(prototype, 'stat').mockImplementation(async function (this: any, ...args: any[]) {
      const observed = await original.apply(this, args)
      if (!replaced && observed.dev === before.dev && observed.ino === before.ino) {
        replaced = true
        await f.deps.journal.exclusive('r1', () => f.deps.journal.write(next))
        const detached = await original.apply(this, args)
        expect(detached.nlink).toBe(0)
        return detached
      }
      return observed
    })
    try {
      if (operation === 'read') expect(await f.deps.journal.read('r1')).toEqual(next)
      else expect(await f.deps.journal.listRunIds()).toEqual(['r1'])
      expect(replaced).toBe(true)
      expect(await f.deps.journal.read('r1')).toEqual(next)
      expect(f.start).toHaveBeenCalledOnce()
    } finally { observe.mockRestore() }
  })

it.skipIf(process.platform === 'win32').each(['hardlink', 'symlink', 'permissions'] as const)(
  'never treats an unsafe journal as a harmless replacement (%s)', async changed => {
    const f = await setup(); await f.launcher.launch(request())
    const file = join(home, 'automation-context-launches.v1', createHash('sha256').update('r1').digest('hex') + '.json')
    if (changed === 'hardlink') await link(file, file + '.other')
    if (changed === 'symlink') { await rename(file, file + '.other'); await symlink(file + '.other', file) }
    if (changed === 'permissions') await chmod(file, 0o644)
    await expect(f.deps.journal.read('r1')).rejects.toThrow()
    await expect(f.deps.journal.listRunIds()).rejects.toThrow()
    expect(f.start).toHaveBeenCalledOnce()
  })


it.skipIf(process.platform === 'win32')('bounds repeated owned replacement without dropping the persisted execution identity', async () => {
  const f = await setup(); await f.launcher.launch(request())
  const file = join(home, 'automation-context-launches.v1', createHash('sha256').update('r1').digest('hex') + '.json')
  const saved = (await f.deps.journal.read('r1'))!
  let current = await stat(file), replacements = 0
  const probe = await open(file, 'r'), prototype = Object.getPrototypeOf(probe), original = prototype.stat
  await probe.close()
  const observe = vi.spyOn(prototype, 'stat').mockImplementation(async function (this: any, ...args: any[]) {
    const observed = await original.apply(this, args)
    if (observed.dev === current.dev && observed.ino === current.ino) {
      if (++replacements > 5) throw new Error('Unbounded journal replacement retry')
      await f.deps.journal.exclusive('r1', () => f.deps.journal.write({ ...saved, exitReceipt: { provider: 'codex', observedAt: replacements } }))
      current = await stat(file)
      return original.apply(this, args)
    }
    return observed
  })
  try {
    await expect(f.deps.journal.read('r1')).rejects.toThrow('AUTOMATION_LAUNCH_JOURNAL_BUSY')
    expect(replacements).toBeGreaterThan(0); expect(replacements).toBeLessThanOrEqual(5)
    expect(f.start).toHaveBeenCalledOnce()
  } finally { observe.mockRestore() }
  expect(await f.deps.journal.read('r1')).toMatchObject({ phase: 'started', requestHash: saved.requestHash })
})

it.skipIf(process.platform === 'win32').each(['read', 'list'] as const)(
  'refuses an opened journal disappearing without a safe replacement instead of returning no identity (%s)', async operation => {
    const f = await setup(); await f.launcher.launch(request())
    const file = join(home, 'automation-context-launches.v1', createHash('sha256').update('r1').digest('hex') + '.json')
    const before = await stat(file), probe = await open(file, 'r'), prototype = Object.getPrototypeOf(probe), original = prototype.stat
    await probe.close()
    let removed = false
    const observe = vi.spyOn(prototype, 'stat').mockImplementation(async function (this: any, ...args: any[]) {
      const observed = await original.apply(this, args)
      if (!removed && observed.dev === before.dev && observed.ino === before.ino) {
        removed = true; await unlink(file); return original.apply(this, args)
      }
      return observed
    })
    try {
      await expect(operation === 'read' ? f.deps.journal.read('r1') : f.deps.journal.listRunIds()).rejects.toThrow('AUTOMATION_LAUNCH_JOURNAL_UNSAFE')
      expect(removed).toBe(true); expect(f.start).toHaveBeenCalledOnce()
    } finally { observe.mockRestore() }
  })

it('retains an explicit first-result resolution in the immutable encrypted seed and on restart', async () => {
  const f = await setup(), input = request()
  input.payload.contextPolicy = { kind: 'isolated', reference: { kind: 'previous-result', maxBytes: 16384 } }
  input.previousResult = { automationId: 'a1', status: 'NONE_ELIGIBLE' }
  await f.launcher.launch(input)
  const session = f.sessions.get('automation-run:r1')!, raw = f.seedMessages.get(session.id)!
  const seed = automationExecutionSeedArtifactSchema.parse(decrypt(session.encryptionKey, session.encryptionVariant, decodeBase64(raw.content))).seed
  expect(seed).toHaveProperty('referenceResolution', { kind: 'previous-result', status: 'NONE_ELIGIBLE' })
  expect(seed.references).toEqual([])
  expect(session.metadata.automationExecutionSeedManifest).toHaveProperty('referenceResolution', seed.referenceResolution)
  const original = await createAutomationContextLauncher(f.deps).restoreRequest('r1')
  expect(original?.previousResult).toEqual(input.previousResult)
  await createAutomationContextLauncher(f.deps).launch(original!)
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
})
