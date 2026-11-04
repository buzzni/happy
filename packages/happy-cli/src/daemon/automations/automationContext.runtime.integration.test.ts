import { expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import type { ChildProcess } from 'node:child_process'
import { readAutomationExecutionRecord,
  sessionCreateBodyHash, type AutomationPayload } from '@slopus/happy-wire'
import { signAutomationExecutionTarget } from '@slopus/happy-wire/automationExecutionToken'
import { signChatAutomationLifecycle } from '@slopus/happy-wire/chatAutomationLifecycleToken'
import { ApiClient } from '@/api/api'
import { decrypt, decodeBase64 } from '@/api/encryption'
import { SessionWriteScopeFixture, eventually, type StoredMessage } from '@/testing/sessionWriteScopeFixture'
import { createAutomationContextLaunchJournal } from './automationContextLaunchJournal'
import { createAutomationContextHost } from './automationContextHost'
import { createAutomationContextAuthorizer, createAutomationContextTransport } from './automationContextTransport'
import { createServerAutomationRuntimeStore } from './serverAutomationRuntimeStore'
import { createAutomationContextWorkspace } from './automationContextWorkspace'

async function seedRun(fixture: SessionWriteScopeFixture, input: Record<string, unknown>): Promise<any> {
  return eventually(async () => {
    const id = randomUUID(), server = fixture.server!
    const response = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { server.off('message', receive); reject(new Error('Fixture seed IPC timeout')) }, 10_000)
      const receive = (message: any) => {
        if (message?.id !== id) return
        clearTimeout(timer); server.off('message', receive); resolve(message)
      }
      server.on('message', receive)
      server.send({ id, action: 'seed-context', ...input })
    })
    if (response.retry) return undefined
    if (!response.ok) throw new Error('Disposable run seed refused')
    return response
  }, 'registered machine and claimed fixture run')
}

