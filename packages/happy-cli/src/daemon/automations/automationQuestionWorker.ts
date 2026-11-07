import { constants } from 'node:fs'
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { automationExecutionQuestionRequestSchema, automationExecutionSessionId, automationExecutionHoldCodeSchema,
  type AutomationExecutionQuestionRequest } from '@slopus/happy-wire'
import { createAutomationTickRunner, type AutomationTickRunner } from './automationTickRunner'
import { createSerialLock } from '@/utils/refreshRecovery'
import { withOwnedFileLock } from '@/utils/ownedFileLock'
import { protectStandaloneObservationDirectory } from '../standaloneLaunchJournal'
import type { createAutomationContextHost } from './automationContextHost'
import type { AutomationContextLaunchJournal } from './automationContextLaunch'
import type { ServerAutomationPayload } from './serverAutomationCache'
import type { ServerAutomationTransport } from './serverAutomationExecutor'
import type { ServerAutomationRuntimeStore } from './serverAutomationRuntimeStore'
import { buildAutomationContextInput } from './automationContextInput'
import { automationContextHoldCode } from './automationContextDeferred'

type Host = ReturnType<typeof createAutomationContextHost>
export type AutomationQuestionWorkerInput = {
  home: string; serverUrl: string; accountId: string; machineId: string; token: string
  journal: AutomationContextLaunchJournal; runtimeStore: ServerAutomationRuntimeStore
  host: Pick<Host, 'prepare' | 'dispatch'> & { cancelRun(runId: string): Promise<boolean> }
  decode(question: { requestId: string; sourceRunId: string; automationId: string; projectId: string;
    revision: number; generation: number; encrypted: AutomationExecutionQuestionRequest['encrypted'] }): ServerAutomationPayload
  transport: Pick<ServerAutomationTransport, 'start' | 'heartbeat'>
  log(message: string): void
}
const questionSchema = z.object({ requestId: z.string().uuid(), sourceRunId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  automationId: z.string().min(1).max(200), projectId: z.string().min(1).max(200), revision: z.number().int().positive(),
  generation: z.number().int().positive(), displaySessionId: z.string().min(1).max(200), machineId: z.string().min(1).max(200),
  encrypted: automationExecutionQuestionRequestSchema.shape.encrypted, createdAt: z.number().int().nonnegative().safe() })
