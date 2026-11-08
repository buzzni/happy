import { z } from 'zod'
import { createHash } from 'node:crypto'
import { automationExecutionSeedManifestSchema, automationExecutionSessionId, automationPreviousResultDataSchema, automationExecutionQuestionIdentitySchema,
  automationPreviousResultNoneSchema, readAutomationExecutionRecord, sessionCreateBodyHash } from '@slopus/happy-wire'
import { decodeBase64, decrypt } from '@/api/encryption'
import type { AutomationContextLaunchJournal } from './automationContextLaunch'

const selectionSchema = z.strictObject({ automationId: z.string().min(1).max(200), generation: z.number().int().positive(),
  revision: z.number().int().positive(), displaySessionId: z.string().min(1).max(200),
  beforeRunId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/).optional(), questionIdentity: automationExecutionQuestionIdentitySchema.optional() })
const candidateSchema = z.strictObject({ status: z.literal('CANDIDATE'), automationId: z.string(), runId: z.string(),
  generation: z.number().int().positive(), displaySessionId: z.string(), executionSessionId: z.string(),
  createBodyHash: z.string().regex(/^[a-f0-9]{64}$/), previousRunId: z.string().nullable(),
  executionExitReceipt: z.strictObject({ version: z.literal(1), provider: z.enum(['claude', 'codex']),
    observedAt: z.number().int().nonnegative(), receivedAt: z.number().int().nonnegative(),
    providerExitedCleanly: z.literal(true), foregroundDrained: z.literal(true),
    backgroundDrained: z.literal(true), writeProducersDrained: z.literal(true) }) })
const encryptedRowSchema = z.object({ seq: z.number().int().positive(), localId: z.string().nullable(),
  content: z.strictObject({ t: z.literal('encrypted'), c: z.string().min(1) }) })
const pageSchema = z.object({ runId: z.string(), automationId: z.string(), generation: z.number().int().positive(),
  displaySessionId: z.string(), executionSessionId: z.string(), seedManifestCiphertext: z.string().min(1),
  dataEncryptionKey: z.string().nullable(), seedMessage: encryptedRowSchema.nullable(), messages: z.array(encryptedRowSchema),
  throughSeq: z.number().int().nonnegative(), nextAfterSeq: z.number().int().positive().nullable() })
type Resolution = z.infer<typeof automationPreviousResultDataSchema> | z.infer<typeof automationPreviousResultNoneSchema>
const unavailable = () => new Error('AUTOMATION_REFERENCE_UNAVAILABLE')

