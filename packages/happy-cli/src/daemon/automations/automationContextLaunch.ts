import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { SessionExecutionCreateBodySchema, automationExecutionSeedSchema, automationExecutionSeedManifestSchema,
  automationExecutionSeedArtifactSchema, automationExecutionSeedLocalId, automationExecutionSessionId, isAutomationExecutionSessionId, automationPayloadSchema } from '@slopus/happy-wire'
import type { ApiClient } from '@/api/api'
import type { Metadata, Session } from '@/api/types'
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers'
import { decodeBase64, decrypt, encrypt, encodeBase64 } from '@/api/encryption'
import { createSessionMetadata } from '@/utils/createSessionMetadata'
import { buildReconnectSessionEnvironment, RECONNECT_FRESH_LAUNCH_ENV } from '../reconnectSessionEnv'
import { OwnedStartRefused } from '../ownedSpawn'
import { buildAutomationContextInput } from './automationContextInput'
import type { createAutomationContextWorkspace } from './automationContextWorkspace'

export const automationContextLaunchRecordSchema = z.strictObject({
  version: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  automationId: z.string().min(1).max(200), generation: z.number().int().positive(), revision: z.number().int().positive(),
  runId: z.string().min(1).max(160), displaySessionId: z.string().min(1).max(200),
  phase: z.enum(['prepared', 'registered', 'submitted', 'started']),
  prepared: z.strictObject({ body: SessionExecutionCreateBodySchema, encryptionKey: z.string().length(44), encryptionVariant: z.enum(['legacy', 'dataKey']),
    requestCiphertext: z.string().min(1).max(1024 * 1024).optional(),
    seedMessage: z.strictObject({ localId: z.string().min(1).max(200), content: z.string().min(1).max(1024 * 1024) }) }),
  sessionId: z.string().min(1).max(200),
  exitReceipt: z.strictObject({ provider: z.enum(['claude', 'codex']), observedAt: z.number().int().nonnegative() }).optional(),
  exitReceiptAcknowledged: z.literal(true).optional(),
  workspaceOwnerToken: z.string().uuid().optional(),
  deferredDispatch: z.enum(['queued', 'settled']).optional(),
  cancelledBeforeSubmit: z.literal(true).optional(),
})
export type AutomationContextLaunchRecord = z.infer<typeof automationContextLaunchRecordSchema>

export interface AutomationContextLaunchJournal {
  exclusive<T>(runId: string, work: () => Promise<T>): Promise<T>
  read(runId: string): Promise<AutomationContextLaunchRecord | null>
  listRunIds(): Promise<string[]>
  write(record: AutomationContextLaunchRecord): Promise<void>
}

const launchRequestSchema = z.strictObject({ automationId: z.string().min(1).max(200), generation: z.number().int().positive(), revision: z.number().int().positive(),
  runId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/), claimToken: z.string().min(1).max(256), payload: automationPayloadSchema, previousResult: z.unknown().optional() })
export type AutomationContextLaunchRequest = z.infer<typeof launchRequestSchema>
type AutomationContextRecovery = { state: 'not-started' | 'running' | 'ended' | 'needs-attention'; sessionId: string; displaySessionId: string;
  automationId: string; generation: number; revision: number }
