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
        claimToken: 'claim-secret', completeToken: 'complete-secret', targetSessionId: null,
        input: { prNumber: 17 }, context: [],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await expect(dispatchAutomationAgentTask({
      configUrl: 'https://studio.example', machineToken: 'machine-secret', machineId: 'machine-1',
      runId: 'run-1', claimToken: 'run-secret', credentialId: 'credential-1', event: null,
      fetchImpl: fetchImpl as never,
    })).resolves.toMatchObject({ ok: true, dispatch: { taskId: 'task-1' } })
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit]
    expect(String(init?.body)).toContain('run-1')
    expect(String(init?.body)).not.toContain('machine-secret')
  })

  it('parses a review_apply requester session target without exposing it in the request', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      dispatch: {
        taskId: 'apply-1', type: 'review_apply.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret',
        targetSessionId: 'creator-session', input: {}, context: [],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(dispatchAutomationAgentTask({
      configUrl: 'https://studio.example', machineToken: 'machine-secret', machineId: 'machine-1',
      runId: 'run-1', claimToken: 'run-secret', credentialId: 'credential-1', event: null,
      fetchImpl: fetchImpl as never,
    })).resolves.toMatchObject({
      ok: true,
      dispatch: { taskId: 'apply-1', targetSessionId: 'creator-session' },
    })
  })

  it('returns a redacted failure for non-success responses', async () => {
    await expect(dispatchAutomationAgentTask({
      configUrl: 'https://studio.example', machineToken: 'machine-secret', machineId: 'machine-1',
      runId: 'run-1', claimToken: 'run-secret', credentialId: 'credential-1', event: null,
      fetchImpl: vi.fn(async () => new Response('claimToken=run-secret', { status: 403 })) as never,
    })).resolves.toEqual({ ok: false, error: 'AgentTask bridge returned 403' })
  })

  // 서버는 이 403 을 네 가지 이유로 낸다(claim, 머신 접근, 저장소 미연결,
  // credential 접근). status 만 남기면 운영자가 어느 검사인지 좁힐 수 없다.
  it('names the server reason so a rejected dispatch says which check failed', async () => {
    await expect(dispatchAutomationAgentTask({
      configUrl: 'https://studio.example', machineToken: 'machine-secret', machineId: 'machine-1',
      runId: 'run-1', claimToken: 'run-secret', credentialId: 'credential-1', event: null,
      fetchImpl: vi.fn(async () => new Response(
        JSON.stringify({ error: 'Selected GitHub credential cannot access the project repository' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      )) as never,
    })).resolves.toEqual({
      ok: false,
      error: 'AgentTask bridge returned 403: '
        + 'Selected GitHub credential cannot access the project repository',
    })
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

  it('retries a transient heartbeat failure after the lease was established', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const stop = maintainAutomationAgentTaskLease({
      dispatch: {
        taskId: 'task-1', type: 'pr_review.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret', input: {}, context: [],
        controlUrl: 'https://studio.test/api/agent-tasks',
      },
      intervalMs: 30_000,
      fetchImpl: fetchImpl as never,
    })

    await vi.advanceTimersByTimeAsync(90_000)

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    stop()
    vi.useRealTimers()
  })

  it('retries a transient network failure after the lease was established', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockRejectedValueOnce(new Error('temporary disconnect'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const stop = maintainAutomationAgentTaskLease({
      dispatch: {
        taskId: 'task-1', type: 'pr_review.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret', input: {}, context: [],
        controlUrl: 'https://studio.test/api/agent-tasks',
      },
      intervalMs: 30_000,
      fetchImpl: fetchImpl as never,
    })

    await vi.advanceTimersByTimeAsync(90_000)

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    stop()
    vi.useRealTimers()
  })
})
