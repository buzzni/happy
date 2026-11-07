import type { ChildProcess } from 'node:child_process'
import { createSerialLock } from '@/utils/refreshRecovery'
import { observeAutomationContextChild } from '@/utils/automationContextExit'
import { OwnedStartRefused } from '../ownedSpawn'
import { buildAutomationContextInput } from './automationContextInput'
import { createAutomationContextLauncher, type AutomationContextLaunchDependencies, type AutomationContextLaunchRecord,
  type AutomationContextLaunchRequest } from './automationContextLaunch'
import { automationContextHoldCode, createAutomationContextDeferred } from './automationContextDeferred'
import type { ServerAutomationExecutorInput } from './serverAutomationExecutor'
import type { ServerAutomationRuntimeStore } from './serverAutomationRuntimeStore'

type Dispatch = NonNullable<ServerAutomationExecutorInput['dispatchIsolatedContext']>
type DispatchInput = Parameters<Dispatch>[0]
type Preparation = NonNullable<ServerAutomationExecutorInput['prepareIsolatedContext']>
type Cancellation = NonNullable<ServerAutomationExecutorInput['cancelIsolatedContext']>
type Context = Pick<DispatchInput, 'environmentVariables' | 'mcpSpawnContext'>
type Transport = Pick<AutomationContextLaunchDependencies, 'register' | 'persistSeed'> & {
  verifyStart: NonNullable<AutomationContextLaunchDependencies['beforeStart']>
}

/** Daemon composition only. Encrypted creation/claim material never crosses a browser RPC. The host must
 * attach observeChild synchronously at the owned spawn, and run maintain before its regular report flush. */
