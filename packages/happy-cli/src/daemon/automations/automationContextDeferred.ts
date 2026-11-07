import type { AutomationContextLaunchJournal, AutomationContextLaunchRequest, createAutomationContextLauncher } from './automationContextLaunch'
import type { PendingAutomationReport } from './serverAutomationRuntimeStore'
import { OwnedStartRefused } from '../ownedSpawn'
import { automationExecutionHoldCodeSchema, type AutomationExecutionHoldCode, type AutomationRunHeartbeatRequest } from '@slopus/happy-wire'

type Launcher = ReturnType<typeof createAutomationContextLauncher>
const revokedClaims = new Set(['claim-cancelled', 'claim-expired', 'claim-not-found', 'run-not-running'])

export function automationContextHoldCode(reason?: string): AutomationExecutionHoldCode {
  if (reason === 'workspace-busy' || reason === 'tracked-session-busy') return 'WORKSPACE_BUSY'
  if (reason === 'workspace-owner-unconfirmed') return 'WORKSPACE_OWNER_UNCONFIRMED'
  if (reason === 'registry-busy') return 'WORKSPACE_REGISTRY_BUSY'
  const known = automationExecutionHoldCodeSchema.safeParse(reason)
  if (known.success) return known.data
  if (reason?.startsWith('AUTOMATION_REFERENCE_')) return 'AUTOMATION_REFERENCE_UNCONFIRMED'
  if (/^AUTOMATION_(?:CONTEXT|STUDIO_ADMISSION)_/.test(reason ?? '')) return 'AUTOMATION_AUTHORIZATION_UNCONFIRMED'
  return 'AUTOMATION_HOLD_UNCONFIRMED'
}

/** Keeps the original RUNNING occurrence while manual work owns its workspace. Maintenance may resume only
 * a positively unsubmitted snapshot; submitted/unknown starts are read-only recovered and never replayed.
 * The host supplies fresh run authorization in resumeOriginal and its existing durable report outbox. */