export interface AutomationContextLaunchDependencies {
  accountId: string; machineId: string; happyOrigin: string
  api: Pick<ApiClient, 'prepareSessionCreation'>
  journal: AutomationContextLaunchJournal
  workspace?: Pick<ReturnType<typeof createAutomationContextWorkspace>, 'acquireAutomation' | 'recoverAutomationExit' | 'releaseUnsubmitted'>
  register(request: AutomationContextLaunchRequest, prepared: AutomationContextLaunchRecord['prepared']): Promise<Session>
  /** Append with the stable localId and return the stored ciphertext, including on an idempotent replay. */
  persistSeed(session: Session, message: AutomationContextLaunchRecord['prepared']['seedMessage']): Promise<{ seq: number; localId: string; content: string }>
  /** Refresh authority after workspace waiting, while failure still proves no provider submission. */
  beforeStart?(request: AutomationContextLaunchRequest, prepared: AutomationContextLaunchRecord['prepared']): Promise<void>
  /** Must use the daemon's submission guard. Only OwnedStartRefused proves a pre-submit refusal. */
  start(options: SpawnSessionOptions): Promise<SpawnSessionResult>
  /** Only positively tracked runtime liveness; termination comes from the durable private exit receipt. */
  discover(sessionId: string): Promise<'running' | 'unconfirmed'>
}
export function createAutomationContextLauncher(deps: AutomationContextLaunchDependencies) {
  const operations = new Map<string, Promise<unknown>>()
  function exclusive<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const previous = operations.get(runId) ?? Promise.resolve()
    const perform = () => deps.journal.exclusive(runId, work)
    const current = previous.then(perform, perform)
    operations.set(runId, current)
    const settled = () => { if (operations.get(runId) === current) operations.delete(runId) }
    void current.then(settled, settled)
    return current
  }
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const scope = digest([deps.happyOrigin, deps.accountId, deps.machineId])
  const normalizeRequest = (input: AutomationContextLaunchRequest) => {
    const { previousResult, ...request } = input
    return launchRequestSchema.parse({ ...request,
      ...(input.payload.contextPolicy?.reference?.kind === 'previous-result' ? { previousResult } : {}) })
  }
  const hashRequest = (input: AutomationContextLaunchRequest) => digest({ request: input, seed: buildAutomationContextInput(input) })
  function assertIdentity(record: AutomationContextLaunchRecord, runId: string) {
    const sessionId = automationExecutionSessionId(runId)
    if (record.scope !== scope || record.runId !== runId || record.sessionId !== sessionId
      || record.prepared.body.tag !== sessionId || isAutomationExecutionSessionId(record.displaySessionId)) {
      throw new Error('AUTOMATION_LAUNCH_IDENTITY_CONFLICT')
    }
  }
  function workspaceIdentity(record: AutomationContextLaunchRecord) {
    const metadata = decrypt(decodeBase64(record.prepared.encryptionKey), record.prepared.encryptionVariant,
      decodeBase64(record.prepared.body.metadata)) as Metadata
    return { runId: record.runId, roots: [metadata.path], ownerToken: record.workspaceOwnerToken! }
  }
  async function releaseWorkspace(record: AutomationContextLaunchRecord, unsubmitted: boolean) {
    if (!deps.workspace || !record.workspaceOwnerToken) return
    const identity = workspaceIdentity(record)
    if (unsubmitted) await deps.workspace.releaseUnsubmitted(identity)
    else await deps.workspace.recoverAutomationExit({ ...identity,
      evidence: { providerExitedCleanly: true, foregroundDrained: true, backgroundDrained: true, writeProducersDrained: true } })
  }
  return {
    async markDeferred(runId: string): Promise<boolean> {
      return exclusive(runId, async () => {
        const record = await deps.journal.read(runId)
        if (!record) throw new Error('AUTOMATION_DEFERRED_STATE_CONFLICT')
        assertIdentity(record, runId)
        if (record.cancelledBeforeSubmit || record.deferredDispatch === 'settled'
          || record.phase !== 'prepared' && record.phase !== 'registered') throw new Error('AUTOMATION_DEFERRED_STATE_CONFLICT')
        if (!record.deferredDispatch) await deps.journal.write({ ...record, deferredDispatch: 'queued' })
        return true
      })
    },
    async finishDeferred(runId: string): Promise<void> {
      await exclusive(runId, async () => {
        const record = await deps.journal.read(runId)
        if (!record?.deferredDispatch) throw new Error('AUTOMATION_DEFERRED_STATE_CONFLICT')
        assertIdentity(record, runId)
        if (record.deferredDispatch !== 'settled') await deps.journal.write({ ...record, deferredDispatch: 'settled' })
      })
    },
    async cancelUnsubmitted(runId: string): Promise<boolean> {
      return exclusive(runId, async () => {
        const record = await deps.journal.read(runId)
        if (!record) throw new Error('AUTOMATION_DEFERRED_STATE_CONFLICT')
        assertIdentity(record, runId)
        if (record.phase !== 'prepared' && record.phase !== 'registered') return false
        if (!record.cancelledBeforeSubmit) await deps.journal.write({ ...record, cancelledBeforeSubmit: true })
        await releaseWorkspace(record, true)
        return true
      })
    },
    /** Private owned-child observer only, after matching native evidence AND actual root close(0, null). */
    async recordOwnedExit(input: { runId: string; sessionId: string; provider: 'claude' | 'codex' }): Promise<void> {
      await exclusive(input.runId, async () => {
        const record = await deps.journal.read(input.runId)
        if (!record) throw new Error('AUTOMATION_EXIT_RECEIPT_CONFLICT')
        assertIdentity(record, input.runId)
        const metadata = decrypt(decodeBase64(record.prepared.encryptionKey), record.prepared.encryptionVariant,
          decodeBase64(record.prepared.body.metadata)) as Metadata
        if (record.sessionId !== input.sessionId || metadata.flavor !== input.provider
          || record.phase !== 'submitted' && record.phase !== 'started') throw new Error('AUTOMATION_EXIT_RECEIPT_CONFLICT')
        if (!record.exitReceipt) await deps.journal.write({ ...record, exitReceipt: { provider: input.provider, observedAt: Date.now() } })
        await releaseWorkspace(record, false)
      })
    },
    async acknowledgeOwnedExit(input: { runId: string; sessionId: string; provider: 'claude' | 'codex'; observedAt: number }): Promise<void> {
      await exclusive(input.runId, async () => {
        const record = await deps.journal.read(input.runId)
        if (!record) throw new Error('AUTOMATION_EXIT_RECEIPT_CONFLICT')
        assertIdentity(record, input.runId)
        if (record.sessionId !== input.sessionId || record.exitReceipt?.provider !== input.provider
          || record.exitReceipt.observedAt !== input.observedAt) throw new Error('AUTOMATION_EXIT_RECEIPT_CONFLICT')
        if (!record.exitReceiptAcknowledged) await deps.journal.write({ ...record, exitReceiptAcknowledged: true })
      })
    },
    /** Private daemon input only. Never return this snapshot through browser RPC or logs. */
    async restoreRequest(runId: string): Promise<AutomationContextLaunchRequest | null> {
      return exclusive(runId, async () => {
        const record = await deps.journal.read(runId)
        if (!record) return null
        assertIdentity(record, runId)
        const invalid = () => { throw new Error('AUTOMATION_LAUNCH_SNAPSHOT_INVALID') }
        if (!record.prepared.requestCiphertext) return invalid()
        let decrypted: unknown
        try { decrypted = decrypt(decodeBase64(record.prepared.encryptionKey), record.prepared.encryptionVariant, decodeBase64(record.prepared.requestCiphertext)) }
        catch { return invalid() }
        const value = launchRequestSchema.safeParse(decrypted)
        if (!value.success) return invalid()
        const saved = normalizeRequest(value.data)
        if (saved.automationId !== record.automationId || saved.generation !== record.generation || saved.revision !== record.revision
          || saved.runId !== runId || saved.payload.conversation?.sessionId !== record.displaySessionId || hashRequest(saved) !== record.requestHash) return invalid()
        return saved
      })
    },
    async recoverAll(): Promise<Array<AutomationContextRecovery & { runId: string }>> {
      const recovered: Array<AutomationContextRecovery & { runId: string }> = []
      for (const runId of await deps.journal.listRunIds()) {
        const result = await this.recover(runId)
        if (!result) throw new Error('AUTOMATION_LAUNCH_JOURNAL_INVALID')
        recovered.push({ runId, ...result })
      }
      return recovered
    },
    /** Reconcile the immutable old run even after edit/pause/delete; this method never dispatches. */
    async recover(runId: string): Promise<AutomationContextRecovery | null> {
      const sessionId = automationExecutionSessionId(runId)
      return exclusive(runId, async () => {
        const record = await deps.journal.read(runId)
        if (!record) return null
        assertIdentity(record, runId)
        const identity = { sessionId, displaySessionId: record.displaySessionId, automationId: record.automationId,
          generation: record.generation, revision: record.revision }
        if (record.phase === 'prepared' || record.phase === 'registered') {
          await releaseWorkspace(record, true)
          return { ...identity, state: 'not-started' }
        }
        if (record.exitReceipt) { await releaseWorkspace(record, false); return { ...identity, state: 'ended' } }
        const observed = await deps.discover(sessionId)
        if (observed === 'unconfirmed') return { ...identity, state: 'needs-attention' }
        if (record.phase !== 'started') await deps.journal.write({ ...record, phase: 'started' })
        return { ...identity, state: observed }
      })
    },
    async launch(input: AutomationContextLaunchRequest): Promise<{
    state: 'started' | 'needs-attention' | 'waiting'; sessionId: string; displaySessionId: string; reason?: string
  }> {
    input = normalizeRequest(input)
    const seed = buildAutomationContextInput(input)
    const { automationId, generation, revision, runId } = input
    const { directory, model, effort } = input.payload, agent = input.payload.agent as 'claude' | 'codex'
    const sessionId = automationExecutionSessionId(runId), displaySessionId = input.payload.conversation!.sessionId
    if (isAutomationExecutionSessionId(displaySessionId)) throw new Error('AUTOMATION_LAUNCH_IDENTITY_CONFLICT')
    const executionSeed = automationExecutionSeedSchema.parse({ version: 1, automationId, generation, revision, runId, displaySessionId,
      question: input.payload.prompt, inputBytes: seed.inputBytes, referenceBytes: seed.referenceBytes, references: seed.references,
      inputSha256: createHash('sha256').update(seed.initialPrompt).digest('hex'), wholeContextTokens: 'unknown',
      ...(seed.referenceSnapshots ? { referenceSnapshots: seed.referenceSnapshots } : {}),
      ...(seed.referenceResolution ? { referenceResolution: seed.referenceResolution } : {}) })
    const { question, referenceSnapshots: _snapshots, ...seedFields } = executionSeed
    const seedManifest = automationExecutionSeedManifestSchema.parse({ ...seedFields,
      questionBytes: Buffer.byteLength(question, 'utf8'), seedSha256: digest(executionSeed) })
    const requestHash = hashRequest(input)
    const publicResult = (state: 'started' | 'needs-attention') => ({ state, sessionId, displaySessionId })
    return exclusive(runId, async () => {
      let record = await deps.journal.read(runId)
      if (record && (record.scope !== scope || record.requestHash !== requestHash || record.sessionId !== sessionId
        || record.displaySessionId !== displaySessionId || record.automationId !== automationId
        || record.generation !== generation || record.revision !== revision)) throw new Error('AUTOMATION_LAUNCH_IDENTITY_CONFLICT')
      if (record?.cancelledBeforeSubmit) return { ...publicResult('needs-attention'), reason: 'cancelled-before-submit' }
      if (record?.exitReceipt) { await releaseWorkspace(record, false); return publicResult('started') }
      if (record?.phase === 'started') return publicResult('started')
      if (record?.phase === 'submitted') {
        const receipt = await deps.discover(sessionId)
        if (receipt === 'unconfirmed') return publicResult('needs-attention')
        await deps.journal.write({ ...record, phase: 'started' })
        return publicResult('started')
      }
      if (!record) {
        const { metadata, state } = createSessionMetadata({ flavor: agent, machineId: deps.machineId, startedBy: 'daemon', source: 'schedule' })
        metadata.path = directory
        metadata.automationExecutionSeedManifest = seedManifest
        const prepared = deps.api.prepareSessionCreation({ tag: sessionId, metadata, state })
        record = { version: 1, scope, requestHash, automationId, generation, revision, runId, displaySessionId, sessionId, phase: 'prepared',
          ...(deps.workspace ? { workspaceOwnerToken: randomUUID() } : {}),
          prepared: { ...prepared, encryptionKey: encodeBase64(prepared.encryptionKey),
            requestCiphertext: encodeBase64(encrypt(prepared.encryptionKey, prepared.encryptionVariant, input)), seedMessage: {
            localId: automationExecutionSeedLocalId(runId), content: encodeBase64(encrypt(prepared.encryptionKey, prepared.encryptionVariant,
              automationExecutionSeedArtifactSchema.parse({ type: 'automation-execution-seed', seed: executionSeed }))) } } }
        // No provider or server side effect precedes this durable, immutable encrypted creation body.
        await deps.journal.write(record)
      }
      const prepared = record.prepared, encryptionKey = decodeBase64(prepared.encryptionKey)
      const metadata = decrypt(encryptionKey, prepared.encryptionVariant, decodeBase64(prepared.body.metadata)) as Metadata
      const state = prepared.body.agentState ? decrypt(encryptionKey, prepared.encryptionVariant, decodeBase64(prepared.body.agentState)) : null
      const artifact = automationExecutionSeedArtifactSchema.parse(decrypt(encryptionKey, prepared.encryptionVariant, decodeBase64(prepared.seedMessage.content)))
      if (encryptionKey.length !== 32 || prepared.body.tag !== sessionId || metadata?.path !== directory || metadata.machineId !== deps.machineId
        || metadata.flavor !== agent || metadata.claudeSessionId || metadata.codexThreadId || metadata.parentSessionId || metadata.forkedFromMessageId
        || digest(metadata.automationExecutionSeedManifest) !== digest(seedManifest)
        || prepared.seedMessage.localId !== automationExecutionSeedLocalId(runId) || digest(artifact.seed) !== seedManifest.seedSha256
        || !z.strictObject({ controlledByUser: z.literal(false) }).safeParse(state).success) throw new Error('AUTOMATION_LAUNCH_SNAPSHOT_INVALID')
      if (!prepared.requestCiphertext || digest(decrypt(encryptionKey, prepared.encryptionVariant, decodeBase64(prepared.requestCiphertext))) !== digest(input)) {
        throw new Error('AUTOMATION_LAUNCH_SNAPSHOT_INVALID')
      }
      const registered = await deps.register(structuredClone(input), structuredClone(prepared))
      if (registered.id !== sessionId || (registered.seq !== 0 && registered.seq !== 1) || registered.encryptionVariant !== prepared.encryptionVariant
        || !Buffer.from(registered.encryptionKey).equals(Buffer.from(encryptionKey))
        || registered.metadata?.claudeSessionId || registered.metadata?.codexThreadId) throw new Error('AUTOMATION_LAUNCH_RECEIPT_CONFLICT')
      record = { ...record, phase: 'registered' }
      await deps.journal.write(record)
      const seedReceipt = await deps.persistSeed(registered, structuredClone(prepared.seedMessage))
      if (seedReceipt.seq !== 1 || seedReceipt.localId !== prepared.seedMessage.localId || seedReceipt.content !== prepared.seedMessage.content) {
        throw new Error('AUTOMATION_SEED_RECEIPT_CONFLICT')
      }
      if (deps.workspace) {
        if (!record.workspaceOwnerToken) {
          record = { ...record, workspaceOwnerToken: randomUUID() }
          await deps.journal.write(record)
        }
        // This durable phase proves no provider dispatch occurred. A previous daemon may have
        // acquired preparation ownership and died before advancing to submitted.
        await releaseWorkspace(record, true)
        const admitted = await deps.workspace.acquireAutomation(workspaceIdentity(record))
        if (!admitted.acquired) return { state: 'waiting', sessionId, displaySessionId, reason: admitted.reason }
      }
      const reconnectEnvironment = { ...buildReconnectSessionEnvironment({ sessionId, encryption: registered,
        serverSnapshot: { ...registered, metadata, seq: 1 }, baselineSeq: 1 }), [RECONNECT_FRESH_LAUNCH_ENV]: '1' }
      const options: SpawnSessionOptions = { directory, agent, model: model ?? undefined, effort: effort ?? undefined,
        initialPrompt: seed.initialPrompt, initialPromptLocalId: `happy-automation:${runId}`, exitAfterFirstTurn: true,
        reconnectEnvironment }
      try { await deps.beforeStart?.(structuredClone(input), structuredClone(prepared)) }
      catch (error) { await releaseWorkspace(record, true); throw error }
      record = { ...record, phase: 'submitted' }
      try { await deps.journal.write(record) }
      catch (error) { await releaseWorkspace(record, true); throw error }
      try {
        const started = await deps.start(options)
        if (started.type !== 'success' || started.sessionId !== sessionId) throw new Error('AUTOMATION_START_UNCONFIRMED')
      } catch (error) {
        if (error instanceof OwnedStartRefused) {
          try { await deps.journal.write({ ...record, phase: 'registered' }) }
          finally { await releaseWorkspace(record, true) }
        }
        throw error
      }
      await deps.journal.write({ ...record, phase: 'started' })
      return publicResult('started')
    })
  } }
}
