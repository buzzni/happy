import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_GITHUB_WORKER_SESSIONS,
  runServerAutomationTick,
  type ServerAutomationExecutorInput,
} from './serverAutomationExecutor'

// 상한을 상수에서 끌어와 만든다. 개수를 하드코딩하면 상한을 올릴 때 테스트가
// "한계에 도달했다" 를 더는 재현하지 못하면서 조용히 통과한다.
const workerSessionIds = (prefix: string, count = MAX_GITHUB_WORKER_SESSIONS) => Array.from(
  { length: count },
  (_, index) => `${prefix}-${index + 1}`,
)
import type { AutomationMcpCallerGrantResult } from './automationMcpCallerGrant'
import type { EncryptedServerAutomation } from './serverAutomationCache'
import type { ServerAutomationRuntimeState } from './serverAutomationRuntimeStore'
import { MAX_WORKTREE_CLEANUP_ATTEMPTS } from './worktreeCleanupGiveUp'
import { buildSandboxRuntimeConfig } from '@/sandbox/config'

function cacheRecord(generation = 2, migrationPending = false) {
  return {
    automationId: 'automation-1', revision: 2, generation, payloadVersion: 1 as const,
    payloadCiphertext: 'encrypted-payload', machineKeyVersion: 1,
    machineKeyEnvelope: 'encrypted-envelope', paused: false, migrationPending, enabledAt: 1,
    runRequestedAt: null,
  }
}

function runtime(initial: ServerAutomationRuntimeState) {
  let state = structuredClone(initial)
  return {
    read: vi.fn(() => structuredClone(state)),
    write: vi.fn((next: ServerAutomationRuntimeState) => { state = structuredClone(next) }),
    state: () => structuredClone(state),
  }
}

function setup(options: { generation?: number; migrationPending?: boolean; claim?: { ok: boolean; value?: any; error?: string } } = {}) {
  const now = 1_000_000
  const store = runtime({
    schedules: [{ automationId: 'automation-1', generation: 2, nextRunAt: now, lastSessionId: null }],
    pendingReports: [],
  })
  const transport = {
    claim: vi.fn(async (_input: any): Promise<any> => options.claim ?? ({ ok: false, error: 'offline' })),
    start: vi.fn(async (_input: any): Promise<any> => ({ ok: true, value: { runLeaseExpiresAt: now + 300_000 } })),
    heartbeat: vi.fn(async (_input: any): Promise<any> => ({ ok: true, value: { runLeaseExpiresAt: now + 300_000 } })),
    report: vi.fn(async (_input: any): Promise<any> => ({ ok: true, value: { idempotent: false } })),
  }
  const runScript = vi.fn(async () => ({ ok: true, stdout: '' }))
  const queryGithubPullRequests = vi.fn<ServerAutomationExecutorInput['queryGithubPullRequests']>(async () => ({
    ok: true,
    pullRequests: [],
  }))
  const queryGithubPullRequestFiles = vi.fn<
    ServerAutomationExecutorInput['queryGithubPullRequestFiles']
  >(async () => ({ ok: true, files: [] }))
  const queryGithubIssues = vi.fn<ServerAutomationExecutorInput['queryGithubIssues']>(async () => ({
    ok: true,
    issues: [],
  }))
  const notifyGithubTrigger = vi.fn<ServerAutomationExecutorInput['notifyGithubTrigger']>()
  const resolveGithubIssueProgressMarkerIdentity = vi.fn<ServerAutomationExecutorInput['resolveGithubIssueProgressMarkerIdentity']>(async () => ({
    ok: true,
    actor: 'automation-bot',
    repository: 'acme/app',
  }))
  const createGithubIssueProgressMarker = vi.fn<ServerAutomationExecutorInput['createGithubIssueProgressMarker']>(async () => ({
    ok: true,
    reactionId: 321,
  }))
  const removeGithubIssueProgressMarker = vi.fn<ServerAutomationExecutorInput['removeGithubIssueProgressMarker']>(async () => ({
    ok: true,
    removed: true,
  }))
  const dispatchAgentTask = vi.fn<ServerAutomationExecutorInput['dispatchAgentTask']>(async () => ({
    ok: true,
    dispatch: null,
  }))
  const maintainAgentTaskLease = vi.fn<ServerAutomationExecutorInput['maintainAgentTaskLease']>()
  const ensureReviewObjects = vi.fn<NonNullable<ServerAutomationExecutorInput['ensureReviewObjects']>>(
    async () => ({ ok: true, fetched: [] }),
  )
  const spawnSession = vi.fn<ServerAutomationExecutorInput['spawnSession']>(async () => ({
    ok: true as const,
    sessionId: 'session-1',
  }))
  const resumeSession = vi.fn<ServerAutomationExecutorInput['resumeSession']>(async () => ({
    ok: false as const,
    error: 'target session unavailable',
    shouldFallback: true,
  }))
  const resolveMcpSpawnContext = vi.fn(async (): Promise<AutomationMcpCallerGrantResult> => ({
    ok: true as const,
    value: {
      mcpCallerGrant: 'SIGNED-GRANT', mcpConfigProjectId: 'P-1', bindingStatus: 'BOUND',
      connectorPolicy: 'required', requiredConnectors: ['gmail'],
    },
  }))
  const preflightMcpConnectors = vi.fn<ServerAutomationExecutorInput['preflightMcpConnectors']>(async () => ({
    ok: true as const, availableConnectors: ['gmail'],
  }))
  const linkSession = vi.fn(async (): Promise<{ ok: boolean; error?: string; skipped?: boolean }> => ({ ok: true }))
  const decryptPayload = vi.fn((_automation: EncryptedServerAutomation, _machineSecretKey: Uint8Array) => ({
    name: 'name', schedule: { kind: 'interval' as const, minutes: 15 }, prompt: 'prompt',
    directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
  }))
  const logDebug = vi.fn()
  const prepareGithubWorktree = vi.fn<ServerAutomationExecutorInput['prepareGithubWorktree']>(async ({ runId, onPlanned }) => {
    const plan = {
      directory: `/isolated/${runId}`,
      worktreePath: `/isolated/${runId}`,
      repositoryRoot: '/repo',
    }
    onPlanned(plan)
    return { ok: true as const, ...plan }
  })
  const discardGithubWorktree = vi.fn<ServerAutomationExecutorInput['discardGithubWorktree']>(async () => ({
    ok: true as const,
  }))
  const input: ServerAutomationExecutorInput = {
    cache: { read: () => ({
      cursor: 1n, serverTime: now, syncedAt: now, pendingAcknowledgements: [],
      automations: [cacheRecord(options.generation, options.migrationPending)],
    }) },
    runtimeStore: store,
    machineSecretKey: new Uint8Array(32),
    now,
    transport,
    decryptPayload,
    runScript,
    queryGithubPullRequests,
    queryGithubPullRequestFiles,
    queryGithubIssues,
    notifyGithubTrigger,
    resolveGithubIssueProgressMarkerIdentity,
    createGithubIssueProgressMarker,
    removeGithubIssueProgressMarker,
    dispatchAgentTask,
    ensureReviewObjects,
    maintainAgentTaskLease,
    resolveMcpSpawnContext,
    preflightMcpConnectors,
    linkSession,
    resumeSession,
    spawnSession,
    prepareGithubWorktree,
    discardGithubWorktree,
    isSessionRunning: vi.fn(() => false),
    isDirectoryInUse: vi.fn(() => false),
    randomId: () => 'report-1',
    logDebug,
  }
  return {
    input, store, transport, decryptPayload, logDebug, runScript, queryGithubPullRequests, queryGithubPullRequestFiles,
    queryGithubIssues, notifyGithubTrigger, dispatchAgentTask, maintainAgentTaskLease,
    ensureReviewObjects,
    resolveGithubIssueProgressMarkerIdentity, createGithubIssueProgressMarker,
    removeGithubIssueProgressMarker,
    resolveMcpSpawnContext, preflightMcpConnectors, linkSession, resumeSession, spawnSession,
    prepareGithubWorktree, discardGithubWorktree, now,
  }
}

