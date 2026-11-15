import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { query } from '@/claude/sdk/query'
import { isManagedEndpointSource } from '@/utils/managedEndpointSource'
/** Entry dispatched before the Happy session runtime; no user session or workspace is created. */
export async function runPersonalEndpointProbe() {
  if (process.env.HAPPY_AI_AUTH_SOURCE !== 'personal-endpoint' || !isManagedEndpointSource(process.env)) throw Error('PERSONAL_ENDPOINT_PROBE_REFUSED')
  const cwd = await mkdtemp(join(tmpdir(), 'saycode-llm-probe-'))
  let toolCall = false, streaming = false, completed = false, failure = 'PERSONAL_ENDPOINT_COMPATIBILITY_FAILED'
  const echo = createSdkMcpServer({ name: 'endpoint-probe', version: '1.0.0', tools: [tool('echo', 'Returns the fixed test value OK.', {}, async () => { toolCall = true; return { content: [{ type: 'text' as const, text: 'OK' }] } })] })
  let response: ReturnType<typeof query> | undefined
  try {
    response = query({ prompt: 'Connection test. Call mcp__endpoint-probe__echo exactly once, then reply OK. Do not use any other tool.', options: {
    cwd, tools: [], mcpServers: { 'endpoint-probe': echo }, strictMcpConfig: true, settingSources: [], isolatedAutomationContext: true, persistSession: false, maxTurns: 3,
    canCallTool: async (name, input) => name === 'mcp__endpoint-probe__echo' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only the fixed connection test tool is allowed.' },
  } })
    for await (const message of response) {
      if (message.type === 'stream_event') streaming = true
      if (message.type === 'result') completed = message.subtype === 'success' && !message.is_error
      const raw = message as unknown as Record<string, unknown>
      if (raw.api_error_status === 401 || raw.error_status === 401 || raw.error === 'authentication_failed' || raw.error === 'authentication_error' || raw.is_error && /\b401\b/.test(String(raw.result))) failure = 'PERSONAL_ENDPOINT_AUTHENTICATION_FAILED'
      else if (raw.is_error && /API Error|ECONN|network|fetch failed|timed out|\b50[234]\b/i.test(String(raw.result))) failure = 'PERSONAL_ENDPOINT_CONNECTION_FAILED'
    }
    if (!completed) throw Error(failure)
    if (!streaming) throw Error('PERSONAL_ENDPOINT_STREAMING_FAILED')
    if (!toolCall) throw Error('PERSONAL_ENDPOINT_TOOL_CALL_FAILED')
    console.log(JSON.stringify({ version: 1, ok: true, streaming, toolCall }))
  } catch (error) {
    if (failure !== 'PERSONAL_ENDPOINT_COMPATIBILITY_FAILED') throw Error(failure)
    throw error
  } finally { response?.close(); await rm(cwd, { recursive: true, force: true }) }
}
void runPersonalEndpointProbe().catch(error => {
  const allowed = new Set(['PERSONAL_ENDPOINT_AUTHENTICATION_FAILED', 'PERSONAL_ENDPOINT_CONNECTION_FAILED', 'PERSONAL_ENDPOINT_STREAMING_FAILED', 'PERSONAL_ENDPOINT_TOOL_CALL_FAILED'])
  const message = error instanceof Error ? error.message : ''
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
  const code = allowed.has(message) ? message : status === 401 ? 'PERSONAL_ENDPOINT_AUTHENTICATION_FAILED' : /ECONN|ENOTFOUND|network|fetch failed|timed out/i.test(message) ? 'PERSONAL_ENDPOINT_CONNECTION_FAILED' : 'PERSONAL_ENDPOINT_COMPATIBILITY_FAILED'
  console.log(JSON.stringify({ version: 1, ok: false, error: code })); process.exitCode = 1
})
