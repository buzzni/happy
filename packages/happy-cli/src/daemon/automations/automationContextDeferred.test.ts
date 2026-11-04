import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiClient } from '@/api/api'
import { decodeBase64, decrypt } from '@/api/encryption'
import type { Session } from '@/api/types'
import type { PendingAutomationReport } from './serverAutomationRuntimeStore'
import { createAutomationContextLauncher, type AutomationContextLaunchRequest } from './automationContextLaunch'
import { createAutomationContextLaunchJournal } from './automationContextLaunchJournal'
import { createAutomationContextWorkspace } from './automationContextWorkspace'
import { createAutomationContextDeferred } from './automationContextDeferred'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'context-deferred-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })
async function setup() {
  const directory = join(home, 'workspace'); await mkdir(directory)
  const api = await ApiClient.create({ token: 'private-account-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } })
  const journal = createAutomationContextLaunchJournal(home)
  const workspace = createAutomationContextWorkspace({ home, isTracked: async () => false })
  const start = vi.fn(async () => ({ type: 'success' as const, sessionId: 'automation-run:r1' }))
  const sessions = new Map<string, Session>()
  const launcher = createAutomationContextLauncher({ accountId: 'owner', machineId: 'm1', happyOrigin: 'https://happy.example',
    api, journal, workspace, start, discover: async () => 'unconfirmed',
    register: async (_request, prepared) => {
      const key = decodeBase64(prepared.encryptionKey), id = prepared.body.tag
      if (!sessions.has(id)) sessions.set(id, { id, seq: 0, metadataVersion: 0, agentStateVersion: 0,
        metadata: decrypt(key, prepared.encryptionVariant, decodeBase64(prepared.body.metadata)) as Session['metadata'],
        agentState: { controlledByUser: false }, encryptionKey: key, encryptionVariant: prepared.encryptionVariant })
      return sessions.get(id)!
    }, persistSeed: async (session, message) => { session.seq = 1; return { ...message, seq: 1 } } })
  const input: AutomationContextLaunchRequest = { automationId: 'a1', runId: 'r1', generation: 1, revision: 1, claimToken: 'original-private-claim',
    payload: { name: 'Task', prompt: 'original authored question', directory, agent: 'codex', scriptCommand: null, suppressSilent: false,
      schedule: { kind: 'once-zoned', date: '2026-11-05', hour: 9, minute: 0, timeZone: 'UTC' },
      conversation: { sessionId: 'manual' }, contextPolicy: { kind: 'isolated', reference: null } } }
  const pending: PendingAutomationReport[] = []
  const heartbeat = vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true }))
  const resumeOriginal = vi.fn(async (saved: AutomationContextLaunchRequest) => launcher.launch(saved))
  const enqueueReport = vi.fn(async (report: PendingAutomationReport) => { pending.push(structuredClone(report)) })
  const log = vi.fn()
  const deps = { journal, launcherFor: (_runId: string) => launcher, heartbeat, resumeOriginal,
    pendingReportFor: (runId: string) => pending.find(row => row.runId === runId) ?? null, enqueueReport, log }
  const supervisor = createAutomationContextDeferred(deps)
  const manual = await workspace.beginManualLaunch([directory])
  if (!manual.acquired) throw new Error('manual reservation refused')
  expect(await launcher.launch(input)).toHaveProperty('state', 'waiting')
  expect(await supervisor.defer('r1')).toBe(true)
  return { deps, journal, workspace, start, launcher, input, pending, heartbeat, resumeOriginal, enqueueReport, log, supervisor,
    releaseManual: () => manual.finish({ submitted: false, tracked: false }) }
}

it('renews the original waiting claim and resumes only its immutable input after coordinator restart', async () => {
  const f = await setup()
  await f.supervisor.maintain()
  expect(f.start).not.toHaveBeenCalled(); expect(f.pending).toEqual([])
  f.input.payload.prompt = 'edited definition that must not replace this occurrence'
  await f.releaseManual()
  await createAutomationContextDeferred(f.deps).maintain()
  expect(f.start).toHaveBeenCalledOnce()
  expect(f.resumeOriginal.mock.calls.at(-1)![0]).toMatchObject({ claimToken: 'original-private-claim', payload: { prompt: 'original authored question' } })
  expect(f.heartbeat).toHaveBeenCalledWith({ runId: 'r1', claimToken: 'original-private-claim' })
  expect(f.pending).toEqual([expect.objectContaining({ runId: 'r1', outcome: 'WOKE', sessionId: 'automation-run:r1' })])
  expect(await f.journal.read('r1')).toHaveProperty('deferredDispatch', 'settled')
  await createAutomationContextDeferred(f.deps).maintain()
  expect(f.start).toHaveBeenCalledOnce(); expect(f.enqueueReport).toHaveBeenCalledOnce()
})

