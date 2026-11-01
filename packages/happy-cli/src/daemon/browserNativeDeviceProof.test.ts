import { createHash } from 'node:crypto'
import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'
import { createBrowserNativeDeviceProof } from './browserNativeDeviceProof'
const keys = { signing: nacl.sign.keyPair(), recipient: nacl.box.keyPair() }
const approval = { body: { kind: 'device-approval', companyId: 'co', machineId: 'pc', machineType: 'dedicated', ownerUserId: 'u', approvalId: 'approval', deviceSigningPublicKey: Buffer.from(keys.signing.publicKey).toString('base64url') } }
const input = { studioOrigin: 'https://studio.example', machineId: 'pc', workspaceId: 'co', path: '/api/machines/pc/agent-browser/native-command', body: JSON.stringify({ generation: 'g', method: 'POST', path: '/v1/sessions/register', body: '{}' }) }
const signer = (pin: unknown = { approval }) => createBrowserNativeDeviceProof({ keys, pin: async () => pin as never, now: () => 1000 })
describe('native browser device proof', () => {
    it('binds exact request and audience with the approved device signature and fresh nonce', async () => {
        const a = JSON.parse(Buffer.from(await signer()(input), 'base64url').toString())
        const b = JSON.parse(Buffer.from(await signer()(input), 'base64url').toString())
        expect(a.body).toMatchObject({ kind: 'browser-native-device-proof', version: 1, audience: input.studioOrigin, machineId: 'pc', companyId: 'co', approvalId: 'approval', method: 'POST', path: input.path, bodySha256: createHash('sha256').update(input.body).digest('hex'), issuedAtMs: 1000, expiresAtMs: 61000 })
        expect(a.body.nonce).not.toBe(b.body.nonce)
        expect(nacl.sign.detached.verify(Buffer.from(JSON.stringify(a.body)), Buffer.from(a.signature, 'base64url'), keys.signing.publicKey)).toBe(true)
    })
    it.each([null, { approval: { body: { ...approval.body, machineId: 'other' } } }, { approval: { body: { ...approval.body, machineType: 'shared', ownerUserId: null } } }, { approval: { body: { ...approval.body, deviceSigningPublicKey: 'wrong' } } }])('refuses absent or mismatched approval', async pin => {
        await expect(signer(pin)(input)).rejects.toThrow('NATIVE_DEVICE_APPROVAL_REQUIRED')
    })
})
