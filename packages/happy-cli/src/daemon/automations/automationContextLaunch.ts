import { z } from 'zod'
import { createHash } from 'node:crypto'
import { SessionExecutionCreateBodySchema, automationExecutionSeedSchema, automationExecutionSeedManifestSchema,
  automationExecutionSeedArtifactSchema, automationExecutionSeedLocalId, automationExecutionSessionId, isAutomationExecutionSessionId, type AutomationPayload } from '@slopus/happy-wire'
import type { ApiClient } from '@/api/api'
import type { Metadata, Session } from '@/api/types'
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers'
import { decodeBase64, decrypt, encrypt, encodeBase64 } from '@/api/encryption'
import { createSessionMetadata } from '@/utils/createSessionMetadata'
import { buildReconnectSessionEnvironment, RECONNECT_FRESH_LAUNCH_ENV } from '../reconnectSessionEnv'
import { OwnedStartRefused } from '../ownedSpawn'
import { buildAutomationContextInput } from './automationContextInput'

export const automationContextLaunchRecordSchema = z.strictObject({
  version: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  automationId: z.string().min(1).max(200), generation: z.number().int().positive(), revision: z.number().int().positive(),
  runId: z.string().min(1).max(160), displaySessionId: z.string().min(1).max(200),
  phase: z.enum(['prepared', 'registered', 'submitted', 'started']),
  prepared: z.strictObject({ body: SessionExecutionCreateBodySchema, encryptionKey: z.string().length(44), encryptionVariant: z.enum(['legacy', 'dataKey']),
    seedMessage: z.strictObject({ localId: z.string().min(1).max(200), content: z.string().min(1).max(1024 * 1024) }) }),
  sessionId: z.string().min(1).max(200),
})
export type AutomationContextLaunchRecord = z.infer<typeof automationContextLaunchRecordSchema>

export interface AutomationContextLaunchJournal {
  exclusive<T>(runId: string, work: () => Promise<T>): Promise<T>
  read(runId: string): Promise<AutomationContextLaunchRecord | null>
  write(record: AutomationContextLaunchRecord): Promise<void>
}

