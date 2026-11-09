import { z } from 'zod'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { HappySessionExecutionProofSchema, SessionExecutionTicketSchema, AutomationExecutionAuthorityRequestBodySchema,
  HappySessionCreateProofBodySchema, automationExecutionSessionId, sessionCreateBodyHash, sessionTagHash,
  rotationBase64url, rotationDecodeBinary, rotationSha256, rotationIsFresh, rotationDigest, sessionExecutionAuthorityDigest,
  signRotationDocument, verifyRotationDocument, type SessionExecutionCreateBody } from '@slopus/happy-wire'
import type { Metadata, AgentState } from '@/api/types'
import { decodeBase64, decrypt } from '@/api/encryption'
import type { AutomationContextLaunchDependencies, AutomationContextLaunchRecord, AutomationContextLaunchJournal } from './automationContextLaunch'
import { readTrustedStudioOrigin } from '../setupTokenBindingProof'
import type { DeviceKeys } from '../deviceKeys'
import type { DeviceOrgPin } from '../deviceOrgPinStore'

const admissionSchema = z.strictObject({ targetProof: z.string().min(1).max(8192), executionBindingRequired: z.boolean(),
  executionProof: HappySessionExecutionProofSchema.optional(), executionAuthorityDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() })
const authoritySchema = z.strictObject({ companyId: z.string().min(1).max(128), machineId: z.string().min(1).max(128),
  approvalId: z.string().min(1).max(128), deviceKeyId: z.string().regex(/^[a-f0-9]{64}$/), machineAccountId: z.string().min(1).max(128),
  studioOrigin: z.string().max(512), happyOrigin: z.string().max(512), keyId: z.string().regex(/^[a-f0-9]{64}$/) })
type Admission = z.infer<typeof admissionSchema>
type AuthorityAction = { kind: 'prepare-submit' } | { kind: 'confirmed'; sessionId: string; displaySessionId: string; createBodyHash: string }
type Authorize = (target: AutomationContextTargetRequest, action?: AuthorityAction) => Promise<Admission>
const sessionSchema = z.object({ id: z.string(), seq: z.number().int().nonnegative(), metadata: z.string(),
  metadataVersion: z.number().int().nonnegative(), agentState: z.string().nullable(), agentStateVersion: z.number().int().nonnegative(),
  dataEncryptionKey: z.string().nullable().optional() })

export type AutomationContextTargetRequest = {
  automationId: string; runId: string; generation: number; revision: number; machineId: string;
  displaySessionId: string; conversationDirectory: string; agent: 'claude' | 'codex'; questionRequestId?: string; body: Readonly<SessionExecutionCreateBody>
}

const admissionErrorCodes = new Set([
  'AUTOMATION_INVALID_CLAIM', 'AUTOMATION_RUN_LEASE_EXPIRED', 'AUTOMATION_QUESTION_IDENTITY_MISMATCH',
  'AUTOMATION_RUN_CHANGED', 'EXECUTION_PRINCIPAL_ACCESS_REVOKED', 'QUESTION_DISPLAY_CHANGED',
  'AUTOMATION_CONTEXT_UNSUPPORTED', 'AUTOMATION_EXECUTION_UNBOUND', 'AUTOMATION_EXECUTION_COMPANY_MISMATCH',
  'AUTOMATION_DEVICE_AUTHORITY_REQUIRED', 'AUTOMATION_COMPANY_INACTIVE', 'AUTOMATION_EXECUTION_AUTHORITY_DENIED',
  'AUTOMATION_EXECUTION_AUTHORITY_CHANGED', 'AUTOMATION_EXECUTION_SIGNER_UNAVAILABLE', 'AUTOMATION_EXECUTION_COMPANY_UNRESOLVED',
])

