/** Persistent, proof-bound application consent. All mutations and client grants share one queue. */
import { syncDirectory } from './syncDirectory'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { z } from 'zod'
import { BrowserRuntimeError, type AuthContext } from './contracts'
import { openLocalClients, type LocalClientOptions } from './localClients'
const id = z.string().min(1).max(256)
const text = z.string().min(1).max(4096).refine(v => !/[\u0000-\u001f\u007f]/.test(v))
const scopeSchema = z.object({ profileId: id, taskSpaceId: id, origins: z.array(z.string().url().max(2048)).min(1).max(32), projectRoot: text, outFile: text })
const minutes = z.union([z.literal(15), z.literal(60), z.literal(1440)])
const REQUEST_TTL_MS = 5 * 60_000
const requestRecord = z.object({ requestId: id, expiresAtMs: z.number().int().nonnegative() }).strict()
const common = scopeSchema.extend({ schemaVersion: z.literal(2), requestId: id, requestedAtMs: z.number().int().nonnegative(), leaseMinutes: minutes })
const registration = common.extend({ name: z.string().min(1).max(120).refine(v => !/[\u0000-\u001f\u007f]/.test(v)), rememberSameScope: z.boolean() }).strict()
const connection = common.extend({ appId: id, appSecret: z.string().min(32).max(256) }).strict()
const manage = z.object({ schemaVersion: z.literal(2), profileId: id, appId: id.optional() }).strict()
const recordSchema = scopeSchema.extend({ appId: id, secretHash: z.string().regex(/^[a-f0-9]{64}$/), name: z.string(),
    principalId: id, workspaceId: id, machineId: id, assignmentId: id.optional(), maxLeaseMinutes: minutes,
    enabled: z.boolean(), revoked: z.boolean(), createdAtMs: z.number(), clientIds: z.array(id).max(2048) }).strict()
