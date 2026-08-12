export type AutomationMcpSpawnContext = {
  mcpCallerGrant: string
  mcpConfigProjectId: string
}

export type AutomationMcpCallerGrantResult =
  | { ok: true; value: AutomationMcpSpawnContext | null }
  | { ok: false; error: string }

const EXCHANGE_TIMEOUT_MS = 3_000

function parseExchangeResponse(value: unknown): AutomationMcpSpawnContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.grant !== 'string' || !row.grant) return null
  if (typeof row.projectId !== 'string' || !row.projectId) return null
  if (typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt) || row.expiresAt <= Date.now()) return null
  return { mcpCallerGrant: row.grant, mcpConfigProjectId: row.projectId }
}

export async function exchangeAutomationMcpCallerGrant(input: {
  configUrl: string | undefined
  machineToken: string
  machineId: string
  runId: string
  claimToken: string
  logDebug?: (message: string) => void
}): Promise<AutomationMcpCallerGrantResult> {
  if (!input.configUrl) {
    input.logDebug?.('MCP caller grant skipped: HAPPY_APLUS_MCP_CONFIG_URL is not set on this daemon')
    return { ok: true, value: null }
  }

  let exchangeUrl: string
  try {
    exchangeUrl = new URL('/api/automation/mcp-caller-grant', input.configUrl).toString()
  } catch {
    return { ok: false, error: 'invalid Aplus MCP config URL' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS)
  try {
    const response = await fetch(exchangeUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.machineToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        machineId: input.machineId,
        runId: input.runId,
        claimToken: input.claimToken,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      return { ok: false, error: `caller grant exchange returned ${response.status}` }
    }
    const context = parseExchangeResponse(await response.json())
    return context
      ? { ok: true, value: context }
      : { ok: false, error: 'caller grant exchange returned an invalid response' }
  } catch {
    return {
      ok: false,
      error: controller.signal.aborted
        ? 'caller grant exchange timed out'
        : 'caller grant exchange failed',
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function linkAutomationProjectSession(input: {
  configUrl: string | undefined
  machineToken: string
  machineId: string
  runId: string
  claimToken: string
  sessionId: string
  logDebug?: (message: string) => void
}): Promise<{ ok: boolean; error?: string }> {
  if (!input.configUrl) {
    input.logDebug?.('Automation project-session link skipped: HAPPY_APLUS_MCP_CONFIG_URL is not set on this daemon')
    return { ok: true }
  }

  let linkUrl: string
  try {
    linkUrl = new URL('/api/automation/session-link', input.configUrl).toString()
  } catch {
    return { ok: false, error: 'invalid Aplus MCP config URL' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS)
  try {
    const response = await fetch(linkUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.machineToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        machineId: input.machineId,
        runId: input.runId,
        claimToken: input.claimToken,
        sessionId: input.sessionId,
      }),
      signal: controller.signal,
    })
    return response.ok
      ? { ok: true }
      : { ok: false, error: `session link returned ${response.status}` }
  } catch {
    return {
      ok: false,
      error: controller.signal.aborted
        ? 'session link timed out'
        : 'session link failed',
    }
  } finally {
    clearTimeout(timer)
  }
}