it('cancels a revoked unsubmitted claim without dispatching or touching the manual reservation', async () => {
  const f = await setup()
  f.heartbeat.mockResolvedValue({ ok: false, error: 'claim-cancelled' })
  await f.supervisor.maintain()
  expect(f.resumeOriginal).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
  expect(f.pending).toEqual([expect.objectContaining({ outcome: 'ERROR', failureCode: 'AUTOMATION_DEFERRED_CANCELLED' })])
  expect(await f.journal.read('r1')).toMatchObject({ cancelledBeforeSubmit: true, deferredDispatch: 'settled' })
  expect(await f.launcher.launch(f.input)).toHaveProperty('state', 'needs-attention')
  await f.releaseManual()
  expect(await f.workspace.acquireAutomation({ runId: 'r2', roots: [f.input.payload.directory] })).toHaveProperty('acquired', true)
})

it('does not start or finish a waiting run after an unconfirmed heartbeat', async () => {
  const f = await setup()
  await f.releaseManual()
  f.heartbeat.mockResolvedValue({ ok: false, error: 'offline' })
  await f.supervisor.maintain()
  expect(f.resumeOriginal).not.toHaveBeenCalled(); expect(f.pending).toEqual([])
  expect(await f.journal.read('r1')).toHaveProperty('deferredDispatch', 'queued')
  expect(f.log).toHaveBeenCalled()
})

it('retains unknown native dispatch ownership and reports attention without submitting again', async () => {
  const f = await setup(); await f.releaseManual()
  f.start.mockRejectedValueOnce(new Error('lost native ACK'))
  await f.supervisor.maintain()
  expect(f.pending[0]).toMatchObject({ outcome: 'ERROR', failureCode: 'AUTOMATION_START_UNCONFIRMED', sessionId: 'automation-run:r1' })
  expect(await f.workspace.beginManualLaunch([f.input.payload.directory])).toHaveProperty('acquired', false)
  await createAutomationContextDeferred(f.deps).maintain()
  expect(f.start).toHaveBeenCalledOnce()
  expect(await f.launcher.cancelUnsubmitted('r1')).toBe(false)
  await expect(f.supervisor.defer('r1')).rejects.toThrow('AUTOMATION_DEFERRED_STATE_CONFLICT')
})

it('retries an unconfirmed preparation request with its original identity instead of consuming a one-time occurrence', async () => {
  const f = await setup(); await f.releaseManual()
  f.resumeOriginal.mockRejectedValueOnce(new Error('AUTOMATION_CONTEXT_REQUEST_UNCONFIRMED'))
  await f.supervisor.maintain()
  expect(f.pending).toEqual([]); expect(f.start).not.toHaveBeenCalled()
  expect(await f.journal.read('r1')).toMatchObject({ deferredDispatch: 'queued', phase: 'registered' })
  expect(await f.journal.read('r1')).not.toHaveProperty('cancelledBeforeSubmit')
  await createAutomationContextDeferred(f.deps).maintain()
  expect(f.start).toHaveBeenCalledOnce()
  expect(f.pending[0]).toMatchObject({ outcome: 'WOKE', runId: 'r1' })
})

it('retries a failed report write with a stable report id and no native replay', async () => {
  const f = await setup(); await f.releaseManual()
  f.enqueueReport.mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(f.supervisor.maintain()).rejects.toThrow('disk unavailable')
  expect(f.pending).toEqual([])
  await createAutomationContextDeferred(f.deps).maintain()
  expect(f.start).toHaveBeenCalledOnce(); expect(f.resumeOriginal).toHaveBeenCalledOnce()
  expect(f.enqueueReport.mock.calls[1][0]).toMatchObject({ reportId: f.enqueueReport.mock.calls[0][0].reportId, outcome: 'WOKE' })
})

it('refuses a queued report from a different claim before renewing or dispatching', async () => {
  const f = await setup()
  f.pending.push({ runId: 'r1', claimToken: 'other-private-claim', reportId: 'automation-context-deferred:r1',
    sessionId: 'automation-run:r1', status: 'COMPLETED', outcome: 'WOKE', detailCiphertext: null })
  await expect(f.supervisor.maintain()).rejects.toThrow('AUTOMATION_REPORT_IDENTITY_CONFLICT')
  expect(f.heartbeat).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
})

it('recovers a lost report-queue ACK by reading the stored report without another native dispatch or report', async () => {
  const f = await setup(); await f.releaseManual()
  f.enqueueReport.mockImplementationOnce(async report => { f.pending.push(structuredClone(report)); throw new Error('lost queue ACK') })
  await expect(f.supervisor.maintain()).rejects.toThrow('lost queue ACK')
  expect(await f.journal.read('r1')).toHaveProperty('deferredDispatch', 'queued')
  await createAutomationContextDeferred(f.deps).maintain()
  expect(f.start).toHaveBeenCalledOnce(); expect(f.enqueueReport).toHaveBeenCalledOnce()
  expect(await f.journal.read('r1')).toHaveProperty('deferredDispatch', 'settled')
})