/** Owner-authorized E2EE evidence only. A dispatch receipt is never a completed answer. */
export function createAutomationContextReferenceReader(deps: {
  serverUrl: string; token: string; accountId: string; machineId: string;
  journal: Pick<AutomationContextLaunchJournal, 'read'>; legacySecret?: Uint8Array
}) {
  const url = new URL(deps.serverUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !deps.token) throw unavailable()
  const base = url.toString().replace(/\/+$/, '')
  const scope = createHash('sha256').update(JSON.stringify([deps.serverUrl, deps.accountId, deps.machineId])).digest('hex')
  return {
    async resolve(raw: z.infer<typeof selectionSchema>): Promise<Resolution> {
      try {
        const input = selectionSchema.parse(raw), signal = AbortSignal.timeout(10_000)
        if (input.questionIdentity && input.beforeRunId !== undefined && input.beforeRunId !== input.questionIdentity.requestId) throw unavailable()
        let remainingBytes = 4 * 1024 * 1024
        async function request(path: string) {
          const response = await fetch(base + path, { redirect: 'error', signal, headers: { Authorization: `Bearer ${deps.token}` } })
          if (!response.ok) { await response.body?.cancel(); throw new Error(`AUTOMATION_REFERENCE_HTTP_${response.status}`) }
          const reader = response.body?.getReader()
          if (!reader) throw unavailable()
          const chunks: Uint8Array[] = []; let bytes = 0
          try {
            while (true) {
              const next = await reader.read()
              if (next.done) break
              bytes += next.value.byteLength; remainingBytes -= next.value.byteLength
              if (bytes > 1024 * 1024 || remainingBytes < 0) throw new Error('AUTOMATION_REFERENCE_TOO_LARGE')
              chunks.push(next.value)
            }
            return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)))
          } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
        }
        const visited = new Set<string>()
        let beforeRunId = input.beforeRunId
        while (true) {
          const query = new URLSearchParams({ machineId: deps.machineId, generation: String(input.generation), revision: String(input.revision),
            displaySessionId: input.displaySessionId, ...(beforeRunId ? { beforeRunId } : {}),
            ...(input.questionIdentity ? { questionRequestId: input.questionIdentity.requestId } : {}) })
          const rawCandidate = await request(`/v1/automations/${encodeURIComponent(input.automationId)}/execution-reference?${query}`)
          const none = automationPreviousResultNoneSchema.safeParse(rawCandidate)
          if (none.success) {
            if (input.questionIdentity || none.data.automationId !== input.automationId) throw unavailable()
            return none.data
          }
          const candidate = candidateSchema.parse(rawCandidate)
          if (candidate.automationId !== input.automationId || candidate.displaySessionId !== input.displaySessionId
            || candidate.executionSessionId !== automationExecutionSessionId(candidate.runId)
            || candidate.runId === input.beforeRunId || visited.has(candidate.runId) || candidate.previousRunId === candidate.runId
            || input.questionIdentity && candidate.runId !== input.questionIdentity.sourceRunId) throw unavailable()
          visited.add(candidate.runId)
          const firstPath = `/v1/sessions/${encodeURIComponent(input.displaySessionId)}/automation-runs/${encodeURIComponent(candidate.runId)}/evidence`
          const first = pageSchema.parse(await request(firstPath + '?after_seq=0&limit=50'))
          const original = await deps.journal.read(candidate.runId)
          let key: Uint8Array, variant: 'legacy' | 'dataKey'
          if (original) {
            if (original.scope !== scope || original.runId !== candidate.runId || original.automationId !== input.automationId
              || original.generation !== candidate.generation || original.displaySessionId !== input.displaySessionId
              || original.sessionId !== candidate.executionSessionId || original.prepared.body.metadata !== first.seedManifestCiphertext
              || (original.prepared.body.dataEncryptionKey ?? null) !== first.dataEncryptionKey
              || await sessionCreateBodyHash(original.prepared.body) !== candidate.createBodyHash) throw unavailable()
            key = decodeBase64(original.prepared.encryptionKey); variant = original.prepared.encryptionVariant
          } else {
            if (first.dataEncryptionKey !== null || deps.legacySecret?.length !== 32) throw unavailable()
            key = deps.legacySecret; variant = 'legacy'
          }
          if (key.length !== 32) throw unavailable()
          const metadata = z.object({ flavor: z.enum(['claude', 'codex']), automationExecutionSeedManifest: automationExecutionSeedManifestSchema })
            .parse(decrypt(key, variant, decodeBase64(first.seedManifestCiphertext)))
          if (metadata.flavor !== candidate.executionExitReceipt.provider
            || original && metadata.automationExecutionSeedManifest.revision !== original.revision) throw unavailable()
          const decrypted = (row: z.infer<typeof encryptedRowSchema>) => ({ ...row, content: decrypt(key, variant, decodeBase64(row.content.c)) })
          const messages: ReturnType<typeof decrypted>[] = []
          let page = first, after = 0
          while (true) {
            if (page.runId !== candidate.runId || page.automationId !== input.automationId || page.generation !== candidate.generation
              || page.displaySessionId !== input.displaySessionId || page.executionSessionId !== candidate.executionSessionId
              || page.throughSeq !== first.throughSeq || page.seedManifestCiphertext !== first.seedManifestCiphertext
              || page.dataEncryptionKey !== first.dataEncryptionKey
              || page.messages.some(row => row.seq <= after || row.seq > first.throughSeq)) throw unavailable()
            messages.push(...page.messages.map(decrypted))
            if (page.nextAfterSeq === null) break
            if (page.nextAfterSeq <= after || page.nextAfterSeq > first.throughSeq || page.messages.at(-1)?.seq !== page.nextAfterSeq) throw unavailable()
            after = page.nextAfterSeq
            page = pageSchema.parse(await request(firstPath + `?after_seq=${after}&through_seq=${first.throughSeq}&limit=50`))
          }
          const record = await readAutomationExecutionRecord({ identity: { automationId: input.automationId, runId: candidate.runId,
            generation: candidate.generation, revision: metadata.automationExecutionSeedManifest.revision, displaySessionId: input.displaySessionId },
            metadata, seedMessage: first.seedMessage ? decrypted(first.seedMessage) : null, messages, complete: true })
          if (record.status !== 'verified') throw unavailable()
          if (record.answer.status === 'completed') return automationPreviousResultDataSchema.parse({ automationId: input.automationId,
            runId: candidate.runId, revision: record.seed.revision, status: 'COMPLETED', question: record.seed.question, answer: record.answer.answer })
          if (record.answer.status !== 'failed' && record.answer.status !== 'cancelled') throw new Error('AUTOMATION_REFERENCE_UNCONFIRMED')
          if (input.questionIdentity) throw unavailable()
          beforeRunId = candidate.runId
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('AUTOMATION_REFERENCE_')) throw error
        throw unavailable()
      }
    },
  }
}
