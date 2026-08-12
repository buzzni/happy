import { describe, expect, it, vi } from 'vitest'

import {
  dispatchAutomationAgentTask,
  maintainAutomationAgentTaskLease,
} from './automationAgentTaskBridge'

describe('automation AgentTask bridge client', () => {
  it('posts the run-scoped identity and parses a dispatch without putting machine auth in the body', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      dispatch: {
        taskId: 'task-1', type: 'pr_review.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret', input: { prNumber: 17 }, context: [],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await expect(dispatchAutomationAgentTask({
      configUrl: 'https://studio.example', machineToken: 'machine-secret', machineId: 'machine-1',
      runId: 'run-1', claimToken: 'run-secret', credentialId: 'credential-1', event: null,
      fetchImpl: fetchImpl as never,
    })).resolves.toMatchObject({ ok: true, dispatch: { taskId: 'task-1' } })
    const [, init] = fetchImpl.mock.calls[0]!
    expect(String(init?.body)).toContain('run-1')
    expect(String(init?.body)).not.toContain('machine-secret')
  })

  it('returns a redacted failure for non-success responses', async () => {
    await expect(dispatchAutomationAgentTask({
      configUrl: 'https://studio.example', machineToken: 'machine-secret', machineId: 'machine-1',
      runId: 'run-1', claimToken: 'run-secret', credentialId: 'credential-1', event: null,
      fetchImpl: vi.fn(async () => new Response('claimToken=run-secret', { status: 403 })) as never,
    })).resolves.toEqual({ ok: false, error: 'AgentTask bridge returned 403' })
  })

  it('keeps a started task lease alive without exposing its capability', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const stop = maintainAutomationAgentTaskLease({
      dispatch: {
        taskId: 'task-1', type: 'pr_review.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret', input: {}, context: [],
        controlUrl: 'https://studio.test/api/agent-tasks',
      },
      intervalMs: 30_000,
      fetchImpl: fetchImpl as never,
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://studio.test/api/agent-tasks/task-1/heartbeat',
      expect.objectContaining({ body: expect.stringContaining('claim-secret') }),
    )
    stop()
    vi.useRealTimers()
  })
})