it.each([{ state: 'active', provider: 'claude', encryptionVariant: 'legacy' },
  { state: 'paused', provider: 'claude', encryptionVariant: 'legacy' },
  { state: 'active', provider: 'codex', encryptionVariant: 'legacy' },
  { state: 'active', provider: 'claude', encryptionVariant: 'dataKey' },
  { state: 'active', provider: 'codex', encryptionVariant: 'dataKey' },
  { state: 'manual', provider: 'codex', encryptionVariant: 'legacy' },
  { state: 'manual', provider: 'claude', encryptionVariant: 'legacy' },
  { state: 'queued', provider: 'codex', encryptionVariant: 'legacy' },
  { state: 'queued', provider: 'claude', encryptionVariant: 'legacy' },
  { state: 'archived', provider: 'codex', encryptionVariant: 'legacy' },
  { state: 'deleted', provider: 'claude', encryptionVariant: 'legacy' },
  { state: 'background', provider: 'codex', encryptionVariant: 'legacy' },
  { state: 'background', provider: 'claude', encryptionVariant: 'legacy' }] as const)(
  'restores a durable $state $provider $encryptionVariant occurrence through the real daemon without replaying or ignoring a stop', async ({ state, provider, encryptionVariant }) => {
  const chatStopped = state === 'archived' || state === 'deleted'
  const shouldRun = state !== 'paused' && !chatStopped
  const isManual = state === 'manual' || state === 'queued' || state === 'background'
  vi.stubEnv('HAPPY_SCOPE_FRESH_PROVIDER_STATE', '1')
  vi.stubEnv('HAPPY_SCOPE_PACKAGED_SERVER', undefined)
  vi.stubEnv('HAPPY_SCOPE_INSTALLED_CLI', undefined)
  let fixture: SessionWriteScopeFixture, run: any
  const secret = randomBytes(32).toString('hex'), runId = `deferred-${randomUUID()}`, claimToken = randomBytes(24).toString('hex')
  const manualMarker = `scope-marker-manual-${randomUUID()}`, queuedMarker = `scope-marker-queued-${randomUUID()}`
  let releaseFirst = () => {}, releaseSecond = () => {}
  const responseGates = new Map<string, Promise<void>>()
  if (state === 'queued') {
    responseGates.set(manualMarker, new Promise<void>(resolve => { releaseFirst = resolve }))
    responseGates.set(queuedMarker, new Promise<void>(resolve => { releaseSecond = resolve }))
  }
  const calls: string[] = []
  let backgroundIssued = false
  const backgroundPath = (name: string) => join(fixture.project, `context-background-${name}`)
  const backgroundFile = async (name: string, expected: string) => {
    try { return await readFile(backgroundPath(name), 'utf8') === expected ? true : undefined }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  // Scoped Studio facade: real Happy admission is still checked on every target proof.
  const studio = createServer(async (request, response) => {
    const reply = (status: number, value: unknown) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
    try {
      if (!request.url?.startsWith('/api/automation/')) { reply(404, {}); return }
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      if (!run || request.headers.authorization !== `Bearer ${fixture.token}` || body.machineId !== run.machineId
        || body.runId !== runId || body.claimToken !== claimToken) { reply(403, {}); return }
      calls.push(request.url)
      if (request.url === '/api/automation/project-environment') {
        if (body.conversationSessionId !== run.displaySessionId || body.conversationDirectory !== fixture.project) { reply(403, {}); return }
        reply(200, { projectId: run.projectId, conversationSessionId: run.displaySessionId,
          conversationDirectory: fixture.project, environmentVariables: {} }); return
      }
      if (request.url === '/api/automation/mcp-caller-grant') {
        reply(200, { projectId: run.projectId, grant: null, bindingStatus: 'DIRECT_OWNER', connectorPolicy: 'optional', requiredConnectors: [] }); return
      }
      if (request.url === '/api/automation/execution-target') {
        const admission = await fetch(`${fixture.serverUrl}/v1/automation-runs/${runId}/mcp-context`, { method: 'POST',
          headers: { Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ machineId: run.machineId, claimToken, executionAdmission: true }), signal: AbortSignal.timeout(10_000) })
        if (!admission.ok) { await admission.body?.cancel(); reply(admission.status >= 500 ? 503 : 403, {}); return }
        const admitted = await admission.json() as any
        if (admitted.executionAdmission?.payloadVersion !== 6
          || body.conversationSessionId !== run.displaySessionId || body.conversationDirectory !== fixture.project) { reply(403, {}); return }
        reply(200, { executionBindingRequired: false, targetProof: signAutomationExecutionTarget({ automationId: run.automationId,
          projectId: run.projectId, generation: run.generation, revision: run.revision, machineId: run.machineId,
          runId, machineAccountId: fixture.accountId, displaySessionId: run.displaySessionId,
          createBodyHash: await sessionCreateBodyHash(body.createBody), executionBindingRequired: false,
          bearer: fixture.token, secret, now: Date.now() }) }); return
      }
      reply(404, {})
    } catch { reply(500, {}) }
  })
  await new Promise<void>(resolve => studio.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(studio.address() as { port: number }).port}`
  fixture = new SessionWriteScopeFixture({ provider, encryptionVariant,
    serverEntry: 'sources/testing/automationContextFixture.ts', browserBridgeHost: '::1', automationContextHost: true, automationStudioUrl: origin,
    beforeModelResponse: async body => {
      await responseGates.get([...body.matchAll(/scope-marker-[a-z0-9-]+/g)].at(-1)?.[0] ?? '')
      if (state !== 'background' || backgroundIssued || !body.includes(manualMarker)) return
      const tools = JSON.parse(body).tools as Array<{ name?: string }>
      const name = tools?.find(tool => tool.name === (provider === 'claude' ? 'Bash' : 'exec_command'))?.name
      // Auxiliary title requests have no native tools; only the authored turn starts this command.
      if (!name) return
      backgroundIssued = true
      const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
      const command = `printf started > ${quote(backgroundPath('started'))}; while [ -d ${quote(fixture.project)} ] && [ ! -f ${quote(backgroundPath('release'))} ]; do sleep 0.05; done; printf done > ${quote(backgroundPath('done'))}`
      return { name, arguments: provider === 'claude' ? { command, run_in_background: true }
        : { cmd: command, yield_time_ms: 1000, max_output_tokens: 1000 } }
    } })
  let failure: unknown
  try {
    await fixture.start()
    const api = await ApiClient.create({ token: fixture.token, encryption: encryptionVariant === 'legacy'
      ? { type: 'legacy', secret: fixture.seed } : { type: 'dataKey', publicKey: fixture.accountBox.publicKey, machineKey: fixture.machineKey } })
    const manualSessionId = isManual ? await fixture.spawnSession(fixture.project, { enabled: false }) : null
    let originalNativeId = 'manual-native-keep'
    if (manualSessionId) {
      await fixture.send(manualSessionId, manualMarker)
      if (state === 'queued') {
        await eventually(async () => fixture.modelRequests.some(body => body.includes(manualMarker)) ? true : undefined, 'manual input reaches the native model')
        await fixture.send(manualSessionId, queuedMarker)
      } else await fixture.waitReply(manualSessionId, manualMarker)
      if (state === 'background') {
        expect(backgroundIssued).toBe(true)
        await eventually(() => backgroundFile('started', 'started'), 'actual native background command starts')
        expect(await backgroundFile('done', 'done')).toBeUndefined()
      }
      originalNativeId = (await fixture.session(manualSessionId)).metadata[fixture.providerIdentityField]
      expect(originalNativeId).toBeTruthy()
    }
    const prepared = api.prepareSessionCreation({ tag: `manual-${randomUUID()}`, metadata: { path: fixture.project,
      host: 'fixture', flavor: provider, [fixture.providerIdentityField]: 'manual-native-keep', homeDir: fixture.home, happyHomeDir: fixture.happyHome,
      happyLibDir: fixture.cli, happyToolsDir: fixture.tools }, state: { controlledByUser: false } })
    const displaySessionId = manualSessionId ?? (await fixture.http('/v1/sessions', prepared.body)).body.session.id
    run = { ...await seedRun(fixture, { accountId: fixture.accountId, displaySessionId, runId, claimToken, directory: fixture.project, secret,
      ...(chatStopped ? { chat: true } : {}) }), displaySessionId }
    const journal = createAutomationContextLaunchJournal(fixture.happyHome)
    const workspace = createAutomationContextWorkspace({ home: fixture.happyHome, isTracked: async () => false })
    const manual = isManual ? null : await workspace.beginManualLaunch([fixture.project])
    if (manual && !manual.acquired) throw new Error('Manual preparation refused')
    const host = createAutomationContextHost({ accountId: fixture.accountId, machineId: run.machineId, happyOrigin: fixture.serverUrl,
      reportExit: async () => { throw new Error('Only the daemon reports a deferred exit') },
      api, journal, workspace, runtimeStore: createServerAutomationRuntimeStore({ filePath: join(fixture.happyHome, 'preparation-runtime.test.json') }),
      heartbeat: async () => { throw new Error('Only the daemon maintains the saved occurrence') },
      resolveContext: async () => { throw new Error('Only the daemon resolves renewed authority') },
      discover: async () => 'unconfirmed', start: async () => { throw new Error('Busy workspace must not submit') }, log: message => fixture.failures.push(message),
      transportForRun: async () => createAutomationContextTransport({ serverUrl: fixture.serverUrl, token: fixture.token,
        machineId: run.machineId, runId, claimToken, authorize: createAutomationContextAuthorizer({ studioOrigin: origin,
          token: fixture.token, machineId: run.machineId, runId, claimToken }) }) })
    const marker = `scope-marker-deferred-${randomUUID()}`
    try {
      expect(await host.dispatch({ automationId: run.automationId, generation: run.generation, revision: run.revision, runId, claimToken,
        environmentVariables: {}, payload: { name: 'Deferred isolated occurrence', directory: fixture.project, agent: provider,
          model: fixture.modelName, prompt: `Return ${marker} only.`, scriptCommand: null, suppressSilent: false,
          schedule: { kind: 'once-zoned', date: '2026-11-05', hour: 9, minute: 0, timeZone: 'UTC' },
          conversation: { sessionId: displaySessionId }, contextPolicy: { kind: 'isolated', reference: null } } }))
        .toMatchObject({ state: 'waiting', deferred: true })
      expect(await journal.read(runId)).toMatchObject({ phase: 'registered', deferredDispatch: 'queued' })
      expect((await journal.read(runId))!.prepared.encryptionVariant).toBe(encryptionVariant)
      expect((await journal.read(runId))!.prepared.body.dataEncryptionKey == null).toBe(encryptionVariant === 'legacy')
      if (state === 'paused') {
        const response = await fetch(`${fixture.serverUrl}/v1/projects/${encodeURIComponent(run.projectId)}/automations/${encodeURIComponent(run.automationId)}`, {
          method: 'PATCH', headers: { Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedRevision: run.revision, paused: true }), signal: AbortSignal.timeout(10_000) })
        expect(response.status).toBe(200)
        expect((await response.json() as any).automation).toMatchObject({ paused: true, generation: run.generation + 1 })
      }
      if (chatStopped) {
        const response = await fetch(`${fixture.serverUrl}/v1/projects/${encodeURIComponent(run.projectId)}/automation-lifecycle`, {
          method: 'POST', headers: { Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json',
            'x-chat-automation-proof': signChatAutomationLifecycle({ projectId: run.projectId, actorUserId: 'fixture-owner',
              bearer: fixture.token, state, secret, now: Date.now() }) }, body: JSON.stringify({ state }), signal: AbortSignal.timeout(10_000) })
        expect(response.status).toBe(200)
      }
      if (state === 'background') {
        await eventually(async () => calls.includes('/api/automation/mcp-caller-grant') ? true : undefined, 'daemon attempts admission after the manual answer while background work is live')
        expect(await backgroundFile('done', 'done')).toBeUndefined()
        expect(await journal.read(runId)).toMatchObject({ phase: 'registered', deferredDispatch: 'queued' })
        expect(fixture.modelRequests.some(body => body.includes(marker))).toBe(false)
        await writeFile(backgroundPath('release'), 'release')
        await eventually(() => backgroundFile('done', 'done'), 'actual native background command completes')
      }
      if (state === 'queued') {
        const grantCalls = () => calls.filter(path => path === '/api/automation/mcp-caller-grant').length
        await eventually(async () => grantCalls() > 0 ? true : undefined, 'daemon attempts the waiting occurrence during the first manual turn')
        expect(await journal.read(runId)).toMatchObject({ phase: 'registered', deferredDispatch: 'queued' })
        expect(fixture.modelRequests.some(body => body.includes(marker))).toBe(false)
        releaseFirst(); await fixture.waitReply(manualSessionId!, manualMarker)
        await eventually(async () => fixture.modelRequests.some(body => body.includes(queuedMarker)) ? true : undefined, 'queued manual turn reaches the native model')
        const previousCalls = grantCalls()
        await eventually(async () => grantCalls() > previousCalls ? true : undefined, 'daemon retries while the queued manual turn runs')
        expect(await journal.read(runId)).toMatchObject({ phase: 'registered', deferredDispatch: 'queued' })
        expect(fixture.modelRequests.some(body => body.includes(marker))).toBe(false)
        releaseSecond(); await fixture.waitReply(manualSessionId!, queuedMarker)
      }
      if (!isManual) { await fixture.stopDaemon(); await fixture.startDaemon() }
    } finally { if (manual?.acquired) expect(await manual.finish({ submitted: false, tracked: false })).toBe(true) }
    await eventually(async () => {
      await fixture.children()
      const saved = await journal.read(runId)
      return shouldRun ? saved?.exitReceipt ? true : undefined
        : saved?.cancelledBeforeSubmit && saved.deferredDispatch === 'settled' ? true : undefined
    }, 'daemon restores the original execution or preserves the stop before submission', 45_000)
    const report = await eventually(async () => {
      const feed = await fixture.http(`/v1/sessions/${displaySessionId}/automation-runs`)
      const result = feed.body.runs?.[0]
      return result?.schedulerStatus === (shouldRun ? 'COMPLETED' : chatStopped ? 'CANCELLED' : 'FAILED')
        && (!shouldRun || result.executionExitReceipt) ? result : undefined
    }, 'daemon flushes the original run report')
    expect(report).toMatchObject({ id: runId, outcome: shouldRun ? 'WOKE' : chatStopped ? null : 'ERROR' })
    if (chatStopped) expect(report.failureCode).toBe(state === 'archived' ? 'CHAT_ARCHIVED' : 'CHAT_DELETED')
    expect(report.executionExitError).toBeNull()
    if (shouldRun) {
      await eventually(async () => (await journal.read(runId))?.exitReceiptAcknowledged ? true : undefined, 'durable server exit ACK')
      const saved = (await journal.read(runId))!
      expect(saved).toMatchObject({ phase: 'started', deferredDispatch: 'settled', exitReceipt: { provider }, exitReceiptAcknowledged: true })
      expect(report.executionExitReceipt).toMatchObject({ version: 1, ...saved.exitReceipt, providerExitedCleanly: true,
        foregroundDrained: true, backgroundDrained: true, writeProducersDrained: true })
    }
    else {
      expect(await journal.read(runId)).toMatchObject({ phase: 'registered', deferredDispatch: 'settled', cancelledBeforeSubmit: true })
      expect(await journal.read(runId)).not.toHaveProperty('exitReceipt')
      expect(report.executionExitReceipt).toBeNull()
    }
    if (!chatStopped) {
      expect(calls).toContain('/api/automation/project-environment')
      expect(calls).toContain('/api/automation/mcp-caller-grant')
    }
    if (!manualSessionId) expect(fixture.modelRequests).toHaveLength(shouldRun ? 1 : 0)
    if (shouldRun) {
      const automaticInputs = fixture.modelRequests.filter(body => body.includes(marker))
      expect(automaticInputs).toHaveLength(1)
      expect(automaticInputs[0]).not.toContain(manualMarker)
      expect(automaticInputs[0]).not.toContain(queuedMarker)
    }
    const manualAfter = (await fixture.http('/v2/sessions/lookup', { ids: [displaySessionId] })).body.sessions[0]
    expect(decrypt(prepared.encryptionKey, prepared.encryptionVariant, decodeBase64(manualAfter.metadata))).toMatchObject({ [fixture.providerIdentityField]: originalNativeId })
    if (manualSessionId) {
      expect(await fixture.resumeSession(manualSessionId)).toBe(manualSessionId)
      const followup = `scope-marker-followup-${randomUUID()}`
      await fixture.send(manualSessionId, followup); await fixture.waitReply(manualSessionId, followup)
      expect((await fixture.session(manualSessionId)).metadata[fixture.providerIdentityField]).toBe(originalNativeId)
      const followupInputs = fixture.modelRequests.filter(body => body.includes(followup))
      expect(followupInputs.some(body => body.includes(manualMarker) && !body.includes(marker))).toBe(true)
    }
    const admission = await workspace.beginManualLaunch([fixture.project])
    expect(admission.acquired).toBe(true)
    if (admission.acquired) expect(await admission.finish({ submitted: false, tracked: false })).toBe(true)
  } catch (error) { failure = new Error(`Deferred daemon failed:\n${await fixture.diagnostics().catch(() => 'Diagnostics unavailable')}`, { cause: error }) }
  finally {
    releaseFirst(); releaseSecond()
    if (state === 'background' && fixture.project) await writeFile(backgroundPath('release'), 'release').catch(() => {
      fixture.failures.push('Disposable background release failed before owned fixture cleanup')
    })
    try { await fixture.close() } catch (error) { failure = failure ? new AggregateError([failure, error]) : error }
    studio.closeAllConnections(); await new Promise<void>(resolve => studio.close(() => resolve()))
    vi.unstubAllEnvs()
  }
  if (failure) throw failure
})

it('refuses a real daemon manual spawn while automatic ownership exists and permits it after proven release', async () => {
  vi.stubEnv('HAPPY_SCOPE_FRESH_PROVIDER_STATE', '1')
  vi.stubEnv('HAPPY_SCOPE_PACKAGED_SERVER', undefined)
  vi.stubEnv('HAPPY_SCOPE_INSTALLED_CLI', undefined)
  const fixture = new SessionWriteScopeFixture({ provider: 'claude', encryptionVariant: 'legacy',
    browserBridgeHost: '::1', automationContextHost: true })
  try {
    await fixture.start()
    const nested = join(fixture.project, 'nested'), alias = join(fixture.root, 'project-alias')
    await mkdir(nested); await symlink(fixture.project, alias)
    const workspace = createAutomationContextWorkspace({ home: fixture.happyHome, isTracked: async () => false })
    const runId = `manual-admission-${randomUUID()}`
    const owned = await workspace.acquireAutomation({ runId, roots: [fixture.project] })
    if (!owned.acquired) throw new Error('Automatic preparation refused')
    try {
      const before = (await fixture.http('/v1/sessions')).body.sessions
      const blocked = await eventually(async () => {
        const result = await fixture.control('/spawn-session', { directory: fixture.project, agent: 'claude' })
        if (result.body.error === 'Daemon is initializing; retry the launch shortly') return undefined
        return result
      }, 'daemon manual launch admission')
      await fixture.children()
      expect(blocked.body.success).toBe(false)
      expect(blocked.body.code).toBe('workspace-automation-busy')
      for (const directory of [nested, alias]) {
        const blockedAlias = await fixture.control('/spawn-session', { directory, agent: 'claude' })
        expect(blockedAlias.body).toMatchObject({ success: false, code: 'workspace-automation-busy' })
      }
      expect((await fixture.http('/v1/sessions')).body.sessions).toEqual(before)
    } finally {
      // This test reserved the workspace but never submitted an automatic provider.
      expect(await workspace.releaseUnsubmitted({ runId, roots: [fixture.project], ownerToken: owned.ownerToken })).toBe(true)
    }
    const resumed = await fixture.control('/spawn-session', { directory: fixture.project, agent: 'claude' })
    await fixture.children()
    expect(resumed.body.success).toBe(true)
    expect(resumed.body.sessionId).not.toMatch(/^automation-run:/)
    const createdDirectory = await fixture.control('/spawn-session', { directory: join(fixture.root, 'new-workspace'), agent: 'claude' })
    await fixture.children()
    expect(createdDirectory.body.success).toBe(true)
  } catch (error) {
    throw new Error(`Daemon admission failed:\n${await fixture.diagnostics().catch(() => 'Diagnostics unavailable')}`, { cause: error })
  } finally { await fixture.close() }
})

it.each(['claude', 'codex'] as const)('keeps two real %s CLI runs on one display target with private history and unchanged manual state', async provider => {
  vi.stubEnv('HAPPY_SCOPE_FRESH_PROVIDER_STATE', '1')
  vi.stubEnv('HAPPY_SCOPE_PACKAGED_SERVER', undefined)
  vi.stubEnv('HAPPY_SCOPE_INSTALLED_CLI', undefined)
  const fixture = new SessionWriteScopeFixture({ provider, encryptionVariant: 'legacy',
    serverEntry: 'sources/testing/automationContextFixture.ts', browserBridgeHost: '::1' })
  const journalHome = resolve(process.env.HAPPY_HOME_DIR!)
  let failure: unknown
  try {
    await fixture.start()
    const machines = await eventually(async () => {
      const response = await fixture.http('/v1/machines')
      return Array.isArray(response.body) && response.body.length ? response.body : undefined
    }, 'fixture machine registration')
    const machineId = machines[0].id as string
    const api = await ApiClient.create({ token: fixture.token, encryption: { type: 'legacy', secret: fixture.seed } })
    const manualMetadata = { path: fixture.project, host: 'fixture', homeDir: fixture.home, happyHomeDir: fixture.happyHome,
      happyLibDir: fixture.cli, happyToolsDir: fixture.tools, flavor: provider,
      ...(provider === 'claude' ? { claudeSessionId: 'manual-native-keep' } : { codexThreadId: 'manual-native-keep' }),
      summary: { text: 'Manual conversation stays here', updatedAt: 1 }, manualGoal: 'keep-original-goal' }
    const manualPrepared = api.prepareSessionCreation({ tag: `manual-${randomUUID()}`, metadata: manualMetadata,
      state: { controlledByUser: false } })
    const created = await fixture.http('/v1/sessions', manualPrepared.body)
    expect(created.status).toBe(200)
    const displaySessionId = created.body.session.id as string
    await fixture.session(displaySessionId)
    const manualMarker = `scope-marker-manual-${randomUUID()}`
    await fixture.send(displaySessionId, manualMarker)
    const before = (await fixture.http('/v2/sessions/lookup', { ids: [displaySessionId] })).body.sessions[0]
    const pendingBefore = await fixture.messages(displaySessionId)
    const nativeIds = new Set<string>(), markers: string[] = [], secret = randomBytes(32).toString('hex')
    const journal = createAutomationContextLaunchJournal(journalHome)
    const workspace = createAutomationContextWorkspace({ home: fixture.happyHome, isTracked: async () => false })
    for (let index = 0; index < 2; index++) {
      const runId = `context-${provider}-${index}-${randomUUID()}`, claimToken = randomBytes(24).toString('hex')
      const info = await seedRun(fixture, { accountId: fixture.accountId, displaySessionId, runId, claimToken,
        directory: fixture.project, secret })
      expect(info.machineId).toBe(machineId)
      const marker = `scope-marker-run-${index}-${randomUUID()}`; markers.push(marker)
      const payload: AutomationPayload = { name: 'Context minimum flow', directory: fixture.project, agent: provider,
        model: fixture.modelName, prompt: `Return ${marker} only.`, scriptCommand: null, suppressSilent: false,
        schedule: { kind: 'interval', minutes: 60 }, conversation: { sessionId: displaySessionId },
        contextPolicy: { kind: 'isolated', reference: null } }
      let child: ChildProcess | undefined
      const exitEvidence: unknown[] = []
      const host = createAutomationContextHost({ accountId: fixture.accountId, machineId, happyOrigin: fixture.serverUrl,
        reportExit: async () => { throw new Error('Unexpected fixture-only maintenance') },
        api, journal, workspace,
        runtimeStore: createServerAutomationRuntimeStore({ filePath: join(fixture.happyHome, 'context-runtime.test.json') }),
        heartbeat: async () => { throw new Error('Unexpected fixture deferred renewal') },
        resolveContext: async () => {
          const context = await fixture.http(`/v1/automation-runs/${runId}/mcp-context`, { machineId, claimToken, executionAdmission: true })
          expect(context.status).toBe(200)
          expect(context.body.executionAdmission).toMatchObject({ generation: info.generation, revision: info.revision,
            machineAccountId: fixture.accountId, payloadVersion: 6 })
          return { environmentVariables: {} }
        },
        log: message => fixture.failures.push(message), transportForRun: async () => createAutomationContextTransport({
          serverUrl: fixture.serverUrl, token: fixture.token, machineId, runId, claimToken, authorize: async target => {
          const context = await fixture.http(`/v1/automation-runs/${runId}/mcp-context`, { machineId, claimToken, executionAdmission: true })
          expect(context.status).toBe(200)
          expect(context.body.executionAdmission).toMatchObject({ generation: info.generation, revision: info.revision, machineAccountId: fixture.accountId, payloadVersion: 6 })
          return { executionBindingRequired: false, targetProof: signAutomationExecutionTarget({ automationId: info.automationId,
            projectId: info.projectId, runId, generation: info.generation, revision: info.revision, machineId, machineAccountId: fixture.accountId,
            displaySessionId, createBodyHash: await sessionCreateBodyHash(target.body), executionBindingRequired: false,
            bearer: fixture.token, secret, now: Date.now() }) }
        } }), start: async (options, _context, observeChild) => {
          expect(await workspace.beginManualLaunch([fixture.project])).toHaveProperty('acquired', false)
          child = fixture.launchContextSession(options)
          observeChild(child)
          child.on('message', message => { if ((message as { type?: unknown })?.type === 'automation-context-exit') exitEvidence.push(message) })
          await eventually(async () => {
            if (child!.exitCode !== null && child!.exitCode !== 0) throw new Error('Native fixture CLI failed')
            const receipt = await journal.read(runId)
            const lookup = await fixture.http('/v2/sessions/lookup', { ids: [receipt!.sessionId] })
            const raw = lookup.body.sessions[0]
            if (!raw) return undefined
            const metadata = decrypt(decodeBase64(receipt!.prepared.encryptionKey), receipt!.prepared.encryptionVariant, decodeBase64(raw.metadata)) as any
            return typeof metadata[fixture.providerIdentityField] === 'string' ? true : undefined
          }, 'real native identity', 60_000)
          return { type: 'success', sessionId: options.reconnectEnvironment!.HAPPY_RECONNECT_SESSION_ID }
        }, discover: async () => child?.exitCode === null ? 'running' : 'unconfirmed' })
      expect(await host.dispatch({ automationId: info.automationId, generation: info.generation, revision: info.revision, runId, claimToken, payload, environmentVariables: {} }))
        .toMatchObject({ state: 'started', displaySessionId })
      await eventually(async () => child!.exitCode === 0 ? true : child!.exitCode === null ? undefined : Promise.reject(new Error('Native CLI exit failed')),
        'native CLI natural exit and message flush', 60_000)
      await eventually(async () => (await journal.read(runId))?.exitReceipt ? true : undefined, 'durable owned native exit receipt')
      expect(await host.recover(runId)).toHaveProperty('state', 'ended')
      const manualAdmission = await workspace.beginManualLaunch([fixture.project])
      expect(manualAdmission.acquired).toBe(true)
      if (!manualAdmission.acquired) throw new Error('Owned native exit did not release the workspace')
      expect(await manualAdmission.finish({ submitted: false, tracked: false })).toBe(true)
      const receipt = (await journal.read(runId))!, key = decodeBase64(receipt.prepared.encryptionKey)
      expect(exitEvidence).toEqual([{ type: 'automation-context-exit', version: 1, provider, sessionId: receipt.sessionId,
        evidence: { providerExitedCleanly: true, foregroundDrained: true, backgroundDrained: true, writeProducersDrained: true } }])
      const raw = (await fixture.http('/v2/sessions/lookup', { ids: [receipt.sessionId] })).body.sessions[0]
      const metadata = decrypt(key, receipt.prepared.encryptionVariant, decodeBase64(raw.metadata)) as any
      const nativeId = metadata[fixture.providerIdentityField]
      expect(nativeId).not.toBe('manual-native-keep'); expect(nativeIds.has(nativeId)).toBe(false); nativeIds.add(nativeId)
      const evidence = await fixture.http(`/v1/sessions/${displaySessionId}/automation-runs/${runId}/evidence`)
      expect(evidence.status).toBe(200); expect(evidence.body.nextAfterSeq).toBeNull()
      const original = decrypt(key, receipt.prepared.encryptionVariant, decodeBase64(evidence.body.seedManifestCiphertext)) as any
      const result = await readAutomationExecutionRecord({ identity: { runId, automationId: info.automationId, generation: info.generation,
        revision: info.revision, displaySessionId }, metadata: original, complete: true,
        seedMessage: { ...evidence.body.seedMessage, content: decrypt(key, receipt.prepared.encryptionVariant, decodeBase64(evidence.body.seedMessage.content.c)) },
        messages: evidence.body.messages.map((message: StoredMessage) => ({
        ...message, content: decrypt(key, receipt.prepared.encryptionVariant, decodeBase64(message.content.c)),
      })) })
      expect(result).toMatchObject({ status: 'verified', seed: { question: payload.prompt },
        answer: { status: 'completed', answer: `fixture reply ${marker}` } })
      expect(await seedRun(fixture, { action: 'complete-context', accountId: fixture.accountId, machineId, claimToken,
        reportId: randomUUID(), runId, sessionId: receipt.sessionId })).toMatchObject({ ok: true })
    }
    expect(nativeIds.size).toBe(2)
    expect(fixture.modelRequests).toHaveLength(2)
    expect(fixture.modelRequests[1]).not.toContain(markers[0])
    for (const body of fixture.modelRequests) expect(body).not.toContain(manualMarker)
    expect((await fixture.http('/v2/sessions/lookup', { ids: [displaySessionId] })).body.sessions[0]).toEqual(before)
    expect(await fixture.messages(displaySessionId)).toEqual(pendingBefore)
    const visible = (await fixture.http('/v1/sessions')).body.sessions
    expect(visible.map((session: { id: string }) => session.id)).toEqual([displaySessionId])
    const history = await fixture.http(`/v1/sessions/${displaySessionId}/automation-runs`)
    expect(history.body.runs).toHaveLength(2)
    expect(fixture.failures).toEqual([])
    console.log(JSON.stringify({ provider, nativeContexts: nativeIds.size, visibleSessions: visible.length,
      runsOnOriginalTarget: history.body.runs.length, manualRows: pendingBefore.length, model: 'local fixture; no external inference' }))
  } catch (error) {
    failure = new Error(`Private context flow failed (${provider}):\n${await fixture.diagnostics().catch(() => 'Diagnostics unavailable')}`, { cause: error })
    throw failure
  } finally {
    try { await fixture.close() } catch (error) {
      if (failure) throw new AggregateError([failure, error], `${(failure as Error).message}\nFixture cleanup: ${String(error)}`)
      throw error
    }
    finally { vi.unstubAllEnvs() }
  }
}, 180_000)
