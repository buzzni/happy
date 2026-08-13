import { z } from 'zod'

const BRIDGE_TIMEOUT_MS = 60_000

const dispatchSchema = z.object({
  taskId: z.string().min(1),
  type: z.enum(['pr_review.v1', 'review_apply.v1', 'testing.v1']),
  agentRunId: z.string().min(1),
  claimToken: z.string().min(1),
  completeToken: z.string().min(1),
  targetSessionId: z.string().trim().min(1).max(200).nullable().optional(),
  input: z.unknown(),
  context: z.array(z.object({ kind: z.string(), body: z.unknown() })),
})

const responseSchema = z.object({ dispatch: dispatchSchema.nullable() })

export type AutomationAgentTaskEvent = {
  event: 'opened' | 'ready_for_review' | 'merged' | 'closed'
  prNumber: number
  prUrl: string
} | null

export type AutomationAgentTaskDispatch = z.infer<typeof dispatchSchema> & { controlUrl: string }

export async function dispatchAutomationAgentTask(input: {
  configUrl: string | undefined
  machineToken: string
  machineId: string
  runId: string
  claimToken: string
  credentialId: string
  event: AutomationAgentTaskEvent
  fetchImpl?: typeof fetch
}): Promise<
  | { ok: true; dispatch: AutomationAgentTaskDispatch | null }
  | { ok: false; error: string }
> {
  let url: string
  try {
    if (!input.configUrl) throw new Error()
    url = new URL('/api/automation/agent-task', input.configUrl).toString()
  } catch {
    return { ok: false, error: 'AgentTask bridge is unavailable' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS)
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.machineToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        machineId: input.machineId,
        runId: input.runId,
        claimToken: input.claimToken,
        credentialId: input.credentialId,
        event: input.event,
      }),
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, error: `AgentTask bridge returned ${response.status}` }
    const parsed = responseSchema.safeParse(await response.json())
    return parsed.success
      ? {
        ok: true,
        dispatch: parsed.data.dispatch
          ? {
            ...parsed.data.dispatch,
            controlUrl: new URL('/api/agent-tasks', input.configUrl).toString().replace(/\/$/, ''),
          }
          : null,
      }
      : { ok: false, error: 'AgentTask bridge returned invalid data' }
  } catch {
    return {
      ok: false,
      error: controller.signal.aborted ? 'AgentTask bridge timed out' : 'AgentTask bridge failed',
    }
  } finally {
    clearTimeout(timer)
  }
}

export function maintainAutomationAgentTaskLease(input: {
  dispatch: AutomationAgentTaskDispatch
  fetchImpl?: typeof fetch
  intervalMs?: number
  maxPreStartFailures?: number
}): () => void {
  const fetchImpl = input.fetchImpl ?? fetch
  const intervalMs = input.intervalMs ?? 30_000
  const maxPreStartFailures = input.maxPreStartFailures ?? 10
  let stopped = false
  let requestRunning = false
  let heartbeatSucceeded = false
  let failures = 0
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
  const timer = setInterval(() => {
    if (requestRunning || stopped) return
    requestRunning = true
    void fetchImpl(`${input.dispatch.controlUrl}/${encodeURIComponent(input.dispatch.taskId)}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        token: input.dispatch.claimToken,
        agentRunId: input.dispatch.agentRunId,
      }),
      signal: AbortSignal.timeout(Math.min(intervalMs, 10_000)),
    }).then((response) => {
      if (response.ok) {
        heartbeatSucceeded = true
        failures = 0
      } else if ((response.status >= 400 && response.status < 500 && heartbeatSucceeded)
          || ++failures >= maxPreStartFailures) {
        stop()
      }
    }).catch(() => {
      if (++failures >= maxPreStartFailures) stop()
    }).finally(() => {
      requestRunning = false
    })
  }, intervalMs)
  timer.unref()
  return stop
}
