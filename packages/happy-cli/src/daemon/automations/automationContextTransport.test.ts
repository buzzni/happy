import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { sessionCreateBodyHash, sessionExecutionAuthorityDigest, rotationDigest, rotationSha256, rotationBase64url,
  rotationIsFresh, signRotationDocument, verifyRotationDocument, SessionExecutionTicketBodySchema,
  SignedAutomationExecutionAuthorityRequestSchema, HappySessionExecutionProofSchema,
  signOrgSetupTokenDocument, orgSetupTokenKeyId, type AutomationPayload } from '@slopus/happy-wire'
import { ApiClient } from '@/api/api'
import { createAutomationContextLaunchJournal } from './automationContextLaunchJournal'
import { createAutomationContextLauncher } from './automationContextLaunch'
import { createAutomationContextAuthorizer, createAutomationContextTransport } from './automationContextTransport'
import { createAutomationContextHost, prepareAutomationContextTick } from './automationContextHost'
import { createAutomationContextWorkspace } from './automationContextWorkspace'
import { createServerAutomationRuntimeStore } from './serverAutomationRuntimeStore'

let home: string, server: Server, origin: string
let seed: { localId: string; content: string } | null, stored: Record<string, unknown> | null
let loseSeedAck: boolean, redirectLookup: boolean, wrongKey: boolean
let issuerMode: 'personal' | 'company' | 'signed-company' | 'redirect' | 'malformed' | 'denied'
const companyDevice = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12))
const companyIssuer = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(13))
const companyOrg = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(14))
let loseRegistrationAck: boolean, failRegistrationBeforeCommit: boolean, corruptCompanyNonce: boolean, foreignCompanyAccount: boolean
let registeredBodyHash: string | null, registeredAuthorityDigest: string | null, registeredProofDigest: string | null
let pendingRegistration: { body: any; proofDigest: string } | null, commitAfterAbsent: number, absentCount: number
let exitMode: 'valid' | 'lost' | 'run' | 'session' | 'provider' | 'time' | 'partial' | 'missing'
let exitAck: any
const requests: Array<{ path: string; authorization: string; body: any }> = []
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'automation-context-http-'))
  requests.length = 0; seed = null; stored = null; loseSeedAck = false; redirectLookup = false; wrongKey = false
  issuerMode = 'personal'
  loseRegistrationAck = false; failRegistrationBeforeCommit = false; corruptCompanyNonce = false; foreignCompanyAccount = false
  registeredBodyHash = null; registeredAuthorityDigest = null; registeredProofDigest = null
  pendingRegistration = null; commitAfterAbsent = 0; absentCount = 0
  exitMode = 'valid'; exitAck = null
  server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = text ? JSON.parse(text) : null
    requests.push({ path: req.url!, authorization: req.headers.authorization ?? '', body })
    if (req.url === '/api/claude-setup-token/daemon/v2/public-key') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ version: 2, algorithm: 'Ed25519', keyId: await rotationSha256(companyIssuer.publicKey),
        publicKey: rotationBase64url(companyIssuer.publicKey), studioOrigin: origin, happyOrigin: origin })); return
    }
    if (req.headers.authorization !== 'Bearer fixture-account-token') { res.writeHead(401).end(); return }
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/automation/execution-target') {
      if (issuerMode === 'redirect') { res.writeHead(307, { Location: '/unexpected-redirect' }).end(); return }
      if (issuerMode === 'denied') { res.writeHead(403).end('{}'); return }
      if (issuerMode === 'signed-company') {
        const executionAuthority = { companyId: 'company-1', machineId: 'm1', approvalId: 'approval-1',
          deviceKeyId: await rotationSha256(companyDevice.publicKey), machineAccountId: foreignCompanyAccount ? 'foreign-owner' : 'owner',
          studioOrigin: origin, happyOrigin: origin, keyId: await rotationSha256(companyIssuer.publicKey) }
        if (!body.executionAuthorityRequest) { res.end(JSON.stringify({ executionBindingRequired: true, executionAuthority })); return }
        try {
          const signed = SignedAutomationExecutionAuthorityRequestSchema.parse(body.executionAuthorityRequest)
          await verifyRotationDocument(signed, companyDevice.publicKey)
          const b = signed.body
          if (!rotationIsFresh(b, Date.now()) || b.runId !== body.runId || b.machineId !== body.machineId
            || b.sessionCreateBodyHash !== await sessionCreateBodyHash(body.createBody)) throw new Error('scope mismatch')
          const executionTicket = await signRotationDocument(SessionExecutionTicketBodySchema.parse({
            version: 1, type: 'saycode-session-execution', audience: origin, studioOrigin: origin, keyId: executionAuthority.keyId,
            companyId: b.companyId, machineId: b.machineId, approvalId: b.approvalId, deviceKeyId: b.deviceKeyId,
            machineOwnerAccountId: b.machineOwnerAccountId, sessionOwnerAccountId: b.sessionOwnerAccountId,
            launchId: b.launchId, operationId: b.operationId,
            initialNonce: corruptCompanyNonce ? rotationBase64url(new Uint8Array(32).fill(99)) : b.initialNonce,
            deviceSigningPublicKey: rotationBase64url(companyDevice.publicKey), sessionTagHash: b.sessionTagHash,
            sessionCreateBodyHash: b.sessionCreateBodyHash, issuedAt: Date.now(), expiresAt: Date.now() + 60000,
          }), companyIssuer.secretKey)
          res.end(JSON.stringify({ targetProof: 'fixture-target-proof', executionBindingRequired: true, executionAuthority,
            executionTicket, executionAuthorityDigest: await sessionExecutionAuthorityDigest(executionTicket.body) })); return
        } catch { res.writeHead(403).end('{}'); return }
      }
      res.end(JSON.stringify({ targetProof: 'fixture-target-proof', executionBindingRequired: issuerMode === 'malformed' ? 'false' : issuerMode === 'company' })); return
    }
    if (req.url === '/v1/automation-runs/r1/execution-session/recover') {
      if (body.claimToken !== 'fixture-claim' || body.machineId !== 'm1' || body.targetProof !== 'fixture-target-proof') { res.writeHead(403).end('{}'); return }
      if (!stored) {
        if (registeredBodyHash) { res.writeHead(409).end('{}'); return }
        absentCount++
        res.end(JSON.stringify({ status: 'NOT_REGISTERED' }))
        if (pendingRegistration && absentCount === commitAfterAbsent) {
          const pending = pendingRegistration.body
          stored = { id: pending.body.tag, seq: 0, metadata: pending.body.metadata, metadataVersion: 0,
            agentState: pending.body.agentState, agentStateVersion: 0, dataEncryptionKey: pending.body.dataEncryptionKey }
          registeredBodyHash = await sessionCreateBodyHash(pending.body)
          registeredAuthorityDigest = pending.executionAuthorityDigest; registeredProofDigest = pendingRegistration.proofDigest
        }
        return
      }
      if ((body.executionAuthorityDigest ?? null) !== registeredAuthorityDigest || await sessionCreateBodyHash(body.body) !== registeredBodyHash) {
        res.writeHead(409).end('{}'); return
      }
      res.end(JSON.stringify({ status: 'REGISTERED', sessionId: stored.id, displaySessionId: 'manual', createBodyHash: registeredBodyHash })); return
    }
    if (req.url === '/v1/automation-runs/r1/execution-exit') {
      if (body.claimToken !== 'fixture-claim' || body.machineId !== 'm1') { res.writeHead(403).end('{}'); return }
      exitAck ??= { runId: 'r1', sessionId: 'automation-run:r1', receipt: { ...body.receipt, receivedAt: 123 } }
      if (exitMode === 'lost') { exitMode = 'valid'; req.socket.destroy(); return }
      const ack = structuredClone(exitAck)
      if (exitMode === 'run') ack.runId = 'another-run'
      if (exitMode === 'session') ack.sessionId = 'manual'
      if (exitMode === 'provider') ack.receipt.provider = 'claude'
      if (exitMode === 'time') ack.receipt.observedAt += 1
      if (exitMode === 'partial') ack.receipt.backgroundDrained = false
      if (exitMode === 'missing') delete ack.receipt
      res.end(JSON.stringify(ack)); return
    }
    if (req.url === '/v1/automation-runs/r1/execution-session') {
      if (body.claimToken !== 'fixture-claim' || body.machineId !== 'm1' || body.targetProof !== 'fixture-target-proof') { res.writeHead(403).end('{}'); return }
      if (issuerMode === 'signed-company') {
        try {
          const proof = HappySessionExecutionProofSchema.parse(body.executionProof)
          await verifyRotationDocument(proof.ticket, companyIssuer.publicKey)
          await verifyRotationDocument(proof.deviceProof, companyDevice.publicKey)
          if (!rotationIsFresh(proof.ticket.body, Date.now()) || !rotationIsFresh(proof.deviceProof.body, Date.now())
            || proof.deviceProof.body.ticketDigest !== await rotationDigest(proof.ticket)
            || body.executionAuthorityDigest !== await sessionExecutionAuthorityDigest(proof.ticket.body)) throw new Error('invalid proof')
          const proofDigest = await rotationDigest(proof)
          if (failRegistrationBeforeCommit) {
            failRegistrationBeforeCommit = false; pendingRegistration = { body, proofDigest }
            res.writeHead(503).end('{}'); return
          }
          if (stored && registeredProofDigest !== proofDigest) { res.writeHead(409).end('{}'); return }
          registeredProofDigest = proofDigest; registeredAuthorityDigest = body.executionAuthorityDigest
          registeredBodyHash = await sessionCreateBodyHash(body.body)
        } catch { res.writeHead(403).end('{}'); return }
      }
      stored ??= { id: body.body.tag, seq: 0, metadata: body.body.metadata, metadataVersion: 0,
        agentState: body.body.agentState, agentStateVersion: 0, dataEncryptionKey: body.body.dataEncryptionKey }
      registeredBodyHash = await sessionCreateBodyHash(body.body)
      if (loseRegistrationAck) { loseRegistrationAck = false; req.socket.destroy(); return }
      res.end(JSON.stringify({ sessionId: stored.id, displaySessionId: 'manual', created: !seed })); return
    }
    if (req.url === '/v2/sessions/lookup') {
      if (redirectLookup) { res.writeHead(302, { Location: '/unexpected-redirect' }).end(); return }
      res.end(JSON.stringify({ sessions: stored ? [{ ...stored, ...(wrongKey ? { dataEncryptionKey: 'foreign-key' } : {}) }] : [] })); return
    }
    if (req.url === '/v3/sessions/automation-run%3Ar1/messages') {
      seed ??= body.messages[0]
      if (stored) stored.seq = 1
      if (loseSeedAck) { loseSeedAck = false; req.socket.destroy(); return }
      res.end(JSON.stringify({ messages: [{ id: 'stored-seed', localId: seed!.localId, seq: 1 }] })); return
    }
    if (req.url === '/v3/sessions/automation-run%3Ar1/messages?after_seq=0&limit=1') {
      res.end(JSON.stringify({ messages: seed ? [{ id: 'stored-seed', localId: seed.localId, seq: 1,
        content: { t: 'encrypted', c: seed.content } }] : [], hasMore: false })); return
    }
    res.writeHead(404).end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  vi.useRealTimers()
  server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve()))
  await rm(home, { recursive: true, force: true })
})
async function setup() {
  const api = await ApiClient.create({ token: 'fixture-account-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } })
  const prepare = vi.spyOn(api, 'prepareSessionCreation')
  const payload: AutomationPayload = { name: 'Task', prompt: 'Current occurrence only', directory: '/work', agent: 'codex',
    scriptCommand: null, suppressSilent: false, schedule: { kind: 'interval', minutes: 60 },
    conversation: { sessionId: 'manual' }, contextPolicy: { kind: 'isolated', reference: null } }
  const input = { automationId: 'a1', generation: 1, revision: 1, runId: 'r1', claimToken: 'fixture-claim', payload }
  const authorize = vi.fn(async (_target: unknown) => ({ targetProof: 'fixture-target-proof', executionBindingRequired: false }))
  const transport = createAutomationContextTransport({ serverUrl: origin, token: 'fixture-account-token', machineId: 'm1',
    runId: 'r1', claimToken: 'fixture-claim', authorize })
  const start = vi.fn(async () => ({ type: 'success' as const, sessionId: 'automation-run:r1' }))
  const deps = { accountId: 'owner', machineId: 'm1', happyOrigin: origin, api, journal: createAutomationContextLaunchJournal(home),
    ...transport, start, discover: async () => 'unconfirmed' as const }
  return { api, prepare, input, authorize, transport, deps, start, launcher: createAutomationContextLauncher(deps) }
}

async function setupCompany(f: Awaited<ReturnType<typeof setup>>, options: { denyBeforeStart?: boolean; missingPin?: boolean } = {}) {
  issuerMode = 'signed-company'
  const approval = await signOrgSetupTokenDocument({ version: 1, kind: 'device-approval', companyId: 'company-1',
    signingGeneration: 1, signingKeyId: await orgSetupTokenKeyId(companyOrg.publicKey), issuedAt: 1000,
    approvalId: 'approval-1', approvalRevision: 1, machineId: 'm1', machineType: 'shared', ownerUserId: null,
    deviceSigningPublicKey: rotationBase64url(companyDevice.publicKey), recipientPublicKey: rotationBase64url(new Uint8Array(32).fill(15)),
    enrollmentDigest: 'a'.repeat(64) }, companyOrg.secretKey)
  const config = { studioOrigin: origin, token: 'fixture-account-token', machineId: 'm1', runId: 'r1', claimToken: 'fixture-claim',
    authority: { journal: f.deps.journal, accountId: 'owner', happyOrigin: origin,
      keys: { signing: companyDevice, recipient: nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(15)) },
      pin: async (_companyId: string) => options.missingPin ? null : { publicKey: rotationBase64url(companyOrg.publicKey), approval } } }
  const authorize = createAutomationContextAuthorizer(config)
  const transport = createAutomationContextTransport({ serverUrl: origin, token: 'fixture-account-token', machineId: 'm1',
    runId: 'r1', claimToken: 'fixture-claim', authorize })
  const launcher = createAutomationContextLauncher({ ...f.deps, ...transport, beforeStart: async (run, prepared) => {
    if (options.denyBeforeStart) issuerMode = 'denied'
    await transport.verifyStart(run, prepared)
  } })
  return { authorize, transport, launcher }
}
const creationRequests = () => requests.filter(row => row.path === '/v1/automation-runs/r1/execution-session')
const signedRequests = () => requests.filter(row => row.path === '/api/automation/execution-target' && row.body.executionAuthorityRequest)

it.each([false, true])('does not start from a reconnect snapshot after the registered execution is deleted (company=%s)', async company => {
  const f = await setup(), transport = company ? (await setupCompany(f)).transport : f.transport
  const launcher = createAutomationContextLauncher({ ...f.deps, ...transport, beforeStart: async (run, prepared) => {
    stored = null
    await transport.verifyStart(run, prepared)
  } })
  await expect(launcher.launch(f.input)).rejects.toThrow()
  expect(f.start).not.toHaveBeenCalled()
  expect(await f.deps.journal.read('r1')).toHaveProperty('phase', 'registered')
})

it.each(['claude', 'codex'] as const)('journals one original company identity and rechecks device authority before %s start', async agent => {
  const f = await setup(); f.input.payload.agent = agent
  const company = await setupCompany(f)
  expect(await company.launcher.launch(f.input)).toHaveProperty('state', 'started')
  const record = await f.deps.journal.read('r1')
  expect(record).toHaveProperty('executionAuthority.registrationConfirmed', true)
  expect(record).not.toHaveProperty('executionAuthority.pendingProof')
  expect(creationRequests()).toHaveLength(1)
  expect(signedRequests()).toHaveLength(2)
  const identities = signedRequests().map(row => row.body.executionAuthorityRequest.body)
  expect(new Set(identities.map(body => `${body.launchId}:${body.operationId}:${body.initialNonce}`)).size).toBe(1)
  expect(identities.every(body => body.agent === agent && body.sessionOwnerAccountId === 'owner')).toBe(true)
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
  for (const secret of [f.input.payload.prompt, 'encryptionKey', 'seedMessage']) expect(JSON.stringify(signedRequests())).not.toContain(secret)
})

it('recovers a lost company registration ACK without a second creation request', async () => {
  const f = await setup(), company = await setupCompany(f); loseRegistrationAck = true
  expect(await company.launcher.launch(f.input)).toHaveProperty('state', 'started')
  expect(creationRequests()).toHaveLength(1)
  expect(requests.filter(row => row.path.endsWith('/execution-session/recover')).length).toBeGreaterThanOrEqual(2)
  expect(await f.deps.journal.read('r1')).toHaveProperty('executionAuthority.registrationConfirmed', true)
  expect(f.start).toHaveBeenCalledOnce()
})

it('renews an unregistered company proof after restart while keeping original body, key and nonce', async () => {
  const f = await setup(), first = await setupCompany(f); failRegistrationBeforeCommit = true
  await expect(first.launcher.launch(f.input)).rejects.toThrow('503')
  const prepared = await f.deps.journal.read('r1')
  expect(f.start).not.toHaveBeenCalled()
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 61000)
  const second = await setupCompany(f)
  expect(await second.launcher.launch(f.input)).toHaveProperty('state', 'started')
  const after = await f.deps.journal.read('r1')
  expect(after?.prepared).toEqual(prepared?.prepared)
  expect(new Set(signedRequests().map(row => row.body.executionAuthorityRequest.body.initialNonce)).size).toBe(1)
  expect(creationRequests()).toHaveLength(2); expect(f.prepare).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
})

