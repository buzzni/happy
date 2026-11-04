import { z } from 'zod'
import { HappySessionExecutionProofSchema, automationExecutionSessionId, type SessionExecutionCreateBody } from '@slopus/happy-wire'
import type { Metadata, AgentState } from '@/api/types'
import { decodeBase64, decrypt } from '@/api/encryption'
import type { AutomationContextLaunchDependencies } from './automationContextLaunch'

const admissionSchema = z.strictObject({ targetProof: z.string().min(1).max(8192), executionBindingRequired: z.boolean(),
  executionProof: HappySessionExecutionProofSchema.optional() })
const sessionSchema = z.object({ id: z.string(), seq: z.number().int().nonnegative(), metadata: z.string(),
  metadataVersion: z.number().int().nonnegative(), agentState: z.string().nullable(), agentStateVersion: z.number().int().nonnegative(),
  dataEncryptionKey: z.string().nullable().optional() })

export type AutomationContextTargetRequest = {
  automationId: string; runId: string; generation: number; revision: number; machineId: string;
  displaySessionId: string; conversationDirectory: string; agent: 'claude' | 'codex'; body: Readonly<SessionExecutionCreateBody>
}

/** Network operations only. The trusted issuer decides proof requirements; this adapter never downgrades them. */
export function createAutomationContextTransport(input: {
  serverUrl: string; token: string; machineId: string; runId: string; claimToken: string;
  authorize(target: AutomationContextTargetRequest): Promise<z.infer<typeof admissionSchema>>
}): Pick<AutomationContextLaunchDependencies, 'register' | 'persistSeed'> {
  const url = new URL(input.serverUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !input.token || !input.machineId || !input.claimToken || input.claimToken.length > 256) throw new Error('AUTOMATION_CONTEXT_TRANSPORT_INVALID')
  const base = url.toString().replace(/\/+$/, ''), sessionId = automationExecutionSessionId(input.runId)
  async function request(path: string, body: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(base + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    } catch { throw new Error('AUTOMATION_CONTEXT_REQUEST_UNCONFIRMED') }
    if (!response.ok) throw new Error(`AUTOMATION_CONTEXT_HTTP_${response.status}`)
    try { return await response.json() } catch { throw new Error('AUTOMATION_CONTEXT_RESPONSE_INVALID') }
  }
  return {
    async register(run, prepared) {
      const displaySessionId = run.payload.conversation?.sessionId
      if (run.runId !== input.runId || prepared.body.tag !== sessionId || !displaySessionId
        || (run.payload.agent !== 'claude' && run.payload.agent !== 'codex')) throw new Error('AUTOMATION_CONTEXT_IDENTITY_CONFLICT')
      // No authored prompt, seed ciphertext or private key is sent to the issuer.
      const admission = admissionSchema.parse(await input.authorize({ automationId: run.automationId, runId: run.runId,
        generation: run.generation, revision: run.revision, machineId: input.machineId, displaySessionId,
        conversationDirectory: run.payload.directory, agent: run.payload.agent, body: structuredClone(prepared.body) }))
      if (admission.executionBindingRequired && !admission.executionProof) throw new Error('AUTOMATION_EXECUTION_PROOF_REQUIRED')
      const receipt = z.object({ sessionId: z.string(), displaySessionId: z.string(), created: z.boolean() }).parse(
        await request(`/v1/automation-runs/${encodeURIComponent(run.runId)}/execution-session`, {
          machineId: input.machineId, claimToken: input.claimToken, displaySessionId, body: prepared.body, ...admission,
        }))
      if (receipt.sessionId !== sessionId || receipt.displaySessionId !== displaySessionId) throw new Error('AUTOMATION_CONTEXT_RECEIPT_CONFLICT')
      const lookup = z.object({ sessions: z.array(sessionSchema).length(1) }).parse(await request('/v2/sessions/lookup', { ids: [sessionId] }))
      const raw = lookup.sessions[0]
      if (raw.id !== sessionId || (raw.dataEncryptionKey ?? null) !== (prepared.body.dataEncryptionKey ?? null)) {
        throw new Error('AUTOMATION_CONTEXT_RECEIPT_CONFLICT')
      }
      const encryptionKey = decodeBase64(prepared.encryptionKey), encryptionVariant = prepared.encryptionVariant
      return { id: raw.id, seq: raw.seq, metadataVersion: raw.metadataVersion, agentStateVersion: raw.agentStateVersion,
        metadata: decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)) as Metadata,
        agentState: raw.agentState ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.agentState)) as AgentState : null,
        encryptionKey, encryptionVariant }
    },
    async persistSeed(session, message) {
      if (session.id !== sessionId) throw new Error('AUTOMATION_CONTEXT_IDENTITY_CONFLICT')
      const result = z.object({ messages: z.array(z.object({ seq: z.number().int().positive(), localId: z.string(),
        content: z.object({ t: z.literal('encrypted'), c: z.string() }) })).length(1) }).parse(
        await request(`/v3/sessions/${encodeURIComponent(sessionId)}/messages`, { messages: [message] }))
      const stored = result.messages[0]
      return { seq: stored.seq, localId: stored.localId, content: stored.content.c }
    },
  }
}
