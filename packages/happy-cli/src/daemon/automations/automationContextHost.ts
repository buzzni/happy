import type { ChildProcess } from 'node:child_process'
import { createSerialLock } from '@/utils/refreshRecovery'
import { observeAutomationContextChild } from '@/utils/automationContextExit'
import { OwnedStartRefused } from '../ownedSpawn'
import { createAutomationContextLauncher, type AutomationContextLaunchDependencies, type AutomationContextLaunchRecord,
  type AutomationContextLaunchRequest } from './automationContextLaunch'
import { createAutomationContextDeferred } from './automationContextDeferred'
import type { ServerAutomationExecutorInput } from './serverAutomationExecutor'
import type { ServerAutomationRuntimeStore } from './serverAutomationRuntimeStore'

type Dispatch = NonNullable<ServerAutomationExecutorInput['dispatchIsolatedContext']>
type DispatchInput = Parameters<Dispatch>[0]
type Context = Pick<DispatchInput, 'environmentVariables' | 'mcpSpawnContext'>
type Transport = Pick<AutomationContextLaunchDependencies, 'register' | 'persistSeed'>

/** Daemon composition only. Encrypted creation/claim material never crosses a browser RPC. The host must
 * attach observeChild synchronously at the owned spawn, and run maintain before its regular report flush. */
export function createAutomationContextHost(deps: Pick<AutomationContextLaunchDependencies,
  'accountId' | 'machineId' | 'happyOrigin' | 'api' | 'journal' | 'discover'> & {
  workspace: NonNullable<AutomationContextLaunchDependencies['workspace']>
  runtimeStore: ServerAutomationRuntimeStore
  transportForRun(run: AutomationContextLaunchRequest, prepared: AutomationContextLaunchRecord['prepared']): Promise<Transport>
  resolveContext(run: AutomationContextLaunchRequest): Promise<Context>
  start: (options: Parameters<AutomationContextLaunchDependencies['start']>[0], context: Context,
    observeChild: (child: ChildProcess) => void) => ReturnType<AutomationContextLaunchDependencies['start']>
  heartbeat: Parameters<typeof createAutomationContextDeferred>[0]['heartbeat']
  log(message: string): void
}) {
  const entries = new Map<string, ReturnType<typeof createEntry>>()
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
    return { launcher, dispatch(input: DispatchInput) {
      return lock(async () => {
        context = { environmentVariables: input.environmentVariables, mcpSpawnContext: input.mcpSpawnContext }
        try {
          const { environmentVariables: _environment, mcpSpawnContext: _mcp, ...run } = input
          const result = await launcher.launch(run)
          if (result.state === 'waiting') {
            await supervisor.defer(runId)
            return { ...result, deferred: true as const }
          }
          return result
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
    dispatch(input: DispatchInput) { return entry(input.runId).dispatch(input) },
    recover(runId: string) { return entry(runId).launcher.recover(runId) },
    maintain: supervisor.maintain,
  }
}
