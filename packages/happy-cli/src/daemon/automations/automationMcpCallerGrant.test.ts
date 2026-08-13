import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  exchangeAutomationMcpCallerGrant,
  linkAutomationProjectSession,
} from './automationMcpCallerGrant'

describe('exchangeAutomationMcpCallerGrant', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fails preflight when the daemon has no trusted Aplus MCP URL, and says why', async () => {
    const logDebug = vi.fn()
    await expect(exchangeAutomationMcpCallerGrant({
      configUrl: undefined,
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
      logDebug,
    })).resolves.toEqual({ ok: false, error: 'Aplus MCP config URL is not configured' })
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('HAPPY_APLUS_MCP_CONFIG_URL'))
  })

  it('exchanges the run claim without exposing it in the config URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      grant: 'SIGNED-GRANT', projectId: 'P-1', expiresAt: Date.now() + 60_000,
      bindingStatus: 'BOUND', connectorPolicy: 'required', requiredConnectors: ['gmail'],
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
      value: {
        mcpCallerGrant: 'SIGNED-GRANT', mcpConfigProjectId: 'P-1',
        bindingStatus: 'BOUND', connectorPolicy: 'required', requiredConnectors: ['gmail'],
      },
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

  // specs/automation-company-owner-identity R2 — 회사 happy 계정 소유
  // 자동화는 개인 커넥터 대상 사용자가 없어 서버가 no-grant 로 응답한다.
  // 후속 R12~R14에서는 no-grant도 정책과 함께 전달되어 executor가 fail-closed
  // 여부를 결정한다.
  it('preserves explicit no-grant policy metadata for executor preflight', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      grant: null, projectId: 'P-1', bindingStatus: 'BOUND',
      connectorPolicy: 'optional', requiredConnectors: ['gmail'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(exchangeAutomationMcpCallerGrant({
      configUrl: 'https://saycode.ai/api/me/mcp-config',
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
    })).resolves.toEqual({
      ok: true,
      value: {
        mcpConfigProjectId: 'P-1', bindingStatus: 'BOUND',
        connectorPolicy: 'optional', requiredConnectors: ['gmail'],
      },
    })
  })

  it.each([
    new Response('{}', { status: 403 }),
    new Response(JSON.stringify({ grant: '', projectId: 'P-1' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
    new Response(JSON.stringify({ grant: null, projectId: '' }), {
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

  it.each([
    [409, 'AUTOMATION_EXECUTION_UNBOUND', 'EXECUTION_PRINCIPAL_UNBOUND'],
    [403, 'EXECUTION_PRINCIPAL_ACCESS_REVOKED', 'EXECUTION_PRINCIPAL_ACCESS_REVOKED'],
  ])('preserves safe principal precondition code from an exchange %s', async (
    status, responseCode, expectedCode,
  ) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: responseCode }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(exchangeAutomationMcpCallerGrant({
      configUrl: 'https://saycode.ai/api/me/mcp-config',
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
    })).resolves.toEqual({
      ok: false,
      error: `caller grant exchange returned ${status}`,
      code: expectedCode,
    })
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

  it('skips project linking when the daemon has no trusted Aplus MCP URL, and says why', async () => {
    const logDebug = vi.fn()
    await expect(linkAutomationProjectSession({
      configUrl: undefined,
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
      sessionId: 'S-1',
      logDebug,
    })).resolves.toEqual({ ok: true, skipped: true })
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('HAPPY_APLUS_MCP_CONFIG_URL'))
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
