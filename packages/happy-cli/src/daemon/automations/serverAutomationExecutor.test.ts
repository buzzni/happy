import { afterEach, describe, expect, it, vi } from 'vitest'

import { runServerAutomationTick, type ServerAutomationExecutorInput } from './serverAutomationExecutor'
import type { EncryptedServerAutomation } from './serverAutomationCache'
import type { ServerAutomationRuntimeState } from './serverAutomationRuntimeStore'

function cacheRecord(generation = 2, migrationPending = false) {
  return {
    automationId: 'automation-1', revision: 2, generation, payloadVersion: 1 as const,
    payloadCiphertext: 'encrypted-payload', machineKeyVersion: 1,
    machineKeyEnvelope: 'encrypted-envelope', paused: false, migrationPending, enabledAt: 1,
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
  const spawnSession = vi.fn(async () => ({ ok: true as const, sessionId: 'session-1' }))
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
    spawnSession,
    isSessionRunning: vi.fn(() => false),
    randomId: () => 'report-1',
    logDebug,
  }
  return { input, store, transport, decryptPayload, logDebug, runScript, spawnSession, now }
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
    const { input, store, transport, spawnSession } = setup({
      claim: { ok: true, value: { runId: 'run-1', claimToken: 'claim-token', claimExpiresAt: 1_100_000, serverTime: 1_000_000 } },
    })
    transport.report
      .mockResolvedValueOnce({ ok: false, error: 'offline' })
      .mockResolvedValueOnce({ ok: true, value: { idempotent: true } })

    await expect(runServerAutomationTick(input)).resolves.toEqual([{ automationId: 'automation-1', outcome: 'WOKE' }])
    expect(transport.claim.mock.invocationCallOrder[0]).toBeLessThan(transport.start.mock.invocationCallOrder[0]!)
    expect(transport.start.mock.invocationCallOrder[0]).toBeLessThan(spawnSession.mock.invocationCallOrder[0]!)
    expect(store.state().pendingReports).toEqual([expect.objectContaining({
      runId: 'run-1', claimToken: 'claim-token', reportId: 'report-1', outcome: 'WOKE',
    })])

    await runServerAutomationTick(input)
    expect(transport.report).toHaveBeenCalledTimes(2)
    expect(transport.report.mock.calls[1]![0]).toEqual(transport.report.mock.calls[0]![0])
    expect(store.state().pendingReports).toEqual([])
    expect(transport.claim).toHaveBeenCalledTimes(1)
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
})