it('uses the canonical registration receipt when an earlier company POST wins after an absent lookup', async () => {
  const f = await setup(), first = await setupCompany(f); failRegistrationBeforeCommit = true; commitAfterAbsent = 3
  await expect(first.launcher.launch(f.input)).rejects.toThrow('503')
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 1000)
  const second = await setupCompany(f)
  expect(await second.launcher.launch(f.input)).toHaveProperty('state', 'started')
  expect(creationRequests()).toHaveLength(2)
  expect(absentCount).toBe(3)
  expect(await f.deps.journal.read('r1')).toHaveProperty('executionAuthority.registrationConfirmed', true)
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
})

it('keeps a confirmed company registration after pre-start revocation and resumes by lookup only', async () => {
  const f = await setup(), first = await setupCompany(f, { denyBeforeStart: true })
  await expect(first.launcher.launch(f.input)).rejects.toThrow('403')
  const registered = await f.deps.journal.read('r1')
  expect(registered).toHaveProperty('executionAuthority.registrationConfirmed', true)
  expect(f.start).not.toHaveBeenCalled()
  const second = await setupCompany(f)
  expect(await second.launcher.launch(f.input)).toHaveProperty('state', 'started')
  expect((await f.deps.journal.read('r1'))?.prepared).toEqual(registered?.prepared)
  expect(creationRequests()).toHaveLength(1); expect(f.start).toHaveBeenCalledOnce()
})

