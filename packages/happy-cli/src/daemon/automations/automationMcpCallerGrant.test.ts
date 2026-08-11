import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  exchangeAutomationMcpCallerGrant,
  linkAutomationProjectSession,
} from './automationMcpCallerGrant'

describe('exchangeAutomationMcpCallerGrant', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns no context when the daemon has no trusted Aplus MCP URL', async () => {
    await expect(exchangeAutomationMcpCallerGrant({
      configUrl: undefined,
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
    })).resolves.toEqual({ ok: true, value: null })
  })

  it('exchanges the run claim without exposing it in the config URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      grant: 'SIGNED-GRANT', projectId: 'P-1', expiresAt: Date.now() + 60_000,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(exchangeAutomationMcpCallerGrant({
      configUrl: 'https://saycode.ai/api/me/mcp-config?existing=1',
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
    })).resolves.toEqual({
      ok: true,
      value: { mcpCallerGrant: 'SIGNED-GRANT', mcpConfigProjectId: 'P-1' },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://saycode.ai/api/automation/mcp-caller-grant',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer machine-token' }),
        body: JSON.stringify({ machineId: 'M-1', runId: 'R-1', claimToken: 'claim-token' }),
      }),
    )
  })

  it.each([
    new Response('{}', { status: 403 }),
    new Response(JSON.stringify({ grant: '', projectId: 'P-1' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  ])('fails closed when the exchange rejects the run or returns an invalid grant', async (response) => {
    vi.stubGlobal('fetch', vi.fn(async () => response))

    const result = await exchangeAutomationMcpCallerGrant({
      configUrl: 'https://saycode.ai/api/me/mcp-config',
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
    })

    expect(result.ok).toBe(false)
  })

  it('links the spawned session with the same run claim proof', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(linkAutomationProjectSession({
      configUrl: 'https://saycode.ai/api/me/mcp-config',
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
      sessionId: 'S-1',
    })).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://saycode.ai/api/automation/session-link',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer machine-token' }),
        body: JSON.stringify({
          machineId: 'M-1', runId: 'R-1', claimToken: 'claim-token', sessionId: 'S-1',
        }),
      }),
    )
  })

  it('keeps project linking retryable when the Aplus endpoint is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))

    await expect(linkAutomationProjectSession({
      configUrl: 'https://saycode.ai/api/me/mcp-config',
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
      sessionId: 'S-1',
    })).resolves.toEqual({ ok: false, error: 'session link returned 503' })
  })
})
