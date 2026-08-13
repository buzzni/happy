export type AutomationMcpSpawnContext = {
  mcpCallerGrant?: string
  mcpConfigProjectId: string
  bindingStatus: 'BOUND' | 'DIRECT_OWNER'
  connectorPolicy: 'required' | 'optional' | 'none' | 'unspecified'
  requiredConnectors: string[]
}

export type AutomationMcpCallerGrantResult =
  | { ok: true; value: AutomationMcpSpawnContext | null }
  | {
    ok: false
    error: string
    code?: 'EXECUTION_PRINCIPAL_UNBOUND' | 'EXECUTION_PRINCIPAL_ACCESS_REVOKED'
  }

const EXCHANGE_TIMEOUT_MS = 3_000

// specs/automation-company-owner-identity R2 — `grant: null` 은 회사 happy
// 계정 소유 자동화의 명시적 no-grant 응답이다: 개인 커넥터 없이 정상 진행.
function parseExchangeResponse(value: unknown): { context: AutomationMcpSpawnContext | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.projectId !== 'string' || !row.projectId) return null
  const bindingStatus = row.bindingStatus === 'BOUND' || row.bindingStatus === 'DIRECT_OWNER'
    ? row.bindingStatus
    : 'DIRECT_OWNER'
  const connectorPolicy = row.connectorPolicy === 'required'
    || row.connectorPolicy === 'optional' || row.connectorPolicy === 'none'
    ? row.connectorPolicy
    : 'unspecified'
  const requiredConnectors = Array.isArray(row.requiredConnectors)
    && row.requiredConnectors.every((entry) =>
      typeof entry === 'string' && /^[a-z0-9-]{1,64}$/.test(entry))
    ? [...new Set(row.requiredConnectors as string[])].sort()
    : []
  if (row.grant !== null && (typeof row.grant !== 'string' || !row.grant)) return null
  if (typeof row.grant === 'string'
    && (typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt)
      || row.expiresAt <= Date.now())) return null
  return {
    context: {
      ...(typeof row.grant === 'string' ? { mcpCallerGrant: row.grant } : {}),
      mcpConfigProjectId: row.projectId,
      bindingStatus,
      connectorPolicy,
      requiredConnectors,
    },
  }
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
    return { ok: false, error: 'Aplus MCP config URL is not configured' }
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
      const body = await response.json().catch(() => null) as { error?: unknown } | null
      const code = response.status === 409 && body?.error === 'AUTOMATION_EXECUTION_UNBOUND'
        ? 'EXECUTION_PRINCIPAL_UNBOUND' as const
        : response.status === 403 && body?.error === 'EXECUTION_PRINCIPAL_ACCESS_REVOKED'
          ? 'EXECUTION_PRINCIPAL_ACCESS_REVOKED' as const
          : undefined
      return {
        ok: false,
        error: `caller grant exchange returned ${response.status}`,
        ...(code ? { code } : {}),
      }
    }
    const parsed = parseExchangeResponse(await response.json())
    if (!parsed) {
      return { ok: false, error: 'caller grant exchange returned an invalid response' }
    }
    return { ok: true, value: parsed.context }
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
}): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  if (!input.configUrl) {
    input.logDebug?.('Automation project-session link skipped: HAPPY_APLUS_MCP_CONFIG_URL is not set on this daemon')
    return { ok: true, skipped: true }
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
