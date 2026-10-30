/** Pinned, device-authenticated Studio protocol. No request-supplied origin or public key. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  DAEMON_ROTATION_PATHS, DaemonRotationRequestBodySchema, MachineSetupTokenBindingV2DocumentSchema,
  SessionExecutionTicketSchema, parseCanonicalOrgSetupTokenJson, rotationDecodeBinary,
  rotationIsFresh, rotationSha256, signRotationDocument, verifyRotationDocument,
  type DaemonRotationRequestBody, type MachineSetupTokenBindingV2Document,
} from '@slopus/happy-wire'
import type { DeviceKeys } from './deviceKeys'
import type { DeviceOrgPin } from './deviceOrgPinStore'

export class MachineRotationError extends Error {
  constructor(readonly reason: string, readonly retryAfterMs?: number) { super(`Machine setup-token rotation: ${reason}`) }
}
export type MachineRotationConfig = { companyId: string; machineId: string; studioOrigin: string; happyOrigin: string; studioPublicKey: string }
const resultSchema = z.object({ version: z.literal(2), operationId: z.string().min(1).max(128),
  state: z.enum(['pending', 'claimed', 'committed', 'exhausted', 'recorded', 'start']), tier: z.enum(['available', 'unknown', 'exhausted']).optional(),
  admission: z.discriminatedUnion('state', [
    z.object({ state: z.literal('allowed'), validForMs: z.number().int().positive().max(15000) }).strict(),
    z.object({ state: z.literal('wait'), retryAfterMs: z.number().int().positive().max(600000), preferredAccountIds: z.array(z.string()) }).strict(),
  ]).optional(),
  observationId: z.string().optional(), binding: MachineSetupTokenBindingV2DocumentSchema.optional(), executionTicket: SessionExecutionTicketSchema.optional(),
}).strict()
export type MachineRotationResult = z.infer<typeof resultSchema>
type RequestFields = DaemonRotationRequestBody extends infer T ? T extends DaemonRotationRequestBody ? Omit<T,
  'version'|'type'|'audience'|'method'|'path'|'companyId'|'machineId'|'approvalId'|'deviceKeyId'|'issuedAt'|'expiresAt'> : never : never

export function createMachineSetupTokenProtocol(deps: {
  config: MachineRotationConfig; keys: DeviceKeys; pin(companyId: string): Promise<DeviceOrgPin | null>;
  bearer(): string; fetch?: typeof fetch; now?: () => number
}) {
  const { config, keys } = deps, now = deps.now ?? Date.now, fetcher = deps.fetch ?? fetch
  let tail: Promise<unknown> = Promise.resolve()
  async function authority() {
    const pin = await deps.pin(config.companyId), body = pin?.approval.body
    if (!body || body.kind !== 'device-approval' || body.companyId !== config.companyId || body.machineId !== config.machineId
      || body.machineType !== 'shared' || body.ownerUserId !== null
      || body.deviceSigningPublicKey !== Buffer.from(keys.signing.publicKey).toString('base64url')) throw new MachineRotationError('FORBIDDEN')
    return { approvalId: body.approvalId, deviceKeyId: await rotationSha256(keys.signing.publicKey) }
  }
  async function request(fields: RequestFields): Promise<DaemonRotationRequestBody> {
    return DaemonRotationRequestBodySchema.parse({ version: 2, type: 'setup-token-daemon-request', audience: config.studioOrigin,
      method: 'POST', path: DAEMON_ROTATION_PATHS[fields.action], companyId: config.companyId, machineId: config.machineId,
      ...await authority(), ...fields, issuedAt: now(), expiresAt: now() + 60000 })
  }
  async function verifyBinding(document: MachineSetupTokenBindingV2Document, launchId: string, recovered = false) {
    await verifyRotationDocument(document, rotationDecodeBinary(config.studioPublicKey, 32))
    const b = document.body, a = await authority()
    if (b.keyId !== await rotationSha256(rotationDecodeBinary(config.studioPublicKey, 32)) || b.companyId !== config.companyId
      || b.machineId !== config.machineId || b.groupScope !== config.companyId || b.launchId !== launchId
      || b.approvalId !== a.approvalId || b.deviceKeyId !== a.deviceKeyId || (!recovered && !rotationIsFresh(b, now()))) throw new MachineRotationError('BINDING_REJECTED')
    return b
  }
  async function postOnce(original: DaemonRotationRequestBody, recovered: boolean, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const a = await authority()
    signal?.throwIfAborted()
    if (original.companyId !== config.companyId || original.machineId !== config.machineId
      || original.approvalId !== a.approvalId || original.deviceKeyId !== a.deviceKeyId) throw new MachineRotationError('FORBIDDEN')
    const body = DaemonRotationRequestBodySchema.parse({ ...original, issuedAt: now(), expiresAt: now() + 60000 })
    const document = await signRotationDocument(body, keys.signing.secretKey)
    let response: Response
    try { response = await fetcher(config.studioOrigin + body.path, { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${deps.bearer()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(document) }) }
    catch { throw new MachineRotationError('REQUEST_FAILED') }
    const raw = await boundedJson(response)
    if (!response.ok) {
      const code = (raw as { error?: unknown })?.error
      if (response.status === 429) {
        const value = response.headers.get('Retry-After'), seconds = value && /^\d+$/.test(value) ? Number(value) * 1000 : value ? Date.parse(value) - now() : 60000
        throw new MachineRotationError('STUDIO_BUDGET', Number.isFinite(seconds) ? Math.max(1000, Math.min(seconds, 1800000)) : 60000)
      }
      if (code === 'SETUP_TOKEN_DAEMON_OPERATION_NOT_FOUND') throw new MachineRotationError('OPERATION_NOT_FOUND')
      if (code === 'SETUP_TOKEN_DAEMON_APPLY_REQUIRED') throw new MachineRotationError('APPLY_REQUIRED')
      if (code === 'SETUP_TOKEN_DAEMON_UNSUPPORTED') throw new MachineRotationError('UNSUPPORTED')
      throw new MachineRotationError(response.status === 401 || response.status === 403 ? 'FORBIDDEN' : 'REQUEST_FAILED')
    }
    let result: MachineRotationResult
    try { result = resultSchema.parse(raw) } catch { throw new MachineRotationError('REQUEST_FAILED') }
    if (result.operationId !== (body.action === 'operation' ? body.targetOperationId : body.operationId)) throw new MachineRotationError('BINDING_REJECTED')
    if (result.binding) await verifyBinding(result.binding, body.launchId, recovered)
    return result
  }
  return {
    config, now, request, authority, verifyBinding,
    /** FIFO per machine. Retry waits happen in the caller, never while holding the queue. */
    post(body: DaemonRotationRequestBody, recovered = false, signal?: AbortSignal): Promise<MachineRotationResult> {
      const result = tail.then(() => postOnce(body, recovered, signal)); tail = result.catch(() => undefined); return result
    },
    async checkPublicKey() {
      const response = await fetcher(config.studioOrigin + '/api/claude-setup-token/daemon/v2/public-key', {
        redirect: 'error', signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } })
      const value = await boundedJson(response) as Record<string, unknown>
      if (!response.ok || value.version !== 2 || value.algorithm !== 'Ed25519' || value.publicKey !== config.studioPublicKey
        || value.keyId !== await rotationSha256(rotationDecodeBinary(config.studioPublicKey, 32))
        || value.studioOrigin !== config.studioOrigin || value.happyOrigin !== config.happyOrigin) throw new MachineRotationError('BINDING_REJECTED')
    },
    sign: <T extends Parameters<typeof signRotationDocument>[0]>(body: T) => signRotationDocument(body, keys.signing.secretKey),
    query: async (launchId: string, targetOperationId: string) => request({ action: 'operation', operationId: randomUUID(), launchId, targetOperationId }),
  }
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new MachineRotationError('REQUEST_FAILED')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length
      if (size > 32768) { await reader.cancel(); throw new MachineRotationError('REQUEST_FAILED') } chunks.push(value) }
    return parseCanonicalOrgSetupTokenJson(Buffer.concat(chunks).toString('utf8'))
  } catch { throw new MachineRotationError('REQUEST_FAILED') } finally { reader.releaseLock() }
}
export type MachineSetupTokenProtocol = ReturnType<typeof createMachineSetupTokenProtocol>