it.each(['pin', 'account', 'nonce'] as const)('refuses a company %s mismatch before registration without downgrade', async mismatch => {
  const f = await setup(), company = await setupCompany(f, { missingPin: mismatch === 'pin' })
  foreignCompanyAccount = mismatch === 'account'; corruptCompanyNonce = mismatch === 'nonce'
  await expect(company.launcher.launch(f.input)).rejects.toThrow()
  expect(creationRequests()).toHaveLength(0); expect(f.start).not.toHaveBeenCalled()
  expect(await f.deps.journal.read('r1')).not.toHaveProperty('executionAuthority.registrationConfirmed')
})

it('registers and stores the exact E2EE seed over authenticated HTTP before submitting a provider', async () => {
  const f = await setup()
  expect(await f.launcher.launch(f.input)).toMatchObject({ state: 'started', sessionId: 'automation-run:r1', displaySessionId: 'manual' })
  expect(requests.map(req => req.path)).toEqual(['/v1/automation-runs/r1/execution-session', '/v2/sessions/lookup',
    '/v3/sessions/automation-run%3Ar1/messages', '/v3/sessions/automation-run%3Ar1/messages?after_seq=0&limit=1'])
  expect(requests.every(req => req.authorization === 'Bearer fixture-account-token')).toBe(true)
  expect(requests[0].body).toMatchObject({ machineId: 'm1', claimToken: 'fixture-claim', displaySessionId: 'manual', executionBindingRequired: false })
  expect(f.authorize.mock.calls[0][0]).toMatchObject({ automationId: 'a1', runId: 'r1', generation: 1, revision: 1,
    machineId: 'm1', displaySessionId: 'manual', conversationDirectory: '/work', agent: 'codex' })
  for (const secret of [f.input.payload.prompt, 'encryptionKey', 'seedMessage']) expect(JSON.stringify(f.authorize.mock.calls[0])).not.toContain(secret)
  expect(seed?.localId).toBe('automation-seed:r1')
  expect(seed?.content).not.toContain(f.input.payload.prompt)
  expect(f.start).toHaveBeenCalledOnce()
})

