import type { AutomationConversationDeliverRequest } from '@slopus/happy-wire'
import type { AutomationMcpSpawnContext } from './automationMcpCallerGrant'
type Binding = { directory: string; encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }
export async function deliverAutomationConversation(input: { runId: string; claimToken: string; sessionId: string; directory: string; prompt: string; mcpSpawnContext?: AutomationMcpSpawnContext }, deps: {
  resolveSession(sessionId: string): Binding | null | undefined
  sameDirectory(left: string, right: string): Promise<boolean>
  /** A stopped conversation is resumed with the run's exchanged grant, or it comes back without connectors. */
  ensureRunning(sessionId: string, mcpSpawnContext?: AutomationMcpSpawnContext): Promise<boolean>
  readSeq(sessionId: string): Promise<number | null>
  encryptUserMessage(binding: Binding, message: unknown): string
  deliver(input: AutomationConversationDeliverRequest): Promise<{ ok: boolean; error?: string }>
}): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  const binding = deps.resolveSession(input.sessionId)
  if (!binding || !await deps.sameDirectory(binding.directory, input.directory)) return { ok: false, error: 'conversation target unavailable' }
  if (!await deps.ensureRunning(input.sessionId, input.mcpSpawnContext)) return { ok: false, error: 'conversation resume failed' }
  const contentCiphertext = deps.encryptUserMessage(binding, {
    role: 'user', content: { type: 'text', text: input.prompt },
    localKey: `happy-automation:${input.runId}`, meta: { sentFrom: 'automation' },
  })
  let activationRetries = 0
  for (let attempt = 0; attempt < 3;) {
    const seq = await deps.readSeq(input.sessionId)
    if (seq === null || !Number.isSafeInteger(seq) || seq < 0) return { ok: false, error: 'conversation sequence unavailable' }
    try {
      const result = await deps.deliver({ wireVersion: 1, runId: input.runId, claimToken: input.claimToken, sessionId: input.sessionId, expectedSeq: seq, contentCiphertext })
      if (result.ok) return { ok: true, sessionId: input.sessionId }
      if (result.error === 'session-inactive') {
        // Allow the 30s activity throttle and 5s batch flush after local resume.
        // This separate bounded budget preserves sequence/unknown-ACK retries.
        if (activationRetries >= 20) return { ok: false, error: 'conversation activation unconfirmed' }
        activationRetries++
        await new Promise(resolve => setTimeout(resolve, 2000))
        continue
      }
      if (result.error !== 'session-changed') return { ok: false, error: result.error ?? 'conversation delivery failed' }
    } catch { /* Replay the same run after an unknown ACK; the server fences its localId. */ }
    attempt++
  }
  return { ok: false, error: 'conversation delivery unconfirmed' }
}
