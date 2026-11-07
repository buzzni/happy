import { createAutomationTickRunner } from './automationTickRunner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AutomationPayload } from '@slopus/happy-wire'
import { createAutomationQuestionWorker, withAutomationQuestionWorker, type AutomationQuestionWorkerInput } from './automationQuestionWorker'
import { createAutomationContextLaunchJournal } from './automationContextLaunchJournal'
import { createServerAutomationRuntimeStore } from './serverAutomationRuntimeStore'

let server: Server, home: string, origin: string, row: any, state: string, lostClaim: boolean, lostStart: boolean
let requests: Array<{ path: string; method: string; body: any }>, persistedAtClaim: boolean
const requestId = 'ad5ab630-9a10-4dc7-957e-e2d628a4df2a'
async function files(directory: string): Promise<string[]> {
  const result: string[] = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) result.push(...await files(join(directory, item.name)))
    else if (item.name.endsWith('.json')) result.push(join(directory, item.name))
  }
  return result
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'automation-question-worker-')); state = 'QUEUED'; lostClaim = false; lostStart = false
  requests = []; persistedAtClaim = false
  const cipher = (size: number) => Buffer.concat([Buffer.from([1]), Buffer.alloc(size - 1)]).toString('base64')
  row = { requestId, sourceRunId: 'prior', automationId: 'a1', projectId: 'chat:c1', revision: 2, generation: 3,
    displaySessionId: 'manual', machineId: 'm1', runId: null, state: 'QUEUED', holdCode: null, createdAt: 1000,
    encrypted: { payloadVersion: 6, payloadCiphertext: cipher(41), machineKeyEnvelope: cipher(105),
      machineKeyVersion: 1, viewerKeyId: 'key1', viewerKeyEnvelope: cipher(105), viewerKeyVersion: 1 }, available: true }
  server = createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part
    const body = text ? JSON.parse(text) : undefined; requests.push({ path: req.url!, method: req.method!, body })
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== 'Bearer private-machine-token') { res.writeHead(401).end('{}'); return }
    const base = '/v1/machines/m1/automation-questions'
    if (req.url?.startsWith(base + '?')) { res.end(JSON.stringify({ questions: state === 'QUEUED' ? [row] : [], nextCursor: null })); return }
    if (req.url === `${base}/${requestId}` && req.method === 'GET') { res.end(JSON.stringify(row)); return }
    if (req.url === `${base}/${requestId}` && req.method === 'PATCH') { row.holdCode = body.holdCode; res.end(JSON.stringify({ requestId, holdCode: body.holdCode })); return }
    if (req.url === `${base}/${requestId}/claim`) {
      const snapshots = await Promise.all((await files(home)).map(file => readFile(file, 'utf8')))
      persistedAtClaim = snapshots.some(text => text.includes(body.claimToken) && text.includes(requestId))
      if (state === 'QUEUED') { state = 'CLAIMED'; row = { ...row, runId: requestId, state: 'CLAIMED' } }
      if (lostClaim) { lostClaim = false; req.socket.destroy(); return }
      res.end(JSON.stringify({ ...row, runId: requestId, state, claimExpiresAt: Date.now() + 120_000, runLeaseExpiresAt: state === 'RUNNING' ? Date.now() + 300_000 : null })); return
    }
    res.writeHead(404).end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve()))
  await rm(home, { recursive: true, force: true })
})
function fixture() {
  const payload: AutomationPayload = { name: 'Question', prompt: 'Explain the selected result', directory: '/work', agent: 'codex',
    scriptCommand: null, suppressSilent: false, schedule: { kind: 'interval', minutes: 60 }, conversation: { sessionId: 'manual' },
    contextPolicy: { kind: 'isolated', reference: { kind: 'previous-result', maxBytes: 16384 } },
    executionQuestion: { requestId, sourceRunId: 'prior' } }
  const previousResult = { automationId: 'a1', runId: 'prior', revision: 1, status: 'COMPLETED', question: 'Original authored question', answer: 'Selected answer' }
  const host = { prepare: vi.fn(async () => ({ previousResult })), dispatch: vi.fn(async () => ({ state: 'started' as const, sessionId: `automation-run:${requestId}`, displaySessionId: 'manual' })),
    cancelRun: vi.fn(async (_runId: string) => true) }
  const transport = { start: vi.fn(async (_input: unknown) => {
    state = 'RUNNING'
    if (lostStart) { lostStart = false; return { ok: false, error: 'request-unconfirmed' } }
    return { ok: true, value: { projectId: 'chat:c1', runLeaseExpiresAt: Date.now() + 300_000 } }
  }), heartbeat: vi.fn(async (_input: unknown) => ({ ok: true })) }
  const deps: AutomationQuestionWorkerInput = { home, serverUrl: origin, accountId: 'owner', machineId: 'm1', token: 'private-machine-token',
    host, transport, journal: createAutomationContextLaunchJournal(home), runtimeStore: createServerAutomationRuntimeStore({ filePath: join(home, 'runtime.json') }),
    decode: vi.fn(() => payload), log: vi.fn() }
  return { deps, payload, previousResult, host, transport, worker: createAutomationQuestionWorker(deps) }
}
it('fsyncs one private claim identity before the network and dispatches a fresh selected question without changing schedules', async () => {
  const f = fixture(); await f.worker.ready(); await f.worker.maintain()
  expect(persistedAtClaim).toBe(true)
  expect(f.host.prepare).toHaveBeenCalledWith(expect.objectContaining({ runId: requestId, payload: f.payload }))
  expect(f.host.dispatch).toHaveBeenCalledWith(expect.objectContaining({ runId: requestId, payload: f.payload, previousResult: f.previousResult,
    environmentVariables: {} }))
  expect(f.host.dispatch).toHaveBeenCalledOnce()
  expect(f.deps.runtimeStore.read()).toMatchObject({ schedules: [], pendingReports: [{ runId: requestId, reportId: requestId,
    status: 'COMPLETED', outcome: 'WOKE', sessionId: `automation-run:${requestId}` }] })
  const claims = requests.filter(item => item.path.endsWith('/claim'))
  expect(claims).toHaveLength(1); expect(claims[0].body.claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const text = (await Promise.all((await files(home)).map(file => readFile(file, 'utf8')))).join('')
  expect(text).not.toContain(f.payload.prompt); expect(text).not.toContain(f.previousResult.answer)
})
it.each(['claim', 'start'] as const)('recovers a lost %s ACK on restart with the same caller token and only one dispatch', async stage => {
  const f = fixture(); lostClaim = stage === 'claim'; lostStart = stage === 'start'
  await f.worker.maintain(); expect(f.host.dispatch).not.toHaveBeenCalled()
  await createAutomationQuestionWorker(f.deps).maintain()
  expect(f.host.dispatch).toHaveBeenCalledOnce()
  const tokens = requests.filter(item => item.path.endsWith('/claim')).map(item => item.body.claimToken)
  expect(tokens).toHaveLength(2); expect(new Set(tokens).size).toBe(1); expect(persistedAtClaim).toBe(true)
  await createAutomationQuestionWorker(f.deps).maintain()
  expect(f.host.dispatch).toHaveBeenCalledOnce()
})
it.each(['oversize', 'unavailable', 'identity'] as const)('holds an unsafe question before claim (%s)', async reason => {
  const f = fixture()
  if (reason === 'oversize') f.previousResult.answer = 'x'.repeat(16384)
  if (reason === 'unavailable') f.host.prepare.mockRejectedValue(new Error('AUTOMATION_REFERENCE_UNAVAILABLE'))
  if (reason === 'identity') f.payload.executionQuestion!.sourceRunId = 'different-result'
  await f.worker.maintain()
  expect(f.host.dispatch).not.toHaveBeenCalled(); expect(f.transport.start).not.toHaveBeenCalled()
  expect(requests.filter(item => item.path.endsWith('/claim'))).toHaveLength(0)
  expect(row.holdCode).not.toBeNull()
  expect(JSON.stringify((f.deps.log as any).mock.calls)).not.toContain(f.payload.prompt)
})
it('cancels only a previously claimed owned question and never infers native cleanup from the intent', async () => {
  const f = fixture(); await f.worker.maintain()
  row.state = 'CANCEL_REQUESTED'; row.available = false
  f.host.cancelRun.mockResolvedValue(false)
  await createAutomationQuestionWorker(f.deps).maintain()
  expect(f.host.cancelRun).toHaveBeenCalledWith(requestId)
  expect(f.host.dispatch).toHaveBeenCalledOnce()
  await createAutomationQuestionWorker(f.deps).maintain()
  expect(f.host.cancelRun).toHaveBeenCalledTimes(2)
})
it('rejects a symlink question storage root without polling or claiming', async () => {
  const f = fixture(), other = join(home, 'other'); await mkdir(other)
  await symlink(other, join(home, 'automation-context-questions.v1'))
  await expect(f.worker.ready()).rejects.toThrow()
  expect(requests).toHaveLength(0)
})
it('does not read or execute a replacement claim file with public permissions', async () => {
  const f = fixture(); lostClaim = true; await f.worker.maintain()
  const file = (await files(home)).find(file => file.includes('automation-context-questions.v1'))!
  expect(file).toBeDefined(); await chmod(file, 0o644)
  await expect(createAutomationQuestionWorker(f.deps).ready()).rejects.toThrow()
  expect(f.host.dispatch).not.toHaveBeenCalled()
})

it('retires a terminal question only after its matching owned-exit acknowledgement and stops polling its history', async () => {
  const f = fixture(); await f.worker.maintain(); state = 'COMPLETED'
  vi.spyOn(f.deps.journal, 'read').mockResolvedValue({ runId: requestId, automationId: 'a1', generation: 3, revision: 2,
    sessionId: `automation-run:${requestId}`, displaySessionId: 'manual', exitReceiptAcknowledged: true,
    exitReceipt: { provider: 'codex', observedAt: 1000 } } as never)
  await createAutomationQuestionWorker(f.deps).maintain()
  const count = requests.filter(row => row.path.includes(requestId)).length
  await createAutomationQuestionWorker(f.deps).maintain(); await createAutomationQuestionWorker(f.deps).maintain()
  expect(requests.filter(row => row.path.includes(requestId))).toHaveLength(count)
  expect(f.host.dispatch).toHaveBeenCalledOnce()
})
it('keeps polling other questions when one owned cancellation cannot be confirmed', async () => {
  const f = fixture(); await f.worker.maintain(); row.state = 'CANCEL_REQUESTED'; row.available = false
  f.host.cancelRun.mockRejectedValue(new Error('private-stop-failure'))
  await expect(createAutomationQuestionWorker(f.deps).maintain()).resolves.toBeUndefined()
  expect(requests.filter(row => row.path.startsWith('/v1/machines/m1/automation-questions?'))).toHaveLength(2)
  await createAutomationQuestionWorker(f.deps).maintain()
  expect(f.host.cancelRun).toHaveBeenCalledTimes(2)
  expect(JSON.stringify((f.deps.log as any).mock.calls)).not.toContain('private-stop-failure')
})

it('keeps legacy ticks progressing during a stalled question and pauses both producers for daemon drain', async () => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const legacyTick = vi.fn(async () => {}), questions = { ready: vi.fn(async () => {}), maintain: vi.fn(async () => { await blocked }) }
  const runner = withAutomationQuestionWorker(createAutomationTickRunner({ runTick: legacyTick }), questions, { isReady: () => true, log: vi.fn() })
  runner.trigger(); await new Promise(resolve => setTimeout(resolve, 10))
  expect(legacyTick).toHaveBeenCalledOnce(); expect(questions.maintain).toHaveBeenCalledOnce(); expect(runner.isRunning()).toBe(true)
  runner.trigger(); await new Promise(resolve => setTimeout(resolve, 10))
  expect(legacyTick).toHaveBeenCalledTimes(2); expect(questions.maintain).toHaveBeenCalledOnce()
  runner.pause(); runner.trigger(); await new Promise(resolve => setTimeout(resolve, 10))
  expect(legacyTick).toHaveBeenCalledTimes(2)
  release(); await new Promise(resolve => setTimeout(resolve, 10)); expect(runner.isRunning()).toBe(false)
  runner.resume({ trigger: true }); await new Promise(resolve => setTimeout(resolve, 10))
  expect(legacyTick).toHaveBeenCalledTimes(3); expect(questions.maintain).toHaveBeenCalledTimes(2)
})