type Question = z.infer<typeof questionSchema>
const currentSchema = questionSchema.extend({ runId: z.string().uuid().nullable(), state: z.enum(['QUEUED', 'CLAIMED', 'CANCEL_REQUESTED']),
  holdCode: automationExecutionHoldCodeSchema.nullable(), available: z.boolean().optional(),
  runState: z.enum(['CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'ABANDONED']).nullable().optional() })
const recordSchema = z.strictObject({ version: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), question: questionSchema,
  claimToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), phase: z.enum(['claiming', 'active', 'finished']) })
type Record = z.infer<typeof recordSchema>

/** Only immutable encrypted request material and a caller-generated claim token are persisted here.
 * File locks cover local read/fsync only; no lock is kept while contacting either server or provider. */
export function createAutomationQuestionWorker(deps: AutomationQuestionWorkerInput) {
  const origin = new URL(deps.serverUrl)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash
    || !deps.accountId || !deps.machineId || !deps.token) throw new Error('AUTOMATION_QUESTION_CONFIGURATION_INVALID')
  const base = origin.toString().replace(/\/+$/, ''), serial = createSerialLock()
  const scope = createHash('sha256').update(JSON.stringify([base, deps.accountId, deps.machineId])).digest('hex')
  const root = join(deps.home, 'automation-context-questions.v1'), directory = join(root, scope)
  const path = (id: string) => join(directory, z.string().uuid().parse(id) + '.json')
  let cursor: string | null = null
  async function prepareDirectory() {
    for (const item of [root, directory]) {
      await mkdir(item, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      await protectStandaloneObservationDirectory(item)
    }
  }
  async function read(id: string): Promise<Record | null> {
    let handle
    try { handle = await open(path(id), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 400_000
        || process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)) throw new Error('AUTOMATION_QUESTION_JOURNAL_UNSAFE')
      const record = recordSchema.parse(JSON.parse(await handle.readFile('utf8')))
      if (record.scope !== scope || record.question.requestId !== id || record.question.machineId !== deps.machineId) throw new Error('AUTOMATION_QUESTION_IDENTITY_CONFLICT')
      return record
    } finally { await handle.close() }
  }
  async function write(value: Record) {
    const record = recordSchema.parse(value), file = path(record.question.requestId), temporary = file + '.' + randomUUID() + '.tmp'
    const data = JSON.stringify(record)
    if (Buffer.byteLength(data) > 400_000) throw new Error('AUTOMATION_QUESTION_JOURNAL_TOO_LARGE')
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(data); await handle.sync(); await handle.close(); await rename(temporary, file)
      if (process.platform !== 'win32') for (const item of [directory, root, deps.home]) {
        const dir = await open(item, constants.O_RDONLY)
        try { await dir.sync() } finally { await dir.close() }
      }
    } finally {
      await handle.close().catch(() => undefined)
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }
  async function records() {
    await prepareDirectory()
    const result: Record[] = []
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -5), record = await read(id)
      if (!record) throw new Error('AUTOMATION_QUESTION_JOURNAL_UNCONFIRMED')
      result.push(record)
    }
    return result
  }
  async function persist(question: Question) {
    return withOwnedFileLock(path(question.requestId) + '.lock', async () => {
      const saved = await read(question.requestId)
      if (saved) {
        if (JSON.stringify(saved.question) !== JSON.stringify(question)) throw new Error('AUTOMATION_QUESTION_IDENTITY_CONFLICT')
        return saved
      }
      const record: Record = { version: 1, scope, question, claimToken: randomBytes(32).toString('base64url'), phase: 'claiming' }
      await write(record)
      return record
    })
  }
  async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<unknown> {
    let response: Response
    try { response = await fetch(base + path, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${deps.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }) }
    catch { throw new Error('AUTOMATION_QUESTION_REQUEST_UNCONFIRMED') }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`AUTOMATION_QUESTION_HTTP_${response.status}`) }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0
    if (!reader) throw new Error('AUTOMATION_QUESTION_RESPONSE_INVALID')
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break
        size += next.value.length
        if (size > 6 * 1024 * 1024) throw new Error('AUTOMATION_QUESTION_RESPONSE_INVALID')
        chunks.push(next.value)
      }
      return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)))
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  }
  const queuePath = `/v1/machines/${encodeURIComponent(deps.machineId)}/automation-questions`
  async function held(question: Question, record: Record | null, error: unknown) {
    const holdCode = automationContextHoldCode(error instanceof Error ? error.message : undefined)
    deps.log(`[automation-question] Held request=${question.requestId} code=${holdCode}`)
    try {
      if (record?.phase === 'active') {
        const result = await deps.transport.heartbeat({ runId: question.requestId, claimToken: record.claimToken, holdCode })
        if (!result.ok) throw new Error('unconfirmed')
      } else await request(`${queuePath}/${question.requestId}`, 'PATCH', { holdCode })
    } catch { deps.log(`[automation-question] Hold publication unconfirmed request=${question.requestId}`) }
  }
  async function stop(record: Record) {
    let confirmed = false
    try { confirmed = await deps.host.cancelRun(record.question.requestId) }
    catch { /* An individual stop failure must retain custody without starving the other questions. */ }
    if (confirmed) await write({ ...record, phase: 'finished' })
    else deps.log(`[automation-question] Owned cancellation exit unconfirmed request=${record.question.requestId}`)
  }
  async function consume(raw: unknown, saved: Record | null, signal?: AbortSignal) {
    const current = currentSchema.parse(raw), question = questionSchema.parse(current), id = question.requestId
    if (question.machineId !== deps.machineId || current.runId !== null && current.runId !== id
      || saved && JSON.stringify(saved.question) !== JSON.stringify(question)) throw new Error('AUTOMATION_QUESTION_IDENTITY_CONFLICT')
    if (current.state === 'CANCEL_REQUESTED' || current.available === false) {
      if (saved) await stop(saved)
      else await held(question, null, new Error('AUTOMATION_AUTHORIZATION_UNCONFIRMED'))
      return
    }
    let record = saved
    try {
      const observed = saved?.phase === 'active' ? await deps.journal.read(id) : null
      if (observed?.exitReceiptAcknowledged && observed.exitReceipt && observed.runId === id
        && observed.automationId === question.automationId && observed.generation === question.generation && observed.revision === question.revision
        && observed.sessionId === automationExecutionSessionId(id) && observed.displaySessionId === question.displaySessionId) {
        const terminal = z.object({ runId: z.literal(id), state: z.enum(['CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'ABANDONED']) }).parse(
          await request(`${queuePath}/${id}/claim`, 'POST', { claimToken: saved!.claimToken }, signal))
        if (terminal.state !== 'CLAIMED' && terminal.state !== 'RUNNING') {
          await write({ ...saved!, phase: 'finished' }); return
        }
      }
      // Dispatch acceptance is not a native exit. Keep observing cancellation/authority above,
      // but do not re-read references, claim or fsync the same active request every tick.
      if (saved?.phase === 'active' && current.runId === id && current.runState === 'COMPLETED') return
      const payload = deps.decode(question)
      if (payload.executionQuestion?.requestId !== id || payload.executionQuestion.sourceRunId !== question.sourceRunId
        || payload.conversation?.sessionId !== question.displaySessionId || !payload.contextPolicy
        || payload.seal && (payload.seal.projectId !== question.projectId || payload.seal.machineId !== deps.machineId)) throw new Error('AUTOMATION_QUESTION_IDENTITY_CONFLICT')
      const identity = { automationId: question.automationId, generation: question.generation, revision: question.revision, runId: id, payload }
      const prepared = await deps.host.prepare(identity)
      buildAutomationContextInput({ ...identity, ...prepared })
      if (signal?.aborted) return
      record ??= await persist(question) // fsync before the first claim request, including retries after unknown ACKs.
      const claim = z.object({ requestId: z.literal(id), sourceRunId: z.literal(question.sourceRunId), runId: z.literal(id),
        automationId: z.literal(question.automationId), projectId: z.literal(question.projectId), generation: z.literal(question.generation), revision: z.literal(question.revision),
        displaySessionId: z.literal(question.displaySessionId), encrypted: automationExecutionQuestionRequestSchema.shape.encrypted,
        state: z.enum(['CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'ABANDONED']) }).parse(
        await request(`${queuePath}/${id}/claim`, 'POST', { claimToken: record.claimToken }, signal))
      if (JSON.stringify(claim.encrypted) !== JSON.stringify(question.encrypted)) throw new Error('AUTOMATION_QUESTION_IDENTITY_CONFLICT')
      record = { ...record, phase: 'active' }; await write(record)
      if (claim.state === 'COMPLETED') return // Dispatch acceptance does not imply native exit.
      if (claim.state !== 'CLAIMED' && claim.state !== 'RUNNING') { await stop(record); return }
      const pending = deps.runtimeStore.read().pendingReports.find(item => item.runId === id)
      if (pending) {
        if (pending.claimToken !== record.claimToken) throw new Error('AUTOMATION_QUESTION_IDENTITY_CONFLICT')
        return
      }
      const launched = await deps.journal.read(id)
      if (launched?.deferredDispatch === 'queued') return // The existing host supervisor owns deferred resumption/reporting.
      if (claim.state === 'CLAIMED') {
        const start = await deps.transport.start({ runId: id, claimToken: record.claimToken })
        if (!start.ok) throw new Error('AUTOMATION_START_UNCONFIRMED')
        if (start.value?.projectId !== question.projectId) throw new Error('AUTOMATION_QUESTION_IDENTITY_CONFLICT')
      }
      if (signal?.aborted) return
      const result = await deps.host.dispatch({ ...identity, ...prepared, claimToken: record.claimToken, environmentVariables: {} })
      if (result.sessionId !== automationExecutionSessionId(id) || result.displaySessionId !== question.displaySessionId) throw new Error('AUTOMATION_QUESTION_IDENTITY_CONFLICT')
      if (result.state === 'waiting' && 'deferred' in result && result.deferred) return
      const state = deps.runtimeStore.read(), existing = state.pendingReports.find(item => item.runId === id)
      if (!existing) deps.runtimeStore.write({ ...state, pendingReports: [...state.pendingReports, { runId: id, claimToken: record.claimToken,
        reportId: id, status: result.state === 'started' ? 'COMPLETED' : 'FAILED', outcome: result.state === 'started' ? 'WOKE' : 'ERROR',
        sessionId: result.sessionId, detailCiphertext: null, ...(result.state === 'started' ? {} : { failureCode: 'AUTOMATION_START_UNCONFIRMED' }) }] })
    } catch (error) { await held(question, record, error) }
  }
  return {
    async ready() { await records() },
    maintain(signal?: AbortSignal) {
      return serial(async () => {
        const local = await records(), seen = new Set<string>()
        for (const record of local) {
          if (signal?.aborted) return
          if (record.phase === 'finished') continue
          const id = record.question.requestId; seen.add(id)
          let current: unknown
          try { current = await request(`${queuePath}/${id}`, 'GET', undefined, signal) }
          catch (error) {
            if (error instanceof Error && error.message === 'AUTOMATION_QUESTION_HTTP_404') await stop(record)
            else await held(record.question, record, error)
            continue
          }
          await consume(current, record, signal)
        }
        if (signal?.aborted) return
        const query = new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) })
        const page = z.object({ questions: z.array(currentSchema).max(20), nextCursor: z.string().min(1).max(1024).nullable() }).parse(
          await request(`${queuePath}?${query}`, 'GET', undefined, signal))
        if (page.nextCursor && page.nextCursor === cursor) throw new Error('AUTOMATION_QUESTION_PAGE_INVALID')
        cursor = page.nextCursor
        for (const current of page.questions) {
          if (signal?.aborted) return
          if (!seen.has(current.requestId)) await consume(current, null, signal)
        }
      })
    },
  }
}

/** Preserve the daemon's existing pause/drain contract while independently scheduling explicit questions. */
export function withAutomationQuestionWorker(scheduled: AutomationTickRunner,
  questions: { ready(): Promise<void>; maintain(signal?: AbortSignal): Promise<void> } | null,
  options: { isReady(): boolean; log(message: string): void }): AutomationTickRunner {
  const runner = createAutomationTickRunner({ runTick: async signal => {
    if (!questions || !options.isReady()) return
    await questions.ready()
    await questions.maintain(signal)
  }, logDebug: message => {
    if (message.includes('tick failed:')) options.log('[automation-question] Question runner progress unconfirmed; pending requests retained')
  } })
  return {
    trigger() { scheduled.trigger(); runner.trigger() },
    isRunning: () => scheduled.isRunning() || runner.isRunning(),
    pause() { scheduled.pause(); runner.pause() },
    resume(input) { scheduled.resume(input); runner.resume(input) },
  }
}
