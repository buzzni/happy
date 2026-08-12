export type AutomationMcpSpawnContext = {
  mcpCallerGrant: string
  mcpConfigProjectId: string
}

export type AutomationMcpCallerGrantResult =
  | { ok: true; value: AutomationMcpSpawnContext | null }
  | { ok: false; error: string }

const EXCHANGE_TIMEOUT_MS = 3_000

// specs/automation-company-owner-identity R2 — `grant: null` 은 회사 happy
// 계정 소유 자동화의 명시적 no-grant 응답이다: 개인 커넥터 없이 정상 진행.
function parseExchangeResponse(value: unknown): { context: AutomationMcpSpawnContext | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.projectId !== 'string' || !row.projectId) return null
  if (row.grant === null) return { context: null }
  if (typeof row.grant !== 'string' || !row.grant) return null
  if (typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt) || row.expiresAt <= Date.now()) return null
  return { context: { mcpCallerGrant: row.grant, mcpConfigProjectId: row.projectId } }
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
    const parsed = parseExchangeResponse(await response.json())
    if (!parsed) {
      return { ok: false, error: 'caller grant exchange returned an invalid response' }
    }
    if (!parsed.context) {
      input.logDebug?.('MCP caller grant: server returned no personal grant for this run (company-owned automation)')
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