it('rechecks strict admission against the immutable body without re-registering a session or seed', async () => {
  const f = await setup(); await f.launcher.launch(f.input)
  const record = (await f.deps.journal.read('r1'))!
  requests.length = 0
  await f.transport.verifyStart(f.input, record.prepared)
  expect(f.authorize).toHaveBeenCalledTimes(2)
  expect(f.authorize.mock.calls[1]).toEqual(f.authorize.mock.calls[0])
  expect(requests.map(row => row.path)).toEqual(['/v1/automation-runs/r1/execution-session/recover'])
  requests.length = 0
  f.authorize.mockRejectedValueOnce(new Error('AUTOMATION_CONTEXT_AUTHORITY_DENIED'))
  await expect(f.transport.verifyStart(f.input, record.prepared)).rejects.toThrow('AUTOMATION_CONTEXT_AUTHORITY_DENIED')
  expect(requests).toHaveLength(0)
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
})

it('does not confirm an unobserved child or replay it after a spawn ACK without the owned observation pipe', async () => {
  const f = await setup(), directory = join(home, 'workspace'); await mkdir(directory)
  f.input.payload.directory = directory
  const workspace = createAutomationContextWorkspace({ home, isTracked: async () => false })
  const resolveContext = vi.fn(async () => {
    expect(await workspace.beginManualLaunch([directory])).toHaveProperty('acquired', false)
    return { environmentVariables: { CURRENT_AUTHORITY: 'renewed' } }
  })
  const host = createAutomationContextHost({ ...f.deps, workspace,
    reportExit: async () => { throw new Error('Unexpected unobserved exit report') },
    runtimeStore: createServerAutomationRuntimeStore({ filePath: join(home, 'runtime.json') }),
    transportForRun: async () => f.transport,
    resolveContext, heartbeat: async () => ({ ok: true }), log: vi.fn(),
    start: f.start })
  expect(await host.dispatch({ ...f.input, environmentVariables: { EXPIRED_AUTHORITY: 'old' } })).toMatchObject({
    state: 'needs-attention', sessionId: 'automation-run:r1', reason: 'AUTOMATION_START_UNCONFIRMED' })
  expect(resolveContext).toHaveBeenCalledExactlyOnceWith(f.input)
  expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ environmentVariables: { CURRENT_AUTHORITY: 'renewed' } }),
    { environmentVariables: { CURRENT_AUTHORITY: 'renewed' } }, expect.any(Function))
  expect(await f.deps.journal.read('r1')).toHaveProperty('phase', 'submitted')
  expect(await host.dispatch({ ...f.input, environmentVariables: {} })).toHaveProperty('state', 'needs-attention')
  expect(f.start).toHaveBeenCalledOnce()
  expect(resolveContext).toHaveBeenCalledOnce()
  expect(await workspace.beginManualLaunch([directory])).toHaveProperty('acquired', false)
})

