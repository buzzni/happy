import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { rotationSha256, signRotationDocument, verifyRotationDocument } from '@slopus/happy-wire'
import { createMachineSetupTokenProtocol, readMachineRotationConfig } from './machineSetupTokenProtocol'
import type { DeviceOrgPin } from './deviceOrgPinStore'

const companyId = 'company', machineId = 'machine', studioOrigin = 'https://studio.test', happyOrigin = 'https://happy.test'
function setup(fetcher: typeof fetch) {
  const keys = { signing: nacl.sign.keyPair(), recipient: nacl.box.keyPair() }, studio = nacl.sign.keyPair()
  const config = { companyId, machineId, studioOrigin, happyOrigin, studioPublicKey: Buffer.from(studio.publicKey).toString('base64url') }
  let pin = { publicKey: 'organization-pin', approval: { body: { kind: 'device-approval', companyId, machineId, machineType: 'shared', ownerUserId: null,
    approvalId: 'approved', deviceSigningPublicKey: Buffer.from(keys.signing.publicKey).toString('base64url') } } } as DeviceOrgPin | null
  const protocol = createMachineSetupTokenProtocol({ config, keys, pin: async () => pin, bearer: () => 'machine-bearer', fetch: fetcher, now: () => 100000 })
  return { protocol, keys, studio, revoke: () => { pin = null } }
}
describe('machine-v2 pinned Studio and device boundary', () => {
  it('is explicitly OFF and refuses malformed ON or a missing exact local allowlist pair', () => {
    expect(readMachineRotationConfig({}, machineId, happyOrigin)).toBeNull()
    expect(() => readMachineRotationConfig({ HAPPY_SETUP_TOKEN_MACHINE_V2_ENABLED: 'true' }, machineId, happyOrigin)).toThrow('CONFIGURATION_REQUIRED')
    const env = { HAPPY_SETUP_TOKEN_MACHINE_V2_ENABLED: 'true', HAPPY_SETUP_TOKEN_MACHINE_V2_COMPANY_ID: companyId,
      HAPPY_APLUS_STUDIO_ORIGIN: studioOrigin, HAPPY_SETUP_TOKEN_MACHINE_V2_STUDIO_PUBLIC_KEY: Buffer.alloc(32).toString('base64url'),
      HAPPY_SETUP_TOKEN_MACHINE_V2_ALLOWLIST: JSON.stringify([[companyId, 'other-machine']]) }
    expect(() => readMachineRotationConfig(env, machineId, happyOrigin)).toThrow('CONFIGURATION_REQUIRED')
    expect(readMachineRotationConfig({ ...env, HAPPY_SETUP_TOKEN_MACHINE_V2_ALLOWLIST: JSON.stringify([[companyId, machineId]]) }, machineId, happyOrigin)).toMatchObject({ companyId, machineId })
  })
  it('signs the exact method/path/body with the approved persistent key; revocation sends nothing', async () => {
    const fetcher = vi.fn(async (_url, options) => {
      const document = JSON.parse(String(options?.body)); await verifyRotationDocument(document, keys.signing.publicKey)
      expect(document.body).toMatchObject({ action: 'issue', method: 'POST', path: '/api/claude-setup-token/daemon/v2/issue', approvalId: 'approved', companyId, machineId })
      expect(options?.headers).toMatchObject({ Authorization: 'Bearer machine-bearer' })
      return Response.json({ version: 2, operationId: document.body.operationId, state: 'exhausted' })
    }) as unknown as typeof fetch
    const { protocol, keys, revoke } = setup(fetcher)
    const request = await protocol.request({ action: 'issue', operationId: 'issue', launchId: 'launch', sessionOwnerAccountId: 'personal', sessionTagHash: 'a'.repeat(64), sessionCreateBodyHash: 'b'.repeat(64) })
    expect((await protocol.post(request)).state).toBe('exhausted')
    revoke(); await expect(protocol.post(request)).rejects.toMatchObject({ reason: 'FORBIDDEN' }); expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('does not turn an outage into unsupported or trust a discovered replacement key', async () => {
    const { protocol } = setup(vi.fn(async () => { throw new Error('offline') }) as typeof fetch)
    const req = await protocol.request({ action: 'operation', operationId: 'query', launchId: 'launch', targetOperationId: 'original' })
    await expect(protocol.post(req)).rejects.toMatchObject({ reason: 'REQUEST_FAILED' })
    await expect(setup(vi.fn(async () => Response.json({ version: 2, algorithm: 'Ed25519', studioOrigin, happyOrigin,
      publicKey: Buffer.alloc(32).toString('base64url'), keyId: await rotationSha256(new Uint8Array(32)) })) as typeof fetch).protocol.checkPublicKey()).rejects.toThrow('BINDING_REJECTED')
  })
  it('keeps machine FIFO order and returns Retry-After as Studio budget without retrying ahead of another session', async () => {
    const order: string[] = []
    const { protocol } = setup(vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body)).body; order.push(body.operationId)
      return body.operationId === 'session-a' ? Response.json({ error: 'SETUP_TOKEN_DAEMON_RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': '120' } })
        : Response.json({ version: 2, operationId: body.operationId, state: 'exhausted' })
    }) as typeof fetch)
    const a = await protocol.request({ action: 'operation', operationId: 'session-a', launchId: 'launch-a', targetOperationId: 'op-a' })
    const b = await protocol.request({ action: 'issue', operationId: 'session-b', launchId: 'launch-b', sessionOwnerAccountId: 'personal', sessionTagHash: 'a'.repeat(64), sessionCreateBodyHash: 'b'.repeat(64) })
    const outcomes = await Promise.allSettled([protocol.post(a), protocol.post(b)])
    expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: { reason: 'STUDIO_BUDGET', retryAfterMs: 120000 } })
    expect(outcomes[1]).toMatchObject({ status: 'fulfilled' }); expect(order).toEqual(['session-a', 'session-b'])
  })
  it('rejects forged and wrong-company bindings despite a successful HTTP envelope', async () => {
    const { protocol, studio, keys } = setup(vi.fn() as unknown as typeof fetch)
    const body = { version: 2 as const, type: 'claude-setup-token-binding' as const, audience: 'saycode-daemon' as const, principalType: 'machine' as const,
      companyId: 'another-company', machineId, groupScope: companyId, assignmentGeneration: 1, assignmentFingerprint: 'a'.repeat(64), managedAccountId: 'account', credentialGeneration: 1,
      approvalId: 'approved', deviceKeyId: await rotationSha256(keys.signing.publicKey), launchId: 'launch', bindingRevision: 1, nonce: Buffer.alloc(32, 1).toString('base64url'),
      previousNonce: null, issuedAt: 100000, expiresAt: 160000, keyId: await rotationSha256(studio.publicKey) }
    await expect(protocol.verifyBinding(await signRotationDocument(body, studio.secretKey), 'launch')).rejects.toThrow('BINDING_REJECTED')
    await expect(protocol.verifyBinding({ body: { ...body, companyId }, signature: Buffer.alloc(64).toString('base64url') }, 'launch')).rejects.toThrow()
  })
})
