import { randomUUID } from 'node:crypto'

import {
  buildAutomationPrompt,
  computeNextRunAt,
  shouldWakeFromScriptOutput,
  type AutomationAgent,
} from './automationDomain'
import type { EncryptedServerAutomation, ServerAutomationCacheState, ServerAutomationPayload } from './serverAutomationCache'
import type {
  PendingAutomationReport,
  ServerAutomationReportOutcome,
  ServerAutomationRuntimeState,
  ServerAutomationRuntimeStore,
} from './serverAutomationRuntimeStore'

type TransportResult = { ok: boolean; value?: any; error?: string }

export interface ServerAutomationTransport {
  claim(input: { automationId: string; generation: number; scheduledFor: number }): Promise<TransportResult>
  start(input: { runId: string; claimToken: string }): Promise<TransportResult>
  heartbeat(input: { runId: string; claimToken: string }): Promise<TransportResult>
  report(input: PendingAutomationReport): Promise<TransportResult>
}

export interface ServerAutomationExecutorInput {
  cache: { read(): ServerAutomationCacheState }
  runtimeStore: ServerAutomationRuntimeStore
  machineSecretKey: Uint8Array
  now: number
  transport: ServerAutomationTransport
  decryptPayload: (automation: EncryptedServerAutomation, machineSecretKey: Uint8Array) => ServerAutomationPayload
  runScript: (input: { command: string; cwd: string; timeout: number }) => Promise<{ ok: boolean; stdout: string; error?: string }>
  spawnSession: (input: {
    directory: string
    initialPrompt: string
    createdByAccountId: null
    agent: AutomationAgent
  }) => Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>
  isSessionRunning: (sessionId: string) => boolean
  randomId?: () => string
  logDebug?: (message: string) => void
}

const SCRIPT_TIMEOUT_MS = 60_000
const HEARTBEAT_MS = 60_000

function serverNow(cache: ServerAutomationCacheState, localNow: number): number {
  if (cache.syncedAt === 0) return localNow
  return cache.serverTime + Math.max(0, localNow - cache.syncedAt)
}

function writeWithoutReport(runtimeStore: ServerAutomationRuntimeStore, reportId: string): void {
  const state = runtimeStore.read()
  runtimeStore.write({ ...state, pendingReports: state.pendingReports.filter((report) => report.reportId !== reportId) })
}

async function flushPendingReports(input: ServerAutomationExecutorInput): Promise<void> {
  const pending = input.runtimeStore.read().pendingReports
  for (const report of pending) {
    const result = await input.transport.report(report)
    if (!result.ok) return
    writeWithoutReport(input.runtimeStore, report.reportId)
  }
}

function reconcileSchedules(
  cache: ServerAutomationCacheState,
  state: ServerAutomationRuntimeState,
  payloads: Map<string, ServerAutomationPayload>,
  now: number,
): ServerAutomationRuntimeState {
  const activeIds = new Set(cache.automations.map((automation) => automation.automationId))
  const schedules = state.schedules.filter((schedule) => activeIds.has(schedule.automationId))
  const byId = new Map(schedules.map((schedule) => [schedule.automationId, schedule]))
  for (const automation of cache.automations) {
    const current = byId.get(automation.automationId)
    if (current?.generation === automation.generation) continue
    const payload = payloads.get(automation.automationId)!
    byId.set(automation.automationId, {
      automationId: automation.automationId,
      generation: automation.generation,
      nextRunAt: computeNextRunAt(payload.schedule, Math.max(now, automation.enabledAt)),
      lastSessionId: null,
    })
  }
  return { ...state, schedules: [...byId.values()] }
}

function advanceSchedule(
  input: ServerAutomationExecutorInput,
  automationId: string,
  payload: ServerAutomationPayload,
  now: number,
  lastSessionId?: string | null,
): void {
  const state = input.runtimeStore.read()
  input.runtimeStore.write({
    ...state,
    schedules: state.schedules.map((schedule) => schedule.automationId === automationId ? {
      ...schedule,
      nextRunAt: computeNextRunAt(payload.schedule, now),
      ...(lastSessionId !== undefined ? { lastSessionId } : {}),
    } : schedule),
  })
}

