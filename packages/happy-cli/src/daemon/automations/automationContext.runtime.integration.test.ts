import { expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import type { ChildProcess } from 'node:child_process'
import { readAutomationExecutionRecord,
  sessionCreateBodyHash, type AutomationPayload } from '@slopus/happy-wire'
import { signAutomationExecutionTarget } from '@slopus/happy-wire/automationExecutionToken'
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

it.each(['active', 'paused'] as const)('restores a durable %s deferred occurrence through the real daemon without replaying or ignoring a stop', async state => {
  vi.stubEnv('HAPPY_SCOPE_FRESH_PROVIDER_STATE', '1')
  vi.stubEnv('HAPPY_SCOPE_PACKAGED_SERVER', undefined)
  vi.stubEnv('HAPPY_SCOPE_INSTALLED_CLI', undefined)
  let fixture: SessionWriteScopeFixture, run: any
  const secret = randomBytes(32).toString('hex'), runId = `deferred-${randomUUID()}`, claimToken = randomBytes(24).toString('hex')
  const calls: string[] = []
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
  fixture = new SessionWriteScopeFixture({ provider: 'claude', encryptionVariant: 'legacy',
    serverEntry: 'sources/testing/automationContextFixture.ts', browserBridgeHost: '::1', automationContextHost: true, automationStudioUrl: origin })
  let failure: unknown
  try {
    await fixture.start()
    const api = await ApiClient.create({ token: fixture.token, encryption: { type: 'legacy', secret: fixture.seed } })
    const prepared = api.prepareSessionCreation({ tag: `manual-${randomUUID()}`, metadata: { path: fixture.project,
      host: 'fixture', flavor: 'claude', claudeSessionId: 'manual-native-keep', homeDir: fixture.home, happyHomeDir: fixture.happyHome,
      happyLibDir: fixture.cli, happyToolsDir: fixture.tools }, state: { controlledByUser: false } })
    const displaySessionId = (await fixture.http('/v1/sessions', prepared.body)).body.session.id
    run = { ...await seedRun(fixture, { accountId: fixture.accountId, displaySessionId, runId, claimToken, directory: fixture.project, secret }), displaySessionId }
    const journal = createAutomationContextLaunchJournal(fixture.happyHome)
    const workspace = createAutomationContextWorkspace({ home: fixture.happyHome, isTracked: async () => false })
    const manual = await workspace.beginManualLaunch([fixture.project])
    if (!manual.acquired) throw new Error('Manual preparation refused')
    const host = createAutomationContextHost({ accountId: fixture.accountId, machineId: run.machineId, happyOrigin: fixture.serverUrl,
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
        environmentVariables: {}, payload: { name: 'Deferred isolated occurrence', directory: fixture.project, agent: 'claude',
          model: fixture.modelName, prompt: `Return ${marker} only.`, scriptCommand: null, suppressSilent: false,
          schedule: { kind: 'once-zoned', date: '2026-11-05', hour: 9, minute: 0, timeZone: 'UTC' },
          conversation: { sessionId: displaySessionId }, contextPolicy: { kind: 'isolated', reference: null } } }))
        .toMatchObject({ state: 'waiting', deferred: true })
      expect(await journal.read(runId)).toMatchObject({ phase: 'registered', deferredDispatch: 'queued' })
      if (state === 'paused') {
        const response = await fetch(`${fixture.serverUrl}/v1/projects/${encodeURIComponent(run.projectId)}/automations/${encodeURIComponent(run.automationId)}`, {
          method: 'PATCH', headers: { Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedRevision: run.revision, paused: true }), signal: AbortSignal.timeout(10_000) })
        expect(response.status).toBe(200)
        expect((await response.json() as any).automation).toMatchObject({ paused: true, generation: run.generation + 1 })
      }
      await fixture.stopDaemon()
      await fixture.startDaemon()
    } finally { expect(await manual.finish({ submitted: false, tracked: false })).toBe(true) }
    await eventually(async () => {
      await fixture.children()
      const saved = await journal.read(runId)
      return state === 'active' ? saved?.exitReceipt ? true : undefined : saved?.cancelledBeforeSubmit ? true : undefined
    }, 'daemon restores the original execution or preserves the stop before submission', 45_000)
    const report = await eventually(async () => {
      const feed = await fixture.http(`/v1/sessions/${displaySessionId}/automation-runs`)
      return feed.body.runs?.[0]?.schedulerStatus === (state === 'active' ? 'COMPLETED' : 'FAILED') ? feed.body.runs[0] : undefined
    }, 'daemon flushes the original run report')
    expect(report).toMatchObject({ id: runId, outcome: state === 'active' ? 'WOKE' : 'ERROR' })
    if (state === 'active') expect(await journal.read(runId)).toMatchObject({ phase: 'started', deferredDispatch: 'settled', exitReceipt: { provider: 'claude' } })
    else {
      expect(await journal.read(runId)).toMatchObject({ phase: 'registered', deferredDispatch: 'settled', cancelledBeforeSubmit: true })
      expect(await journal.read(runId)).not.toHaveProperty('exitReceipt')
    }
    expect(calls).toContain('/api/automation/project-environment')
    expect(calls).toContain('/api/automation/mcp-caller-grant')
    expect(fixture.modelRequests).toHaveLength(state === 'active' ? 1 : 0)
    if (state === 'active') expect(fixture.modelRequests[0]).toContain(marker)
    const manualAfter = (await fixture.http('/v2/sessions/lookup', { ids: [displaySessionId] })).body.sessions[0]
    expect(decrypt(prepared.encryptionKey, prepared.encryptionVariant, decodeBase64(manualAfter.metadata))).toMatchObject({ claudeSessionId: 'manual-native-keep' })
    const admission = await workspace.beginManualLaunch([fixture.project])
    expect(admission.acquired).toBe(true)
    if (admission.acquired) expect(await admission.finish({ submitted: false, tracked: false })).toBe(true)
  } catch (error) { failure = new Error(`Deferred daemon failed:\n${await fixture.diagnostics().catch(() => 'Diagnostics unavailable')}`, { cause: error }) }
  finally {
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
        api, journal, workspace,
        runtimeStore: createServerAutomationRuntimeStore({ filePath: join(fixture.happyHome, 'context-runtime.test.json') }),
        heartbeat: async () => { throw new Error('Unexpected fixture deferred renewal') },
        resolveContext: async () => { throw new Error('Unexpected fixture authority recovery') },
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