type App = z.infer<typeof recordSchema>
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const denied = () => new BrowserRuntimeError('SCOPE_DENIED', 'Application consent or proof is unavailable')
function owns(app: App, auth: AuthContext) {
    const c = auth.credential
    return c.kind === 'agent-grant' && app.principalId === c.principalId && app.workspaceId === c.workspaceId && app.machineId === c.machineId
        && app.profileId === c.profileId && app.assignmentId === c.assignmentId
}
function scopeKey(raw: z.infer<typeof scopeSchema>) {
    return JSON.stringify([raw.profileId, raw.taskSpaceId, [...new Set(raw.origins)].sort(), raw.projectRoot, raw.outFile])
}
export async function openLocalClientApps(options: LocalClientOptions) {
    const file = join(options.stateDir, 'browser-local-apps.v2.json')
    let apps: App[] = [], unhealthy = false, observedAtMs = 0
    let requests: z.infer<typeof requestRecord>[] = []
    try { const saved = z.object({ schemaVersion: z.literal(2), observedAtMs: z.number().nonnegative(), requests: z.array(z.union([id, requestRecord])).max(4096), apps: z.array(recordSchema).max(256) }).strict().parse(JSON.parse(await readFile(file, 'utf8'))); apps = saved.apps; observedAtMs = saved.observedAtMs; requests = saved.requests.filter((request): request is z.infer<typeof requestRecord> => typeof request !== 'string') }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Application consent registry unavailable') }
    const clients = await openLocalClients({ ...options, storage: { file: 'browser-app-clients.v2.json', maxLeaseMs: 86400000, maxGrants: 2048 } })
    let tail: Promise<unknown> = Promise.resolve()
    const exclusive = <T>(fn: () => Promise<T>): Promise<T> => { const run = tail.then(fn, fn); tail = run.catch(() => undefined); return run }
    const persist = async () => {
        const tmp = `${file}.${randomUUID()}.tmp`
        try {
            const fd = await open(tmp, 'wx', 0o600)
            try { await fd.writeFile(JSON.stringify({ schemaVersion: 2, apps, observedAtMs, requests })); await fd.sync() } finally { await fd.close() }
            await rename(tmp, file)
            await syncDirectory(options.stateDir)
        } catch (e) { unhealthy = true; throw e } finally { await rm(tmp, { force: true }) }
    }
    const allowedClient = (clientId: string) => !unhealthy && options.now() >= observedAtMs && apps.some(a => !a.revoked && a.clientIds.includes(clientId))
    const publicApp = (a: App) => ({ appId: a.appId, name: a.name, ...scopeSchema.parse(a), maxLeaseMinutes: a.maxLeaseMinutes,
        autoApprove: a.enabled && !a.revoked, revoked: a.revoked, createdAtMs: a.createdAtMs })
    const cleanup = (app: App) => clients.revokeMatching(clientId => app.clientIds.includes(clientId))
    const reconcile = async () => {
        // Recover both durable app revocations and issuance interrupted before the app journal commit.
        await clients.revokeMatching(clientId => !apps.some(app => !app.revoked && app.clientIds.includes(clientId)))
        await clients.sweep()
        const retained = apps.filter(app => !app.revoked || app.clientIds.some(clients.hasClient))
        if (retained.length !== apps.length) { apps = retained; await persist() }
    }
    const sweep = () => exclusive(reconcile)
    return {
        activeCount: clients.activeCount,
        isActive: (clientId: string) => allowedClient(clientId) && clients.isActive(clientId),
        sweep,
        drain: () => tail.then(() => clients.drain()),
        revokingGrantIds: clients.revokingGrantIds,
        handle: (action: string, secret: string, raw: unknown): Promise<unknown> => exclusive(async () => {
            if (unhealthy || options.now() < observedAtMs) throw denied()
            if (options.now() > observedAtMs) { observedAtMs = options.now(); await persist() }
            if (action === 'revoke-app-proof') {
                const req = z.object({ schemaVersion: z.literal(2), appId: id }).strict().parse(raw)
                const app = apps.find(candidate => candidate.appId === req.appId && candidate.secretHash === hash(secret))
                if (!app) throw denied()
                // Newly issued proof can always reduce its own authority, even after the owner exits.
                app.enabled = false; app.revoked = true
                await persist()
                return { schemaVersion: 2, revoked: true, autoApprove: false, cleanupPending: (await cleanup(app)).cleanupPending }
            }
            if (action === 'list' || action === 'revoke-owned') {
                const req = z.object({ schemaVersion: z.literal(2), profileId: id,
                    ...(action === 'revoke-owned' ? { clientSessionId: id } : {}) }).strict().parse(raw)
                const owner = await options.owner(secret, req.profileId)
                const ownedIds = new Set(apps.filter(app => owns(app, owner)).flatMap(app => app.clientIds))
                if (action === 'list') {
                    const result = await clients.handle('list', secret, { schemaVersion: 1, profileId: req.profileId }) as { clients: Array<{ clientSessionId: string }> }
                    return { schemaVersion: 2, clients: result.clients.filter(client => ownedIds.has(client.clientSessionId)) }
                }
                const clientId = (req as { clientSessionId: string }).clientSessionId
                if (!ownedIds.has(clientId)) throw denied()
                return clients.handle('revoke-owned', secret, { schemaVersion: 1, profileId: req.profileId, clientSessionId: clientId })
            }
            if (['status', 'grant', 'revoke'].includes(action)) {
                z.object({ schemaVersion: z.literal(2) }).strict().parse(raw)
                const status = await clients.handle('status', secret, { schemaVersion: 1 }) as { clientSessionId: string }
                if (!allowedClient(status.clientSessionId)) throw denied()
                return { ...await clients.handle(action, secret, { schemaVersion: 1 }) as object, schemaVersion: 2 }
            }
            if (['list-apps', 'disable-app', 'revoke-app'].includes(action)) {
                const req = manage.parse(raw), owner = await options.owner(secret, req.profileId)
                const owned = apps.filter(a => owns(a, owner))
                if (action === 'list-apps') {
                    const listed = await clients.handle('list', secret, { schemaVersion: 1, profileId: req.profileId }) as { clients: Array<{ clientSessionId: string }> }
                    return { schemaVersion: 2, apps: owned.map(a => ({ ...publicApp(a), clients: listed.clients.filter(c => a.clientIds.includes(c.clientSessionId)) })) }
                }
                const app = owned.find(a => a.appId === req.appId); if (!app) throw denied()
                app.enabled = false
                if (action === 'revoke-app') app.revoked = true
                await persist() // Durable denial precedes cleanup, and shares the issuance queue.
                return { schemaVersion: 2, revoked: app.revoked, autoApprove: false, cleanupPending: app.revoked ? (await cleanup(app)).cleanupPending : false }
            }
            if (action !== 'register-app' && action !== 'connect-app') throw denied()
            const req = action === 'register-app' ? registration.parse(raw) : connection.parse(raw)
            const rel = relative(req.projectRoot, req.outFile)
            if (!isAbsolute(req.projectRoot) || !isAbsolute(req.outFile) || !rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw denied()
            const owner = await options.owner(secret, req.profileId)
            if (owner.credential.kind !== 'agent-grant') throw denied()
            const now = options.now()
            if (req.requestedAtMs > now || now - req.requestedAtMs >= REQUEST_TTL_MS) throw new BrowserRuntimeError('INVALID_REQUEST', 'Application request expired or is from the future')
            requests = requests.filter(request => request.expiresAtMs > now)
            if (requests.some(request => request.requestId === req.requestId)) throw new BrowserRuntimeError('CONFLICT', 'Request already attempted; inspect connections instead of retrying')
            if (requests.length >= 4096) throw new BrowserRuntimeError('CONFLICT', 'Application request rate limit reached; wait for requests to expire')
            await reconcile()
            let app: App, appSecret: string | undefined
            if ('appId' in req) {
                const existing = apps.find(a => a.appId === req.appId)
                if (!existing || !owns(existing, owner) || !existing.enabled || existing.revoked || hash(req.appSecret) !== existing.secretHash
                    || scopeKey(req) !== scopeKey(existing) || req.leaseMinutes > existing.maxLeaseMinutes) throw denied()
                app = existing
            } else {
                if (apps.length >= 256) throw new BrowserRuntimeError('CONFLICT', 'Application registration limit reached')
                appSecret = randomBytes(32).toString('base64url')
                app = { ...scopeSchema.parse(req), appId: `app-${randomUUID()}`, secretHash: hash(appSecret), name: req.name,
                    principalId: owner.credential.principalId, workspaceId: owner.credential.workspaceId, machineId: owner.credential.machineId,
                    assignmentId: owner.credential.assignmentId, maxLeaseMinutes: req.leaseMinutes, enabled: req.rememberSameScope,
                    revoked: false, createdAtMs: options.now(), clientIds: [] }
            }
            requests.push({ requestId: req.requestId, expiresAtMs: req.requestedAtMs + REQUEST_TTL_MS }); await persist()
            app.clientIds = app.clientIds.filter(c => clients.isActive(c))
            const created = await clients.handle('register', secret, { schemaVersion: 1, profileId: req.profileId, taskSpaceId: req.taskSpaceId,
                origins: req.origins, leaseMs: req.leaseMinutes * 60000 }) as { clientSessionId: string; clientSecret: string }
            // Publish consent only together with its first successfully issued connection.
            if (appSecret) apps.push(app)
            app.clientIds.push(created.clientSessionId)
            try { await persist() } catch (e) { await clients.handle('revoke', created.clientSecret, { schemaVersion: 1 }).catch(() => undefined); throw e }
            return { ...created, schemaVersion: 2, appId: app.appId, ...(appSecret ? { appSecret } : {}) }
        }),
    }
}
