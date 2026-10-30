import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { openServerEnvelope, type TrustedIssuer } from './auth'
import { BrowserRuntimeError, INTERACTIVE_CAPABILITY_ISSUER } from './contracts'

const id = z.string().min(1).max(256)
const claimsSchema = z.object({
    kind: z.literal('native-command'), iss: z.literal(INTERACTIVE_CAPABILITY_ISSUER),
    aud: id, machineId: id, workspaceId: id, principalId: id,
    generation: z.string().regex(/^[A-Za-z0-9_-]{43}$/), requestId: z.string().uuid(),
    method: z.enum(['GET', 'POST']), path: z.string().min(1).max(2048),
    bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAtMs: z.number().int().nonnegative().safe(), expiresAtMs: z.number().int().nonnegative().safe(),
}).strict()
const denied = () => new BrowserRuntimeError('UNAUTHORIZED', 'A fresh signed native service command is required')

/** Only Core's trusted issuer can authorize machine-level operations. The local
 * daemon carries an exact one-use request, never a reusable machine credential.
 * Issuers must authorize the operation and scope before signing; a session-user
 * attestation alone is deliberately insufficient. */
export function nativeBrokerAuthorization(options: {
    identity: { machineId: string; workspaceId: string; principalId: string }
    trustedIssuers: readonly TrustedIssuer[]
    now: () => number
}) {
    if (!options.trustedIssuers.length) throw new Error('Native service needs trusted issuers')
    // Never loaded from disk: after a crash, all previous authority is invalid.
    const generation = randomBytes(32).toString('base64url')
    const consumed = new Map<string, number>()
    const identity = { ...options.identity }
    // Copy the trust configuration so a later caller mutation cannot alter admission.
    const issuers = options.trustedIssuers.map(issuer => ({ ...issuer }))
    let lastNow = Number.isSafeInteger(options.now()) ? options.now() : 0
    /** The latest time seen, or undefined for an unusable clock reading (that request is denied). */
    const observe = (): number | undefined => {
        const now = options.now()
        if (!Number.isSafeInteger(now)) return undefined
        lastNow = Math.max(lastNow, now)
        return lastNow
    }
    return {
        challenge: () => ({ schemaVersion: 1 as const, machineId: identity.machineId, workspaceId: identity.workspaceId, generation }),
        async authorize(req: IncomingMessage): Promise<unknown> {
            const token = req.headers['x-abp-native-command']
            if (typeof token !== 'string' || token.length > 8192 || req.headers['x-abp-daemon-token'] !== undefined) throw denied()
            let claims: z.infer<typeof claimsSchema>
            try { claims = claimsSchema.parse(openServerEnvelope(token.split('.'), 'abp-native-command', issuers)) }
            catch { throw denied() }
            // Time only moves forward here: a backward wall-clock step can neither revive an expired
            // command nor a pruned nonce (both are judged against the latest time seen), and it does not
            // lock the runtime out until a restart either.
            const now = observe()
            if (now === undefined || claims.machineId !== identity.machineId || claims.aud !== identity.machineId ||
                claims.workspaceId !== identity.workspaceId || claims.principalId !== identity.principalId || claims.generation !== generation ||
                claims.method !== req.method || claims.path !== req.url ||
                claims.issuedAtMs > now || claims.expiresAtMs <= now || claims.expiresAtMs <= claims.issuedAtMs ||
                claims.expiresAtMs - claims.issuedAtMs > 60000) throw denied()
            const chunks: Buffer[] = []
            let bytes = 0
            // Read only after authenticating the envelope; bound both bytes and time.
            const timer = setTimeout(() => req.destroy(), 5000)
            try {
                for await (const chunk of req) {
                    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                    bytes += part.length
                    if (bytes > 16384) throw denied()
                    chunks.push(part)
                }
            } finally { clearTimeout(timer) }
            const raw = Buffer.concat(chunks)
            if (createHash('sha256').update(raw).digest('hex') !== claims.bodySha256) throw denied()
            // No await between the final time check and consume. Concurrent copies
            // cannot both dispatch. A failed/uncertain operation cannot be replayed.
            const dispatchAt = observe()
            if (dispatchAt === undefined || claims.expiresAtMs <= dispatchAt) throw denied()
            for (const [nonce, expiry] of consumed) if (expiry <= dispatchAt) consumed.delete(nonce)
            if (consumed.has(claims.requestId) || consumed.size >= 4096) throw denied()
            consumed.set(claims.requestId, claims.expiresAtMs)
            try { return raw.length ? JSON.parse(raw.toString('utf8')) : {} }
            catch { throw new BrowserRuntimeError('INVALID_REQUEST', 'body is not valid JSON') }
        },
    }
}