describe('runServerAutomationTick', () => {
  afterEach(() => vi.useRealTimers())

  it('fails closed without running user code when the server claim fails', async () => {
    const { input, store, transport, runScript, spawnSession, now } = setup()

    await expect(runServerAutomationTick(input)).resolves.toEqual([])
    expect(transport.start).not.toHaveBeenCalled()
    expect(runScript).not.toHaveBeenCalled()
    expect(spawnSession).not.toHaveBeenCalled()
    expect(store.state().schedules[0]!.nextRunAt).toBe(now)
  })

  it('consumes a new immediate run request without changing the automation generation', async () => {
    const { input, store, transport, now } = setup()
    store.write({
      ...store.read(),
      schedules: [{
        automationId: 'automation-1', generation: 2, nextRunAt: now + 900_000,
        lastSessionId: null, runRequestRevision: null,
      }],
    })
    input.cache = { read: () => ({
      cursor: 1n, serverTime: now, syncedAt: now, pendingAcknowledgements: [],
      automations: [{ ...cacheRecord(), revision: 3, runRequestedAt: now - 1_000 }],
    }) }

    await runServerAutomationTick(input)

    expect(transport.claim).toHaveBeenCalledWith({
      automationId: 'automation-1', generation: 2, scheduledFor: now - 1_000,
    })
    expect(store.state().schedules[0]).toMatchObject({ runRequestRevision: 3 })
  })

  it('keeps an immediate run request due while another run is active', async () => {
    const { input, store, transport, now } = setup({ claim: { ok: false, error: 'active-run' } })
    const requestedAt = now - 1_000
    store.write({
      ...store.read(),
      schedules: [{
        automationId: 'automation-1', generation: 2, nextRunAt: now + 900_000,
        lastSessionId: null, runRequestRevision: null,
      }],
    })
    input.cache = { read: () => ({
      cursor: 1n, serverTime: now, syncedAt: now, pendingAcknowledgements: [],
      automations: [{ ...cacheRecord(), revision: 3, runRequestedAt: requestedAt }],
    }) }

    await runServerAutomationTick(input)

    expect(transport.claim).toHaveBeenCalledWith({
      automationId: 'automation-1', generation: 2, scheduledFor: requestedAt,
    })
    expect(store.state().schedules[0]!.nextRunAt).toBe(requestedAt)
  })

  it('advances a scheduled slot when another run is already active', async () => {
    const { input, store, transport, now } = setup({ claim: { ok: false, error: 'active-run' } })

    await runServerAutomationTick(input)

    expect(transport.claim).toHaveBeenCalledWith({
      automationId: 'automation-1', generation: 2, scheduledFor: now,
    })
    expect(store.state().schedules[0]!.nextRunAt).toBe(now + 15 * 60_000)
  })

  it('isolates a corrupt encrypted row so other automations still tick', async () => {
    const { input, decryptPayload, logDebug, transport, now } = setup()
    const corrupt = { ...cacheRecord(), automationId: 'automation-corrupt' }
    input.cache = { read: () => ({
      cursor: 1n, serverTime: now, syncedAt: now, pendingAcknowledgements: [],
      automations: [corrupt, cacheRecord()],
    }) }
    decryptPayload.mockImplementation((automation) => {
      if (automation.automationId === corrupt.automationId) throw new Error('automation-decrypt-failed')
      return {
        name: 'name', schedule: { kind: 'interval' as const, minutes: 15 }, prompt: 'prompt',
        directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      }
    })
    await expect(runServerAutomationTick(input)).resolves.toEqual([])
    expect(transport.claim).toHaveBeenCalledWith(expect.objectContaining({ automationId: 'automation-1' }))
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('automation-corrupt'))
  })

  it('does not claim while legacy scheduler ownership is still staged', async () => {
    const { input, transport, runScript, spawnSession } = setup({ migrationPending: true })

    await expect(runServerAutomationTick(input)).resolves.toEqual([])
    expect(transport.claim).not.toHaveBeenCalled()
    expect(runScript).not.toHaveBeenCalled()
    expect(spawnSession).not.toHaveBeenCalled()
  })

  it('backs off an ended marker cleanup when the claimed run cannot start', async () => {
    const { input, store, transport, now } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'Issue triage', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Triage', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'issue_opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubIssueProgressMarkers: [{
        automationId: 'automation-1', generation: 2, sessionId: 'ended-session',
        issueNumber: 12, actor: 'automation-bot', repository: 'acme/app', reactionId: 321,
      }],
    })
    transport.start.mockResolvedValue({ ok: false, error: 'start unavailable' })

    await expect(runServerAutomationTick(input)).resolves.toEqual([])
    expect(store.state().githubIssueProgressMarkers).toEqual([expect.objectContaining({
      sessionId: 'ended-session', cleanupRetryAt: now + 15 * 60_000,
    })])

    await expect(runServerAutomationTick(input)).resolves.toEqual([])
    expect(transport.claim).toHaveBeenCalledTimes(1)
    expect(transport.start).toHaveBeenCalledTimes(1)
  })

  it('runs only after claim and start, then durably retries the same completion report', async () => {
    const { input, store, transport, resolveMcpSpawnContext, linkSession, spawnSession, logDebug } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token', claimExpiresAt: 1_100_000, serverTime: 1_000_000 } },
    })
    transport.report
      .mockResolvedValueOnce({ ok: false, error: 'offline' })
      .mockResolvedValueOnce({ ok: true, value: { idempotent: true } })

    await expect(runServerAutomationTick(input)).resolves.toEqual([{ automationId: 'automation-1', outcome: 'WOKE' }])
    expect(transport.claim.mock.invocationCallOrder[0]).toBeLessThan(transport.start.mock.invocationCallOrder[0]!)
    expect(transport.start.mock.invocationCallOrder[0]).toBeLessThan(spawnSession.mock.invocationCallOrder[0]!)
    expect(resolveMcpSpawnContext).toHaveBeenCalledWith({ runId: 'run-1', claimToken: 'claim-token' })
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      mcpSpawnContext: expect.objectContaining({
        mcpCallerGrant: 'SIGNED-GRANT', mcpConfigProjectId: 'P-1',
        connectorPolicy: 'required', requiredConnectors: ['gmail'],
      }),
      expectedConnectors: ['gmail'],
    }))
    expect(store.state().pendingReports).toEqual([expect.objectContaining({
      runId: 'run-1', claimToken: 'claim-token', reportId: 'report-1', outcome: 'WOKE',
    })])

    await runServerAutomationTick(input)
    expect(transport.report).toHaveBeenCalledTimes(2)
    expect(transport.report.mock.calls[1]![0]).toEqual(transport.report.mock.calls[0]![0])
    expect(linkSession).toHaveBeenCalledWith({
      runId: 'run-1', claimToken: 'claim-token', sessionId: 'session-1',
    })
    expect(store.state().pendingReports).toEqual([])
    expect(transport.claim).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(logDebug.mock.calls)).not.toContain('SIGNED-GRANT')
  })

  it('keeps a successful report durable until the spawned session is linked to its project', async () => {
    const { input, store, transport, linkSession } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    transport.report
      .mockResolvedValueOnce({ ok: true, value: { idempotent: false } })
      .mockResolvedValueOnce({ ok: true, value: { idempotent: true } })
    linkSession
      .mockResolvedValueOnce({ ok: false, error: 'project link unavailable' })
      .mockResolvedValueOnce({ ok: true })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'WOKE' },
    ])
    expect(store.state().pendingReports).toEqual([expect.objectContaining({
      runId: 'run-1', sessionId: 'session-1',
    })])

    await runServerAutomationTick(input)
    expect(transport.report).toHaveBeenCalledTimes(2)
    expect(linkSession).toHaveBeenCalledTimes(2)
    expect(store.state().pendingReports).toEqual([])
    expect(transport.claim).toHaveBeenCalledTimes(1)
  })

  it('keeps retrying the project link while the daemon has no Aplus config, within the 24h window', async () => {
    const { input, store, transport, linkSession } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    transport.report.mockResolvedValue({ ok: true, value: { idempotent: false } })
    linkSession.mockResolvedValue({ ok: true, skipped: true })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'WOKE' },
    ])
    expect(store.state().pendingReports).toEqual([expect.objectContaining({
      runId: 'run-1', sessionId: 'session-1',
    })])

    // A due interval schedule would otherwise reclaim and start a second run on
    // this tick too — reject that claim to isolate the pending-report flush.
    transport.claim.mockResolvedValueOnce({ ok: false, error: 'not due yet' })
    input.now += 60 * 60 * 1000 // +1h, well inside the 24h giveup window
    await runServerAutomationTick(input)
    expect(linkSession).toHaveBeenCalledTimes(2)
    expect(store.state().pendingReports).toEqual([expect.objectContaining({
      runId: 'run-1', sessionId: 'session-1',
    })])
  })

  it('gives up linking after the 24h retry window and stops carrying the report', async () => {
    const { input, store, transport, linkSession, logDebug } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    transport.report.mockResolvedValue({ ok: true, value: { idempotent: false } })
    linkSession.mockResolvedValue({ ok: true, skipped: true })

    await runServerAutomationTick(input)
    expect(store.state().pendingReports).toHaveLength(1)

    // Isolate the flush (see comment above): reject the reclaim so this tick
    // only exercises the give-up path for the already-pending report.
    transport.claim.mockResolvedValueOnce({ ok: false, error: 'not due yet' })
    input.now += 25 * 60 * 60 * 1000 // past the 24h giveup window
    await runServerAutomationTick(input)
    expect(store.state().pendingReports).toEqual([])
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('gave up'))
  })

  it('fails before spawn when the execution policy cannot be resolved', async () => {
    const { input, transport, resolveMcpSpawnContext, spawnSession, logDebug } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    resolveMcpSpawnContext.mockResolvedValue({
      ok: false,
      error: 'caller grant exchange returned 409',
      code: 'EXECUTION_PRINCIPAL_UNBOUND',
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'ERROR' },
    ])

    expect(spawnSession).not.toHaveBeenCalled()
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('caller grant exchange returned 409'))
    expect(transport.report).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', status: 'FAILED', outcome: 'ERROR', sessionId: null,
      failureCode: 'EXECUTION_PRINCIPAL_UNBOUND',
    }))
  })

  it('allows degraded spawn only for an optional connector policy', async () => {
    const {
      input, transport, resolveMcpSpawnContext, preflightMcpConnectors, spawnSession,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    resolveMcpSpawnContext.mockResolvedValue({
      ok: true,
      value: {
        mcpConfigProjectId: 'P-1', bindingStatus: 'BOUND', connectorPolicy: 'optional',
        requiredConnectors: ['gmail'],
      },
    })
    preflightMcpConnectors.mockResolvedValue({
      ok: false, code: 'GRANT_MISSING', unavailableConnectors: ['gmail'],
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'WOKE' },
    ])

    expect(spawnSession).toHaveBeenCalledTimes(1)
    expect(spawnSession.mock.calls[0]![0]).not.toHaveProperty('mcpSpawnContext')
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ expectedConnectors: ['gmail'] }))
    expect(transport.report).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', status: 'COMPLETED', outcome: 'WOKE', sessionId: 'session-1',
      degradedCode: 'GRANT_MISSING',
    }))
  })

  it('blocks a required connector automation when tool inventory is unavailable', async () => {
    const { input, preflightMcpConnectors, spawnSession, transport } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    preflightMcpConnectors.mockResolvedValue({
      ok: false, code: 'TOOL_INVENTORY_EMPTY', unavailableConnectors: ['gmail'],
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'ERROR' },
    ])
    expect(spawnSession).not.toHaveBeenCalled()
    expect(transport.report).toHaveBeenCalledWith(expect.objectContaining({
      status: 'FAILED', outcome: 'ERROR', sessionId: null,
      failureCode: 'TOOL_INVENTORY_EMPTY',
    }))
  })

  it('issues the caller grant only after the wake gate decides to spawn a session', async () => {
    const { input, runScript, resolveMcpSpawnContext, spawnSession } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'name', schedule: { kind: 'interval' as const, minutes: 15 }, prompt: 'prompt',
      directory: '/repo', scriptCommand: 'check-if-needed', suppressSilent: false, agent: 'claude' as const,
    }))
    runScript.mockResolvedValue({ ok: true, stdout: '{"wakeAgent": false}' })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'SKIPPED_GATE' },
    ])

    expect(runScript).toHaveBeenCalled()
    expect(resolveMcpSpawnContext).not.toHaveBeenCalled()
    expect(spawnSession).not.toHaveBeenCalled()
  })

  it('resets a stale local schedule when the server generation changes', async () => {
    const { input, store, transport, now } = setup({ generation: 3 })

    await runServerAutomationTick(input)
    expect(transport.claim).not.toHaveBeenCalled()
    expect(store.state().schedules).toEqual([expect.objectContaining({
      automationId: 'automation-1', generation: 3, nextRunAt: now + 15 * 60_000,
    })])
  })

  it.each(['claim-denied', 'already-claimed'])('advances without catch-up or user code after %s', async (error) => {
    const { input, store, transport, runScript, spawnSession, now } = setup({ claim: { ok: false, error } })

    await expect(runServerAutomationTick(input)).resolves.toEqual([])
    expect(store.state().schedules[0]!.nextRunAt).toBe(now + 15 * 60_000)
    expect(transport.start).not.toHaveBeenCalled()
    expect(runScript).not.toHaveBeenCalled()
    expect(spawnSession).not.toHaveBeenCalled()
  })

  it('keeps a GitHub backlog eligible for the next tick after a stale claim is rejected', async () => {
    const { input, store, transport, now } = setup({ claim: { ok: false, error: 'claim-denied' } })
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: {
          snapshot: [], highestPrNumber: 12, processed: [],
          pending: [{
            id: 'opened:12:head-sha', event: 'opened',
            pr: {
              number: 12, title: 'PR 12', url: 'https://github.test/o/r/pull/12',
              author: { login: 'bob' }, baseRefName: 'main', headRefName: 'pr-12',
              isDraft: false, state: 'OPEN', mergedAt: null, labels: [], changedFiles: 0, files: [],
            },
          }],
        },
      }],
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Review',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    }))

    await expect(runServerAutomationTick(input)).resolves.toEqual([])

    expect(store.state().schedules[0]!.nextRunAt).toBe(now + 1)
    expect(transport.start).not.toHaveBeenCalled()
  })

  it('keeps the due for a later retry when the server is unreachable', async () => {
    const { input, store, transport, spawnSession, now } = setup()
    transport.claim.mockRejectedValue(new Error('socket disconnected'))

    await expect(runServerAutomationTick(input)).rejects.toThrow('socket disconnected')
    expect(store.state().schedules[0]!.nextRunAt).toBe(now)
    expect(spawnSession).not.toHaveBeenCalled()
  })

  it('does not run user code when pause or generation wins between claim and start', async () => {
    const { input, store, transport, runScript, spawnSession, now } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'token' } },
    })
    transport.start.mockResolvedValue({ ok: false, error: 'claim-cancelled' })

    await expect(runServerAutomationTick(input)).resolves.toEqual([])
    expect(store.state().schedules[0]!.nextRunAt).toBe(now + 15 * 60_000)
    expect(runScript).not.toHaveBeenCalled()
    expect(spawnSession).not.toHaveBeenCalled()
  })

  it('heartbeats a long-running started execution before reporting it', async () => {
    vi.useFakeTimers()
    const { input, transport, spawnSession } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'token' } },
    })
    spawnSession.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, sessionId: 'session-1' }), 61_000)
    }))

    const running = runServerAutomationTick(input)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(transport.heartbeat).toHaveBeenCalledWith({ runId: 'run-1', claimToken: 'token' })
    await vi.advanceTimersByTimeAsync(1_000)
    await running
    expect(transport.report).toHaveBeenCalled()
  })

  it('persists a matching GitHub event before starting a session with the rendered prompt', async () => {
    const {
      input, store, queryGithubPullRequests, spawnSession, createGithubIssueProgressMarker,
      removeGithubIssueProgressMarker,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review {pr.number}: {pr.title}', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'codex' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
      githubIssueProgressMarkers: [{
        automationId: 'automation-1', generation: 1, sessionId: 'ended-issue-session',
        issueNumber: 9, actor: 'automation-bot', repository: 'acme/old-app', reactionId: 300,
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'run-scoped-token', GH_REPO: 'acme/app' },
      pullRequests: [{
        number: 10, title: 'Add search', url: 'https://github.test/o/r/pull/10', author: { login: 'alice' },
        baseRefName: 'main', headRefName: 'feature/search', isDraft: false, state: 'OPEN', mergedAt: null,
        labels: [], changedFiles: 1, files: [{ path: 'apps/web/page.tsx' }],
      }],
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'WOKE' },
    ])
    expect(queryGithubPullRequests).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo', githubCredentialId: 'credential-1', runId: 'run-1', claimToken: 'claim-token',
    }))
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      initialPrompt: expect.stringMatching(
        /^\[주의\].*외부 사용자가 임의로 작성할 수 있는 데이터.*\n\nReview 10: Add search$/,
      ),
      agent: 'codex',
      environmentVariables: { GH_TOKEN: 'run-scoped-token', GH_REPO: 'acme/app' },
    }))
    expect(store.state().githubTriggers?.[0]?.state.processed).toContain('10:opened')
    expect(createGithubIssueProgressMarker).not.toHaveBeenCalled()
    expect(removeGithubIssueProgressMarker).toHaveBeenCalledWith(expect.objectContaining({
      issueNumber: 9,
      repository: 'acme/old-app',
      reactionId: 300,
    }))
    expect(store.state().githubIssueProgressMarkers).toEqual([])
  })

  it('spawns an issue_opened session with the issue-rendered prompt and persists the high-water state', async () => {
    const {
      input, store, queryGithubPullRequests, queryGithubIssues, spawnSession,
      resolveGithubIssueProgressMarkerIdentity, createGithubIssueProgressMarker,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'Issue triage', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Triage {issue.number}: {issue.title} ({issue.url})', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      model: 'sonnet', effort: 'high',
      githubTrigger: {
        event: 'issue_opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: {
          snapshot: [], highestPrNumber: 0, processed: [], pending: [],
          highestIssueNumber: 11, pendingIssues: [],
        },
      }],
    })
    queryGithubIssues.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'run-scoped-token', GH_REPO: 'acme/app' },
      issues: [{
        number: 12, title: 'Search is broken', url: 'https://github.test/o/r/issues/12',
        author: { login: 'alice' }, labels: [{ name: 'bug' }],
      }],
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'WOKE' },
    ])
    expect(queryGithubIssues).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo', githubCredentialId: 'credential-1', runId: 'run-1', claimToken: 'claim-token',
    }))
    expect(queryGithubPullRequests).not.toHaveBeenCalled()
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      initialPrompt: expect.stringMatching(
        /^\[주의\].*이슈 제목·작성자·라벨.*\n\nTriage 12: Search is broken \(https:\/\/github\.test\/o\/r\/issues\/12\)$/,
      ),
      agent: 'claude',
      model: 'sonnet',
      effort: 'high',
      environmentVariables: { GH_TOKEN: 'run-scoped-token', GH_REPO: 'acme/app' },
    }))
    expect(store.state().githubTriggers?.[0]?.state.processed).toContain('12:issue_opened')
    expect(store.state().githubTriggers?.[0]?.state.highestIssueNumber).toBe(12)
    expect(spawnSession.mock.invocationCallOrder[0]).toBeLessThan(
      resolveGithubIssueProgressMarkerIdentity.mock.invocationCallOrder[0]!,
    )
    expect(resolveGithubIssueProgressMarkerIdentity).toHaveBeenCalledWith({
      cwd: '/repo',
      githubEnvironment: { GH_TOKEN: 'run-scoped-token', GH_REPO: 'acme/app' },
    })
    expect(createGithubIssueProgressMarker).toHaveBeenCalledWith({
      cwd: '/repo',
      githubEnvironment: { GH_TOKEN: 'run-scoped-token', GH_REPO: 'acme/app' },
      issueNumber: 12,
      actor: 'automation-bot',
      repository: 'acme/app',
    })
    expect(store.state().githubIssueProgressMarkers).toEqual([{
      automationId: 'automation-1', generation: 2, sessionId: 'session-1', issueNumber: 12,
      actor: 'automation-bot', repository: 'acme/app', reactionId: 321,
    }])
  })

  it('keeps an issue session successful and reports typed degradation when the progress reaction fails', async () => {
    const {
      input, store, transport, queryGithubIssues, createGithubIssueProgressMarker,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'Issue triage', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Triage {issue.number}', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'issue_opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: {
          snapshot: [], highestPrNumber: 0, processed: [], pending: [],
          highestIssueNumber: 11, pendingIssues: [],
        },
      }],
    })
    queryGithubIssues.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'run-scoped-token', GH_REPO: 'acme/app' },
      issues: [{
        number: 12, title: 'Search is broken', url: 'https://github.test/o/r/issues/12',
        author: { login: 'alice' }, labels: [],
      }],
    })
    createGithubIssueProgressMarker.mockResolvedValue({ ok: false, error: 'reaction denied' })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'WOKE' },
    ])
    expect(transport.report).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'WOKE',
      sessionId: 'session-1',
      degradedCode: 'GITHUB_ISSUE_PROGRESS_MARKER_CREATE_FAILED',
    }))
    expect(store.state().githubIssueProgressMarkers).toEqual([expect.objectContaining({
      sessionId: 'session-1', issueNumber: 12, actor: 'automation-bot',
      repository: 'acme/app', reactionId: null,
    })])
  })

  it('removes a persisted issue progress marker after restart when its session is no longer running', async () => {
    const {
      input, store, queryGithubIssues, resolveGithubIssueProgressMarkerIdentity,
      removeGithubIssueProgressMarker,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'Issue triage', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Triage', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'issue_opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: {
          snapshot: [], highestPrNumber: 0, processed: [], pending: [],
          highestIssueNumber: 12, pendingIssues: [],
        },
      }],
      githubIssueProgressMarkers: [{
        automationId: 'automation-1', generation: 2, sessionId: 'ended-session',
        issueNumber: 12, actor: 'automation-bot', repository: 'acme/old-app', reactionId: 321,
      }],
    })
    queryGithubIssues.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'run-scoped-token', GH_REPO: 'acme/new-app' },
      issues: [],
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'SKIPPED_GATE' },
    ])
    expect(resolveGithubIssueProgressMarkerIdentity).toHaveBeenCalledWith({
      cwd: '/repo',
      githubEnvironment: { GH_TOKEN: 'run-scoped-token', GH_REPO: 'acme/old-app' },
    })
    expect(removeGithubIssueProgressMarker).toHaveBeenCalledWith({
      cwd: '/repo',
      githubEnvironment: { GH_TOKEN: 'run-scoped-token', GH_REPO: 'acme/old-app' },
      issueNumber: 12,
      actor: 'automation-bot',
      repository: 'acme/old-app',
      reactionId: 321,
    })
    expect(store.state().githubIssueProgressMarkers).toEqual([])
  })

  it('brings a future GitHub schedule forward to clean an ended issue marker on the next daemon tick', async () => {
    const {
      input, store, transport, queryGithubIssues, removeGithubIssueProgressMarker, now,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'Issue triage', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Triage', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'issue_opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      schedules: [{
        automationId: 'automation-1', generation: 2, nextRunAt: now + 15 * 60_000,
        lastSessionId: null,
      }],
      githubIssueProgressMarkers: [{
        automationId: 'automation-1', generation: 2, sessionId: 'ended-session',
        issueNumber: 12, actor: 'automation-bot', repository: 'acme/app', reactionId: 321,
      }],
    })
    queryGithubIssues.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'run-scoped-token', GH_REPO: 'acme/app' },
      issues: [],
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'SKIPPED_GATE' },
    ])
    expect(transport.claim).toHaveBeenCalledWith({
      automationId: 'automation-1', generation: 2, scheduledFor: now,
    })
    expect(removeGithubIssueProgressMarker).toHaveBeenCalled()
    expect(store.state().githubIssueProgressMarkers).toEqual([])
  })

  it('retains a failed issue marker cleanup and reports typed degradation for retry', async () => {
    const {
      input, store, transport, queryGithubIssues, removeGithubIssueProgressMarker, now,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'Issue triage', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Triage', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'issue_opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubIssueProgressMarkers: [{
        automationId: 'automation-1', generation: 2, sessionId: 'ended-session',
        issueNumber: 12, actor: 'automation-bot', repository: 'acme/app', reactionId: null,
      }],
    })
    queryGithubIssues.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'run-scoped-token', GH_REPO: 'acme/app' },
      issues: [],
    })
    removeGithubIssueProgressMarker.mockResolvedValue({ ok: false, error: 'GitHub unavailable' })

    await runServerAutomationTick(input)

    expect(transport.report).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'SKIPPED_GATE',
      degradedCode: 'GITHUB_ISSUE_PROGRESS_MARKER_CLEANUP_FAILED',
    }))
    expect(store.state().githubIssueProgressMarkers).toEqual([expect.objectContaining({
      sessionId: 'ended-session', reactionId: null, cleanupRetryAt: now + 15 * 60_000,
    })])

    await expect(runServerAutomationTick(input)).resolves.toEqual([])
    expect(transport.claim).toHaveBeenCalledTimes(1)
    expect(removeGithubIssueProgressMarker).toHaveBeenCalledTimes(1)
  })

  it('keeps marker cleanup degradation when optional connector preflight also degrades the spawned session', async () => {
    const {
      input, store, transport, queryGithubIssues, removeGithubIssueProgressMarker,
      resolveMcpSpawnContext, preflightMcpConnectors,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'Issue triage', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Triage {issue.number}', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'issue_opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: {
          snapshot: [], highestPrNumber: 0, processed: [], highestIssueNumber: 12, pending: [],
          pendingIssues: [{
            id: '12:issue_opened', event: 'issue_opened',
            issue: {
              number: 12, title: 'Search is broken', url: 'https://github.test/o/r/issues/12',
              author: { login: 'alice' }, labels: [],
            },
          }],
        },
      }],
      githubIssueProgressMarkers: [{
        automationId: 'automation-1', generation: 1, sessionId: 'ended-session',
        issueNumber: 11, actor: 'automation-bot', repository: 'acme/app', reactionId: 300,
      }],
    })
    queryGithubIssues.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'run-scoped-token', GH_REPO: 'acme/app' },
      issues: [],
    })
    removeGithubIssueProgressMarker.mockResolvedValue({ ok: false, error: 'GitHub unavailable' })
    resolveMcpSpawnContext.mockResolvedValue({
      ok: true,
      value: {
        mcpConfigProjectId: 'P-1', bindingStatus: 'BOUND', connectorPolicy: 'optional',
        requiredConnectors: ['gmail'],
      },
    })
    preflightMcpConnectors.mockResolvedValue({
      ok: false, code: 'GRANT_MISSING', unavailableConnectors: ['gmail'],
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'WOKE' },
    ])
    expect(transport.report).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'WOKE',
      degradedCode: 'GITHUB_ISSUE_PROGRESS_MARKER_CLEANUP_FAILED',
    }))
  })

  it('does not remove an issue marker while its session is still running', async () => {
    const {
      input, store, queryGithubIssues, resolveGithubIssueProgressMarkerIdentity,
      removeGithubIssueProgressMarker,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.isSessionRunning = vi.fn((sessionId) => sessionId === 'active-session')
    input.decryptPayload = vi.fn(() => ({
      name: 'Issue triage', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Triage', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'issue_opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubIssueProgressMarkers: [{
        automationId: 'automation-1', generation: 2, sessionId: 'active-session',
        issueNumber: 12, actor: 'automation-bot', repository: 'acme/app', reactionId: 321,
      }],
    })
    queryGithubIssues.mockResolvedValue({ ok: true, issues: [] })

    await runServerAutomationTick(input)

    expect(resolveGithubIssueProgressMarkerIdentity).not.toHaveBeenCalled()
    expect(removeGithubIssueProgressMarker).not.toHaveBeenCalled()
    expect(store.state().githubIssueProgressMarkers).toEqual([expect.objectContaining({
      sessionId: 'active-session', reactionId: 321,
    })])
  })

  it('keeps a shared issue reaction while another owning session is still running', async () => {
    const {
      input, store, queryGithubIssues, removeGithubIssueProgressMarker,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.isSessionRunning = vi.fn((sessionId) => sessionId === 'other-active-session')
    input.decryptPayload = vi.fn(() => ({
      name: 'Issue triage', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Triage', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'issue_opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubIssueProgressMarkers: [{
        automationId: 'automation-1', generation: 2, sessionId: 'ended-session',
        issueNumber: 12, actor: 'automation-bot', repository: 'acme/app', reactionId: 321,
      }, {
        automationId: 'automation-2', generation: 1, sessionId: 'other-active-session',
        issueNumber: 12, actor: 'AUTOMATION-BOT', repository: 'ACME/APP', reactionId: 321,
      }],
    })
    queryGithubIssues.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'run-scoped-token', GH_REPO: 'acme/app' },
      issues: [],
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'SKIPPED_GATE' },
    ])

    expect(removeGithubIssueProgressMarker).not.toHaveBeenCalled()
    expect(store.state().githubIssueProgressMarkers).toEqual([expect.objectContaining({
      automationId: 'automation-2', sessionId: 'other-active-session', reactionId: 321,
    })])
  })

  it('does not create an issue progress marker when session spawn fails', async () => {
    const {
      input, store, queryGithubIssues, spawnSession,
      resolveGithubIssueProgressMarkerIdentity, createGithubIssueProgressMarker,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'Issue triage', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Triage', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'issue_opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: {
          snapshot: [], highestPrNumber: 0, processed: [], pending: [],
          highestIssueNumber: 11, pendingIssues: [],
        },
      }],
    })
    queryGithubIssues.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'run-scoped-token', GH_REPO: 'acme/app' },
      issues: [{
        number: 12, title: 'Search is broken', url: 'https://github.test/o/r/issues/12',
        author: { login: 'alice' }, labels: [],
      }],
    })
    spawnSession.mockResolvedValue({ ok: false, error: 'spawn failed' })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'ERROR' },
    ])
    expect(resolveGithubIssueProgressMarkerIdentity).not.toHaveBeenCalled()
    expect(createGithubIssueProgressMarker).not.toHaveBeenCalled()
    expect(store.state().githubIssueProgressMarkers ?? []).toEqual([])
  })

  // .137 이후 query.error 자체가 자기 서술적이라 executor 가 접두사를 또 붙이면
  // "GitHub query failed: GitHub query failed:" 로 두 번 찍힌다.
  it('does not repeat the failure prefix the query already carries', async () => {
    const { input, logDebug, queryGithubPullRequests } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review {pr.number}', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    }))
    queryGithubPullRequests.mockResolvedValue({
      ok: false,
      error: 'GitHub query failed: HTTP 504: We could not respond in time',
    })

    await runServerAutomationTick(input)

    const line = logDebug.mock.calls.map((call) => String(call[0]))
      .find((message) => message.includes('GitHub query failed'))
    expect(line).toBeDefined()
    expect(line!.match(/GitHub query failed/g)).toHaveLength(1)
    expect(line).toContain('HTTP 504')
  })

  // 권한이 없으면 gh 는 오류가 아니라 빈 배열을 돌려준다. 첫 baseline 이 조용히
  // 0건으로 기록되면 운영자는 어떤 로그도 못 본다 — 이 사고에서 가장 오래 헤맨 지점.
  it('records the observed count when an issue baseline is first established', async () => {
    const { input, logDebug, queryGithubIssues } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'Issue triage', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Triage {issue.number}', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'issue_opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    }))
    queryGithubIssues.mockResolvedValue({ ok: true, issues: [] })

    await runServerAutomationTick(input)

    const line = logDebug.mock.calls.map((call) => String(call[0]))
      .find((message) => message.includes('baseline'))
    expect(line).toBeDefined()
    expect(line).toContain('0')
    // 0건은 "이슈가 없다" 와 "실행 계정이 이슈를 못 읽는다" 를 구분하지 못한다.
    expect(line!.toLowerCase()).toContain('permission')
  })

  // AC9 로 계약이 바뀌었다 — 목록 조회는 경로 필터 유무와 무관하게 항상 가볍고,
  // 파일은 이벤트를 유발하는 PR 에만 따로 받는다.
  it.each([
    ['keeps the list query light even when a path filter exists', ['projects/api/*'], false],
    ['keeps the list query light when no path filter is set', [], false],
  ])('%s', async (_label, paths, expected) => {
    const { input, queryGithubPullRequests } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review {pr.number}', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    }))

    await runServerAutomationTick(input)

    expect(queryGithubPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({ includeChangedFiles: expected }),
    )
  })

  it('fetches files only for the pull requests that derive an event', async () => {
    const { input, queryGithubPullRequests, queryGithubPullRequestFiles, store } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review {pr.number}', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: ['api/'] },
        action: 'start-session' as const, githubCredentialId: null,
      },
    }))
    store.write({
      ...store.state(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 10, processed: [], pending: [] },
      }],
    })
    const row = (n: number) => ({
      number: n, title: 't', url: 'u', author: { login: 'a' }, baseRefName: 'main',
      headRefName: 'f', isDraft: false, state: 'OPEN' as const, mergedAt: null,
      labels: [], changedFiles: 0, files: [],
    })
    queryGithubPullRequests.mockResolvedValue({ ok: true, pullRequests: [row(9), row(11)] })

    await runServerAutomationTick(input)

    // 목록 조회는 파일 없이, 파일은 후보 11 에만.
    expect(queryGithubPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({ includeChangedFiles: false }),
    )
    expect(queryGithubPullRequestFiles).toHaveBeenCalledWith(
      expect.objectContaining({ numbers: [11] }),
    )
  })

  it('does not fetch files when no pull request derives an event', async () => {
    const { input, queryGithubPullRequests, queryGithubPullRequestFiles, store } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review {pr.number}', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: ['api/'] },
        action: 'start-session' as const, githubCredentialId: null,
      },
    }))
    store.write({
      ...store.state(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 99, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({ ok: true, pullRequests: [] })

    await runServerAutomationTick(input)

    expect(queryGithubPullRequestFiles).not.toHaveBeenCalled()
  })

  it('collects an issue baseline without firing on the first observation (fail-closed)', async () => {
    const { input, store, queryGithubIssues, notifyGithubTrigger, spawnSession } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'Issue triage', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Triage {issue.number}', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'issue_opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    }))
    queryGithubIssues.mockResolvedValue({
      ok: true,
      issues: [{
        number: 42, title: 'Old issue', url: 'https://github.test/o/r/issues/42',
        author: { login: 'bob' }, labels: [],
      }],
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'SKIPPED_GATE' },
    ])
    expect(spawnSession).not.toHaveBeenCalled()
    expect(notifyGithubTrigger).not.toHaveBeenCalled()
    expect(store.state().githubTriggers?.[0]?.state.highestIssueNumber).toBe(42)
  })

  it('notifies issue_opened events without starting an LLM session', async () => {
    const {
      input, store, queryGithubIssues, notifyGithubTrigger, resolveMcpSpawnContext, spawnSession,
      createGithubIssueProgressMarker,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'Issue alert', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Opened {issue.number} by {issue.author}', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'issue_opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'notify' as const,
        githubCredentialId: null,
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: {
          snapshot: [], highestPrNumber: 0, processed: [], pending: [],
          highestIssueNumber: 0, pendingIssues: [],
        },
      }],
    })
    queryGithubIssues.mockResolvedValue({
      ok: true,
      issues: [{
        number: 5, title: 'Docs typo', url: 'https://github.test/o/r/issues/5',
        author: { login: 'bob' }, labels: [],
      }],
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'WOKE' },
    ])
    expect(notifyGithubTrigger).toHaveBeenCalledWith({
      title: 'Issue alert',
      body: 'Opened 5 by bob',
      url: 'https://github.test/o/r/issues/5',
    })
    expect(resolveMcpSpawnContext).not.toHaveBeenCalled()
    expect(spawnSession).not.toHaveBeenCalled()
    expect(createGithubIssueProgressMarker).not.toHaveBeenCalled()
  })

  it('forwards escalation handles so the server comment can mention them', async () => {
    // 2026-08-31 — hsmoa 프롬프트의 "high 이면 @eunchong 을 멘션하라" 가 한 번도
    // 동작하지 않은 이유는 코멘트를 워커가 아니라 서버가 조립하기 때문이다. 담당자는
    // 설정에만 있고 서버는 자동화 payload 를 복호화할 수 없으므로, 데몬이 dispatch 에
    // 실어 보내야 서버가 알 수 있다.
    const { input, store, queryGithubPullRequests, dispatchAgentTask } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review safely', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'codex' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
        escalateTo: ['eunchong'],
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'github-secret', GH_REPO: 'acme/app' },
      pullRequests: [],
    })

    await runServerAutomationTick(input)

    expect(dispatchAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      escalateTo: ['eunchong'],
    }))
  })

  it('reviews in a worktree checked out at the dispatched head sha', async () => {
    // 2026-09-01 프로덕션 — PR #317 리뷰가 "대상 SHA 테스트를 실행하지 못했다" 고
    // 보고했다. AgentTask 워커만 프로젝트 디렉터리에서 그대로 돌아 HEAD 가 사용자가
    // 마지막에 둔 커밋이었기 때문이다(start-session 리뷰는 전용 worktree 를 받는다).
    // 그래서 워커는 git show 로 파일을 한 장씩 읽는 우회를 하고 테스트는 포기했다.
    const { input, store, queryGithubPullRequests, dispatchAgentTask,
      prepareGithubWorktree, spawnSession } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review safely', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'codex' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'github-secret', GH_REPO: 'acme/app' },
      pullRequests: [],
    })
    dispatchAgentTask.mockResolvedValue({
      ok: true,
      dispatch: {
        taskId: 'review-1', type: 'pr_review.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret',
        controlUrl: 'https://studio.test/api/agent-tasks',
        input: { prNumber: 317, baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) },
        context: [{ kind: 'diff', body: 'diff --git a/x b/x' }],
      },
    })

    await runServerAutomationTick(input)

    // 이벤트가 아니라 dispatch 가 준 SHA 여야 한다 — 큐에서 나온 task 는 지금
    // planned 이벤트와 다른 PR 일 수 있다.
    expect(prepareGithubWorktree).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      pullRequest: { number: 317, expectedHeadSha: 'c'.repeat(40) },
    }))
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/isolated/run-1',
    }))
  })

  it('skips a merged PR whose branch is gone instead of falling back', async () => {
    // 2026-09-01 프로덕션 — happy #319 가 머지되며 브랜치가 삭제됐고, 그 이벤트를
    // 처리하던 AgentTask 리뷰가 worktree 준비에 실패하자 프로젝트 디렉터리로
    // 폴백해 워커를 띄웠다. 삭제된 브랜치는 되돌릴 수 없는 실패라 폴백해도 리뷰할
    // 대상이 없다 — 이벤트를 소비하고 끊어야 한다. AgentTask 폴백을 영구 실패
    // 판정보다 앞에 두어 생긴 문제다.
    const { input, store, queryGithubPullRequests, dispatchAgentTask,
      prepareGithubWorktree, spawnSession, logDebug } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review safely', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'codex' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'github-secret', GH_REPO: 'acme/app' },
      pullRequests: [],
    })
    dispatchAgentTask.mockResolvedValue({
      ok: true,
      dispatch: {
        taskId: 'review-1', type: 'pr_review.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret',
        controlUrl: 'https://studio.test/api/agent-tasks',
        input: { prNumber: 319, baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) },
        context: [{ kind: 'diff', body: 'diff --git a/x b/x' }],
      },
    })
    prepareGithubWorktree.mockResolvedValue({
      ok: false,
      error: "GitHub pull request checkout failed: fatal: couldn't find remote ref refs/heads/gone",
      cleaned: true,
    })

    await runServerAutomationTick(input)

    expect(spawnSession).not.toHaveBeenCalled()
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('permanently unavailable'))
    expect(logDebug).not.toHaveBeenCalledWith(expect.stringContaining('project directory instead'))
  })

  it('still reviews in the project directory when the worktree cannot be prepared', async () => {
    // dispatch 시점에 서버가 task 를 이미 확정했다. 여기서 중단하면 그 task 는 워커
    // 없이 lease 만료까지 남는다. worktree 는 있으면 좋은 것이지 전제가 아니므로,
    // 실패하면 사유를 남기고 기존처럼 프로젝트 디렉터리에서 리뷰한다.
    const { input, store, queryGithubPullRequests, dispatchAgentTask,
      prepareGithubWorktree, spawnSession, logDebug } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review safely', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'codex' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'github-secret', GH_REPO: 'acme/app' },
      pullRequests: [],
    })
    dispatchAgentTask.mockResolvedValue({
      ok: true,
      dispatch: {
        taskId: 'review-1', type: 'pr_review.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret',
        controlUrl: 'https://studio.test/api/agent-tasks',
        input: { prNumber: 317, baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) },
        context: [{ kind: 'diff', body: 'diff --git a/x b/x' }],
      },
    })
    prepareGithubWorktree.mockResolvedValue({
      ok: false, error: 'worktree add failed: disk full', cleaned: true,
    })

    await runServerAutomationTick(input)

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ directory: '/repo' }))
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('disk full'))
  })

  it('provisions the review commits before the pr_review worker starts', async () => {
    // 2026-08-31 프로덕션 — hsmoa_backend AgentTask 리뷰가 "전달된 baseSha/headSha 가
    // 워크스페이스에 없어 호출부 검증과 소스 SHA 테스트를 실행하지 못했다" 고 보고했다.
    // 프로젝트 워크스페이스가 기본 브랜치 단일 refspec 의 shallow clone 이었고,
    // preset 은 워커가 스스로 checkout·조회하는 것을 금지한다. 워커가 아니라 여기서
    // 객체를 준비해 줘야 리뷰가 diff 밖 문맥을 볼 수 있다.
    const { input, store, queryGithubPullRequests, dispatchAgentTask, ensureReviewObjects } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Follow project review rules', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'codex' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'github-secret', GH_REPO: 'acme/app' },
      pullRequests: [],
    })
    dispatchAgentTask.mockResolvedValue({
      ok: true,
      dispatch: {
        taskId: 'review-1', type: 'pr_review.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret',
        controlUrl: 'https://studio.test/api/agent-tasks',
        input: { baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) },
        context: [{ kind: 'diff', body: 'diff --git a/x b/x' }],
      },
    })

    await runServerAutomationTick(input)

    expect(ensureReviewObjects).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      shas: ['b'.repeat(40), 'c'.repeat(40)],
    }))
  })

  it('starts the worker anyway when the review commits cannot be fetched', async () => {
    // 객체가 없어도 immutable diff artifact 로 리뷰는 가능하다. 여기서 멈추면 고칠 수
    // 있었던 리뷰까지 잃는다. 다만 왜 문맥이 없는지는 남긴다 (AGENTS.md §1.13).
    const { input, store, queryGithubPullRequests, dispatchAgentTask, ensureReviewObjects,
      spawnSession, logDebug } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Follow project review rules', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'codex' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'github-secret', GH_REPO: 'acme/app' },
      pullRequests: [],
    })
    dispatchAgentTask.mockResolvedValue({
      ok: true,
      dispatch: {
        taskId: 'review-1', type: 'pr_review.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret',
        controlUrl: 'https://studio.test/api/agent-tasks',
        input: { baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) },
        context: [{ kind: 'diff', body: 'diff --git a/x b/x' }],
      },
    })
    ensureReviewObjects.mockResolvedValue({ ok: false, error: 'remote hung up unexpectedly' })

    await runServerAutomationTick(input)

    expect(spawnSession).toHaveBeenCalled()
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('remote hung up unexpectedly'))
  })

  it('fails closed when issue_opened is combined with agent-task-review', async () => {
    const { input, queryGithubIssues, dispatchAgentTask, spawnSession } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'Issue review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'issue_opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'ERROR' },
    ])
    expect(queryGithubIssues).not.toHaveBeenCalled()
    expect(dispatchAgentTask).not.toHaveBeenCalled()
    expect(spawnSession).not.toHaveBeenCalled()
  })

  it('passes the payload model/effort seed to spawn and omits absent seeds', async () => {
    const { input, spawnSession } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'name', schedule: { kind: 'interval' as const, minutes: 15 }, prompt: 'prompt',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      model: null, effort: null,
    }))

    await runServerAutomationTick(input)
    const spawned = spawnSession.mock.calls[0]![0]
    expect(spawned).not.toHaveProperty('model')
    expect(spawned).not.toHaveProperty('effort')
  })

  it('dispatches AgentTask continuations on a poll without putting capabilities in the prompt', async () => {
    const {
      input, store, queryGithubPullRequests, dispatchAgentTask, maintainAgentTaskLease,
      resolveMcpSpawnContext, spawnSession,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Follow project review rules', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'codex' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'github-secret', GH_REPO: 'acme/app' },
      pullRequests: [],
    })
    dispatchAgentTask.mockResolvedValue({
      ok: true,
      dispatch: {
        taskId: 'apply-1', type: 'review_apply.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret',
        controlUrl: 'https://studio.test/api/agent-tasks',
        input: { reviewedHeadSha: 'a'.repeat(40) }, context: [{ kind: 'review', body: { findings: [] } }],
      },
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'WOKE' },
    ])
    expect(dispatchAgentTask).toHaveBeenCalledWith({
      runId: 'run-1', claimToken: 'claim-token', credentialId: 'credential-1', event: null,
    })
    // 2026-08-31 — 담당자 소환은 서버가 조립하는 코멘트에서만 가능하므로, 설정값이
    // dispatch 를 타고 서버까지 가야 한다. 지정하지 않은 자동화는 필드가 없다.
    expect(dispatchAgentTask.mock.calls[0]![0]).not.toHaveProperty('escalateTo')
    const spawned = spawnSession.mock.calls[0]![0]
    expect(spawned.initialPrompt).toContain('Task ID: apply-1')
    expect(spawned.initialPrompt).toContain('[Review apply quality contract]')
    expect(spawned.initialPrompt).toContain('PLAUSIBLE-only')
    expect(spawned.initialPrompt).toContain('Record an applied or skipped decision')
    // 2026-09-02 — apply 가 작성자 브랜치에 직접 push 해 원하지 않은 커밋이 들어갔다.
    // 되돌리려면 revert 가 이력에 남는다. 수정은 스택 PR 로 제안한다 — 머지하면
    // 반영, 닫으면 흔적 없이 폐기. 독립 리뷰의 review-fix/ 관례를 그대로 쓴다.
    expect(spawned.initialPrompt).toMatch(/never push to the pull request'?s own branch/i)
    expect(spawned.initialPrompt).toContain('review-fix/<prNumber>-<reviewedHeadSha7>')
    expect(spawned.initialPrompt).toMatch(/base (is|=) the reviewed pull request'?s head branch/i)
    expect(spawned.initialPrompt).toContain('"fixBranch"')
    expect(spawned.initialPrompt).toContain('"fixPrUrl"')
    expect(spawned.initialPrompt).toContain('Retry network failures and 5xx responses')
    expect(spawned.initialPrompt).not.toContain('claim-secret')
    expect(spawned.initialPrompt).not.toContain('complete-secret')
    expect(spawned.filterInheritedCredentials).toBe(true)
    expect(resolveMcpSpawnContext).not.toHaveBeenCalled()
    expect(spawned).not.toHaveProperty('mcpSpawnContext')
    expect(spawned.environmentVariables).toMatchObject({
      APLUS_AGENT_TASK_ID: 'apply-1',
      APLUS_AGENT_TASK_CLAIM_TOKEN: 'claim-secret',
      APLUS_AGENT_TASK_COMPLETE_TOKEN: 'complete-secret',
      GH_TOKEN: 'github-secret',
    })
    expect(maintainAgentTaskLease).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'apply-1' }))
  })

  it('resumes the original creator session for review_apply before spawning a new worker', async () => {
    const {
      input, store, queryGithubPullRequests, dispatchAgentTask, maintainAgentTaskLease,
      resumeSession, spawnSession, linkSession, logDebug,
    } = setup({ claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } } })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Apply verified findings', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'codex' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      schedules: store.read().schedules.map((schedule) => ({
        ...schedule,
        lastSessionId: 'previous-worker-session',
      })),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'github-secret', GH_REPO: 'acme/app' },
      pullRequests: [],
    })
    dispatchAgentTask.mockResolvedValue({
      ok: true,
      dispatch: {
        taskId: 'apply-1', type: 'review_apply.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret',
        targetSessionId: 'creator-session', controlUrl: 'https://studio.test/api/agent-tasks',
        input: { reviewedHeadSha: 'a'.repeat(40) },
        context: [{ kind: 'review', body: { findings: [] } }],
      },
    })
    resumeSession.mockResolvedValue({ ok: true, sessionId: 'creator-session' })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'WOKE' },
    ])

    expect(resumeSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'creator-session', directory: '/repo', exitAfterFirstTurn: true,
      initialPrompt: expect.stringContaining('Task ID: apply-1'),
      environmentVariables: expect.objectContaining({
        APLUS_AGENT_TASK_ID: 'apply-1',
        APLUS_AGENT_TASK_CLAIM_TOKEN: 'claim-secret',
        GH_TOKEN: 'github-secret',
      }),
    }))
    const resumeInput = resumeSession.mock.calls[0]![0]
    expect(resumeInput.initialPrompt).not.toContain('claim-secret')
    expect(resumeInput.initialPrompt).not.toContain('complete-secret')
    expect(spawnSession).not.toHaveBeenCalled()
    expect(maintainAgentTaskLease).toHaveBeenCalledOnce()
    expect(linkSession).not.toHaveBeenCalled()
    expect(store.read().schedules[0]?.lastSessionId).toBeNull()
    expect(logDebug).toHaveBeenCalledWith(
      '[server-automation] resumed original requester session creator-session for review_apply task apply-1',
    )
  })

  it('runs review_apply in a worktree at the reviewed head when the project directory has moved on', async () => {
    const {
      input, store, queryGithubPullRequests, dispatchAgentTask, resumeSession, spawnSession,
      prepareGithubWorktree,
    } = setup({ claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } } })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Apply verified findings', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'codex' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'github-secret', GH_REPO: 'acme/app' },
      pullRequests: [],
    })
    dispatchAgentTask.mockResolvedValue({
      ok: true,
      dispatch: {
        taskId: 'apply-1', type: 'review_apply.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret',
        targetSessionId: 'creator-session', controlUrl: 'https://studio.test/api/agent-tasks',
        input: { prNumber: 12896, reviewedHeadSha: 'b'.repeat(40) },
        context: [{ kind: 'review', body: { findings: [] } }],
      },
    })
    resumeSession.mockResolvedValue({ ok: true, sessionId: 'creator-session' })
    input.readHeadSha = vi.fn(async () => 'd'.repeat(40))

    await runServerAutomationTick(input)

    // 2026-09-01 프로덕션 — PR #12896 의 apply 가 아무것도 반영하지 못하고 stale 로
    // 끝났다. 원격 PR 은 열려 있고 원격 head 도 리뷰 SHA 와 같았지만, 재개된 사용자
    // 세션의 디렉터리는 사용자가 마지막에 둔 커밋이었다. 워커는 계약대로 행동했다 —
    // 잘못은 어긋난 HEAD 위에서 apply 를 시작하게 둔 쪽에 있다.
    //
    // 사용자가 PR 을 올린 뒤 계속 일하는 것이 정상이므로, 이건 드문 경우가 아니라
    // 기본 경로다. 재개 전에 판정해서 어긋나면 리뷰 대상 head 로 체크아웃한다.
    expect(resumeSession).not.toHaveBeenCalled()
    expect(prepareGithubWorktree).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      pullRequest: { number: 12896, expectedHeadSha: 'b'.repeat(40) },
    }))
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/isolated/run-1',
    }))
  })

  it('keeps resuming the creator session for review_apply while the project directory is on the reviewed head', async () => {
    const {
      input, store, queryGithubPullRequests, dispatchAgentTask, resumeSession, spawnSession,
      prepareGithubWorktree,
    } = setup({ claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } } })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Apply verified findings', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'codex' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'github-secret', GH_REPO: 'acme/app' },
      pullRequests: [],
    })
    dispatchAgentTask.mockResolvedValue({
      ok: true,
      dispatch: {
        taskId: 'apply-1', type: 'review_apply.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret',
        targetSessionId: 'creator-session', controlUrl: 'https://studio.test/api/agent-tasks',
        input: { prNumber: 12896, reviewedHeadSha: 'b'.repeat(40) },
        context: [{ kind: 'review', body: { findings: [] } }],
      },
    })
    resumeSession.mockResolvedValue({ ok: true, sessionId: 'creator-session' })
    input.readHeadSha = vi.fn(async () => 'b'.repeat(40))

    await runServerAutomationTick(input)

    // HEAD 가 맞으면 사용자 세션에서 그대로 반영한다 — 원 리뷰 대화의 맥락과
    // "내 세션에서 고쳐진다" 는 가시성은 worktree 로 옮기면 잃는 것들이다.
    expect(prepareGithubWorktree).not.toHaveBeenCalled()
    expect(resumeSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'creator-session', directory: '/repo',
    }))
    expect(spawnSession).not.toHaveBeenCalled()
  })

  it('does not resume the creator session for review_apply when the project HEAD cannot be read', async () => {
    const {
      input, store, queryGithubPullRequests, dispatchAgentTask, resumeSession, spawnSession,
      prepareGithubWorktree,
    } = setup({ claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } } })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Apply verified findings', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'codex' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'github-secret', GH_REPO: 'acme/app' },
      pullRequests: [],
    })
    dispatchAgentTask.mockResolvedValue({
      ok: true,
      dispatch: {
        taskId: 'apply-1', type: 'review_apply.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret',
        targetSessionId: 'creator-session', controlUrl: 'https://studio.test/api/agent-tasks',
        input: { prNumber: 12896, reviewedHeadSha: 'b'.repeat(40) },
        context: [{ kind: 'review', body: { findings: [] } }],
      },
    })
    resumeSession.mockResolvedValue({ ok: true, sessionId: 'creator-session' })
    input.readHeadSha = vi.fn(async () => null)

    await runServerAutomationTick(input)

    // 모르면 어긋난 것으로 다룬다. 확인하지 못한 채 사용자 디렉터리에서 시작하면
    // 우리가 고치려는 그 조용한 stale 로 되돌아간다.
    expect(resumeSession).not.toHaveBeenCalled()
    expect(prepareGithubWorktree).toHaveBeenCalledWith(expect.objectContaining({
      pullRequest: { number: 12896, expectedHeadSha: 'b'.repeat(40) },
    }))
  })

  it('falls back to one new apply worker when the original creator session cannot resume', async () => {
    const { input, store, queryGithubPullRequests, dispatchAgentTask, resumeSession, spawnSession } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Apply verified findings', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({ ok: true, pullRequests: [] })
    dispatchAgentTask.mockResolvedValue({
      ok: true,
      dispatch: {
        taskId: 'apply-1', type: 'review_apply.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret',
        targetSessionId: 'creator-session', controlUrl: 'https://studio.test/api/agent-tasks',
        input: { reviewedHeadSha: 'a'.repeat(40) }, context: [],
      },
    })
    resumeSession.mockResolvedValue({
      ok: false,
      error: 'target session is still running',
      shouldFallback: true,
    })

    await runServerAutomationTick(input)

    expect(resumeSession).toHaveBeenCalledOnce()
    expect(spawnSession).toHaveBeenCalledOnce()
  })

  it('leaves review_apply pending instead of spawning a competing worker while the creator session is busy', async () => {
    const {
      input, store, queryGithubPullRequests, dispatchAgentTask,
      maintainAgentTaskLease, resumeSession, spawnSession,
    } = setup({ claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } } })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Apply verified findings', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({ ok: true, pullRequests: [] })
    dispatchAgentTask.mockResolvedValue({
      ok: true,
      dispatch: {
        taskId: 'apply-1', type: 'review_apply.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret',
        targetSessionId: 'creator-session', controlUrl: 'https://studio.test/api/agent-tasks',
        input: { reviewedHeadSha: 'a'.repeat(40) }, context: [],
      },
    })
    resumeSession.mockResolvedValue({
      ok: false,
      error: 'target session is still running',
      shouldFallback: false,
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'ERROR' },
    ])

    expect(resumeSession).toHaveBeenCalledOnce()
    expect(spawnSession).not.toHaveBeenCalled()
    expect(maintainAgentTaskLease).not.toHaveBeenCalled()
  })

  // 2026-08-26 프로덕션 — 서버가 dispatch:null 과 함께 사유를 보내기 시작했는데
  // 이 실행기가 그걸 로그로 남기지 않으면 데몬 로그에는 여전히 아무것도 안 남고
  // "실행했는데 아무 일도 안 일어남" 이 반복된다. SKIPPED_GATE 로 조용히
  // 빠지기 전에 사유를 logDebug 로 남긴다.
  it('logs the reason before skipping when the server explains an empty dispatch', async () => {
    const { input, store, queryGithubPullRequests, dispatchAgentTask, spawnSession, logDebug } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review safely', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      pullRequests: [{
        number: 17, title: 'Review me', url: 'https://github.test/o/r/pull/17', author: { login: 'alice' },
        baseRefName: 'main', headRefName: 'feature/review', isDraft: false, state: 'OPEN', mergedAt: null,
        labels: [], changedFiles: 1, files: [{ path: 'src/index.ts' }],
      }],
    })
    dispatchAgentTask.mockResolvedValue({ ok: true, dispatch: null, reason: 'queue-empty' })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'SKIPPED_GATE' },
    ])

    expect(store.state().githubTriggers?.[0]?.state.processed).toContain('17:opened')
    expect(spawnSession).not.toHaveBeenCalled()
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('queue-empty'))
  })

  // 2026-08-26 프로덕션 — 서버가 dispatch 를 정상적으로 돌려줬는데(pr_review.v1,
  // scriptCommand 없음) worker 가 스폰되지 않았고 데몬 로그에 아무 흔적도 없었다.
  // spawnSession 이 반환하는 error 를 이 실행기가 완전히 버리고 있었다 — 사유를
  // 아는 코드가 그것을 버리는 같은 패턴이 dispatch 이후 spawn 단계에도 있었다.
  it('logs the spawn error instead of silently discarding it after a successful dispatch', async () => {
    const {
      input, store, queryGithubPullRequests, dispatchAgentTask, spawnSession, logDebug,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review safely', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      pullRequests: [{
        number: 17, title: 'Review me', url: 'https://github.test/o/r/pull/17', author: { login: 'alice' },
        baseRefName: 'main', headRefName: 'feature/review', isDraft: false, state: 'OPEN', mergedAt: null,
        labels: [], changedFiles: 1, files: [{ path: 'src/index.ts' }],
      }],
    })
    dispatchAgentTask.mockResolvedValue({
      ok: true,
      dispatch: {
        taskId: 'task-1', type: 'pr_review.v1', agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret', targetSessionId: null,
        input: { prNumber: 17 }, context: [], controlUrl: 'https://studio.example/api/agent-tasks',
      },
    })
    spawnSession.mockResolvedValue({ ok: false, error: 'directory does not exist' })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'ERROR' },
    ])

    expect(store.state().githubTriggers?.[0]?.state.processed).toContain('17:opened')
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('directory does not exist'))
  })

  it('leaves a GitHub event pending when the AgentTask bridge fails', async () => {
    const { input, store, queryGithubPullRequests, dispatchAgentTask, spawnSession } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review safely', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      pullRequests: [{
        number: 17, title: 'Review me', url: 'https://github.test/o/r/pull/17', author: { login: 'alice' },
        baseRefName: 'main', headRefName: 'feature/review', isDraft: false, state: 'OPEN', mergedAt: null,
        labels: [], changedFiles: 1, files: [{ path: 'src/index.ts' }],
      }],
    })
    dispatchAgentTask.mockResolvedValue({ ok: false, error: 'temporary bridge failure' })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'ERROR' },
    ])

    expect(store.state().githubTriggers?.[0]?.state.processed).not.toContain('17:opened')
    expect(spawnSession).not.toHaveBeenCalled()
  })

  it.each(['pr_review.v1', 'testing.v1'] as const)(
    'does not grant the repository credential to a %s session',
    async (taskType) => {
      const {
        input, store, queryGithubPullRequests, dispatchAgentTask, spawnSession, prepareGithubWorktree,
      } = setup({
        claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
      })
      input.decryptPayload = vi.fn(() => ({
        name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
        prompt: 'Review safely', directory: '/repo', scriptCommand: null,
        suppressSilent: false, agent: 'claude' as const,
        githubTrigger: {
          event: 'opened' as const,
          filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
          action: 'agent-task-review' as const,
          githubCredentialId: 'credential-1',
        },
      }))
      store.write({
        ...store.read(),
        githubTriggers: [{
          automationId: 'automation-1', generation: 2,
          state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
        }],
      })
      queryGithubPullRequests.mockResolvedValue({
        ok: true,
        githubEnvironment: { GH_TOKEN: 'must-not-reach-reviewer', GH_REPO: 'acme/app' },
        pullRequests: [],
      })
      dispatchAgentTask.mockResolvedValue({
        ok: true,
        dispatch: {
          taskId: 'read-only-1', type: taskType, agentRunId: 'automation:run-1',
          claimToken: 'claim-secret', completeToken: 'complete-secret',
          controlUrl: 'https://studio.test/api/agent-tasks',
          input: { headSha: 'a'.repeat(40) }, context: [],
        },
      })

      await runServerAutomationTick(input)
      const spawned = spawnSession.mock.calls[0]![0]
      const spawnedEnvironment = spawned.environmentVariables!
      expect(spawned.filterInheritedCredentials).toBe(true)
      expect(spawnedEnvironment).toEqual(expect.objectContaining({
        APLUS_AGENT_TASK_ID: 'read-only-1',
      }))
      expect(spawnedEnvironment).not.toHaveProperty('GH_TOKEN')
      expect(spawnedEnvironment).not.toHaveProperty('GH_REPO')
      expect(prepareGithubWorktree).not.toHaveBeenCalled()
      // 2026-08-31 프로덕션 — pr_review 워커가 리뷰를 끝내고도 결과를 제출하지 못했다:
      //   "결과 제출 요청이 로컬 셸 보간으로 손상되어 HTTP 400 으로 거부됐고,
      //    프로토콜에 따라 재시도하지 못했습니다."
      // 지시가 "POST /complete with ... result" 라고만 해서 워커가 셸에서 JSON 을
      // 조립했고, 리뷰 본문의 따옴표·백틱·$ 가 보간을 타며 본문이 깨졌다. 바로 다음
      // 줄의 "4xx 는 재시도하지 말라" 규칙까지 정확히 지켜 조용히 끝났다.
      // 제출 방법을 못박아 셸을 경유하지 않게 한다.
      expect(spawned.initialPrompt).toContain('--data-binary @')
      expect(spawned.initialPrompt).toMatch(/never (build|assemble).*(shell|inline)|do not .*inline .*-d/i)
      // 4xx 는 재시도로 풀리지 않지만 조용히 끝나서도 안 된다. 이번 사고에서 400 은
      // 워커 세션 안에서만 보였고 서버·데몬 로그에는 아무 흔적이 없었다.
      expect(spawned.initialPrompt).toMatch(/4xx.*status code and response body/i)
      if (taskType === 'pr_review.v1') {
        // 2026-09-01 검증 — 리뷰 워커가 대상 SHA worktree 에서 돌기 시작하자 그 다음
        // 층이 드러났다: worktree 는 빈 체크아웃이라 node_modules 가 없고,
        // permissionMode 'read-only' 와 샌드박스가 함께 설치를 막아 vitest 를 실행하지
        // 못했다. 이제 강제는 샌드박스 한 곳에서만 한다 — 이중으로 걸면 어느 쪽이
        // 막았는지 알 수 없고, review_apply 도 permissionMode 없이 도는 것과 어긋난다.
        expect(spawned).not.toHaveProperty('permissionMode')
        expect(spawned.initialPrompt).toContain('[PR review quality contract]')
        expect(spawned.initialPrompt).toContain('correctness, regressions, contracts, security, tests, and resources')
        expect(spawned.initialPrompt).toContain('[CONFIRMED] or [PLAUSIBLE]')
        expect(spawned.initialPrompt).toContain('concrete input/state -> incorrect outcome')
        expect(spawned.initialPrompt.indexOf('[PR review quality contract]'))
          .toBeGreaterThan(spawned.initialPrompt.indexOf('Additional project instructions: Review safely'))
        // 설정 모양이 아니라 그 설정이 만들어 내는 쓰기 경로를 본다. 모양만 고정하면
        // sessionIsolation 해석이 바뀌어도 테스트가 눈치채지 못한다.
        const sandboxConfig = JSON.parse(spawnedEnvironment.HAPPY_PROJECT_SANDBOX_CONFIG!)
        expect(sandboxConfig).toMatchObject({ enabled: true, networkMode: 'allowed' })
        const runtimeConfig = buildSandboxRuntimeConfig(sandboxConfig, '/review/worktree')
        // 리뷰 worktree 가 쓰기 가능해야 의존성을 설치해 대상 SHA 테스트를 돌릴 수 있다.
        expect(runtimeConfig.filesystem.allowWrite).toContain('/review/worktree')
        // 완화한 것은 worktree 하나뿐이다 — 자격증명 읽기는 그대로 막혀 있어야 한다.
        expect(runtimeConfig.filesystem.denyRead).toEqual(
          expect.arrayContaining([expect.stringContaining('/.ssh'), expect.stringContaining('/.aws')]),
        )
      } else {
        expect(spawned).not.toHaveProperty('permissionMode')
        expect(spawnedEnvironment).not.toHaveProperty('HAPPY_PROJECT_SANDBOX_CONFIG')
      }
    },
  )

  it('tells the pr_review worker how to install dependencies before running the target checks', async () => {
    const { input, store, queryGithubPullRequests, dispatchAgentTask, spawnSession } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'AgentTask review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review safely', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: true, authors: [], paths: [] },
        action: 'agent-task-review' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 'must-not-reach-reviewer', GH_REPO: 'acme/app' },
      pullRequests: [],
    })
    dispatchAgentTask.mockResolvedValue({
      ok: true,
      dispatch: {
        taskId: 'install-1', type: 'pr_review.v1' as const, agentRunId: 'automation:run-1',
        claimToken: 'claim-secret', completeToken: 'complete-secret',
        controlUrl: 'https://studio.test/api/agent-tasks',
        input: { headSha: 'a'.repeat(40) }, context: [],
      },
    })

    await runServerAutomationTick(input)
    const prompt = spawnSession.mock.calls[0]![0].initialPrompt

    // 2026-09-01 프로덕션 — worktree 를 받고도 테스트를 못 돌렸다:
    //   "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL: Command vitest not found.
    //    Dependencies were not installed because PR review is read-only."
    // 워커는 지시를 정확히 따랐다. 설치가 허용된다는 사실을 알려주지 않으면
    // 쓰기 권한만 열어도 그대로 포기한다.
    expect(prompt).toMatch(/install .*dependencies/i)
    // 설치 스크립트는 PR 작성자가 쓴 임의 코드다. 실행 시점을 테스트 하나로 좁힌다.
    expect(prompt).toContain('--ignore-scripts')
    // 완화한 것은 "돌려보기" 까지다. 리뷰가 PR 을 고치기 시작하면 안 된다.
    expect(prompt).toMatch(/never commit, push/i)
    // 설치 실패를 조용히 넘기면 "검사를 안 했다" 가 "검사가 통과했다" 로 보인다.
    expect(prompt).toMatch(/install fails[^\n]*not_run/i)
  })

  it('records notify-only GitHub events without issuing an MCP grant or starting an LLM session', async () => {
    const {
      input, store, queryGithubPullRequests, notifyGithubTrigger, resolveMcpSpawnContext, spawnSession,
      prepareGithubWorktree,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR notification', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Opened {pr.number}',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'notify' as const,
        githubCredentialId: null,
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      pullRequests: [{
        number: 11, title: 'Docs', url: 'https://github.test/o/r/pull/11', author: { login: 'bob' },
        baseRefName: 'main', headRefName: 'docs', isDraft: false, state: 'OPEN', mergedAt: null,
        labels: [], changedFiles: 1, files: [{ path: 'README.md' }],
      }],
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'WOKE' },
    ])
    expect(notifyGithubTrigger).toHaveBeenCalledWith({
      title: 'PR notification',
      body: 'Opened 11',
      url: 'https://github.test/o/r/pull/11',
    })
    expect(resolveMcpSpawnContext).not.toHaveBeenCalled()
    expect(spawnSession).not.toHaveBeenCalled()
    expect(prepareGithubWorktree).not.toHaveBeenCalled()
  })

  it('polls first, then drains multiple queued GitHub events in the same daemon tick', async () => {
    const { input, store, transport, queryGithubPullRequests, notifyGithubTrigger, now } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR notification', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Opened {pr.number}',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'notify' as const,
        githubCredentialId: null,
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      pullRequests: [11, 12, 13, 14].map((number) => ({
        number, title: `PR ${number}`, url: `https://github.test/o/r/pull/${number}`,
        author: { login: 'bob' }, baseRefName: 'main', headRefName: `pr-${number}`,
        isDraft: false, state: 'OPEN', mergedAt: null, labels: [], changedFiles: 0, files: [],
      })),
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'WOKE' },
      { automationId: 'automation-1', outcome: 'WOKE' },
      { automationId: 'automation-1', outcome: 'WOKE' },
    ])

    expect(transport.report.mock.calls.map(([report]) => ({
      queueDepth: report.queueDepth,
      queuePosition: report.queuePosition,
      queueTotal: report.queueTotal,
      notificationOnly: report.notificationOnly,
    }))).toEqual([
      { queueDepth: 4, queuePosition: 0, queueTotal: 4, notificationOnly: false },
      { queueDepth: 3, queuePosition: 1, queueTotal: 4, notificationOnly: true },
      { queueDepth: 2, queuePosition: 2, queueTotal: 4, notificationOnly: true },
      { queueDepth: 1, queuePosition: 3, queueTotal: 4, notificationOnly: true },
    ])
    expect(notifyGithubTrigger).toHaveBeenCalledTimes(3)
    expect(transport.report.mock.calls.map(([report]) => report.queueEstimatedAt)).toEqual([
      now + 60_000, now + 60_000, now + 60_000, now + 60_000,
    ])
    expect(store.state().githubQueueProgress).toEqual([{
      automationId: 'automation-1', generation: 2, total: 4, completed: 3,
    }])
    expect(store.state().schedules[0]!.nextRunAt).toBe(now + 4)
  })

  it('returns an empty GitHub poll to its configured cadence', async () => {
    const { input, store, transport, now } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR notification', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Opened',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'notify' as const,
        githubCredentialId: null,
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'SKIPPED_GATE' },
    ])

    expect(transport.report).toHaveBeenCalledWith(expect.objectContaining({ queueDepth: 0 }))
    expect(store.state().schedules[0]!.nextRunAt).toBe(now + 15 * 60_000)
  })

  it('keeps the original batch total when draining a pre-existing queue without progress metadata', async () => {
    const { input, store, transport, notifyGithubTrigger } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR notification', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Opened',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'notify' as const,
        githubCredentialId: null,
      },
    }))
    const pr = (number: number) => ({
      number, title: `PR ${number}`, url: `https://github.test/o/r/pull/${number}`,
      author: { login: 'bob' }, baseRefName: 'main', headRefName: `pr-${number}`,
      isDraft: false, state: 'OPEN', mergedAt: null, labels: [], changedFiles: 0, files: [],
    })
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: {
          snapshot: [pr(11), pr(12)], highestPrNumber: 12, processed: [],
          pending: [
            { id: 'opened:11:head-11', event: 'opened', pr: pr(11) },
            { id: 'opened:12:head-12', event: 'opened', pr: pr(12) },
          ],
        },
      }],
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'WOKE' },
      { automationId: 'automation-1', outcome: 'WOKE' },
    ])

    expect(transport.report.mock.calls.map(([report]) => ({
      depth: report.queueDepth, position: report.queuePosition, total: report.queueTotal,
    }))).toEqual([
      { depth: 1, position: 1, total: 2 },
      { depth: 0, position: 2, total: 2 },
    ])
    expect(notifyGithubTrigger).toHaveBeenCalledTimes(2)
  })

  it('starts another queued review while below the GitHub worker concurrency limit', async () => {
    const { input, store, transport, queryGithubPullRequests, spawnSession } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Review',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    }))
    store.write({
      ...store.read(),
      schedules: store.read().schedules.map((schedule) => ({ ...schedule, lastSessionId: 'active-review' })),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: {
          snapshot: [], highestPrNumber: 12, processed: [],
          pending: [{
            id: 'opened:12:head-sha', event: 'opened',
            pr: {
              number: 12, title: 'PR 12', url: 'https://github.test/o/r/pull/12',
              author: { login: 'bob' }, baseRefName: 'main', headRefName: 'pr-12',
              isDraft: false, state: 'OPEN', mergedAt: null, labels: [], changedFiles: 0, files: [],
            },
          }],
        },
      }],
    })
    input.isSessionRunning = vi.fn(() => true)

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'WOKE' },
    ])

    expect(queryGithubPullRequests).toHaveBeenCalledTimes(1)
    expect(transport.claim).toHaveBeenCalledTimes(1)
    expect(transport.start).toHaveBeenCalledTimes(1)
    expect(transport.report).toHaveBeenCalledTimes(1)
    expect(spawnSession).toHaveBeenCalledTimes(1)
    expect(store.state().githubActiveSessions).toEqual([{
      automationId: 'automation-1', generation: 2,
      sessionIds: ['active-review', 'session-1'],
    }])
  })

  it('keeps a queued review pending at the GitHub worker concurrency limit', async () => {
    const { input, store, transport, now } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Review',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: {
          snapshot: [], highestPrNumber: 12, processed: [],
          pending: [{
            id: 'opened:12:head-sha', event: 'opened',
            pr: {
              number: 12, title: 'PR 12', url: 'https://github.test/o/r/pull/12',
              author: { login: 'bob' }, baseRefName: 'main', headRefName: 'pr-12',
              isDraft: false, state: 'OPEN', mergedAt: null, labels: [], changedFiles: 0, files: [],
            },
          }],
        },
      }],
      githubActiveSessions: [{
        automationId: 'automation-1', generation: 2,
        sessionIds: workerSessionIds('review'),
      }],
    })
    input.isSessionRunning = vi.fn(() => true)

    await expect(runServerAutomationTick(input)).resolves.toEqual([])

    expect(transport.claim).not.toHaveBeenCalled()
    expect(store.state().schedules[0]!.nextRunAt).toBe(now + 1)
  })

  it('counts still-running workers from an older automation generation', async () => {
    const { input, store, transport, queryGithubPullRequests, spawnSession, now } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Review',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
      githubActiveSessions: [{
        automationId: 'automation-1', generation: 1,
        sessionIds: workerSessionIds('old-review'),
      }],
    })
    input.isSessionRunning = vi.fn(() => true)
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      pullRequests: [{
        number: 13, title: 'PR 13', url: 'https://github.test/o/r/pull/13',
        author: { login: 'bob' }, baseRefName: 'main', headRefName: 'pr-13',
        isDraft: false, state: 'OPEN', mergedAt: null, labels: [], changedFiles: 0, files: [],
      }],
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([])

    expect(transport.claim).toHaveBeenCalledTimes(1)
    expect(spawnSession).not.toHaveBeenCalled()
    expect(store.state().githubActiveSessions).toEqual([{
      automationId: 'automation-1', generation: 1,
      sessionIds: workerSessionIds('old-review'),
    }])
    expect(store.state().schedules[0]!.nextRunAt).toBe(now + 1)
  })

  it('fails closed when the selected GitHub credential cannot query the repository', async () => {
    const {
      input, store, transport, queryGithubPullRequests, resolveMcpSpawnContext, spawnSession, now,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Review',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: 'missing-credential',
      },
    }))
    store.write({
      ...store.read(),
      githubIssueProgressMarkers: [{
        automationId: 'automation-1', generation: 1, sessionId: 'ended-issue-session',
        issueNumber: 9, actor: 'automation-bot', repository: 'acme/app', reactionId: 300,
      }],
    })
    queryGithubPullRequests.mockResolvedValue({ ok: false, error: 'credential unavailable' })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'ERROR' },
    ])
    expect(queryGithubPullRequests).toHaveBeenCalledTimes(1)
    expect(resolveMcpSpawnContext).not.toHaveBeenCalled()
    expect(spawnSession).not.toHaveBeenCalled()
    expect(store.state().githubIssueProgressMarkers).toEqual([expect.objectContaining({
      sessionId: 'ended-issue-session', cleanupRetryAt: now + 15 * 60_000,
    })])

    await expect(runServerAutomationTick(input)).resolves.toEqual([])
    expect(transport.claim).toHaveBeenCalledTimes(1)
    expect(queryGithubPullRequests).toHaveBeenCalledTimes(1)
  })

  it('starts at most three GitHub-triggered sessions in one daemon tick', async () => {
    const {
      input, store, transport, queryGithubPullRequests, spawnSession, prepareGithubWorktree, now,
    } = setup()
    const automationIds = ['automation-1', 'automation-2', 'automation-3', 'automation-4']
    store.write({
      schedules: automationIds.map((automationId) => ({
        automationId, generation: 2, nextRunAt: now, lastSessionId: null,
      })),
      githubTriggers: automationIds.map((automationId) => ({
        automationId, generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      })),
      pendingReports: [],
    })
    input.cache = { read: () => ({
      cursor: 1n, serverTime: now, syncedAt: now, pendingAcknowledgements: [],
      automations: automationIds.map((automationId) => ({ ...cacheRecord(), automationId })),
    }) }
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Review',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    }))
    transport.claim.mockImplementation(async ({ automationId }: { automationId: string }) => ({
      ok: true,
      value: { runId: `run-${automationId}`, claimToken: `claim-${automationId}` },
    }))
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      pullRequests: [{
        number: 10, title: 'Add search', url: 'https://github.test/o/r/pull/10', author: { login: 'alice' },
        baseRefName: 'main', headRefName: 'feature/search', isDraft: false, state: 'OPEN', mergedAt: null,
        labels: [], changedFiles: 1, files: [{ path: 'apps/web/page.tsx' }],
      }],
    })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'WOKE' },
      { automationId: 'automation-2', outcome: 'WOKE' },
      { automationId: 'automation-3', outcome: 'WOKE' },
    ])
    expect(transport.claim).toHaveBeenCalledTimes(7)
    expect(spawnSession).toHaveBeenCalledTimes(3)
    expect(prepareGithubWorktree).toHaveBeenCalledTimes(3)
    expect(spawnSession.mock.calls.map(([call]) => call.directory)).toEqual([
      '/isolated/run-automation-1',
      '/isolated/run-automation-2',
      '/isolated/run-automation-3',
    ])
    expect(new Set(spawnSession.mock.calls.map(([call]) => call.directory)).size).toBe(3)
    expect(spawnSession.mock.calls.some(([call]) => call.directory === '/repo')).toBe(false)
    expect(queryGithubPullRequests).toHaveBeenCalledTimes(7)
    expect(store.state().schedules.find((item) => item.automationId === 'automation-4')?.nextRunAt).toBe(now + 1)
  })

  it('counts a newly timed-out worker against the concurrency limit in the same tick', async () => {
    const {
      input, store, transport, spawnSession, now,
    } = setup()
    // 살아있는 세션 상한-1 개 + 이번 틱에 타임아웃된 워커 1개 = 상한
    const liveSessions = workerSessionIds('review', MAX_GITHUB_WORKER_SESSIONS - 1)
    const automationIds = ['automation-1', 'automation-2', 'automation-3']
    const pendingEvent = {
      id: 'opened:10:head-sha', event: 'opened' as const,
      pr: {
        number: 10, title: 'Add search', url: 'https://github.test/o/r/pull/10',
        author: { login: 'alice' }, baseRefName: 'main', headRefName: 'feature/search',
        headRefOid: 'a'.repeat(40), isDraft: false, state: 'OPEN', mergedAt: null,
        labels: [], changedFiles: 0, files: [],
      },
    }
    store.write({
      schedules: automationIds.map((automationId) => ({
        automationId, generation: 2, nextRunAt: now, lastSessionId: null,
      })),
      githubTriggers: automationIds.map((automationId) => ({
        automationId, generation: 2,
        state: { snapshot: [], highestPrNumber: 10, processed: [], pending: [pendingEvent] },
      })),
      githubActiveSessions: [{
        automationId: 'older-automation', generation: 1,
        sessionIds: liveSessions,
      }],
      pendingReports: [],
    })
    input.cache = { read: () => ({
      cursor: 1n, serverTime: now, syncedAt: now, pendingAcknowledgements: [],
      automations: automationIds.map((automationId) => ({ ...cacheRecord(), automationId })),
    }) }
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Review',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    }))
    transport.claim.mockImplementation(async ({ automationId }: { automationId: string }) => ({
      ok: true,
      value: { runId: `run-${automationId}`, claimToken: `claim-${automationId}` },
    }))
    input.isSessionRunning = vi.fn((sessionId) => liveSessions.includes(sessionId))
    input.isDirectoryInUse = vi.fn((directory) => directory === '/isolated/run-automation-1')
    spawnSession.mockResolvedValue({ ok: false, error: 'Session webhook timeout for PID 101' })

    await runServerAutomationTick(input)

    expect(spawnSession).toHaveBeenCalledTimes(1)
    expect(transport.claim).toHaveBeenCalledTimes(1)
    expect(store.state().githubWorktrees).toEqual([expect.objectContaining({
      runId: 'run-automation-1', sessionId: null,
    })])
    expect(store.state().schedules.filter((schedule) => schedule.nextRunAt === now + 1)
      .map((schedule) => schedule.automationId)).toEqual(['automation-2', 'automation-3'])
  })

  it('keeps a GitHub event pending instead of spawning in the shared directory when worktree preparation fails', async () => {
    const {
      input, store, transport, queryGithubPullRequests, spawnSession, prepareGithubWorktree,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Review',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      pullRequests: [{
        number: 10, title: 'Add search', url: 'https://github.test/o/r/pull/10', author: { login: 'alice' },
        baseRefName: 'main', headRefName: 'feature/search', isDraft: false, state: 'OPEN', mergedAt: null,
        labels: [], changedFiles: 1, files: [{ path: 'apps/web/page.tsx' }],
      }],
    })
    prepareGithubWorktree.mockResolvedValue({ ok: false, error: 'worktree checkout failed' } as never)

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'ERROR' },
    ])

    expect(prepareGithubWorktree).toHaveBeenCalledTimes(1)
    expect(spawnSession).not.toHaveBeenCalled()
    expect(transport.report).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'FAILED', outcome: 'ERROR', sessionId: null,
    }))
    expect(store.state().githubTriggers?.[0]?.state.pending).toHaveLength(1)
  })

  it('discards the isolated worktree and keeps the event pending when session spawn fails', async () => {
    const {
      input, store, queryGithubPullRequests, spawnSession, prepareGithubWorktree, discardGithubWorktree,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Review',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      pullRequests: [{
        number: 10, title: 'Add search', url: 'https://github.test/o/r/pull/10', author: { login: 'alice' },
        baseRefName: 'main', headRefName: 'feature/search', headRefOid: 'a'.repeat(40),
        isDraft: false, state: 'OPEN', mergedAt: null,
        labels: [], changedFiles: 1, files: [{ path: 'apps/web/page.tsx' }],
      }],
    })
    spawnSession.mockResolvedValue({ ok: false, error: 'spawn failed' })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'ERROR' },
    ])

    expect(prepareGithubWorktree).toHaveBeenCalledTimes(1)
    expect(discardGithubWorktree).toHaveBeenCalledWith({
      repositoryRoot: '/repo', worktreePath: '/isolated/run-1',
    })
    expect(store.state().githubTriggers?.[0]?.state.pending).toHaveLength(1)
  })

  it('keeps the isolated worktree when a timed-out spawn process still uses its directory', async () => {
    const {
      input, store, queryGithubPullRequests, spawnSession, discardGithubWorktree, now,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Review',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      pullRequests: [{
        number: 10, title: 'Add search', url: 'https://github.test/o/r/pull/10', author: { login: 'alice' },
        baseRefName: 'main', headRefName: 'feature/search', headRefOid: 'a'.repeat(40),
        isDraft: false, state: 'OPEN', mergedAt: null, labels: [], changedFiles: 0, files: [],
      }],
    })
    spawnSession.mockResolvedValue({ ok: false, error: 'Session webhook timeout for PID 101' })
    input.isDirectoryInUse = vi.fn((directory) => directory === '/isolated/run-1')

    await runServerAutomationTick(input)

    expect(discardGithubWorktree).not.toHaveBeenCalled()
    expect(store.state().githubWorktrees).toEqual([expect.objectContaining({
      runId: 'run-1', sessionId: null, cleanupRetryAt: now + 60_000,
    })])
    expect(store.state().githubTriggers?.[0]?.state.pending).toHaveLength(1)
  })

  it('journals before preparation and atomically associates the spawned session with event consumption', async () => {
    const {
      input, store, queryGithubPullRequests, prepareGithubWorktree,
    } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Review',
      directory: '/repo/apps/web', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 0, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      pullRequests: [{
        number: 10, title: 'Add search', url: 'https://github.test/o/r/pull/10', author: { login: 'alice' },
        baseRefName: 'main', headRefName: 'feature/search', headRefOid: 'a'.repeat(40),
        isDraft: false, state: 'OPEN', mergedAt: null, labels: [], changedFiles: 0, files: [],
      }],
    })

    await runServerAutomationTick(input)

    expect(prepareGithubWorktree.mock.calls[0]?.[0].onPlanned).toEqual(expect.any(Function))
    expect(store.state().githubWorktrees).toEqual([{
      automationId: 'automation-1', generation: 2, runId: 'run-1',
      repositoryRoot: '/repo', worktreePath: '/isolated/run-1', directory: '/isolated/run-1',
      sessionId: 'session-1', createdAt: 1_000_000,
    }])
    expect(store.write.mock.calls.some(([state]) => (
      state.githubWorktrees?.some((entry) => entry.sessionId === 'session-1')
        && state.githubTriggers?.some((entry) => entry.state.pending.length > 0)
    ))).toBe(false)
  })

  it('removes a journaled worktree after restart when its session is no longer running', async () => {
    const { input, store, discardGithubWorktree } = setup()
    input.cache = { read: () => ({
      cursor: 0n, serverTime: 0, syncedAt: 0, pendingAcknowledgements: [], automations: [],
    }) }
    store.write({
      ...store.read(),
      githubWorktrees: [{
        automationId: 'automation-1', generation: 2, runId: 'run-old',
        repositoryRoot: '/repo', worktreePath: '/isolated/run-old', directory: '/isolated/run-old',
        sessionId: 'ended-session', createdAt: 1,
      }],
    })

    await runServerAutomationTick(input)

    expect(discardGithubWorktree).toHaveBeenCalledWith({
      repositoryRoot: '/repo', worktreePath: '/isolated/run-old',
    })
    expect(store.state().githubWorktrees).toEqual([])
  })

  it('preserves a dirty ended worktree in the journal for manual recovery', async () => {
    const { input, store, discardGithubWorktree, logDebug, now } = setup()
    input.cache = { read: () => ({
      cursor: 0n, serverTime: 0, syncedAt: 0, pendingAcknowledgements: [], automations: [],
    }) }
    store.write({
      ...store.read(),
      githubWorktrees: [{
        automationId: 'automation-1', generation: 2, runId: 'run-old',
        repositoryRoot: '/repo', worktreePath: '/isolated/run-old', directory: '/isolated/run-old',
        sessionId: 'ended-session', createdAt: 1,
      }],
    })
    discardGithubWorktree.mockResolvedValue({ ok: false, dirty: true, error: 'worktree is dirty' })

    await runServerAutomationTick(input)

    expect(store.state().githubWorktrees).toEqual([expect.objectContaining({
      worktreePath: '/isolated/run-old', cleanupRetryAt: now + 15 * 60_000,
    })])
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('worktree is dirty'))
  })

  it('stays quiet about an unsupported glob while another prefix still fires', async () => {
    // 경고가 발화한 실행에도 붙으면 매 tick 노이즈가 되고, 진짜 멈춘 자동화가
    // 그 안에 묻힌다. 필터가 실제로 아무것도 못 고른 순간에만 말한다.
    const { input, store, logDebug, queryGithubPullRequests,
      queryGithubPullRequestFiles, spawnSession } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review {pr.number}', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'codex' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: {
          baseBranch: null, label: null, excludeDraft: true, authors: [],
          paths: ['projects/*/src', 'apps/web/*'],
        },
        action: 'start-session' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 9, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 't', GH_REPO: 'acme/app' },
      pullRequests: [{
        number: 10, title: 'Add search', url: 'https://github.test/o/r/pull/10',
        author: { login: 'alice' }, baseRefName: 'main', headRefName: 'feature/search',
        isDraft: false, state: 'OPEN', mergedAt: null, labels: [], changedFiles: 0, files: [],
      }],
    })
    queryGithubPullRequestFiles.mockResolvedValue({
      ok: true,
      files: [{ number: 10, changedFiles: 1, files: [{ path: 'apps/web/page.tsx' }] }],
    })

    await runServerAutomationTick(input)

    expect(spawnSession).toHaveBeenCalled()
    expect(logDebug).not.toHaveBeenCalledWith(expect.stringContaining('path filter matched nothing'))
  })

  it('warns when an unsupported path glob silently filters every candidate out', async () => {
    // 2026-08-31 프로덕션 — 경로 필터가 `projects/x/*` 로 저장돼 리터럴 비교에서
    // 전부 탈락했고, hsmoa_backend 리뷰 자동화 두 개가 한 건도 돌지 않았다.
    // 후행 glob 은 이제 매처가 받아주지만, 그 자리를 넘어서는 glob 은 여전히
    // 지원하지 않는다. 그때 아무 말 없이 0건이 되면 "필터가 제대로 걸렀다" 와
    // "필터가 고장났다" 를 사용자가 구분할 수 없다.
    const { input, store, logDebug, queryGithubPullRequests,
      queryGithubPullRequestFiles, spawnSession } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token' } },
    })
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const },
      prompt: 'Review {pr.number}', directory: '/repo', scriptCommand: null,
      suppressSilent: false, agent: 'codex' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: {
          baseBranch: null, label: null, excludeDraft: true, authors: [],
          paths: ['projects/*/src'],
        },
        action: 'start-session' as const,
        githubCredentialId: 'credential-1',
      },
    }))
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: { snapshot: [], highestPrNumber: 9, processed: [], pending: [] },
      }],
    })
    queryGithubPullRequests.mockResolvedValue({
      ok: true,
      githubEnvironment: { GH_TOKEN: 't', GH_REPO: 'acme/app' },
      pullRequests: [{
        number: 10, title: 'Add search', url: 'https://github.test/o/r/pull/10',
        author: { login: 'alice' }, baseRefName: 'main', headRefName: 'feature/search',
        isDraft: false, state: 'OPEN', mergedAt: null, labels: [], changedFiles: 0, files: [],
      }],
    })
    queryGithubPullRequestFiles.mockResolvedValue({
      ok: true,
      files: [{ number: 10, changedFiles: 1, files: [{ path: 'projects/web/src/index.ts' }] }],
    })

    await runServerAutomationTick(input)

    expect(queryGithubPullRequestFiles).toHaveBeenCalled()
    expect(spawnSession).not.toHaveBeenCalled()
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('projects/*/src'))
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('path filter'))
  })

  it('counts each failed cleanup so a stuck worktree cannot be retried forever', async () => {
    const { input, store, discardGithubWorktree, now } = setup()
    input.cache = { read: () => ({
      cursor: 0n, serverTime: 0, syncedAt: 0, pendingAcknowledgements: [], automations: [],
    }) }
    store.write({
      ...store.read(),
      githubWorktrees: [{
        automationId: 'automation-1', generation: 2, runId: 'run-old',
        repositoryRoot: '/repo', worktreePath: '/isolated/run-old', directory: '/isolated/run-old',
        sessionId: 'ended-session', createdAt: 1, cleanupAttempts: 3,
      }],
    })
    discardGithubWorktree.mockResolvedValue({ ok: false, dirty: false, error: 'boom' })

    await runServerAutomationTick(input)

    expect(store.state().githubWorktrees).toEqual([expect.objectContaining({
      worktreePath: '/isolated/run-old', cleanupAttempts: 4, cleanupRetryAt: now + 60_000,
    })])
  })

  it('never gives up on a dirty worktree, however many attempts it has taken', async () => {
    // dirty 는 고장이 아니라 "사람이 회수할 작업물이 남아 있다" 는 의도된 보류다.
    // 예산으로 이것까지 지우면 자동화가 사람의 작업물을 조용히 버리게 된다.
    const { input, store, discardGithubWorktree, now } = setup()
    input.cache = { read: () => ({
      cursor: 0n, serverTime: 0, syncedAt: 0, pendingAcknowledgements: [], automations: [],
    }) }
    store.write({
      ...store.read(),
      githubWorktrees: [{
        automationId: 'automation-1', generation: 2, runId: 'run-old',
        repositoryRoot: '/repo', worktreePath: '/isolated/run-old', directory: '/isolated/run-old',
        sessionId: 'ended-session', createdAt: 1,
        cleanupAttempts: MAX_WORKTREE_CLEANUP_ATTEMPTS + 50,
      }],
    })
    discardGithubWorktree.mockResolvedValue({ ok: false, dirty: true, error: 'worktree is dirty' })

    await runServerAutomationTick(input)

    expect(store.state().githubWorktrees).toEqual([expect.objectContaining({
      worktreePath: '/isolated/run-old', cleanupRetryAt: now + 15 * 60_000,
    })])
  })

  it('gives up loudly once the cleanup attempt budget is spent', async () => {
    // 2026-08-30 프로덕션 — 서브모듈 때문에 remove 가 거부되자 재시도 상한이 없어
    // 누적 1,192회 실패하며 worktree 11개가 2.3GB 를 물고 있었다. 실패는 debug 로그에만
    // 쌓였고 아무도 몰랐다. 예산을 다 쓰면 멈추고, 남은 경로를 사람이 볼 수 있게 알린다.
    const { input, store, discardGithubWorktree, logDebug } = setup()
    input.cache = { read: () => ({
      cursor: 0n, serverTime: 0, syncedAt: 0, pendingAcknowledgements: [], automations: [],
    }) }
    store.write({
      ...store.read(),
      githubWorktrees: [{
        automationId: 'automation-1', generation: 2, runId: 'run-old',
        repositoryRoot: '/repo', worktreePath: '/isolated/run-old', directory: '/isolated/run-old',
        sessionId: 'ended-session', createdAt: 1,
        cleanupAttempts: MAX_WORKTREE_CLEANUP_ATTEMPTS - 1,
      }],
    })
    discardGithubWorktree.mockResolvedValue({ ok: false, dirty: false, error: 'boom' })

    await runServerAutomationTick(input)

    // journal 에서 빠져야 다음 tick 이 다시 시도하지 않는다.
    expect(store.state().githubWorktrees).toEqual([])
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('giving up'))
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('/isolated/run-old'))

    discardGithubWorktree.mockClear()
    await runServerAutomationTick(input)
    expect(discardGithubWorktree).not.toHaveBeenCalled()
  })

  it('does not clean a journaled worktree while its session remains live after restart', async () => {
    const { input, store, discardGithubWorktree } = setup()
    input.cache = { read: () => ({
      cursor: 0n, serverTime: 0, syncedAt: 0, pendingAcknowledgements: [], automations: [],
    }) }
    input.isSessionRunning = vi.fn((sessionId) => sessionId === 'live-session')
    store.write({
      ...store.read(),
      githubWorktrees: [{
        automationId: 'automation-1', generation: 2, runId: 'run-old',
        repositoryRoot: '/repo', worktreePath: '/isolated/run-old', directory: '/isolated/run-old',
        sessionId: 'live-session', createdAt: 1,
      }],
    })

    await runServerAutomationTick(input)

    expect(discardGithubWorktree).not.toHaveBeenCalled()
    expect(store.state().githubWorktrees).toHaveLength(1)
  })

  it('does not clean an unassociated journal entry while a restarted session uses its directory', async () => {
    const { input, store, discardGithubWorktree } = setup()
    input.cache = { read: () => ({
      cursor: 0n, serverTime: 0, syncedAt: 0, pendingAcknowledgements: [], automations: [],
    }) }
    input.isDirectoryInUse = vi.fn((directory) => directory === '/isolated/run-old/apps/web')
    store.write({
      ...store.read(),
      githubWorktrees: [{
        automationId: 'automation-1', generation: 2, runId: 'run-old',
        repositoryRoot: '/repo', worktreePath: '/isolated/run-old',
        directory: '/isolated/run-old/apps/web', sessionId: null, createdAt: 1,
      }],
    })

    await runServerAutomationTick(input)

    expect(discardGithubWorktree).not.toHaveBeenCalled()
    expect(store.state().githubWorktrees).toHaveLength(1)
  })

  it('does not retry a pending event while a timed-out worker still owns its journaled directory', async () => {
    const { input, store, transport, queryGithubPullRequests, spawnSession } = setup()
    input.decryptPayload = vi.fn(() => ({
      name: 'PR review', schedule: { kind: 'github' as const, minutes: 15 as const }, prompt: 'Review',
      directory: '/repo', scriptCommand: null, suppressSilent: false, agent: 'claude' as const,
      githubTrigger: {
        event: 'opened' as const,
        filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
        action: 'start-session' as const,
        githubCredentialId: null,
      },
    }))
    input.isDirectoryInUse = vi.fn((directory) => directory === '/isolated/run-old')
    store.write({
      ...store.read(),
      githubTriggers: [{
        automationId: 'automation-1', generation: 2,
        state: {
          snapshot: [], highestPrNumber: 10, processed: [],
          pending: [{
            id: '10:opened', event: 'opened',
            pr: {
              number: 10, title: 'Add search', url: 'https://github.test/o/r/pull/10',
              author: { login: 'alice' }, baseRefName: 'main', headRefName: 'feature/search',
              headRefOid: 'a'.repeat(40), isDraft: false, state: 'OPEN', mergedAt: null,
              labels: [], changedFiles: 0, files: [],
            },
          }],
        },
      }],
      githubWorktrees: [{
        automationId: 'automation-1', generation: 2, runId: 'run-old',
        repositoryRoot: '/repo', worktreePath: '/isolated/run-old', directory: '/isolated/run-old',
        sessionId: null, createdAt: 1,
      }],
    })

    await runServerAutomationTick(input)

    expect(transport.claim).not.toHaveBeenCalled()
    expect(queryGithubPullRequests).not.toHaveBeenCalled()
    expect(spawnSession).not.toHaveBeenCalled()
    expect(store.state().githubTriggers?.[0]?.state.pending).toHaveLength(1)
  })
})