/** Rejections may contain secrets. Preserve only known codes from a bounded body, never its raw text. */
async function admissionFailureCode(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []; let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 4096) return ''
      chunks.push(next.value)
    }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('error' in body)) return ''
    const code = body.error === 'Invalid automation claim' ? 'AUTOMATION_INVALID_CLAIM'
      : body.error === 'Automation run lease expired' ? 'AUTOMATION_RUN_LEASE_EXPIRED' : body.error
    return typeof code === 'string' && admissionErrorCodes.has(code) ? `:${code}` : ''
  } catch { return '' }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

/** The daemon's explicit trust configuration is the only destination. Payloads supply no URLs or downgrade flags. */
export function createAutomationContextAuthorizer(input: {
  studioOrigin: string | null; token: string; machineId: string; runId: string; claimToken: string
  authority?: { journal: AutomationContextLaunchJournal; accountId: string; happyOrigin: string; keys: DeviceKeys;
    pin(companyId: string): Promise<DeviceOrgPin | null> }
}): Authorize {
  const configuredOrigin = readTrustedStudioOrigin({ HAPPY_APLUS_STUDIO_ORIGIN: input.studioOrigin ?? undefined })
  if (!configuredOrigin || !input.token || !input.machineId || !input.claimToken || input.claimToken.length > 256) throw new Error('AUTOMATION_STUDIO_ADMISSION_UNCONFIGURED')
  const origin = configuredOrigin
  automationExecutionSessionId(input.runId)
  async function json(path: string, body?: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(new URL(path, origin), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body) })
    } catch { throw new Error('AUTOMATION_STUDIO_ADMISSION_UNCONFIRMED') }
    if (!response.ok) throw new Error(`AUTOMATION_STUDIO_ADMISSION_HTTP_${response.status}${await admissionFailureCode(response)}`)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('AUTOMATION_STUDIO_ADMISSION_INVALID')
    const chunks: Uint8Array[] = []; let bytes = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > 16 * 1024) throw new Error('AUTOMATION_STUDIO_ADMISSION_INVALID')
        chunks.push(next.value)
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    } catch { throw new Error('AUTOMATION_STUDIO_ADMISSION_INVALID') }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  }
  const conflict = (): never => { throw new Error('AUTOMATION_EXECUTION_AUTHORITY_CONFLICT') }
  let candidate: Admission | null = null
  async function recordFor(target: AutomationContextTargetRequest) {
    const host = input.authority
    if (!host) return conflict()
    const record = await host.journal.read(target.runId)
    const scope = createHash('sha256').update(JSON.stringify([host.happyOrigin, host.accountId, input.machineId])).digest('hex')
    if (!record || record.scope !== scope || record.automationId !== target.automationId || record.generation !== target.generation
      || record.revision !== target.revision || record.runId !== target.runId || record.displaySessionId !== target.displaySessionId
      || record.phase !== 'prepared' && record.phase !== 'registered'
      || await sessionCreateBodyHash(record.prepared.body) !== await sessionCreateBodyHash(target.body)) return conflict()
    return record
  }
  return async (target, action) => {
    if (target.machineId !== input.machineId || target.runId !== input.runId
      || target.questionRequestId !== undefined && target.questionRequestId !== input.runId) throw new Error('AUTOMATION_CONTEXT_IDENTITY_CONFLICT')
    if (action) {
      const record = await recordFor(target), authority = record.executionAuthority
      if (!authority || !candidate?.executionProof) return conflict()
      if (action.kind === 'confirmed') {
        if (action.sessionId !== record.sessionId || action.displaySessionId !== record.displaySessionId
          || action.createBodyHash !== await sessionCreateBodyHash(record.prepared.body)) return conflict()
        const { pendingProof, ...fixed } = authority
        await input.authority!.journal.write({ ...record, executionAuthority: { ...fixed, registrationConfirmed: true } })
      } else {
        if (record.phase !== 'prepared' || authority.registrationConfirmed) return conflict()
        if (!rotationIsFresh(candidate.executionProof.ticket.body, Date.now())
          || !rotationIsFresh(candidate.executionProof.deviceProof.body, Date.now())) return conflict()
        await input.authority!.journal.write({ ...record, executionAuthority: { ...authority, pendingProof: candidate.executionProof } })
      }
      return candidate
    }
    const body = { machineId: input.machineId, runId: input.runId, claimToken: input.claimToken,
      generation: target.generation, revision: target.revision, conversationSessionId: target.displaySessionId,
      conversationDirectory: target.conversationDirectory, agent: target.agent, createBody: target.body,
      ...(target.questionRequestId ? { questionRequestId: target.questionRequestId } : {}) }
    const raw = await json('/api/automation/execution-target', body)
    const personal = admissionSchema.omit({ executionProof: true }).safeParse(raw)
    if (personal.success && !personal.data.executionBindingRequired && !personal.data.executionAuthorityDigest) {
      if (input.authority && (await recordFor(target)).executionAuthority) return conflict()
      return personal.data
    }
    const discovery = z.strictObject({ executionBindingRequired: z.literal(true), executionAuthority: authoritySchema }).safeParse(raw)
    if (!discovery.success || !input.authority) throw new Error('AUTOMATION_EXECUTION_PROOF_REQUIRED')
    const host = input.authority, challenge = discovery.data.executionAuthority
    const pin = await host.pin(challenge.companyId), approval = pin?.approval.body
    if (!approval || approval.kind !== 'device-approval' || approval.companyId !== challenge.companyId
      || approval.machineId !== input.machineId || approval.approvalId !== challenge.approvalId
      || approval.deviceSigningPublicKey !== rotationBase64url(host.keys.signing.publicKey)
      || challenge.deviceKeyId !== await rotationSha256(host.keys.signing.publicKey)
      || challenge.machineAccountId !== host.accountId || challenge.machineId !== input.machineId
      || challenge.studioOrigin !== origin || challenge.happyOrigin !== new URL(host.happyOrigin).origin) return conflict()
    let record = await recordFor(target)
    const fixed = { companyId: challenge.companyId, machineAccountId: host.accountId,
      approvalId: challenge.approvalId, deviceKeyId: challenge.deviceKeyId }
    if (!record.executionAuthority) {
      if (record.phase !== 'prepared') return conflict()
      record = { ...record, executionAuthority: { ...fixed, launchId: randomUUID(), operationId: randomUUID(), initialNonce: rotationBase64url(randomBytes(32)) } }
      await host.journal.write(record)
    }
    const authority = record.executionAuthority!
    if ((Object.keys(fixed) as Array<keyof typeof fixed>).some(key => authority[key] !== fixed[key])) return conflict()
    const publicKey = z.strictObject({ version: z.literal(2), algorithm: z.literal('Ed25519'), keyId: z.string(), publicKey: z.string(),
      studioOrigin: z.string(), happyOrigin: z.string() }).parse(await json('/api/claude-setup-token/daemon/v2/public-key'))
    const issuerKey = rotationDecodeBinary(publicKey.publicKey, 32)
    if (publicKey.studioOrigin !== origin || publicKey.happyOrigin !== challenge.happyOrigin || publicKey.keyId !== challenge.keyId
      || await rotationSha256(issuerKey) !== challenge.keyId) return conflict()
    const now = Date.now(), sessionHash = await sessionCreateBodyHash(target.body), tagHash = await sessionTagHash(target.body.tag)
    const signedBody = AutomationExecutionAuthorityRequestBodySchema.parse({ version: 1, type: 'automation-execution-authority',
      audience: origin, method: 'POST', path: '/api/automation/execution-target',
      companyId: authority.companyId, machineId: input.machineId, approvalId: authority.approvalId, deviceKeyId: authority.deviceKeyId,
      launchId: authority.launchId, operationId: authority.operationId, initialNonce: authority.initialNonce,
      runId: target.runId, generation: target.generation, revision: target.revision, displaySessionId: target.displaySessionId, agent: target.agent,
      sessionOwnerAccountId: host.accountId, machineOwnerAccountId: host.accountId, sessionTagHash: tagHash,
      sessionCreateBodyHash: sessionHash, issuedAt: now, expiresAt: now + 60000 })
    const signed = await signRotationDocument(signedBody, host.keys.signing.secretKey)
    const issued = admissionSchema.omit({ executionProof: true }).extend({ executionBindingRequired: z.literal(true),
      executionAuthority: authoritySchema, executionTicket: SessionExecutionTicketSchema }).parse(
      await json('/api/automation/execution-target', { ...body, executionAuthorityRequest: signed }))
    if (JSON.stringify(issued.executionAuthority) !== JSON.stringify(challenge)) return conflict()
    const ticket = issued.executionTicket, t = ticket.body
    await verifyRotationDocument(ticket, issuerKey)
    const expected = { ...authority, machineId: input.machineId, sessionOwnerAccountId: host.accountId, machineOwnerAccountId: host.accountId,
      sessionTagHash: tagHash, sessionCreateBodyHash: sessionHash, deviceSigningPublicKey: rotationBase64url(host.keys.signing.publicKey),
      audience: challenge.happyOrigin, studioOrigin: origin, keyId: challenge.keyId }
    const { pendingProof, registrationConfirmed, machineAccountId, ...ticketExpected } = expected
    if (!rotationIsFresh(t, Date.now()) || (Object.keys(ticketExpected) as Array<keyof typeof ticketExpected>).some(key => t[key] !== ticketExpected[key])
      || issued.executionAuthorityDigest !== await sessionExecutionAuthorityDigest(t)) return conflict()
    const deviceProof = await signRotationDocument(HappySessionCreateProofBodySchema.parse({ version: 1, type: 'happy-session-create-proof',
      audience: challenge.happyOrigin, method: 'POST', path: '/v1/sessions', ticketDigest: await rotationDigest(ticket),
      sessionOwnerAccountId: host.accountId, sessionTagHash: tagHash, sessionCreateBodyHash: sessionHash,
      issuedAt: Date.now(), expiresAt: Math.min(t.expiresAt, Date.now() + 60000) }), host.keys.signing.secretKey)
    candidate = { targetProof: issued.targetProof, executionBindingRequired: true, executionAuthorityDigest: issued.executionAuthorityDigest,
      executionProof: { ticket, deviceProof } }
    return candidate
  }
}

