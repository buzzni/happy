import nacl from 'tweetnacl'
import { z } from 'zod'
import { canonicalOrgSetupTokenJson } from './orgSetupTokenApproval'
import { rotationBase64url, rotationDecodeBinary, RotationOriginSchema } from './sharedMachineRotation'

export const SUBAGENT_PATHS = {
  prepare: '/api/org-llm-endpoints/daemon/subagent-prepare',
  status: '/api/org-llm-endpoints/daemon/subagent-status',
  failure: '/api/org-llm-endpoints/daemon/subagent-failure',
  started: '/api/org-llm-endpoints/daemon/subagent-started',
  launching: '/api/org-llm-endpoints/daemon/subagent-launching',
  childTicket: '/api/org-llm-endpoints/daemon/subagent-child-ticket',
  resume: '/api/org-llm-endpoints/daemon/subagent-resume',
  capabilities: '/api/org-llm-endpoints/daemon/subagent-capabilities',
} as const
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const common = {
  version: z.literal(1), type: z.literal('org-llm-subagent-request'), method: z.literal('POST'),
  audience: RotationOriginSchema, machineId: id, sourceSessionId: id, launchId: id, operationId: id,
  digest: hash, nonce: hash, issuedAt: time, expiresAt: time,
}
const bodySchema = z.discriminatedUnion('path', [
  z.object({ ...common, path: z.literal(SUBAGENT_PATHS.prepare), endpointId: id.optional() }).strict(),
  z.object({ ...common, path: z.literal(SUBAGENT_PATHS.status) }).strict(),
  z.object({ ...common, path: z.literal(SUBAGENT_PATHS.capabilities) }).strict(),
  z.object({ ...common, path: z.literal(SUBAGENT_PATHS.launching) }).strict(),
  z.object({ ...common, path: z.literal(SUBAGENT_PATHS.childTicket), initialNonce: z.string().refine(value => {
    try { rotationDecodeBinary(value, 32); return true } catch { return false }
  }), sessionTagHash: hash, sessionCreateBodyHash: hash }).strict(),
  z.object({ ...common, path: z.literal(SUBAGENT_PATHS.resume), bindingId: id, endpointId: id, targetId: id, generation: z.number().int().positive() }).strict(),
  z.object({ ...common, path: z.literal(SUBAGENT_PATHS.failure), reason: z.string().min(1).max(200) }).strict(),
  z.object({ ...common, path: z.literal(SUBAGENT_PATHS.started), sessionId: id, targetId: id }).strict(),
]).refine(body => body.expiresAt > body.issuedAt && body.expiresAt - body.issuedAt <= 60_000)
export const SignedSubagentRequestSchema = z.object({ body: bodySchema, signature: z.string().refine(value => {
  try { rotationDecodeBinary(value, 64); return true } catch { return false }
}) }).strict()
export type SubagentRequest = z.infer<typeof bodySchema>

// Domain separation prevents a signed subagent request being interpreted as another device protocol.
function signingBytes(body: unknown) {
  return new TextEncoder().encode('saycode-org-llm-subagent-v1\n' + canonicalOrgSetupTokenJson(body))
}
export function signSubagentRequest<T extends Record<string, unknown>>(body: T, secretKey: Uint8Array) {
  return { body, signature: rotationBase64url(nacl.sign.detached(signingBytes(body), secretKey)) }
}
export function verifySubagentRequest(request: z.infer<typeof SignedSubagentRequestSchema>, publicKey: string) {
  return nacl.sign.detached.verify(signingBytes(request.body), rotationDecodeBinary(request.signature, 64), rotationDecodeBinary(publicKey, 32))
}
