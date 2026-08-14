import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { fetchAplusMcpConfigSnapshot, type AplusMcpServersMap } from '@/aplus/fetchAplusMcpServers'
import type { AutomationMcpSpawnContext } from './automationMcpCallerGrant'

export type AutomationConnectorPreflightResult =
  | { ok: true; availableConnectors: string[] }
  | {
    ok: false
    code: 'POLICY_UNSPECIFIED' | 'GRANT_MISSING' | 'CONFIG_UNAVAILABLE'
      | 'CONNECTOR_CONFIG_MISSING' | 'CONNECTOR_AUTH_REQUIRED'
      | 'CONNECTOR_RUNTIME_UNAVAILABLE' | 'TOOL_INVENTORY_EMPTY'
    unavailableConnectors: string[]
  }

type PreflightDeps = {
  fetchSnapshot: typeof fetchAplusMcpConfigSnapshot
  listTools: (name: string, server: AplusMcpServersMap[string]) => Promise<string[]>
}

async function listTools(
  name: string,
  server: AplusMcpServersMap[string],
): Promise<string[]> {
  const client = new Client(
    { name: `happy-automation-preflight-${name}`, version: '1.0.0' },
    { capabilities: {} },
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  try {
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {
        ...(server.headers ? { headers: server.headers } : {}),
        signal: controller.signal,
      },
    })
    await client.connect(transport)
    const inventory = await client.listTools()
    return inventory.tools.map((tool) => tool.name)
  } finally {
    clearTimeout(timer)
    await client.close().catch(() => undefined)
  }
}

const defaultDeps: PreflightDeps = {
  fetchSnapshot: fetchAplusMcpConfigSnapshot,
  listTools,
}

export async function preflightAutomationConnectors(
  input: {
    configUrl: string | undefined
    machineToken: string
    machineId: string
    runId: string
    context: AutomationMcpSpawnContext
  },
  deps: PreflightDeps = defaultDeps,
): Promise<AutomationConnectorPreflightResult> {
  const required = input.context.requiredConnectors
  if (input.context.connectorPolicy === 'none') return { ok: true, availableConnectors: [] }
  if (input.context.connectorPolicy === 'unspecified') {
    return { ok: false, code: 'POLICY_UNSPECIFIED', unavailableConnectors: required }
  }
  if (input.context.connectorPolicy === 'required' && required.length === 0) {
    return { ok: false, code: 'CONNECTOR_CONFIG_MISSING', unavailableConnectors: [] }
  }
  if (!input.context.mcpCallerGrant) {
    return { ok: false, code: 'GRANT_MISSING', unavailableConnectors: required }
  }

  const snapshot = await deps.fetchSnapshot(input.machineToken, input.machineId, {
    configUrl: input.configUrl,
    projectId: input.context.mcpConfigProjectId,
    callerGrant: input.context.mcpCallerGrant,
    expectedConnectors: required,
    sessionId: input.runId,
    lifecycle: 'spawn',
  })
  if (!snapshot.result.ok) {
    return {
      ok: false,
      code: snapshot.result.reason === 'connector-config-missing'
        || snapshot.result.reason === 'mcp-config-missing'
        ? 'CONNECTOR_CONFIG_MISSING'
        : 'CONFIG_UNAVAILABLE',
      unavailableConnectors: required,
    }
  }

  const available: string[] = []
  const authRequired: string[] = []
  const runtimeUnavailable: string[] = []
  const emptyInventory: string[] = []
  for (const provider of required) {
    const server = snapshot.servers[provider]
    if (!server) {
      runtimeUnavailable.push(provider)
      continue
    }
    try {
      const tools = await deps.listTools(provider, server)
      if (tools.length > 0) available.push(provider)
      else emptyInventory.push(provider)
    } catch (error) {
      const code = error && typeof error === 'object'
        ? (error as { code?: unknown }).code
        : undefined
      if (code === 401 || code === 403) authRequired.push(provider)
      else runtimeUnavailable.push(provider)
    }
  }
  if (authRequired.length > 0) {
    return {
      ok: false,
      code: 'CONNECTOR_AUTH_REQUIRED',
      unavailableConnectors: authRequired,
    }
  }
  if (runtimeUnavailable.length > 0) {
    return {
      ok: false,
      code: 'CONNECTOR_RUNTIME_UNAVAILABLE',
      unavailableConnectors: runtimeUnavailable,
    }
  }
  if (emptyInventory.length > 0) {
    return { ok: false, code: 'TOOL_INVENTORY_EMPTY', unavailableConnectors: emptyInventory }
  }
  return { ok: true, availableConnectors: available }
}