/** Network operations only. The trusted issuer decides proof requirements; this adapter never downgrades them. */
export function createAutomationContextTransport(input: {
  serverUrl: string; token: string; machineId: string; runId: string; claimToken: string;
  authorize: Authorize
}): Pick<AutomationContextLaunchDependencies, 'register' | 'persistSeed'> & {
  verifyStart: NonNullable<AutomationContextLaunchDependencies['beforeStart']>
  reportExit(record: AutomationContextLaunchRecord): Promise<void>
} {
  const url = new URL(input.serverUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !input.token || !input.machineId || !input.claimToken || input.claimToken.length > 256) throw new Error('AUTOMATION_CONTEXT_TRANSPORT_INVALID')
  const base = url.toString().replace(/\/+$/, ''), sessionId = automationExecutionSessionId(input.runId)
  async function request(path: string, body?: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    } catch { throw new Error('AUTOMATION_CONTEXT_REQUEST_UNCONFIRMED') }
    if (!response.ok) throw new Error(`AUTOMATION_CONTEXT_HTTP_${response.status}`)
    try { return await response.json() } catch { throw new Error('AUTOMATION_CONTEXT_RESPONSE_INVALID') }
  }
  return {
    async verifyStart(run, prepared) {
      const displaySessionId = run.payload.conversation?.sessionId
      if (run.runId !== input.runId || run.claimToken !== input.claimToken || prepared.body.tag !== sessionId || !displaySessionId
        || (run.payload.agent !== 'claude' && run.payload.agent !== 'codex')) throw new Error('AUTOMATION_CONTEXT_IDENTITY_CONFLICT')
      // Recheck the strict issuer after waiting without creating another session or seed.
      const admission = admissionSchema.parse(await input.authorize({ automationId: run.automationId, runId: run.runId,
        generation: run.generation, revision: run.revision, machineId: input.machineId, displaySessionId,
        conversationDirectory: run.payload.directory, agent: run.payload.agent, body: structuredClone(prepared.body),
        ...(run.payload.executionQuestion ? { questionRequestId: run.payload.executionQuestion.requestId } : {}) }))
      if (admission.executionBindingRequired && (!admission.executionProof || !admission.executionAuthorityDigest)) throw new Error('AUTOMATION_EXECUTION_PROOF_REQUIRED')
      const { executionProof, ...currentAuthority } = admission, ticket = executionProof?.ticket.body
      const receipt = z.strictObject({ status: z.literal('REGISTERED'), sessionId: z.string(), displaySessionId: z.string(),
        createBodyHash: z.string() }).parse(await request(`/v1/automation-runs/${encodeURIComponent(run.runId)}/execution-session/recover`, {
          machineId: input.machineId, claimToken: input.claimToken, displaySessionId, body: prepared.body, ...currentAuthority,
          recoveryIdentity: ticket ? { companyId: ticket.companyId, approvalId: ticket.approvalId, deviceKeyId: ticket.deviceKeyId,
            launchId: ticket.launchId, operationId: ticket.operationId, initialNonce: ticket.initialNonce } : null,
        }))
      if (receipt.sessionId !== sessionId || receipt.displaySessionId !== displaySessionId
        || receipt.createBodyHash !== await sessionCreateBodyHash(prepared.body)) throw new Error('AUTOMATION_CONTEXT_RECEIPT_CONFLICT')
    },
    async reportExit(record) {
      if (record.runId !== input.runId || record.sessionId !== sessionId || record.prepared.body.tag !== sessionId || !record.exitReceipt) {
        throw new Error('AUTOMATION_EXIT_RECEIPT_CONFLICT')
      }
      const receipt = { version: 1 as const, ...record.exitReceipt, providerExitedCleanly: true as const,
        foregroundDrained: true as const, backgroundDrained: true as const, writeProducersDrained: true as const }
      const ack = z.object({ runId: z.literal(input.runId), sessionId: z.literal(sessionId), receipt: z.object({
        version: z.literal(1), provider: z.enum(['claude', 'codex']), observedAt: z.number().int().nonnegative(), receivedAt: z.number().int().nonnegative(),
        providerExitedCleanly: z.literal(true), foregroundDrained: z.literal(true), backgroundDrained: z.literal(true), writeProducersDrained: z.literal(true),
      }) }).parse(await request(`/v1/automation-runs/${encodeURIComponent(input.runId)}/execution-exit`, {
        machineId: input.machineId, claimToken: input.claimToken, createBodyHash: await sessionCreateBodyHash(record.prepared.body), receipt,
      }))
      if (ack.receipt.provider !== receipt.provider || ack.receipt.observedAt !== receipt.observedAt) throw new Error('AUTOMATION_EXIT_RECEIPT_CONFLICT')
    },
    async register(run, prepared) {
      const displaySessionId = run.payload.conversation?.sessionId
      if (run.runId !== input.runId || run.claimToken !== input.claimToken || prepared.body.tag !== sessionId || !displaySessionId
        || (run.payload.agent !== 'claude' && run.payload.agent !== 'codex')) throw new Error('AUTOMATION_CONTEXT_IDENTITY_CONFLICT')
      // No authored prompt, seed ciphertext or private key is sent to the issuer.
      const target: AutomationContextTargetRequest = { automationId: run.automationId, runId: run.runId,
        generation: run.generation, revision: run.revision, machineId: input.machineId, displaySessionId,
        conversationDirectory: run.payload.directory, agent: run.payload.agent, body: structuredClone(prepared.body),
        ...(run.payload.executionQuestion ? { questionRequestId: run.payload.executionQuestion.requestId } : {}) }
      let admission = admissionSchema.parse(await input.authorize(target))
      if (admission.executionBindingRequired && (!admission.executionProof || !admission.executionAuthorityDigest)) throw new Error('AUTOMATION_EXECUTION_PROOF_REQUIRED')
      const createBodyHash = await sessionCreateBodyHash(prepared.body)
      const path = `/v1/automation-runs/${encodeURIComponent(run.runId)}/execution-session`
      const requestBody = () => ({ machineId: input.machineId, claimToken: input.claimToken, displaySessionId, body: prepared.body, ...admission })
      const recover = async () => {
        const { executionProof, ...body } = requestBody(), ticket = executionProof!.ticket.body
        const receipt = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('NOT_REGISTERED') }),
          z.strictObject({ status: z.literal('REGISTERED'), sessionId: z.string(), displaySessionId: z.string(), createBodyHash: z.string() })]).parse(
          await request(`${path}/recover`, { ...body, recoveryIdentity: { companyId: ticket.companyId, approvalId: ticket.approvalId,
            deviceKeyId: ticket.deviceKeyId, launchId: ticket.launchId, operationId: ticket.operationId, initialNonce: ticket.initialNonce } }))
        if (receipt.status === 'NOT_REGISTERED') return false
        if (receipt.sessionId !== sessionId || receipt.displaySessionId !== displaySessionId || receipt.createBodyHash !== createBodyHash) {
          throw new Error('AUTOMATION_CONTEXT_RECEIPT_CONFLICT')
        }
        await input.authorize(target, { kind: 'confirmed', ...receipt })
        return true
      }
      if (!admission.executionBindingRequired || !await recover()) {
        if (admission.executionBindingRequired) admission = admissionSchema.parse(await input.authorize(target, { kind: 'prepare-submit' }))
        try {
          const receipt = z.object({ sessionId: z.string(), displaySessionId: z.string(), created: z.boolean() }).parse(await request(path, requestBody()))
          if (receipt.sessionId !== sessionId || receipt.displaySessionId !== displaySessionId) throw new Error('AUTOMATION_CONTEXT_RECEIPT_CONFLICT')
          if (admission.executionBindingRequired) await input.authorize(target, { kind: 'confirmed', sessionId, displaySessionId, createBodyHash })
        } catch (error) {
          // A lost ACK or an earlier in-flight POST may already have won. Never blindly POST again.
          if (!admission.executionBindingRequired || !await recover()) throw error
        }
      }
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
      const result = z.object({ messages: z.array(z.object({ id: z.string().min(1), seq: z.number().int().positive(), localId: z.string() })).length(1) }).parse(
        await request(`/v3/sessions/${encodeURIComponent(sessionId)}/messages`, { messages: [message] }))
      const ack = result.messages[0]
      if (ack.seq !== 1 || ack.localId !== message.localId) throw new Error('AUTOMATION_SEED_RECEIPT_CONFLICT')
      // Append ACKs intentionally omit content. Read the owned first row to verify what actually won localId deduplication.
      const page = z.object({ messages: z.array(z.object({ id: z.string().min(1), seq: z.number().int().positive(), localId: z.string(),
        content: z.object({ t: z.literal('encrypted'), c: z.string() }) })).length(1) }).parse(
        await request(`/v3/sessions/${encodeURIComponent(sessionId)}/messages?after_seq=0&limit=1`))
      const stored = page.messages[0]
      if (stored.id !== ack.id || stored.seq !== ack.seq || stored.localId !== ack.localId) throw new Error('AUTOMATION_SEED_RECEIPT_CONFLICT')
      return { seq: stored.seq, localId: stored.localId, content: stored.content.c }
    },
  }
}