it.each(['waiting', 'unconfirmed'] as const)('cancels only original isolated executions and preserves uncertain custody (%s)', async state => {
  const f = await setup(), directory = join(home, 'workspace'); await mkdir(directory)
  f.input.payload.directory = directory; f.input.generation = 2; f.input.revision = 2
  const workspace = createAutomationContextWorkspace({ home, isTracked: async () => false })
  const manual = state === 'waiting' ? await workspace.beginManualLaunch([directory]) : null
  const stopExecution = vi.fn(async () => {})
  const deps = { ...f.deps, workspace, stopExecution,
    reportExit: async () => { throw new Error('No exit reporting in cancellation fixture') },
    runtimeStore: createServerAutomationRuntimeStore({ filePath: join(home, 'runtime.json') }),
    transportForRun: async () => f.transport, resolveContext: async () => ({ environmentVariables: {} }),
    heartbeat: async () => ({ ok: true }), log: vi.fn(), start: f.start }
  const host = createAutomationContextHost(deps)
  if (state === 'waiting') expect(await host.dispatch({ ...f.input, environmentVariables: {} })).toHaveProperty('state', 'waiting')
  else expect(await host.dispatch({ ...f.input, environmentVariables: {} })).toHaveProperty('state', 'needs-attention')
  const cancel = host.cancelAutomation
  expect(await cancel({ automationId: 'another-automation', generation: 2, revision: 2 })).toBe(true)
  expect(await cancel({ automationId: f.input.automationId, generation: 1, revision: 1 })).toBe(true)
  expect(stopExecution).not.toHaveBeenCalled()
  expect(await f.deps.journal.read('r1')).not.toHaveProperty('cancelledBeforeSubmit')
  const identity = { automationId: f.input.automationId, generation: 2, revision: 2 }
  expect(await cancel(identity)).toBe(state === 'waiting')
  if (manual?.acquired) {
    expect(await f.deps.journal.read('r1')).toHaveProperty('cancelledBeforeSubmit', true)
    expect(stopExecution).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
    expect(await manual.finish({ submitted: false, tracked: false })).toBe(true)
  } else {
    expect(stopExecution).toHaveBeenCalledExactlyOnceWith({ sessionId: 'automation-run:r1', directory })
    expect(await workspace.beginManualLaunch([directory])).toHaveProperty('acquired', false)
    // The owned observer, not stop ACK/PID disappearance, supplies a positive durable exit.
    await createAutomationContextLauncher({ ...f.deps, workspace }).recordOwnedExit({ runId: 'r1', sessionId: 'automation-run:r1', provider: 'codex' })
    expect(await cancel(identity)).toBe(true)
    expect(stopExecution).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
    expect(await workspace.beginManualLaunch([directory])).toHaveProperty('acquired', true)
  }
})

