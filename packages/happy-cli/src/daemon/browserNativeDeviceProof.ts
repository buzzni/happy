import { createHash, randomUUID } from 'node:crypto'
import nacl from 'tweetnacl'
import type { DeviceKeys } from './deviceKeys'
import type { DeviceOrgPin } from './deviceOrgPinStore'

export type BrowserNativeDeviceRequest = { studioOrigin: string; machineId: string; workspaceId: string; path: string; body: string }
export type BrowserNativeDeviceSigner = (request: BrowserNativeDeviceRequest) => Promise<string>
/** The pin provider validates the current locally confirmed approval on every request. No key leaves the daemon. */
export function createBrowserNativeDeviceProof(deps: { keys: DeviceKeys; pin(companyId: string): Promise<DeviceOrgPin | null>; now?: () => number }): BrowserNativeDeviceSigner {
    return async request => {
        const pin = await deps.pin(request.workspaceId), approval = pin?.approval.body
        if (!approval || approval.kind !== 'device-approval' || approval.companyId !== request.workspaceId ||
            approval.machineId !== request.machineId || approval.machineType !== 'dedicated' || !approval.ownerUserId ||
            approval.deviceSigningPublicKey !== Buffer.from(deps.keys.signing.publicKey).toString('base64url')) {
            throw new Error('NATIVE_DEVICE_APPROVAL_REQUIRED')
        }
        const issuedAtMs = (deps.now ?? Date.now)()
        const body = { kind: 'browser-native-device-proof', version: 1, audience: new URL(request.studioOrigin).origin,
            machineId: request.machineId, companyId: request.workspaceId, approvalId: approval.approvalId,
            method: 'POST', path: request.path, bodySha256: createHash('sha256').update(request.body).digest('hex'),
            issuedAtMs, expiresAtMs: issuedAtMs + 60_000, nonce: randomUUID() }
        const signature = Buffer.from(nacl.sign.detached(Buffer.from(JSON.stringify(body)), deps.keys.signing.secretKey)).toString('base64url')
        return Buffer.from(JSON.stringify({ body, signature })).toString('base64url')
    }
}
