import { afterEach, describe, expect, it, vi } from 'vitest'

import { runServerAutomationTick, type ServerAutomationExecutorInput } from './serverAutomationExecutor'
import type { AutomationMcpCallerGrantResult } from './automationMcpCallerGrant'
import type { EncryptedServerAutomation } from './serverAutomationCache'
import type { ServerAutomationRuntimeState } from './serverAutomationRuntimeStore'

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
  const queryGithubIssues = vi.fn<ServerAutomationExecutorInput['queryGithubIssues']>(async () => ({
    ok: true,
    issues: [],
  }))
  const notifyGithubTrigger = vi.fn<ServerAutomationExecutorInput['notifyGithubTrigger']>()
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
    queryGithubIssues,
    notifyGithubTrigger,
    dispatchAgentTask,
    maintainAgentTaskLease,
    resolveMcpSpawnContext,
    preflightMcpConnectors,
    linkSession,
    resumeSession,
    spawnSession,
    isSessionRunning: vi.fn(() => false),
    randomId: () => 'report-1',
    logDebug,
  }
  return {
    input, store, transport, decryptPayload, logDebug, runScript, queryGithubPullRequests,
    queryGithubIssues, notifyGithubTrigger, dispatchAgentTask, maintainAgentTaskLease,
    resolveMcpSpawnContext, preflightMcpConnectors, linkSession, resumeSession, spawnSession, now,
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
    const { input, store, queryGithubPullRequests, spawnSession } = setup({
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
  })

  it('spawns an issue_opened session with the issue-rendered prompt and persists the high-water state', async () => {
    const { input, store, queryGithubPullRequests, queryGithubIssues, spawnSession } = setup({
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
    const { input, store, queryGithubIssues, notifyGithubTrigger, resolveMcpSpawnContext, spawnSession } = setup({
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
      if (taskType === 'pr_review.v1') {
        expect(spawned).toMatchObject({ permissionMode: 'read-only' })
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
    }))).toEqual([
      { queueDepth: 4, queuePosition: 0, queueTotal: 4 },
      { queueDepth: 3, queuePosition: 1, queueTotal: 4 },
      { queueDepth: 2, queuePosition: 2, queueTotal: 4 },
      { queueDepth: 1, queuePosition: 3, queueTotal: 4 },
    ])
    expect(notifyGithubTrigger).toHaveBeenCalledTimes(3)
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

  it('fails closed when the selected GitHub credential cannot query the repository', async () => {
    const { input, queryGithubPullRequests, resolveMcpSpawnContext, spawnSession } = setup({
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
    queryGithubPullRequests.mockResolvedValue({ ok: false, error: 'credential unavailable' })

    await expect(runServerAutomationTick(input)).resolves.toEqual([
      { automationId: 'automation-1', outcome: 'ERROR' },
    ])
    expect(queryGithubPullRequests).toHaveBeenCalledTimes(1)
    expect(resolveMcpSpawnContext).not.toHaveBeenCalled()
    expect(spawnSession).not.toHaveBeenCalled()
  })

  it('starts at most three GitHub-triggered sessions in one daemon tick', async () => {
    const { input, store, transport, queryGithubPullRequests, spawnSession, now } = setup()
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
    expect(queryGithubPullRequests).toHaveBeenCalledTimes(7)
    expect(store.state().schedules.find((item) => item.automationId === 'automation-4')?.nextRunAt).toBe(now + 1)
  })
})
