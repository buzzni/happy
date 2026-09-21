export type AutomationProjectEnvironmentResult =
  | { ok: true; environmentVariables: Record<string, string> }
  | { ok: false; error: string; code?: 'EXECUTION_PRINCIPAL_UNBOUND' }

/** Run-scoped secrets stay in memory; never put response bodies in diagnostics. */
export async function fetchAutomationProjectEnvironment(input: {
  configUrl: string | undefined
  machineToken: string
  machineId: string
  runId: string
  claimToken: string
}): Promise<AutomationProjectEnvironmentResult> {
  if (!input.configUrl) return { ok: false, error: 'Aplus MCP config URL is not configured' }
  let url: URL
  try {
    url = new URL('/api/automation/project-environment', input.configUrl)
  } catch {
    return { ok: false, error: 'invalid Aplus MCP config URL' }
  }
  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${input.machineToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineId: input.machineId, runId: input.runId, claimToken: input.claimToken }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      if (response.status === 409) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null
        if (body?.error === 'AUTOMATION_EXECUTION_UNBOUND') {
          return {
            ok: false,
            error: 'project environment execution principal is unbound',
            code: 'EXECUTION_PRINCIPAL_UNBOUND',
          }
        }
      }
      return { ok: false, error: `project environment request returned ${response.status}` }
    }
    const body: unknown = await response.json()
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const { projectId, environmentVariables } = body as Record<string, unknown>
      if (typeof projectId === 'string' && projectId
        && environmentVariables && typeof environmentVariables === 'object' && !Array.isArray(environmentVariables)
        && Object.entries(environmentVariables).every(([key, value]) =>
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0'))) {
        return { ok: true, environmentVariables: environmentVariables as Record<string, string> }
      }
    }
    return { ok: false, error: 'invalid project environment response' }
  } catch {
    return { ok: false, error: 'project environment request failed' }
  }
}