export interface AutomationContextLaunchRequest {
  automationId: string; generation: number; revision: number; runId: string; payload: AutomationPayload; previousResult?: unknown
}
export interface AutomationContextLaunchDependencies {
  accountId: string; machineId: string; happyOrigin: string
  api: Pick<ApiClient, 'prepareSessionCreation'>
  journal: AutomationContextLaunchJournal
  register(request: AutomationContextLaunchRequest, prepared: AutomationContextLaunchRecord['prepared']): Promise<Session>
  /** Append with the stable localId and return the stored ciphertext, including on an idempotent replay. */
  persistSeed(session: Session, message: AutomationContextLaunchRecord['prepared']['seedMessage']): Promise<{ seq: number; localId: string; content: string }>
  /** Must use the daemon's submission guard. Only OwnedStartRefused proves a pre-submit refusal. */
  start(options: SpawnSessionOptions): Promise<SpawnSessionResult>
  /** 'ended' requires an owned exit receipt, never just PID absence or a disconnected socket. */
  discover(sessionId: string): Promise<'running' | 'ended' | 'unconfirmed'>
}
export function createAutomationContextLauncher(deps: AutomationContextLaunchDependencies) {
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const scope = digest([deps.happyOrigin, deps.accountId, deps.machineId])
  return {
    /** Reconcile the immutable old run even after edit/pause/delete; this method never dispatches. */
    async recover(runId: string): Promise<null | {
      state: 'not-started' | 'running' | 'ended' | 'needs-attention'; sessionId: string; displaySessionId: string;
      automationId: string; generation: number; revision: number
    }> {
      const sessionId = automationExecutionSessionId(runId)
      return deps.journal.exclusive(runId, async () => {
        const record = await deps.journal.read(runId)
        if (!record) return null
        if (record.scope !== scope || record.runId !== runId || record.sessionId !== sessionId
          || record.prepared.body.tag !== sessionId || isAutomationExecutionSessionId(record.displaySessionId)) {
          throw new Error('AUTOMATION_LAUNCH_IDENTITY_CONFLICT')
        }
        const identity = { sessionId, displaySessionId: record.displaySessionId, automationId: record.automationId,
          generation: record.generation, revision: record.revision }
        if (record.phase === 'prepared' || record.phase === 'registered') return { ...identity, state: 'not-started' }
        const observed = await deps.discover(sessionId)
        if (observed === 'unconfirmed') return { ...identity, state: 'needs-attention' }
        if (record.phase !== 'started') await deps.journal.write({ ...record, phase: 'started' })
        return { ...identity, state: observed }
      })
    },
    async launch(input: AutomationContextLaunchRequest): Promise<{
    state: 'started' | 'needs-attention'; sessionId: string; displaySessionId: string
  }> {
    const seed = buildAutomationContextInput(input)
    const { automationId, generation, revision, runId } = input
    const { directory, model, effort } = input.payload, agent = input.payload.agent as 'claude' | 'codex'
    const sessionId = automationExecutionSessionId(runId), displaySessionId = input.payload.conversation!.sessionId
    if (isAutomationExecutionSessionId(displaySessionId)) throw new Error('AUTOMATION_LAUNCH_IDENTITY_CONFLICT')
    const executionSeed = automationExecutionSeedSchema.parse({ version: 1, automationId, generation, revision, runId, displaySessionId,
      question: input.payload.prompt, inputBytes: seed.inputBytes, referenceBytes: seed.referenceBytes, references: seed.references,
      inputSha256: createHash('sha256').update(seed.initialPrompt).digest('hex'), wholeContextTokens: 'unknown' })
    const { question, ...seedFields } = executionSeed
    const seedManifest = automationExecutionSeedManifestSchema.parse({ ...seedFields,
      questionBytes: Buffer.byteLength(question, 'utf8'), seedSha256: digest(executionSeed) })
    const requestHash = digest({ automationId, generation, revision, runId, displaySessionId, directory, agent,
      model: model ?? null, effort: effort ?? null, seed })
    const publicResult = (state: 'started' | 'needs-attention') => ({ state, sessionId, displaySessionId })
    return deps.journal.exclusive(runId, async () => {
      let record = await deps.journal.read(runId)
      if (record && (record.scope !== scope || record.requestHash !== requestHash || record.sessionId !== sessionId
        || record.displaySessionId !== displaySessionId || record.automationId !== automationId
        || record.generation !== generation || record.revision !== revision)) throw new Error('AUTOMATION_LAUNCH_IDENTITY_CONFLICT')
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
          prepared: { ...prepared, encryptionKey: encodeBase64(prepared.encryptionKey), seedMessage: {
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
      const reconnectEnvironment = { ...buildReconnectSessionEnvironment({ sessionId, encryption: registered,
        serverSnapshot: { ...registered, metadata, seq: 1 }, baselineSeq: 1 }), [RECONNECT_FRESH_LAUNCH_ENV]: '1' }
      const options: SpawnSessionOptions = { directory, agent, model: model ?? undefined, effort: effort ?? undefined,
        initialPrompt: seed.initialPrompt, initialPromptLocalId: `happy-automation:${runId}`, exitAfterFirstTurn: true,
        reconnectEnvironment }
      record = { ...record, phase: 'submitted' }
      await deps.journal.write(record)
      try {
        const started = await deps.start(options)
        if (started.type !== 'success' || started.sessionId !== sessionId) throw new Error('AUTOMATION_START_UNCONFIRMED')
      } catch (error) {
        if (error instanceof OwnedStartRefused) await deps.journal.write({ ...record, phase: 'registered' })
        throw error
      }
      await deps.journal.write({ ...record, phase: 'started' })
      return publicResult('started')
    })
  } }
}
