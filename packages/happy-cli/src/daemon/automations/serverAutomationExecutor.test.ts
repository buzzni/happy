import { afterEach, describe, expect, it, vi } from 'vitest'

import { runServerAutomationTick, type ServerAutomationExecutorInput } from './serverAutomationExecutor'
import type { AutomationMcpCallerGrantResult } from './automationMcpCallerGrant'
import type { EncryptedServerAutomation } from './serverAutomationCache'
import type { ServerAutomationRuntimeState } from './serverAutomationRuntimeStore'
import { MAX_WORKTREE_CLEANUP_ATTEMPTS } from './worktreeCleanupGiveUp'

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
    const spawned = spawnSession.mock.calls[0]![0]
    expect(spawned.initialPrompt).toContain('Task ID: apply-1')
    expect(spawned.initialPrompt).toContain('[Review apply quality contract]')
    expect(spawned.initialPrompt).toContain('PLAUSIBLE-only')
    expect(spawned.initialPrompt).toContain('Record an applied or skipped decision')
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
      if (taskType === 'pr_review.v1') {
        expect(spawned).toMatchObject({ permissionMode: 'read-only' })
        expect(spawned.initialPrompt).toContain('[PR review quality contract]')
        expect(spawned.initialPrompt).toContain('correctness, regressions, contracts, security, tests, and resources')
        expect(spawned.initialPrompt).toContain('[CONFIRMED] or [PLAUSIBLE]')
        expect(spawned.initialPrompt).toContain('concrete input/state -> incorrect outcome')
        expect(spawned.initialPrompt.indexOf('[PR review quality contract]'))
          .toBeGreaterThan(spawned.initialPrompt.indexOf('Additional project instructions: Review safely'))
        expect(JSON.parse(spawnedEnvironment.HAPPY_PROJECT_SANDBOX_CONFIG!)).toMatchObject({
          enabled: true,
          sessionIsolation: 'custom',
          customWritePaths: [],
          networkMode: 'allowed',
        })
      } else {
        expect(spawned).not.toHaveProperty('permissionMode')
        expect(spawnedEnvironment).not.toHaveProperty('HAPPY_PROJECT_SANDBOX_CONFIG')
      }
    },
  )

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
        sessionIds: ['review-1', 'review-2', 'review-3'],
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
        sessionIds: ['old-review-1', 'old-review-2', 'old-review-3'],
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
      sessionIds: ['old-review-1', 'old-review-2', 'old-review-3'],
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
        sessionIds: ['review-1', 'review-2'],
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
    input.isSessionRunning = vi.fn((sessionId) => sessionId === 'review-1' || sessionId === 'review-2')
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
