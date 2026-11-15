import { callPersonalEndpointBroker, buildPersonalEndpointEnvironment, type PersonalEndpointSelection } from './personalLlmEndpoint'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { sanitizeChildEnv } from '@/utils/childEnv'
export function validateEndpointProbeResult(raw: string): boolean {
  try { const v = JSON.parse(raw); return v.version === 1 && v.ok === true && v.streaming === true && v.toolCall === true } catch { return false }
}
const failureCodes = new Set(['PERSONAL_ENDPOINT_AUTHENTICATION_FAILED', 'PERSONAL_ENDPOINT_CONNECTION_FAILED', 'PERSONAL_ENDPOINT_STREAMING_FAILED', 'PERSONAL_ENDPOINT_TOOL_CALL_FAILED'])
export function endpointProbeFailure(raw: string) {
  try { const v = JSON.parse(raw); if (failureCodes.has(v.error)) return v.error as string } catch { /* Invalid provider output is not a diagnostic. */ }
  return 'PERSONAL_ENDPOINT_COMPATIBILITY_FAILED'
}
/** A provider session, not a user workspace: it has no project files or external tools. */
export async function testPersonalEndpoint(selection: PersonalEndpointSelection, machineId: string) {
  const relay = await callPersonalEndpointBroker({ ...selection, userId: selection.ownerUserId, machineId, operation: 'acquire' })
  try {
    if (relay.purpose !== 'test') throw Error('PERSONAL_ENDPOINT_PURPOSE_MISMATCH')
    const env = buildPersonalEndpointEnvironment(selection, machineId, relay)
    await new Promise<void>((resolve, reject) => {
      const child = spawnHappyCLI(['personal-endpoint-probe'], { env: { ...sanitizeChildEnv(process.env), ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', done = false
      const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); ok ? resolve() : reject(Error(endpointProbeFailure(stdout.trim()))) }
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(false) }, 60_000)
      child.stdout?.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 8192) { child.kill('SIGKILL'); finish(false) } })
      // stderr may contain provider content. Drain it without forwarding or logging it.
      child.stderr?.on('data', () => {})
      child.once('error', () => finish(false)); child.once('close', code => finish(code === 0 && validateEndpointProbeResult(stdout.trim())))
    })
    return { version: 1, ok: true, streaming: true, toolCall: true }
  } finally { await callPersonalEndpointBroker({ issuer: selection.issuer, userId: selection.ownerUserId, machineId, operation: 'release', leaseId: relay.leaseId }).catch(() => { console.warn('[personal-llm] test relay cleanup unavailable') }) }
}