export function createAutomationContextDeferred(deps: {
  journal: AutomationContextLaunchJournal
  launcherFor(runId: string): Launcher
  heartbeat(input: AutomationRunHeartbeatRequest): Promise<{ ok: boolean; error?: string }>
  resumeOriginal(input: AutomationContextLaunchRequest): ReturnType<Launcher['launch']>
  pendingReportFor(runId: string): PendingAutomationReport | null
  enqueueReport(report: PendingAutomationReport): Promise<void>
  log(message: string): void
}) {
  let maintenance: Promise<void> | null = null
  async function maintain(signal?: AbortSignal) {
    for (const runId of await deps.journal.listRunIds()) {
      if (signal?.aborted) return
      let record = await deps.journal.read(runId)
      if (record?.deferredDispatch !== 'queued') continue
      const launcher = deps.launcherFor(runId), saved = await launcher.restoreRequest(runId)
      if (!saved) throw new Error('AUTOMATION_DEFERRED_SNAPSHOT_UNAVAILABLE')
      const reportId = `automation-context-deferred:${runId}`
      const queued = deps.pendingReportFor(runId)
      const assertQueued = (value: PendingAutomationReport) => {
        if (value.reportId !== reportId || value.claimToken !== saved.claimToken
          || value.sessionId !== null && value.sessionId !== record!.sessionId) throw new Error('AUTOMATION_REPORT_IDENTITY_CONFLICT')
      }
      if (queued) { assertQueued(queued); await launcher.finishDeferred(runId); continue }
      const heartbeat = await deps.heartbeat({ runId, claimToken: saved.claimToken,
        holdCode: record.deferredHoldCode ?? 'AUTOMATION_HOLD_UNCONFIRMED' })
      if (signal?.aborted) return
      let failureCode: string | undefined
      if (!heartbeat.ok) {
        if (!revokedClaims.has(heartbeat.error ?? '')) {
          deps.log(`[automation-context] Deferred claim renewal unconfirmed run=${runId}`)
          continue
        }
        if (!await launcher.cancelUnsubmitted(runId)) {
          // Losing authority is not evidence that an already submitted writer stopped.
          deps.log(`[automation-context] Deferred claim ended after submission; retaining native ownership run=${runId}`)
          await launcher.finishDeferred(runId)
          continue
        }
        failureCode = 'AUTOMATION_DEFERRED_CANCELLED'
      } else if (record.cancelledBeforeSubmit) failureCode = 'AUTOMATION_EXECUTION_FAILED'
      else {
        const recovery = await launcher.recover(runId)
        if (!recovery) throw new Error('AUTOMATION_DEFERRED_SNAPSHOT_UNAVAILABLE')
        if (recovery.state === 'not-started') {
          if (signal?.aborted) return
          try {
            const resumed = await deps.resumeOriginal(saved)
            if (resumed.state === 'waiting') {
              await launcher.markDeferred(runId, automationContextHoldCode(resumed.reason))
              continue
            }
            if (resumed.state !== 'started') failureCode = 'AUTOMATION_START_UNCONFIRMED'
          } catch (error) {
            // Read the durable submission boundary, not the exception text, before deciding whether retry is safe.
            const observed = await launcher.recover(runId)
            const code = error instanceof Error && /^(?:AUTOMATION|EXECUTION|CONVERSATION|WORKSPACE)_[A-Z0-9_]{1,100}$/.test(error.message)
              ? error.message : 'AUTOMATION_EXECUTION_FAILED'
            deps.log(`[automation-context] Deferred resume failed run=${runId} code=${code}`)
            if (observed?.state === 'not-started') {
              if (error instanceof OwnedStartRefused || code === 'AUTOMATION_CONTEXT_REQUEST_UNCONFIRMED'
                || code === 'AUTOMATION_STUDIO_ADMISSION_UNCONFIRMED'
                || /^AUTOMATION_(?:CONTEXT|STUDIO_ADMISSION)_HTTP_5\d\d$/.test(code)) {
                await launcher.markDeferred(runId, automationContextHoldCode(code))
                continue
              }
              await launcher.cancelUnsubmitted(runId)
              failureCode = code
            } else failureCode = 'AUTOMATION_START_UNCONFIRMED'
          }
        } else if (recovery.state === 'needs-attention' && record.phase !== 'started') failureCode = 'AUTOMATION_START_UNCONFIRMED'
      }
      record = await deps.journal.read(runId)
      if (!record) throw new Error('AUTOMATION_DEFERRED_SNAPSHOT_UNAVAILABLE')
      if (!failureCode) {
        try {
          const cleared = await deps.heartbeat({ runId, claimToken: saved.claimToken, holdCode: null })
          if (!cleared.ok) deps.log(`[automation-context] Started hold clear unconfirmed run=${runId}`)
        } catch { deps.log(`[automation-context] Started hold clear unconfirmed run=${runId}`) }
      }
      const report: PendingAutomationReport = { runId, claimToken: saved.claimToken, reportId,
        status: failureCode ? 'FAILED' : 'COMPLETED', outcome: failureCode ? 'ERROR' : 'WOKE',
        sessionId: record.phase === 'prepared' ? null : record.sessionId, failureCode: failureCode ?? null,
        detailCiphertext: null, createdAt: Date.now() }
      await deps.enqueueReport(report)
      const stored = deps.pendingReportFor(runId)
      if (!stored) throw new Error('AUTOMATION_REPORT_QUEUE_UNCONFIRMED')
      assertQueued(stored)
      if (stored.status !== report.status || stored.outcome !== report.outcome || stored.failureCode !== report.failureCode) throw new Error('AUTOMATION_REPORT_IDENTITY_CONFLICT')
      await launcher.finishDeferred(runId)
    }
  }
  return {
    defer(runId: string, holdCode?: AutomationExecutionHoldCode) { return deps.launcherFor(runId).markDeferred(runId, holdCode) },
    maintain(signal?: AbortSignal): Promise<void> {
      if (maintenance) return maintenance
      const current = maintain(signal)
      maintenance = current
      const settled = () => { if (maintenance === current) maintenance = null }
      void current.then(settled, settled)
      return current
    },
  }
}