it('retries the same durable exit receipt after a lost server ACK without replaying the provider', async () => {
  const f = await setup(), directory = join(home, 'workspace'); await mkdir(directory)
  f.input.payload.directory = directory
  await f.launcher.launch(f.input)
  await f.launcher.recordOwnedExit({ runId: 'r1', sessionId: 'automation-run:r1', provider: 'codex' })
  const saved = (await f.deps.journal.read('r1'))!
  const reportExit = vi.fn(async () => undefined)
  reportExit.mockRejectedValueOnce(new Error('AUTOMATION_CONTEXT_REQUEST_UNCONFIRMED'))
  const log = vi.fn()
  const deps = { ...f.deps, reportExit, workspace: createAutomationContextWorkspace({ home, isTracked: async () => false }),
    runtimeStore: createServerAutomationRuntimeStore({ filePath: join(home, 'runtime.json') }),
    transportForRun: async () => f.transport, resolveContext: async () => ({ environmentVariables: {} }),
    heartbeat: async () => ({ ok: true }), log }
  await createAutomationContextHost(deps).maintain()
  expect(reportExit).toHaveBeenCalledOnce()
  expect(await f.deps.journal.read('r1')).not.toHaveProperty('exitReceiptAcknowledged')
  await createAutomationContextHost(deps).maintain()
  expect(reportExit).toHaveBeenCalledTimes(2)
  expect(reportExit.mock.calls[0]).toEqual([f.input, saved])
  expect(reportExit.mock.calls[1]).toEqual(reportExit.mock.calls[0])
  expect(await f.deps.journal.read('r1')).toHaveProperty('exitReceiptAcknowledged', true)
  await createAutomationContextHost(deps).maintain()
  expect(reportExit).toHaveBeenCalledTimes(2)
  expect(f.start).toHaveBeenCalledOnce()
  expect(log).toHaveBeenCalledOnce()
})

it('posts only the original private claim, creation hash and positive exit receipt and reconciles a lost HTTP ACK', async () => {
  const f = await setup(); await f.launcher.launch(f.input)
  await f.launcher.recordOwnedExit({ runId: 'r1', sessionId: 'automation-run:r1', provider: 'codex' })
  const record = (await f.deps.journal.read('r1'))!
  exitMode = 'lost'
  await expect(f.transport.reportExit(record)).rejects.toThrow('AUTOMATION_CONTEXT_REQUEST_UNCONFIRMED')
  await expect(f.transport.reportExit(record)).resolves.toBeUndefined()
  const sent = requests.filter(row => row.path.endsWith('/execution-exit'))
  expect(sent).toHaveLength(2)
  expect(sent[0]).toEqual(sent[1])
  expect(sent[0].body).toEqual({ machineId: 'm1', claimToken: 'fixture-claim',
    createBodyHash: await sessionCreateBodyHash(record.prepared.body), receipt: { version: 1, ...record.exitReceipt,
      providerExitedCleanly: true, foregroundDrained: true, backgroundDrained: true, writeProducersDrained: true } })
  for (const secret of [f.input.payload.prompt, record.prepared.encryptionKey, record.prepared.body.metadata, record.prepared.seedMessage.content]) {
    expect(JSON.stringify(sent)).not.toContain(secret)
  }
  expect(f.authorize).toHaveBeenCalledOnce()
  expect(f.start).toHaveBeenCalledOnce()
})

it.each(['run', 'session', 'provider', 'time', 'partial', 'missing'] as const)('refuses a mismatched exit HTTP ACK: %s', async mode => {
  const f = await setup(); await f.launcher.launch(f.input)
  await f.launcher.recordOwnedExit({ runId: 'r1', sessionId: 'automation-run:r1', provider: 'codex' })
  exitMode = mode
  await expect(f.transport.reportExit((await f.deps.journal.read('r1'))!)).rejects.toThrow()
  expect(await f.deps.journal.read('r1')).not.toHaveProperty('exitReceiptAcknowledged')
  expect(f.start).toHaveBeenCalledOnce()
})

it('refuses a different claim before issuing a proof or performing a registration request', async () => {
  const f = await setup()
  await expect(f.launcher.launch({ ...f.input, claimToken: 'changed-claim' })).rejects.toThrow('AUTOMATION_CONTEXT_IDENTITY_CONFLICT')
  expect(f.authorize).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
})

it('recovers a lost HTTP storage ACK with the same ciphertext and no early or duplicate provider', async () => {
  const f = await setup(); loseSeedAck = true
  await expect(f.launcher.launch(f.input)).rejects.toThrow('AUTOMATION_CONTEXT_REQUEST_UNCONFIRMED')
  expect(f.start).not.toHaveBeenCalled()
  const first = structuredClone(seed)
  expect(await createAutomationContextLauncher(f.deps).launch(f.input)).toMatchObject({ state: 'started' })
  expect(seed).toEqual(first)
  const writes = requests.filter(req => req.path.includes('/messages') && req.body?.messages)
  expect(writes).toHaveLength(2)
  expect(writes[0].body).toEqual(writes[1].body)
  expect(f.prepare).toHaveBeenCalledOnce()
  expect(f.start).toHaveBeenCalledOnce()
})

it('requires a real signed execution proof when the trusted issuer requires one', async () => {
  const f = await setup()
  f.authorize.mockResolvedValue({ targetProof: 'fixture-target-proof', executionBindingRequired: true })
  await expect(f.launcher.launch(f.input)).rejects.toThrow('AUTOMATION_EXECUTION_PROOF_REQUIRED')
  expect(requests).toHaveLength(0)
  expect(f.start).not.toHaveBeenCalled()
})

