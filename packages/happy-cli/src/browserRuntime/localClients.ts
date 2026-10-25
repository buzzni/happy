/** Bounded browser delegation. Separate registry: old brokers must never widen client credentials. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { mintAgentGrant } from './auth'
import { BrowserRuntimeError, type AgentGrant, type AuthContext, type GrantId, type Operation } from './contracts'

const OPERATIONS: Operation[] = ['createTask', 'openPage', 'closePage', 'observe', 'screenshot', 'submitBatch', 'finishTask', 'getTask', 'resume', 'cancel']
const MAX_LEASE_MS = 60 * 60_000
const TOKEN_MS = 5 * 60_000
const id = z.string().min(1).max(256)
const origin = z.string().max(2048).refine(value => {
    try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && u.origin === value } catch { return false }
})
const registrationRequest = z.object({ schemaVersion: z.literal(1), profileId: id, taskSpaceId: id,
    origins: z.array(origin).min(1).max(32), leaseMs: z.number().int().min(1_000).max(MAX_LEASE_MS) }).strict()
const simpleRequest = z.object({ schemaVersion: z.literal(1) }).strict()
const recordSchema = z.object({
    clientSessionId: id, secretHash: z.string().regex(/^[a-f0-9]{64}$/), principalId: id, workspaceId: id, machineId: id,
    profileId: id, assignmentId: id.optional(), taskSpaceId: id, origins: z.array(origin).min(1).max(32),
    expiresAtMs: z.number().int().positive(), createdAtMs: z.number().int().nonnegative(), revoking: z.boolean(),
    revoked: z.boolean().optional(), cleanupAfterMs: z.number().int().nonnegative().optional(),
    grantIds: z.array(id).max(256), lastGrant: z.object({ grantId: id, issuedAtMs: z.number(), expiresAtMs: z.number() }).optional(),
}).strict()
type ClientRecord = z.infer<typeof recordSchema>
export interface LocalClientOptions {
    stateDir: string
    agentKey: string | Buffer
    now(): number
    /** Must authenticate an existing, bound, current-assignment owner; never accepts client credentials. */
    owner(secret: string, profileId: string): Promise<AuthContext>
    recheckOwner(secret: string, profileId: string): Promise<void>
    attach(owner: AuthContext, client: AgentGrant, expiresAtMs: number): Promise<void>
    check(client: AgentGrant): Promise<void>
    revokeGrant(id: GrantId): Promise<void>
    endSession(id: string): Promise<void>
    cleanupSession?(id: string): Promise<void>
}
const hash = (secret: string) => createHash('sha256').update(secret).digest('hex')
const denied = () => new BrowserRuntimeError('UNAUTHORIZED', 'Client credential is invalid, expired or revoked')