async function executeStartedRun(
  input: ServerAutomationExecutorInput,
  automation: EncryptedServerAutomation,
  payload: ServerAutomationPayload,
  lastSessionId: string | null,
): Promise<{ outcome: ServerAutomationReportOutcome; sessionId: string | null }> {
  if (lastSessionId && input.isSessionRunning(lastSessionId)) {
    return { outcome: 'SKIPPED_GATE', sessionId: lastSessionId }
  }
  let scriptOutput: string | null = null
  if (payload.scriptCommand) {
    const script = await input.runScript({
      command: payload.scriptCommand,
      cwd: payload.directory,
      timeout: SCRIPT_TIMEOUT_MS,
    })
    if (!script.ok) return { outcome: 'ERROR', sessionId: null }
    if (!shouldWakeFromScriptOutput(script.stdout)) return { outcome: 'SKIPPED_GATE', sessionId: null }
    scriptOutput = script.stdout
  }
  const spawned = await input.spawnSession({
    directory: payload.directory,
    initialPrompt: buildAutomationPrompt(payload.prompt, scriptOutput),
    createdByAccountId: null,
    agent: payload.agent ?? 'claude',
  })
  return spawned.ok
    ? { outcome: 'WOKE', sessionId: spawned.sessionId }
    : { outcome: 'ERROR', sessionId: null }
}

export async function runServerAutomationTick(
  input: ServerAutomationExecutorInput,
): Promise<Array<{ automationId: string; outcome: ServerAutomationReportOutcome }>> {
  await flushPendingReports(input)
  const cache = input.cache.read()
  if (cache.cursor === 0n) return []
  const now = serverNow(cache, input.now)
  const payloads = new Map<string, ServerAutomationPayload>()
  const decryptableAutomations: EncryptedServerAutomation[] = []
  for (const automation of cache.automations) {
    try {
      payloads.set(automation.automationId, input.decryptPayload(automation, input.machineSecretKey))
      decryptableAutomations.push(automation)
    } catch (error) {
      input.logDebug?.(`[server-automation] ${automation.automationId} decrypt failed: ${error}`)
    }
  }

  const before = input.runtimeStore.read()
  const reconciled = reconcileSchedules({ ...cache, automations: decryptableAutomations }, before, payloads, now)
  if (JSON.stringify(reconciled.schedules) !== JSON.stringify(before.schedules)) input.runtimeStore.write(reconciled)

  const outcomes: Array<{ automationId: string; outcome: ServerAutomationReportOutcome }> = []
  for (const automation of decryptableAutomations) {
    if (automation.paused || automation.migrationPending === true) continue
    const schedule = input.runtimeStore.read().schedules.find((item) => item.automationId === automation.automationId)
    if (!schedule || schedule.generation !== automation.generation || schedule.nextRunAt > now) continue
    const payload = payloads.get(automation.automationId)!
    const claim = await input.transport.claim({
      automationId: automation.automationId,
      generation: automation.generation,
      scheduledFor: schedule.nextRunAt,
    })
    if (!claim.ok || !claim.value) {
      if (claim.error === 'claim-denied' || claim.error === 'already-claimed') {
        advanceSchedule(input, automation.automationId, payload, now)
      }
      continue
    }

    advanceSchedule(input, automation.automationId, payload, now)
    const runId = claim.value.runId as string
    const claimToken = claim.value.claimToken as string
    const started = await input.transport.start({ runId, claimToken })
    if (!started.ok) continue

    const heartbeat = setInterval(() => {
      void input.transport.heartbeat({ runId, claimToken }).catch((error) => {
        input.logDebug?.(`[server-automation] heartbeat failed: ${error}`)
      })
    }, HEARTBEAT_MS)
    let result: { outcome: ServerAutomationReportOutcome; sessionId: string | null }
    try {
      result = await executeStartedRun(input, automation, payload, schedule.lastSessionId)
    } catch (error) {
      input.logDebug?.(`[server-automation] ${automation.automationId} failed: ${error}`)
      result = { outcome: 'ERROR', sessionId: null }
    } finally {
      clearInterval(heartbeat)
    }

    if (result.sessionId) advanceSchedule(input, automation.automationId, payload, now, result.sessionId)
    const report: PendingAutomationReport = {
      runId,
      claimToken,
      reportId: (input.randomId ?? randomUUID)(),
      status: result.outcome === 'ERROR' ? 'FAILED' : 'COMPLETED',
      outcome: result.outcome,
      sessionId: result.sessionId,
      detailCiphertext: null,
    }
    const state = input.runtimeStore.read()
    input.runtimeStore.write({ ...state, pendingReports: [...state.pendingReports, report] })
    const reported = await input.transport.report(report)
    if (reported.ok) writeWithoutReport(input.runtimeStore, report.reportId)
    outcomes.push({ automationId: automation.automationId, outcome: result.outcome })
  }
  return outcomes
}