it.each(['key', 'redirect'])('refuses a mismatched session %s without legacy creation or native dispatch', async reason => {
  const f = await setup(); wrongKey = reason === 'key'; redirectLookup = reason === 'redirect'
  await expect(f.launcher.launch(f.input)).rejects.toThrow(reason === 'key' ? 'AUTOMATION_CONTEXT_RECEIPT_CONFLICT' : 'AUTOMATION_CONTEXT_REQUEST_UNCONFIRMED')
  expect(f.start).not.toHaveBeenCalled()
  expect(requests.some(req => req.path === '/v1/sessions' || req.path === '/unexpected-redirect')).toBe(false)
})

it('requests scoped admission only from the configured Studio origin without sending private input or keys', async () => {
  const f = await setup()
  const authorize = createAutomationContextAuthorizer({ studioOrigin: origin, token: 'fixture-account-token', machineId: 'm1', runId: 'r1', claimToken: 'fixture-claim' })
  const transport = createAutomationContextTransport({ serverUrl: origin, token: 'fixture-account-token', machineId: 'm1', runId: 'r1', claimToken: 'fixture-claim', authorize })
  expect(await createAutomationContextLauncher({ ...f.deps, ...transport }).launch(f.input)).toHaveProperty('state', 'started')
  expect(requests[0]).toEqual({ path: '/api/automation/execution-target', authorization: 'Bearer fixture-account-token', body: {
    machineId: 'm1', runId: 'r1', claimToken: 'fixture-claim', generation: 1, revision: 1,
    conversationSessionId: 'manual', conversationDirectory: '/work', agent: 'codex', createBody: f.prepare.mock.results[0].value.body,
  } })
  for (const secret of [f.input.payload.prompt, 'encryptionKey', 'seedMessage']) expect(JSON.stringify(requests[0])).not.toContain(secret)
  expect(f.start).toHaveBeenCalledOnce()
})

it.each(['company', 'redirect', 'malformed', 'denied'] as const)('never falls back to legacy admission after a %s response', async mode => {
  const f = await setup(); issuerMode = mode
  const authorize = createAutomationContextAuthorizer({ studioOrigin: origin, token: 'fixture-account-token', machineId: 'm1', runId: 'r1', claimToken: 'fixture-claim' })
  const transport = createAutomationContextTransport({ serverUrl: origin, token: 'fixture-account-token', machineId: 'm1', runId: 'r1', claimToken: 'fixture-claim', authorize })
  await expect(createAutomationContextLauncher({ ...f.deps, ...transport }).launch(f.input)).rejects.toThrow()
  expect(requests.map(row => row.path)).toEqual(['/api/automation/execution-target'])
  expect(f.start).not.toHaveBeenCalled()
})

it.each([null, 'http://untrusted.example', 'https://studio.example/path', 'https://user:secret@studio.example', 'https://studio.example/?other=1'])(
  'rejects an absent or invalid trusted origin (%s)', studioOrigin => {
    expect(() => createAutomationContextAuthorizer({ studioOrigin, token: 'fixture-account-token', machineId: 'm1', runId: 'r1', claimToken: 'fixture-claim' })).toThrow()
    expect(requests).toHaveLength(0)
  })


it.each(['ready', 'broken', 'missing', 'aborted'] as const)('prepares legacy ticking without admitting isolated work after failed recovery (%s)', async state => {
  const controller = new AbortController(), dispatch = vi.fn(), cancelAutomation = vi.fn(), log = vi.fn()
  const maintain = vi.fn(async () => {
    if (state === 'broken') throw new Error('SENSITIVE_JOURNAL_VALUE_MUST_NOT_BE_LOGGED')
    if (state === 'aborted') controller.abort()
  })
  const admission = await prepareAutomationContextTick(state === 'missing' ? null : { maintain, dispatch, cancelAutomation }, controller.signal, log)
  expect(admission.isolatedContextReady).toBe(state === 'ready')
  expect(admission.dispatchIsolatedContext).toBe(state === 'ready' ? dispatch : undefined)
  expect(admission.cancelIsolatedContext).toBe(state === 'ready' ? cancelAutomation : undefined)
  expect(maintain).toHaveBeenCalledTimes(state === 'missing' ? 0 : 1)
  expect(log).toHaveBeenCalledTimes(state === 'broken' ? 1 : 0)
  expect(JSON.stringify(log.mock.calls)).not.toContain('SENSITIVE_JOURNAL_VALUE')
})

