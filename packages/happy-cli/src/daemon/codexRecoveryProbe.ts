import type { CodexAppServerClient } from '../codex/codexAppServerClient'

type ProbeClient = Pick<CodexAppServerClient, 'setEventHandler' | 'setApprovalHandler' | 'connect' | 'startThread' | 'sendTurnAndWait' | 'disconnect'>
export type CodexRecoveryProbeResult = { attempts: number } & (
  | { ok: true; model: 'gpt-6.1-sol' }
  | { ok: false; errorKind: string }
)

/** Provider output stays local: only these bounded reasons cross the machine RPC. */
export function codexRecoveryErrorKind(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/revoked|refresh_token_reused|invalid_grant/i.test(text)) return 'CODEX_REAUTH_REQUIRED'
  if (/unauthorized|authentication[_ ]error|invalid[_ ]token|\b401\b/i.test(text)) return 'CODEX_AUTHENTICATION_FAILED'
  if (/workspace.*(?:missing|unavailable|not found)|selected workspace/i.test(text)) return 'CODEX_WORKSPACE_UNAVAILABLE'
  if (/initialize.*timed out/i.test(text)) return 'CODEX_INITIALIZE_TIMEOUT'
  if (/ENOTFOUND|ECONN|ETIMEDOUT|fetch failed|network error/i.test(text)) return 'CODEX_NETWORK_ERROR'
  if (/not installed|ENOENT|unknown (?:option|argument)|unexpected argument/i.test(text)) return 'CODEX_CLI_UNAVAILABLE'
  if (/quota|rate.?limit|\b429\b/i.test(text)) return 'CODEX_RATE_LIMITED'
  if (/model.*(?:not available|not supported|not found)/i.test(text)) return 'CODEX_MODEL_UNAVAILABLE'
  return 'CODEX_RESPONSE_NOT_VERIFIED'
}

async function createClient(): Promise<ProbeClient> {
  const { CodexAppServerClient } = await import('../codex/codexAppServerClient')
  return new CodexAppServerClient()
}

/** Uses the actual Happy app-server adapter, including its managed rotation proxy. */
export async function probeHappyCodex(
  cwd: string,
  factory: () => ProbeClient | Promise<ProbeClient> = createClient,
): Promise<CodexRecoveryProbeResult> {
  for (let attempts = 1; attempts <= 2; attempts++) {
    let client: ProbeClient
    try { client = await factory() }
    catch (error) { return { ok: false, errorKind: codexRecoveryErrorKind(error), attempts } }
    let timer: ReturnType<typeof setTimeout> | undefined
    let initialized = false
    let reply = false
    let completed = false
    let failure: string | null = null
    let usedTool = false
    let settleObservation!: () => void
    const observation = new Promise<void>(resolve => { settleObservation = resolve })
    client.setApprovalHandler(async () => { usedTool = true; return 'denied' })
    client.setEventHandler(event => {
      if (event.type === 'agent_message' && String(event.message).trim() === 'SHARED_AI_OK') reply = true
      if (/^(exec_command|patch_apply|mcp_tool_call)_begin$/.test(event.type)) usedTool = true
      if (event.type === 'error' || event.type === 'turn_aborted'
        || (event.type === 'task_complete' && ((event.status != null && event.status !== 'completed') || event.error != null || event.reason === 'inactivity_timeout'))) {
        failure = codexRecoveryErrorKind(new Error(JSON.stringify(event)))
      }
    })
    try {
      const run = async (): Promise<CodexRecoveryProbeResult> => {
        await client.connect()
        initialized = true
        const options = { cwd, model: 'gpt-6.1-sol' as const, sandbox: 'read-only' as const, approvalPolicy: 'never' as const }
        await client.startThread({ ...options, mcpServers: {}, developerInstructions: 'This is an authentication health check. Do not use any tools.' })
        const turn = await client.sendTurnAndWait('Reply with exactly SHARED_AI_OK. Do not use tools.', { ...options, effort: 'low', turnTimeoutMs: 30_000,
          onCompleted: () => { completed = true }, onCompletionObservationSettled: settleObservation })
        // UI final-answer/idle fallbacks can settle before the provider's authoritative result.
        if (!turn.aborted && reply && !failure && !usedTool) await observation
        return !turn.aborted && reply && completed && !failure && !usedTool
          ? { ok: true, model: 'gpt-6.1-sol', attempts }
          : { ok: false, errorKind: failure ?? 'CODEX_RESPONSE_NOT_VERIFIED', attempts }
      }
      return await Promise.race([run(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(initialized ? 'response timed out' : 'initialize timed out')), 75_000)
      })])
    } catch (error) {
      const errorKind = codexRecoveryErrorKind(error)
      if (attempts === 2 || errorKind !== 'CODEX_INITIALIZE_TIMEOUT') return { ok: false, errorKind, attempts }
    } finally {
      clearTimeout(timer)
      // Dispose only the probe's child; never stop the daemon or a user's session.
      try { await client.disconnect() }
      catch { return { ok: false, errorKind: 'CODEX_RESPONSE_NOT_VERIFIED', attempts } }
    }
  }
  return { ok: false, errorKind: 'CODEX_INITIALIZE_TIMEOUT', attempts: 2 }
}