export async function openLocalClients(options: LocalClientOptions) {
    const file = join(options.stateDir, 'browser-local-clients.json')
    let records: Record<string, ClientRecord> = {}
    try {
        records = z.object({ schemaVersion: z.literal(1), clients: z.record(z.string(), recordSchema) }).strict()
            .parse(JSON.parse(await readFile(file, 'utf8'))).clients
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Local client registry is unreadable')
    }
    // All read/modify/write paths, including replay, share the same queue.
    let tail: Promise<unknown> = Promise.resolve()
    const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = tail.then(fn, fn); tail = run.catch(() => undefined); return run
    }
    const persist = async () => {
        const temporary = `${file}.${randomUUID()}.tmp`
        try {
            const handle = await open(temporary, 'wx', 0o600)
            try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, clients: records })); await handle.sync() } finally { await handle.close() }
            await rename(temporary, file)
            const dir = await open(options.stateDir, 'r'); try { await dir.sync() } finally { await dir.close() }
        } finally { await rm(temporary, { force: true }) }
    }
    const credential = (r: ClientRecord): AgentGrant => ({
        kind: 'agent-grant', grantId: (r.lastGrant?.grantId ?? `pending-${r.clientSessionId}`) as never,
        principalId: r.principalId as never, workspaceId: r.workspaceId as never, machineId: r.machineId as never,
        profileId: r.profileId as never, agentSessionId: r.clientSessionId as never,
        taskSpaceIds: [r.taskSpaceId as never], allowedOrigins: [...r.origins], operations: [...OPERATIONS],
        issuedAtMs: r.lastGrant?.issuedAtMs ?? options.now(), expiresAtMs: r.lastGrant?.expiresAtMs ?? r.expiresAtMs,
        ...(r.assignmentId ? { assignmentId: r.assignmentId } : {}),
    })
    const revoke = async (r: ClientRecord) => {
        if (!r.revoked) {
            r.revoking = true
            await persist() // Durable fence precedes every side effect. Failure keeps the in-memory fence.
            await options.endSession(r.clientSessionId)
            for (const grantId of r.grantIds) await options.revokeGrant(grantId as GrantId)
            r.revoked = true
            await persist()
        }
        if ((r.cleanupAfterMs ?? 0) > options.now()) return { revoked: true, cleanupPending: true }
        try { await options.cleanupSession?.(r.clientSessionId) }
        catch {
            r.cleanupAfterMs = options.now() + 60_000
            await persist()
            return { revoked: true, cleanupPending: true }
        }
        delete records[r.clientSessionId]
        await persist()
        return { revoked: true, cleanupPending: false }
    }
    const sweep = () => exclusive(async () => {
        for (const r of Object.values(records)) {
            if ((r.revoking || r.expiresAtMs <= options.now()) && (r.cleanupAfterMs ?? 0) <= options.now())
                await revoke(r).catch(() => undefined)
        }
    })
    const authenticate = (secret: string) => {
        const r = secret && Object.values(records).find(r => r.secretHash === hash(secret))
        if (!r || r.revoking || r.expiresAtMs <= options.now()) throw denied()
        return r
    }
    const metadata = (r: ClientRecord) => ({ schemaVersion: 1, clientSessionId: r.clientSessionId, profileId: r.profileId,
        taskSpaceId: r.taskSpaceId, origins: r.origins, operations: OPERATIONS, expiresAtMs: r.expiresAtMs })
    return {
        isActive: (id: string) => Boolean(records[id] && !records[id].revoking && records[id].expiresAtMs > options.now()),
        sweep,
        drain: () => tail.then(() => undefined),
        revokingGrantIds: () => new Set(Object.values(records).filter(r => r.revoking || r.expiresAtMs <= options.now()).flatMap(r => r.grantIds)),
        pendingRevocations: () => Object.values(records).filter(r => r.revoking).length,
        handle: (action: string, secret: string, raw: unknown): Promise<unknown> => exclusive(async () => {
            if (action === 'list' || action === 'revoke-owned') {
                const schema = action === 'list' ? z.object({ schemaVersion: z.literal(1), profileId: id }).strict()
                    : z.object({ schemaVersion: z.literal(1), profileId: id, clientSessionId: id }).strict()
                const parsed = schema.safeParse(raw)
                if (!parsed.success) throw new BrowserRuntimeError('INVALID_REQUEST', 'Invalid owner request')
                const owner = await options.owner(secret, parsed.data.profileId)
                const owned = Object.values(records).filter(r => r.principalId === owner.credential.principalId && r.profileId === owner.credential.profileId
                    && r.machineId === owner.credential.machineId && r.workspaceId === owner.credential.workspaceId)
                if (action === 'list') return { clients: owned.map(r => ({ ...metadata(r), revoking: r.revoking, revoked: Boolean(r.revoked), cleanupPending: Boolean(r.revoked) })) }
                const target = owned.find(r => r.clientSessionId === ('clientSessionId' in parsed.data ? parsed.data.clientSessionId : undefined))
                if (!target) throw new BrowserRuntimeError('SCOPE_DENIED', 'Unknown owned client')
                return revoke(target)
            }
            if (action === 'register') {
                const parsed = registrationRequest.safeParse(raw)
                if (!parsed.success) throw new BrowserRuntimeError('INVALID_REQUEST', 'Invalid client registration')
                const req = parsed.data
                const owner = await options.owner(secret, req.profileId)
                if (owner.credential.kind !== 'agent-grant') throw denied()
                const ownerGrant = owner.credential
                if (req.origins.some(o => !ownerGrant.allowedOrigins.includes(o)))
                    throw new BrowserRuntimeError('SCOPE_DENIED', 'Client origin is outside owner policy')
                const now = options.now()
                if (Object.values(records).filter(r => !r.revoking && r.expiresAtMs > now && r.principalId === owner.credential.principalId).length >= 16) throw new BrowserRuntimeError('CONFLICT', 'Too many local client connections')
                const clientSecret = randomBytes(32).toString('base64url')
                const r: ClientRecord = { clientSessionId: `client-${randomUUID()}`, secretHash: hash(clientSecret),
                    principalId: owner.credential.principalId, workspaceId: owner.credential.workspaceId, machineId: owner.credential.machineId,
                    profileId: owner.credential.profileId, assignmentId: owner.credential.assignmentId,
                    taskSpaceId: req.taskSpaceId, origins: [...new Set(req.origins)], createdAtMs: now, expiresAtMs: now + req.leaseMs,
                    grantIds: [], revoking: true }
                records[r.clientSessionId] = r
                // A crash before activation leaves only a tombstone; replay removes any attached membership.
                await persist()
                try {
                    await options.attach(owner, credential(r), r.expiresAtMs)
                    await options.recheckOwner(secret, req.profileId)
                    r.revoking = false
                    try { await persist() } catch (error) { r.revoking = true; throw error }
                } catch (error) { await revoke(r); throw error }
                return { ...metadata(r), clientSecret }
            }
            if (!simpleRequest.safeParse(raw).success) throw new BrowserRuntimeError('INVALID_REQUEST', 'Invalid client request')
            const r = authenticate(secret)
            if (action === 'revoke') return revoke(r)
            if (action !== 'grant' && action !== 'status') throw new BrowserRuntimeError('UNSUPPORTED_OPERATION', 'Unknown client operation')
            // Check with the connection expiry, not a previous short token which may have expired.
            await options.check({ ...credential(r), expiresAtMs: r.expiresAtMs })
            if (action === 'status') return metadata(r)
            const now = options.now()
            if (!r.lastGrant || (r.lastGrant.expiresAtMs !== r.expiresAtMs && r.lastGrant.expiresAtMs - now < 180_000)) {
                if (r.grantIds.length >= 256) throw new BrowserRuntimeError('CONFLICT', 'Client grant limit reached')
                const grantId = `grant-${randomUUID()}`
                r.lastGrant = { grantId, issuedAtMs: now, expiresAtMs: Math.min(now + TOKEN_MS, r.expiresAtMs) }
                r.grantIds.push(grantId)
                try { await persist() } catch (error) { r.revoking = true; throw error }
            }
            const grant = credential(r)
            return { ...metadata(r), token: mintAgentGrant(grant, { agentKey: options.agentKey }, now),
                grantId: grant.grantId, tokenExpiresAtMs: grant.expiresAtMs }
        }),
    }
}