it.each(['changed', 'deleted'])('keeps the frozen previous reference and holds after workspace waiting when it is %s', async reason => {
  const f = await setup(), directory = join(home, 'workspace'); await mkdir(directory)
  f.input.payload.directory = directory
  const payload = { ...f.input.payload, contextPolicy: { kind: 'isolated' as const,
    reference: { kind: 'previous-result' as const, maxBytes: 16384 } } }
  const previousResult = { automationId: 'a1', runId: 'prior', revision: 1, status: 'COMPLETED', question: 'Original question', answer: 'PRIVATE_SELECTED_ANSWER' }
  let unavailable = false
  const resolvePreviousResult = vi.fn(async () => {
    if (unavailable && reason === 'deleted') throw new Error('AUTOMATION_REFERENCE_HTTP_404')
    return unavailable ? { ...previousResult, answer: 'DIFFERENT_ANSWER' } : previousResult
  })
  const workspace = createAutomationContextWorkspace({ home, isTracked: async () => false })
  const manual = await workspace.beginManualLaunch([directory]); expect(manual.acquired).toBe(true)
  const deps = { ...f.deps, workspace, resolvePreviousResult,
    reportExit: async () => { throw new Error('No exit reporting before provider') },
    runtimeStore: createServerAutomationRuntimeStore({ filePath: join(home, 'runtime.json') }),
    transportForRun: async () => f.transport, resolveContext: async () => ({ environmentVariables: {} }),
    heartbeat: vi.fn(async (_input: unknown) => ({ ok: true })), log: vi.fn(), start: f.start }
  const host = createAutomationContextHost(deps)
  const prepared = await (host as any).prepare({ automationId: 'a1', generation: 1, revision: 1, payload })
  expect(prepared).toEqual({ previousResult })
  await host.dispatch({ ...f.input, payload, ...prepared, environmentVariables: {} })
  expect(deps.heartbeat).toHaveBeenCalledWith({ runId: 'r1', claimToken: f.input.claimToken, holdCode: 'WORKSPACE_BUSY' })
  const original = await f.deps.journal.read('r1')
  unavailable = true
  if (manual.acquired) await manual.finish({ submitted: false, tracked: false })
  await createAutomationContextHost(deps).maintain()
  expect(f.start).not.toHaveBeenCalled()
  expect(await f.deps.journal.read('r1')).toMatchObject({ phase: 'registered', deferredDispatch: 'queued', prepared: original!.prepared })
  expect(await f.deps.journal.read('r1')).toHaveProperty('deferredHoldCode', reason === 'changed' ? 'AUTOMATION_REFERENCE_CHANGED' : 'AUTOMATION_REFERENCE_UNCONFIRMED')
  expect(deps.heartbeat).toHaveBeenLastCalledWith({ runId: 'r1', claimToken: f.input.claimToken,
    holdCode: reason === 'changed' ? 'AUTOMATION_REFERENCE_CHANGED' : 'AUTOMATION_REFERENCE_UNCONFIRMED' })
  expect(resolvePreviousResult).toHaveBeenLastCalledWith({ automationId: 'a1', generation: 1, revision: 1, displaySessionId: 'manual', beforeRunId: 'r1' })
  expect(JSON.stringify(deps.log.mock.calls)).not.toContain(previousResult.answer)
})

const questionIdentity = { requestId: 'ad5ab630-9a10-4dc7-957e-e2d628a4df2a', sourceRunId: 'prior' }
it('keeps the explicit question identity when preparing its selected previous result', async () => {
  const f = await setup()
  const payload = { ...f.input.payload, executionQuestion: questionIdentity,
    contextPolicy: { kind: 'isolated' as const, reference: { kind: 'previous-result' as const, maxBytes: 16384 } } }
  const previousResult = { automationId: 'a1', runId: 'prior', revision: 1, status: 'COMPLETED', question: 'Selected question', answer: 'Selected answer' }
  const resolvePreviousResult = vi.fn(async () => previousResult)
  const host = createAutomationContextHost({ ...f.deps,
    workspace: createAutomationContextWorkspace({ home, isTracked: async () => false }), resolvePreviousResult,
    runtimeStore: createServerAutomationRuntimeStore({ filePath: join(home, 'runtime.json') }),
    transportForRun: async () => f.transport, resolveContext: async () => ({ environmentVariables: {} }),
    reportExit: async () => {}, heartbeat: async () => ({ ok: true }), log: () => {}, start: f.start })
  expect(await host.prepare({ ...f.input, runId: questionIdentity.requestId, payload })).toEqual({ previousResult })
  expect(resolvePreviousResult).toHaveBeenCalledWith({ automationId: 'a1', generation: 1, revision: 1,
    displaySessionId: 'manual', questionIdentity })
  expect(f.start).not.toHaveBeenCalled()
})
it('sends the question identity to the trusted Studio issuer', async () => {
  const authorize = createAutomationContextAuthorizer({ studioOrigin: origin, token: 'fixture-account-token', machineId: 'm1',
    runId: questionIdentity.requestId, claimToken: 'fixture-claim' })
  await authorize({ automationId: 'a1', runId: questionIdentity.requestId, generation: 1, revision: 1,
    machineId: 'm1', displaySessionId: 'manual', conversationDirectory: '/work', agent: 'codex',
    questionRequestId: questionIdentity.requestId, body: { tag: `automation-run:${questionIdentity.requestId}`, metadata: 'cipher', agentState: null } } as any)
  expect(requests.find(row => row.path === '/api/automation/execution-target')?.body).toHaveProperty('questionRequestId', questionIdentity.requestId)
})
it.each(['register', 'verifyStart'] as const)('forwards the sealed question identity during %s authorization', async action => {
  const f = await setup(), authorize = vi.fn(async (_target: unknown): Promise<never> => { throw new Error('stop-before-http') })
  const transport = createAutomationContextTransport({ serverUrl: origin, token: 'fixture-account-token', machineId: 'm1',
    runId: questionIdentity.requestId, claimToken: 'fixture-claim', authorize })
  const run = { ...f.input, runId: questionIdentity.requestId, payload: { ...f.input.payload, executionQuestion: questionIdentity,
    contextPolicy: { kind: 'isolated' as const, reference: { kind: 'previous-result' as const, maxBytes: 16384 } } } }
  const prepared = { body: { tag: `automation-run:${questionIdentity.requestId}`, metadata: 'cipher', agentState: null },
    encryptionKey: 'key', encryptionVariant: 'legacy' as const }
  await expect(transport[action](run, prepared as any)).rejects.toThrow('stop-before-http')
  expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ questionRequestId: questionIdentity.requestId }))
  expect(f.start).not.toHaveBeenCalled()
})