export function createAutomationContextHost(deps: Pick<AutomationContextLaunchDependencies,
  'accountId' | 'machineId' | 'happyOrigin' | 'api' | 'journal' | 'discover'> & {
  workspace: NonNullable<AutomationContextLaunchDependencies['workspace']>
  runtimeStore: ServerAutomationRuntimeStore
  transportForRun(run: AutomationContextLaunchRequest, prepared: AutomationContextLaunchRecord['prepared']): Promise<Transport>
  resolveContext(run: AutomationContextLaunchRequest): Promise<Context>
  resolvePreviousResult?(input: { automationId: string; generation: number; revision: number;
    displaySessionId: string; beforeRunId?: string }): Promise<unknown>
  start: (options: Parameters<AutomationContextLaunchDependencies['start']>[0], context: Context,
    observeChild: (child: ChildProcess) => void) => ReturnType<AutomationContextLaunchDependencies['start']>
  heartbeat: Parameters<typeof createAutomationContextDeferred>[0]['heartbeat']
  /** Resolves only after the server acknowledges this exact durable positive receipt. */
  reportExit(run: AutomationContextLaunchRequest, record: AutomationContextLaunchRecord): Promise<void>
  /** Requests termination only. Neither the ACK nor PID absence proves writer release. */
  stopExecution?(input: { sessionId: string; directory: string }): Promise<void>
  log(message: string): void
}) {
  const entries = new Map<string, ReturnType<typeof createEntry>>()
  const maintain = createSerialLock()
  async function defer(run: AutomationContextLaunchRequest, reason?: string) {
    const holdCode = automationContextHoldCode(reason)
    await supervisor.defer(run.runId, holdCode)
    try {
      const published = await deps.heartbeat({ runId: run.runId, claimToken: run.claimToken, holdCode })
      if (!published.ok) deps.log(`[automation-context] Hold publication unconfirmed run=${run.runId}`)
    } catch { deps.log(`[automation-context] Hold publication unconfirmed run=${run.runId}`) }
    return holdCode
  }
  async function resolvePrevious(run: Parameters<Preparation>[0], beforeRunId?: string) {
    if (!deps.resolvePreviousResult || !run.payload.conversation) throw new Error('AUTOMATION_REFERENCE_UNSUPPORTED')
    return deps.resolvePreviousResult({ automationId: run.automationId, generation: run.generation, revision: run.revision,
      displaySessionId: run.payload.conversation.sessionId, ...(beforeRunId ? { beforeRunId } : {}) })
  }
  const prepare: Preparation = async input => {
    const original = input.runId ? await entry(input.runId).launcher.restoreRequest(input.runId) : null
    if (original && (original.automationId !== input.automationId || original.generation !== input.generation || original.revision !== input.revision)) {
      throw new Error('AUTOMATION_LAUNCH_IDENTITY_CONFLICT')
    }
    const previousResult = input.payload.contextPolicy?.reference?.kind === 'previous-result'
      ? original ? original.previousResult : await resolvePrevious(input) : undefined
    const result = previousResult === undefined ? {} : { previousResult }
    buildAutomationContextInput({ ...input, ...result })
    return result
  }
  function createEntry(runId: string) {
    const lock = createSerialLock()
    let context: Context | null = null, transport: Transport | null = null
    const launcher = createAutomationContextLauncher({ ...deps,
      register: async (run, prepared) => {
        const next = await deps.transportForRun(run, prepared)
        const session = await next.register(run, prepared)
        transport = next
        return session
      },
      persistSeed: async (session, message) => {
        const current = transport
        if (!current) throw new Error('AUTOMATION_SEED_TRANSPORT_UNAVAILABLE')
        try { return await current.persistSeed(session, message) }
        finally { transport = null }
      },
      beforeStart: async (run, prepared) => {
        context = await deps.resolveContext(run)
        if (run.payload.contextPolicy?.reference?.kind === 'previous-result') {
          const fresh = await resolvePrevious(run, run.runId)
          if (JSON.stringify(buildAutomationContextInput({ ...run, previousResult: fresh })) !== JSON.stringify(buildAutomationContextInput(run))) {
            throw new Error('AUTOMATION_REFERENCE_CHANGED')
          }
        }
        await (await deps.transportForRun(run, prepared)).verifyStart(run, prepared)
      },
      start: async options => {
        if (!context || options.agent !== 'claude' && options.agent !== 'codex') throw new OwnedStartRefused('validation-error')
        const provider = options.agent
        let observed = false
        const started = await deps.start({ ...options, environmentVariables: context.environmentVariables, sessionSource: 'schedule',
          ...(context.mcpSpawnContext?.browserAttestation ? { browserAttestation: context.mcpSpawnContext.browserAttestation } : {}) }, context,
        child => {
          if (observed) throw new Error('AUTOMATION_CHILD_IDENTITY_CONFLICT')
          observed = true
          const sessionId = options.reconnectEnvironment!.HAPPY_RECONNECT_SESSION_ID
          void observeAutomationContextChild({ child, sessionId, provider,
            persist: () => launcher.recordOwnedExit({ runId, sessionId, provider }) }).then(confirmed => {
            if (!confirmed) deps.log(`[automation-context] Owned exit remains unconfirmed run=${runId}`)
          })
        })
        if (!observed) throw new Error('AUTOMATION_CHILD_OBSERVATION_UNCONFIRMED')
        return started
      },
    })
    return { launcher,
      cancel(request: Parameters<Cancellation>[0]) {
        return lock(async () => {
          const record = await deps.journal.read(runId)
          if (!record) throw new Error('AUTOMATION_LAUNCH_SNAPSHOT_INVALID')
          if (record.automationId !== request.automationId || record.generation > request.generation || record.revision > request.revision) return true
          const run = await launcher.restoreRequest(runId)
          if (!run) throw new Error('AUTOMATION_LAUNCH_SNAPSHOT_INVALID')
          if (await launcher.cancelUnsubmitted(runId)) return true
          if ((await launcher.recover(runId))?.state === 'ended') return true
          if (!deps.stopExecution) return false
          await deps.stopExecution({ sessionId: record.sessionId, directory: run.payload.directory })
          const confirmed = (await launcher.recover(runId))?.state === 'ended'
          if (!confirmed) deps.log(`[automation-context] Owned cancellation exit remains unconfirmed run=${runId}`)
          return confirmed
        })
      }, dispatch(input: DispatchInput) {
      return lock(async () => {
        context = { environmentVariables: input.environmentVariables, mcpSpawnContext: input.mcpSpawnContext }
        try {
          const { environmentVariables: _environment, mcpSpawnContext: _mcp, ...request } = input
          const original = await launcher.restoreRequest(input.runId)
          const selection = original ? { previousResult: original.previousResult }
            : Object.hasOwn(request, 'previousResult') ? {} : await prepare(request)
          const result = await launcher.launch({ ...request, ...selection })
          if (result.state === 'waiting') {
            await defer(input, result.reason)
            return { ...result, deferred: true as const }
          }
          return result
        } catch (error) {
          const record = await deps.journal.read(runId)
          if (error instanceof Error && /^AUTOMATION_REFERENCE_[A-Z0-9_]+$/.test(error.message)
            && record && (record.phase === 'prepared' || record.phase === 'registered')) {
            const holdCode = await defer(input, error.message)
            deps.log(`[automation-context] Reference held run=${runId} code=${holdCode}`)
            return { state: 'waiting' as const, sessionId: record.sessionId, displaySessionId: record.displaySessionId,
              reason: holdCode, deferred: true as const }
          }
          if (record?.phase === 'submitted' || record?.phase === 'started') {
            deps.log(`[automation-context] Native start remains unconfirmed run=${runId}`)
            return { state: 'needs-attention' as const, sessionId: record.sessionId, displaySessionId: record.displaySessionId,
              reason: 'AUTOMATION_START_UNCONFIRMED' }
          }
          throw error
        } finally { context = null; transport = null }
      })
    } }
  }
  function entry(runId: string) {
    let value = entries.get(runId)
    if (!value) { value = createEntry(runId); entries.set(runId, value) }
    return value
  }
  const supervisor = createAutomationContextDeferred({ journal: deps.journal, launcherFor: runId => entry(runId).launcher,
    heartbeat: deps.heartbeat, resumeOriginal: async run => entry(run.runId).dispatch({ ...run, ...await deps.resolveContext(run) }),
    pendingReportFor: runId => deps.runtimeStore.read().pendingReports.find(row => row.runId === runId) ?? null,
    enqueueReport: async report => {
      const state = deps.runtimeStore.read(), existing = state.pendingReports.find(row => row.runId === report.runId)
      if (existing) {
        if (existing.reportId !== report.reportId || existing.claimToken !== report.claimToken) throw new Error('AUTOMATION_REPORT_IDENTITY_CONFLICT')
        return
      }
      deps.runtimeStore.write({ ...state, pendingReports: [...state.pendingReports, report] })
    }, log: deps.log })
  return {
    async cancelAutomation(request: Parameters<Cancellation>[0]): Promise<boolean> {
      let confirmed = true
      for (const runId of await deps.journal.listRunIds()) {
        const record = await deps.journal.read(runId)
        if (record?.automationId === request.automationId && record.generation <= request.generation && record.revision <= request.revision) {
          if (!await entry(runId).cancel(request)) confirmed = false
        }
      }
      return confirmed
    },
    prepare,
    dispatch(input: DispatchInput) { return entry(input.runId).dispatch(input) },
    recover(runId: string) { return entry(runId).launcher.recover(runId) },
    maintain(signal?: AbortSignal) {
      return maintain(async () => {
        await supervisor.maintain(signal)
        for (const runId of await deps.journal.listRunIds()) {
          if (signal?.aborted) return
          const record = await deps.journal.read(runId)
          if (!record?.exitReceipt || record.exitReceiptAcknowledged) continue
          try {
            const launcher = entry(runId).launcher, run = await launcher.restoreRequest(runId)
            if (!run) throw new Error('AUTOMATION_LAUNCH_SNAPSHOT_INVALID')
            await deps.reportExit(run, record)
            await launcher.acknowledgeOwnedExit({ runId, sessionId: record.sessionId, ...record.exitReceipt })
          } catch (error) {
            const code = error instanceof Error && /^AUTOMATION_[A-Z0-9_]{1,100}$/.test(error.message)
              ? error.message : 'AUTOMATION_EXIT_REPORT_UNCONFIRMED'
            deps.log(`[automation-context] Owned exit report unconfirmed run=${runId} code=${code}`)
          }
        }
      })
    },
  }
}


/** Prepare the new execution path without making it a prerequisite of legacy ticking. */
export async function prepareAutomationContextTick(host: (Pick<ReturnType<typeof createAutomationContextHost>, 'maintain' | 'dispatch'>
  & Partial<Pick<ReturnType<typeof createAutomationContextHost>, 'cancelAutomation' | 'prepare'>>) | null,
  signal: AbortSignal, log: (message: string) => void): Promise<{ isolatedContextReady: boolean; prepareIsolatedContext?: Preparation; dispatchIsolatedContext?: Dispatch; cancelIsolatedContext?: Cancellation }> {
  if (!host || signal.aborted) return { isolatedContextReady: false }
  try { await host.maintain(signal) }
  catch {
    // Journal integrity is a prerequisite of isolated work, not of existing v1/v4 automations.
    log('[automation-context] Recovery unconfirmed; isolated admission paused for this tick')
    return { isolatedContextReady: false }
  }
  return signal.aborted ? { isolatedContextReady: false } : { isolatedContextReady: true,
    dispatchIsolatedContext: host.dispatch, ...(host.prepare ? { prepareIsolatedContext: host.prepare } : {}), ...(host.cancelAutomation ? { cancelIsolatedContext: host.cancelAutomation } : {}) }
}
