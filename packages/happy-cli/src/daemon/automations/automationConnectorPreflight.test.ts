import { describe, expect, it, vi } from 'vitest'

import { preflightAutomationConnectors } from './automationConnectorPreflight'
import type { AutomationMcpSpawnContext } from './automationMcpCallerGrant'

const context = (overrides: Partial<AutomationMcpSpawnContext> = {}): AutomationMcpSpawnContext => ({
  mcpCallerGrant: 'SIGNED',
  mcpConfigProjectId: 'P-1',
  bindingStatus: 'BOUND',
  connectorPolicy: 'required',
  requiredConnectors: ['gmail'],
  ...overrides,
})

const deps = (overrides: Record<string, unknown> = {}) => ({
  fetchSnapshot: vi.fn(async () => ({
    result: { ok: true as const, servers: { gmail: { type: 'http' as const, url: 'https://mcp.test' } } },
    servers: { gmail: { type: 'http' as const, url: 'https://mcp.test' } },
  })),
  listTools: vi.fn(async () => ['gmail_search_messages']),
  ...overrides,
})

describe('preflightAutomationConnectors', () => {
  it('verifies configuration, runtime connection, and a non-empty tool inventory', async () => {
    const d = deps()
    await expect(preflightAutomationConnectors({
      configUrl: 'https://saycode.test/api/me/mcp-config', machineToken: 'TOKEN',
      machineId: 'M-1', runId: 'R-1', context: context(),
    }, d)).resolves.toEqual({ ok: true, availableConnectors: ['gmail'] })
    expect(d.fetchSnapshot).toHaveBeenCalledWith('TOKEN', 'M-1', expect.objectContaining({
      projectId: 'P-1', callerGrant: 'SIGNED', expectedConnectors: ['gmail'], sessionId: 'R-1',
    }))
    expect(d.listTools).toHaveBeenCalledWith('gmail', expect.objectContaining({ type: 'http' }))
  })

  it('fails before config fetch when required connector access has no caller grant', async () => {
    const d = deps()
    await expect(preflightAutomationConnectors({
      configUrl: 'https://saycode.test', machineToken: 'TOKEN', machineId: 'M-1', runId: 'R-1',
      context: context({ mcpCallerGrant: undefined }),
    }, d)).resolves.toEqual({
      ok: false, code: 'GRANT_MISSING', unavailableConnectors: ['gmail'],
    })
    expect(d.fetchSnapshot).not.toHaveBeenCalled()
  })

  it('distinguishes missing configuration, runtime failure, and empty tool inventory', async () => {
    const missingConfig = deps({
      fetchSnapshot: vi.fn(async () => ({
        result: {
          ok: false as const, reason: 'connector-config-missing' as const, error: 'missing',
          expected: ['gmail'], configured: [], missing: ['gmail'],
        },
        servers: {},
      })),
    })
    await expect(preflightAutomationConnectors({
      configUrl: 'https://saycode.test', machineToken: 'TOKEN', machineId: 'M-1', runId: 'R-1',
      context: context(),
    }, missingConfig)).resolves.toMatchObject({ ok: false, code: 'CONNECTOR_CONFIG_MISSING' })

    const runtimeFailure = deps({ listTools: vi.fn(async () => { throw new Error('offline') }) })
    await expect(preflightAutomationConnectors({
      configUrl: 'https://saycode.test', machineToken: 'TOKEN', machineId: 'M-1', runId: 'R-1',
      context: context(),
    }, runtimeFailure)).resolves.toMatchObject({ ok: false, code: 'CONNECTOR_RUNTIME_UNAVAILABLE' })

    const authFailure = deps({
      listTools: vi.fn(async () => { throw Object.assign(new Error('unauthorized'), { code: 401 }) }),
    })
    await expect(preflightAutomationConnectors({
      configUrl: 'https://saycode.test', machineToken: 'TOKEN', machineId: 'M-1', runId: 'R-1',
      context: context(),
    }, authFailure)).resolves.toMatchObject({ ok: false, code: 'CONNECTOR_AUTH_REQUIRED' })

    const emptyTools = deps({ listTools: vi.fn(async () => []) })
    await expect(preflightAutomationConnectors({
      configUrl: 'https://saycode.test', machineToken: 'TOKEN', machineId: 'M-1', runId: 'R-1',
      context: context(),
    }, emptyTools)).resolves.toMatchObject({ ok: false, code: 'TOOL_INVENTORY_EMPTY' })
  })
})
