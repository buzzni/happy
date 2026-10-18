import axios from 'axios'
import nacl from 'tweetnacl'
import { describe, expect, it, vi } from 'vitest'
import { rotationDigest, rotationSha256, sessionCreateBodyHash, sessionTagHash, signRotationDocument, verifyRotationDocument,
  type DaemonRotationRequestBody, type MachineSetupTokenBindingV2, type HappySessionExecutionProof } from '@slopus/happy-wire'
import { ApiClient } from '@/api/api'
import type { Metadata } from '@/api/types'
import type { SessionPersistenceResult } from '@/persistence'
import type { DeviceOrgPin } from './deviceOrgPinStore'
import { createMachineSetupTokenProtocol, MachineRotationError, type MachineRotationResult } from './machineSetupTokenProtocol'
import { createMachineSetupTokenRuntime } from './machineSetupTokenRuntime'
import type { MachineRotationJournalRecord } from './machineSetupTokenJournal'
import { isMachineSetupTokenBinding, readSetupTokenResumeSelection, formatSetupTokenBinding, SETUP_TOKEN_BINDING_ENV } from './sessionEnv'
import type { TrackedSession } from './types'

vi.mock('axios', () => ({ default: { post: vi.fn() } }))
const NOW = 1800000000000, companyId = 'company', machineId = 'machine', studioOrigin = 'https://studio.test', happyOrigin = 'https://happy.test'
const originalOwner = 'staged-personal-account', machineOwner = 'company-owner'
const refusal = { observedAt: NOW, reason: 'rate-limited' as const, retryAt: null, windows: [] }
async function setup() {
  const keys = { signing: nacl.sign.keyPair(), recipient: nacl.box.keyPair() }, studio = nacl.sign.keyPair()
  const keyId = await rotationSha256(studio.publicKey), deviceKeyId = await rotationSha256(keys.signing.publicKey)
  const config = { companyId, machineId, studioOrigin, happyOrigin, studioPublicKey: Buffer.from(studio.publicKey).toString('base64url') }
  const pin = { publicKey: 'org', approval: { body: { kind: 'device-approval', companyId, machineId, machineType: 'shared', ownerUserId: null,
    approvalId: 'approval', deviceSigningPublicKey: Buffer.from(keys.signing.publicKey).toString('base64url') } } } as DeviceOrgPin
  let clock = NOW;
  const steps: string[] = [], requests: DaemonRotationRequestBody[] = [], disk = new Map<string, MachineRotationJournalRecord>()
  const drafts = new Map<string, any>(), createdSessions = new Map<string, any>()
  const operations = new Map<string, MachineRotationResult>(), bindings = new Map<string, MachineSetupTokenBindingV2>()
  const relations = new Map<string, string>(), sessions = new Map<string, TrackedSession>(), acknowledged = new Map<string, string>()
  let invalidTicket: 'owner' | 'device' | 'body' | undefined
  let loseCreate = false, loseIssue = false, issueBeforeSend = false
  let denyInitialQuery = false;
  let deny = false, saveFailure = false, crashAfterRebind = false, commitTimeout = false, claimTimeout = false, count = 0
  const journal = { read: async (id: string) => structuredClone(disk.get(id) ?? null), write: vi.fn(async (record: MachineRotationJournalRecord) => {
    if (crashAfterRebind && record.pending?.binding?.bindingRevision === 2) { crashAfterRebind = false; throw new MachineRotationError('PERSISTENCE_FAILED') }
    disk.set(record.launchId, structuredClone(record)); steps.push('journal')
  }) }
  const serve = async (url: string | URL | Request, options?: RequestInit): Promise<Response> => {
    if (String(url).endsWith('/public-key')) return Response.json({ version: 2, algorithm: 'Ed25519', publicKey: config.studioPublicKey, keyId, studioOrigin, happyOrigin })
    const document = JSON.parse(String(options?.body)); await verifyRotationDocument(document, keys.signing.publicKey)
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer company-machine-bearer' })
    const body = document.body as DaemonRotationRequestBody; requests.push(body); steps.push(body.action)
    if (deny) return Response.json({ error: 'SETUP_TOKEN_DAEMON_MACHINE_FORBIDDEN' }, { status: 403 })
    if (body.action === 'issue' && issueBeforeSend) { issueBeforeSend = false; throw new Error('not received') }
    if (body.action === 'operation') {
      if (denyInitialQuery && requests.some(r => r.action === 'issue' && r.operationId === body.targetOperationId)) return Response.json({}, { status: 403 });
      const op = operations.get(body.targetOperationId)
      return op ? Response.json(op) : Response.json({ error: 'SETUP_TOKEN_DAEMON_OPERATION_NOT_FOUND' }, { status: 404 })
    }
    const prior = operations.get(body.operationId); if (prior) return Response.json(prior)
    if (body.action === 'issue' || body.action === 'rebind') {
      const pending = disk.get(body.launchId)?.pending
      expect(pending?.request.operationId).toBe(body.operationId) // Intent ACK BEFORE mutation.
      const previous = body.action === 'rebind' ? bindings.get(body.nonce)! : undefined
      if (body.action === 'rebind') {
        expect(body.observation).toMatchObject({ managedAccountId: previous!.managedAccountId, credentialGeneration: 1, accountWideRefusal: 'account_limit', windows: [] })
      }
      const binding: MachineSetupTokenBindingV2 = { version: 2, type: 'claude-setup-token-binding', audience: 'saycode-daemon', principalType: 'machine', companyId, machineId,
        groupScope: companyId, assignmentGeneration: 1, assignmentFingerprint: 'a'.repeat(64), managedAccountId: previous ? 'account-b' : 'account-a', credentialGeneration: 1,
        approvalId: 'approval', deviceKeyId, launchId: body.launchId, bindingRevision: previous ? previous.bindingRevision + 1 : 1, previousNonce: previous?.nonce ?? null,
        nonce: Buffer.alloc(32, ++count).toString('base64url'), issuedAt: NOW, expiresAt: NOW + 60000, keyId }
      bindings.set(binding.nonce, binding)
      const result: MachineRotationResult = { version: 2, operationId: body.operationId, state: 'pending', binding: await signRotationDocument(binding, studio.secretKey) }
      if (body.action === 'issue') result.executionTicket = await signRotationDocument({ version: 1, type: 'saycode-session-execution', audience: happyOrigin, studioOrigin, keyId, companyId, machineId,
        machineOwnerAccountId: machineOwner, sessionOwnerAccountId: invalidTicket === 'owner' ? 'wrong-owner' : body.sessionOwnerAccountId, launchId: body.launchId, initialNonce: binding.nonce, operationId: body.operationId,
        approvalId: 'approval', deviceKeyId, deviceSigningPublicKey: Buffer.from(invalidTicket === 'device' ? nacl.sign.keyPair().publicKey : keys.signing.publicKey).toString('base64url'),
        sessionTagHash: body.sessionTagHash, sessionCreateBodyHash: invalidTicket === 'body' ? 'f'.repeat(64) : body.sessionCreateBodyHash, issuedAt: NOW, expiresAt: NOW + 60000 }, studio.secretKey)
      operations.set(body.operationId, result); if (body.action === 'issue' && loseIssue) { loseIssue = false; throw new Error('issue response lost') }; return Response.json(result)
    }
    const binding = bindings.get(body.nonce)!
    expect(relations.get(body.launchId)).toBe(body.sessionId) // Exact authenticated execution relation.
    if (body.action === 'claim' || body.action === 'commit') {
      if (body.action === 'commit') {
        expect(acknowledged.get(body.sessionId)).toContain(binding.nonce)
        expect(body.bindingDigest).toBe(await rotationDigest(await signRotationDocument(binding, studio.secretKey)))
      }
      const state = body.action === 'claim' ? 'claimed' : 'committed'
      for (const result of operations.values()) if (result.binding?.body.nonce === binding.nonce) result.state = state
      const result: MachineRotationResult = { version: 2, operationId: body.operationId, state }; operations.set(body.operationId, result)
      if (body.action === 'commit' && commitTimeout) { commitTimeout = false; throw new Error('response lost after commit') }
      if (body.action === 'claim' && claimTimeout) { claimTimeout = false; throw new Error('response lost after claim') }
      return Response.json(result)
    }
    return Response.json({ version: 2, operationId: body.operationId, state: 'recorded' })
  }
  const fetcher = vi.fn(serve) as typeof fetch
  const protocol = createMachineSetupTokenProtocol({ config, keys, pin: async () => pin, bearer: () => 'company-machine-bearer', fetch: fetcher, now: () => clock })
  let persisted: TrackedSession | undefined
  const persist = vi.fn(async (session: TrackedSession, binding: string): Promise<SessionPersistenceResult> => {
    steps.push('persist'); persisted = session
    if (saveFailure) return { status: 'failed' }
    session.agentEnvironment = { ...session.agentEnvironment, [SETUP_TOKEN_BINDING_ENV]: binding }; acknowledged.set(session.happySessionId!, binding); return { status: 'committed' }
  })
  const sessionEnvironment = vi.fn(async (_agent, _selection, binding) => {
    steps.push('token'); return { CLAUDE_CODE_OAUTH_TOKEN: `SYNTHETIC-${binding.managedAccountId}`, [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(binding) }
  })
  const build = (allowInitialIssue = true) => createMachineSetupTokenRuntime({ allowInitialIssue: () => allowInitialIssue, protocol, journal: { ...journal, list: async () => [...disk.keys()] }, sessionEnvironment, persist, findSession: id => sessions.get(id),
    savePrepared: async (id, _hash, draft) => { drafts.set(id, draft); return { status: 'committed' } },
    loadPrepared: async id => drafts.get(id),
    discoverSession: async (state, _snapshot, proof) => {
      if (createdSessions.has(state.launchId)) return createdSessions.get(state.launchId);
      if (!proof) return null;
      return (await axios.post('https://happy.test/v1/sessions', { ...state.pending!.createBody, executionProof: proof }, { headers: { Authorization: 'Bearer original-staged-bearer' } })).data.session;
    },
  })
  vi.mocked(axios.post).mockImplementation(async (_url, value, options) => {
    steps.push('create')
    expect(options?.headers?.Authorization).toBe('Bearer original-staged-bearer')
    const { executionProof, ...body } = value as Record<string, unknown> & { executionProof: HappySessionExecutionProof }
    expect(body.tag).toBeTypeOf('string')
    await verifyRotationDocument(executionProof.deviceProof, keys.signing.publicKey)
    expect(executionProof.ticket.body.sessionCreateBodyHash).toBe(await sessionCreateBodyHash(body as never))
    expect(executionProof.deviceProof.body.sessionTagHash).toBe(await sessionTagHash(String(body.tag)))
    expect(executionProof.ticket.body.sessionOwnerAccountId).toBe(originalOwner)
    const sessionId = `session-${relations.size + 1}`; relations.set(executionProof.ticket.body.launchId, sessionId)
    const raw = { id: sessionId, seq: 0, metadata: body.metadata, metadataVersion: 1, agentState: body.agentState, agentStateVersion: 1 }
    createdSessions.set(executionProof.ticket.body.launchId, raw)
    if (loseCreate) { loseCreate = false; throw new Error('response lost after create') }
    return { data: { session: raw } }
  })
  const api = await ApiClient.create({ token: 'original-staged-bearer', encryption: { type: 'legacy', secret: new Uint8Array(32) } })
  const input = { metadata: { path: '/project', host: 'box' } as Metadata, ownerAccountId: originalOwner, machineOwnerAccountId: machineOwner, userHomeDir: '/staged-home',
    createSession: (input: Parameters<typeof api.getOrCreateSession>[0]) => api.getOrCreateSession(input) }
  const attach = (environment: Record<string, string>) => {
    const binding = readSetupTokenResumeSelection({ [SETUP_TOKEN_BINDING_ENV]: environment[SETUP_TOKEN_BINDING_ENV] })!.binding
    if (!isMachineSetupTokenBinding(binding)) throw new Error('machine expected')
    const tracked = { ...persisted!, pid: 123, agentEnvironment: { [SETUP_TOKEN_BINDING_ENV]: environment[SETUP_TOKEN_BINDING_ENV] } }
    sessions.set(binding.execution.sessionId, tracked)
    return { tracked, binding }
  }
  return { denyInitialQuery: () => { denyInitialQuery = true }, advance: (ms: number) => { clock += ms }, build, input, attach, requests, steps, disk, sessions, operations, persist, sessionEnvironment, journal,
    invalidTicket: (value: typeof invalidTicket) => { invalidTicket = value },
    loseCreate: () => { loseCreate = true }, loseIssue: (before = false) => { if (before) issueBeforeSend = true; else loseIssue = true }, drafts,
    failSave: (value: boolean) => { saveFailure = value }, deny: () => { deny = true }, crashRebind: () => { crashAfterRebind = true }, loseCommit: () => { commitTimeout = true }, loseClaim: () => { claimTimeout = true } }
}
describe('machine-v2 actual launch and control consumer transaction', () => {
  it('creates under the original staged Happy account, proves the encrypted payload, and returns token only after persistence and commit', async () => {
    const t = await setup(), prepared = await t.build().prepareLaunch(t.input)
    expect(prepared.reconnectEnvironment.HAPPY_RECONNECT_SESSION_ID).toBe(prepared.session.id)
    expect(prepared.session.metadata.setupTokenRotation).toEqual({ version: 1, principalType: 'machine', bindingVersion: 2 })
    expect(t.steps).toEqual(['journal', 'issue', 'journal', 'create', 'journal', 'persist', 'claim', 'persist', 'commit', 'journal', 'token'])
    expect(t.persist.mock.calls[0][0].userHomeDir).toBe('/staged-home')
    const serialized = JSON.stringify([...t.disk.values()]); expect(serialized).not.toMatch(/SYNTHETIC|bearer|signature|executionTicket|deviceProof/)
  })
  it('denies enabled launch without creating or returning provider credentials', async () => {
    const t = await setup(); t.deny()
    await expect(t.build().prepareLaunch(t.input)).rejects.toThrow('FORBIDDEN')
    expect(t.steps).not.toContain('create'); expect(t.sessionEnvironment).not.toHaveBeenCalled()
  })
  it.each(['owner', 'device', 'body'] as const)('rejects a signed but incorrectly bound execution ticket (%s) before Happy create or token return', async field => {
    const t = await setup(); t.invalidTicket(field);
    await expect(t.build().prepareLaunch(t.input)).rejects.toThrow('BINDING_REJECTED');
    expect(t.steps).not.toContain('create'); expect(t.sessionEnvironment).not.toHaveBeenCalled();
  });
  it('returns no token on local persistence failure and recovers the exact consumed operation without selecting again', async () => {
    const t = await setup(), runtime = t.build(), launch = await runtime.prepareLaunch(t.input), { binding, tracked } = t.attach(launch.environment)
    t.failSave(true)
    await expect(runtime.rebind(launch.session.id, launch.environment[SETUP_TOKEN_BINDING_ENV], refusal)).rejects.toThrow('PERSISTENCE_FAILED')
    expect(t.sessionEnvironment).toHaveBeenCalledTimes(1)
    expect([...t.disk.values()][0].current).toBe(launch.environment[SETUP_TOKEN_BINDING_ENV])
    t.failSave(false)
    const recovered = await t.build().resume(tracked, binding)
    expect(recovered.CLAUDE_CODE_OAUTH_TOKEN).toBe('SYNTHETIC-account-b')
    expect(t.requests.filter(r => r.action === 'rebind')).toHaveLength(1)
    expect(t.requests.some(r => r.action === 'operation')).toBe(true)
  })
  it.each(['claim', 'commit'] as const)('recovers a lost %s response via query and the same action IDs', async action => {
    const t = await setup(), launch = await t.build().prepareLaunch(t.input), { binding, tracked } = t.attach(launch.environment)
    if (action === 'claim') t.loseClaim(); else t.loseCommit()
    await expect(t.build().rebind(launch.session.id, launch.environment[SETUP_TOKEN_BINDING_ENV], refusal)).rejects.toThrow('REQUEST_FAILED')
    const recovered = await t.build().resume(tracked, binding)
    expect(recovered.CLAUDE_CODE_OAUTH_TOKEN).toBe('SYNTHETIC-account-b')
    expect(t.requests.filter(r => r.action === 'rebind')).toHaveLength(1)
    expect(t.requests.filter(r => r.action === action && r.bindingRevision === 2)).toHaveLength(1)
  })
  it('queries the saved operation after a crash immediately after rebind selection but before saving the returned binding', async () => {
    const t = await setup(), launch = await t.build().prepareLaunch(t.input), { binding, tracked } = t.attach(launch.environment)
    t.crashRebind()
    await expect(t.build().rebind(launch.session.id, launch.environment[SETUP_TOKEN_BINDING_ENV], refusal)).rejects.toThrow('PERSISTENCE_FAILED')
    expect((await t.build().resume(tracked, binding)).CLAUDE_CODE_OAUTH_TOKEN).toBe('SYNTHETIC-account-b')
    expect(t.requests.filter(r => r.action === 'rebind')).toHaveLength(1)
  })
  it('preserves the original refusal ID and timestamp across exhausted retries rather than refreshing evidence', async () => {
    const t = await setup(), runtime = t.build(), launch = await runtime.prepareLaunch(t.input); t.attach(launch.environment);
    const running = launch.environment[SETUP_TOKEN_BINDING_ENV];
    // A usage observation and the atomic final observation must name the same original evidence.
    await runtime.reportUsage(launch.session.id, running, refusal);
    await runtime.rebind(launch.session.id, running, refusal);
    const evidence = t.requests.filter(r => r.action === 'usage' || r.action === 'rebind').map(r => 'observation' in r ? r.observation : null);
    expect(evidence[0]).toEqual(evidence[1]); expect(evidence[0]?.observedAt).toBe(NOW);
  });
  it('durably fences first provider submission and never resets that fence on rotation or process replacement', async () => {
    const t = await setup(), runtime = t.build(), launch = await runtime.prepareLaunch(t.input), { binding } = t.attach(launch.environment);
    expect(await runtime.canStartWithoutConversation(binding)).toBe(true);
    await runtime.recordProviderStart(binding);
    expect(await t.build().canStartWithoutConversation(binding)).toBe(false);
    await runtime.rebind(launch.session.id, launch.environment[SETUP_TOKEN_BINDING_ENV], refusal);
    expect([...t.disk.values()][0].startSubmitted).toBe(true);
  });
  it('refuses a concurrent resume while the initial launch is still committing', async () => {
    const t = await setup(), runtime = t.build(), original = t.persist.getMockImplementation()!;
    t.persist.mockImplementationOnce(async (session, encoded) => {
      const result = await original(session, encoded);
      const binding = readSetupTokenResumeSelection({ [SETUP_TOKEN_BINDING_ENV]: encoded })!.binding;
      if (!isMachineSetupTokenBinding(binding)) throw new Error('machine expected');
      await expect(runtime.resume(session, binding)).rejects.toThrow('LAUNCH_IN_PROGRESS');
      return result;
    });
    await runtime.prepareLaunch(t.input);
    expect(t.sessionEnvironment).toHaveBeenCalledTimes(1);
  });
  it('coalesces concurrent rebind consumers and catches a stale provider up without another selection', async () => {
    const t = await setup(), runtime = t.build(), launch = await runtime.prepareLaunch(t.input); t.attach(launch.environment)
    const id = launch.session.id, running = launch.environment[SETUP_TOKEN_BINDING_ENV]
    const [a, b] = await Promise.all([runtime.rebind(id, running, refusal), runtime.rebind(id, running, refusal)])
    expect(a).toEqual(b); expect(t.requests.filter(r => r.action === 'rebind')).toHaveLength(1)
    expect(await runtime.rebind(id, running, refusal)).toEqual(a)
    expect(t.requests.filter(r => r.action === 'rebind')).toHaveLength(1)
  })
  it('gives simultaneous new launches separate operation/session/nonce bindings', async () => {
    const t = await setup(), runtime = t.build()
    const [a, b] = await Promise.all([runtime.prepareLaunch(t.input), runtime.prepareLaunch(t.input)])
    expect(a.session.id).not.toBe(b.session.id)
    const records = [...t.disk.values()].map(s => s.current)
    expect(new Set(records).size).toBe(2); expect(t.requests.filter(r => r.action === 'issue')).toHaveLength(2)
  })
  it('does not return an in-flight switch token after the session ended', async () => {
    const t = await setup(), runtime = t.build(), launch = await runtime.prepareLaunch(t.input); t.attach(launch.environment)
    const original = t.persist.getMockImplementation()!
    t.persist.mockImplementation(async (session, binding) => { const result = await original(session, binding); t.sessions.clear(); return result })
    await expect(runtime.rebind(launch.session.id, launch.environment[SETUP_TOKEN_BINDING_ENV], refusal)).rejects.toThrow('NOT_BOUND')
    expect(t.sessionEnvironment).toHaveBeenCalledTimes(1)
  })
  it('recovers the original create after response loss with its durable encryption snapshot, without issuing another selection', async () => {
    const t = await setup(); t.loseCreate()
    await expect(t.build().prepareLaunch(t.input)).rejects.toThrow('Execution-bound session creation failed')
    expect(t.sessionEnvironment).not.toHaveBeenCalled()
    expect(t.drafts.size).toBe(1)
    await t.build().recoverLaunches()
    expect(t.requests.filter(r => r.action === 'issue')).toHaveLength(1)
    expect([...t.disk.values()][0].current).toBeTruthy()
    // Recovery publishes resume authority but never starts/feeds a provider itself.
    expect(t.sessionEnvironment).not.toHaveBeenCalled()
  })
  it.each([false, true])('recovers the original issue operation after a crash before session create (before-send=%s)', async before => {
    const t = await setup(); t.loseIssue(before);
    await expect(t.build().prepareLaunch(t.input)).rejects.toThrow('REQUEST_FAILED');
    await t.build().recoverLaunches();
    expect(new Set(t.requests.filter(r => r.action === 'issue').map(r => r.operationId)).size).toBe(1);
    expect([...t.disk.values()][0].current).toBeTruthy();
    expect(t.sessionEnvironment).not.toHaveBeenCalled();
  });
  it('does not issue an unreceived pending initial operation while new issuance is OFF', async () => {
    const t = await setup(); t.loseIssue(true);
    await expect(t.build().prepareLaunch(t.input)).rejects.toThrow();
    await expect(t.build(false).recoverLaunches()).rejects.toThrow('ISSUANCE_DISABLED');
    expect(t.requests.filter(r => r.action === 'issue')).toHaveLength(1);
    expect(t.sessionEnvironment).not.toHaveBeenCalled();
  });
  it('recovers an expired initial ticket only through an already registered execution, with no new selection', async () => {
    const t = await setup(); t.loseCreate();
    await expect(t.build().prepareLaunch(t.input)).rejects.toThrow(); t.advance(120000);
    await t.build().recoverLaunches();
    expect(t.requests.filter(r => r.action === 'issue')).toHaveLength(1);
    expect([...t.disk.values()][0].current).toBeTruthy(); expect(t.sessionEnvironment).not.toHaveBeenCalled();
  });
  it('keeps an expired uncertain create fail-closed instead of selecting again when no registered execution is recoverable', async () => {
    const t = await setup(); t.loseIssue();
    await expect(t.build().prepareLaunch(t.input)).rejects.toThrow(); t.advance(120000);
    await expect(t.build().recoverLaunches()).rejects.toThrow('PERSISTENCE_INDETERMINATE');
    expect(t.requests.filter(r => r.action === 'issue')).toHaveLength(1);
    expect(t.steps).not.toContain('create'); expect(t.sessionEnvironment).not.toHaveBeenCalled();
  });
  it('resumes an authorized finished session with a pending commit, while live rebind still requires the exact running child', async () => {
    const t = await setup(), launch = await t.build().prepareLaunch(t.input), { binding, tracked } = t.attach(launch.environment)
    t.loseCommit()
    await expect(t.build().rebind(launch.session.id, launch.environment[SETUP_TOKEN_BINDING_ENV], refusal)).rejects.toThrow()
    t.sessions.clear()
    expect((await t.build().resume(tracked, binding)).CLAUDE_CODE_OAUTH_TOKEN).toBe('SYNTHETIC-account-b')
    await expect(t.build().rebind(launch.session.id, launch.environment[SETUP_TOKEN_BINDING_ENV], refusal)).rejects.toThrow('NOT_BOUND')
  })

})

it('primary review: an exhausted recovered rebind never returns the old token as a successful switch', async () => {
  const t = await setup(), runtime = t.build(), launch = await runtime.prepareLaunch(t.input), { binding, tracked } = t.attach(launch.environment)
  t.crashRebind()
  await expect(runtime.rebind(launch.session.id, launch.environment[SETUP_TOKEN_BINDING_ENV], refusal)).rejects.toThrow('PERSISTENCE_FAILED')
  const pending = [...t.disk.values()][0].pending!
  t.operations.set(pending.request.operationId, { version: 2, operationId: pending.request.operationId, state: 'exhausted' })
  await expect(t.build().resume(tracked, binding)).rejects.toThrow('NO_ACCOUNT')
  expect(t.sessionEnvironment).toHaveBeenCalledTimes(1)
})
it('primary review: usage and rebind preserve the same observation identity across retries', async () => {
 const t=await setup(),runtime=t.build(),launch=await runtime.prepareLaunch(t.input);t.attach(launch.environment)
 const running=launch.environment[SETUP_TOKEN_BINDING_ENV]
 await runtime.reportUsage(launch.session.id,running,refusal)
 await runtime.rebind(launch.session.id,running,refusal)
 const observations=t.requests.filter(r=>r.action==='usage'||r.action==='rebind').map(r=>r.observation)
 expect(observations[1]).toEqual(observations[0])
})

it('primary review: resume validates current committed authority rather than an obsolete initial assignment', async () => {
 const t=await setup(),runtime=t.build(),launch=await runtime.prepareLaunch(t.input),{tracked}=t.attach(launch.environment)
 const current=await runtime.rebind(launch.session.id,launch.environment[SETUP_TOKEN_BINDING_ENV],refusal)
 const binding=readSetupTokenResumeSelection(current)!.binding
 if (!isMachineSetupTokenBinding(binding)) throw new Error('machine expected')
 t.denyInitialQuery()
 expect(await t.build().resume(tracked,binding)).toEqual(current)
 expect(t.requests.filter(r=>r.action==='rebind')).toHaveLength(1)
})
