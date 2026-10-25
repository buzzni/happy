/** Local browser delegation CLI. Secrets are file/env inputs, never argv or stdout. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { loadBrowserTaskEnv } from '../daemon/browserTaskEnv'
const descriptorSchema = z.object({ schemaVersion: z.literal(1), brokerSocket: z.string().min(1), runtimeUrl: z.string(),
    clientSecret: z.string().min(1), clientSessionId: z.string().min(1), profileId: z.string().min(1),
    taskSpaceId: z.string().min(1), expiresAtMs: z.number().int().positive() }).strict()
const appDescriptorSchema = descriptorSchema.extend({ schemaVersion: z.literal(2), appId: z.string().min(1), appSecret: z.string().min(32), projectRoot: z.string(), outFile: z.string(), origins: z.array(z.string()), name: z.string(), maxLeaseMinutes: z.number() }).strict()
const anyDescriptor = z.union([descriptorSchema, appDescriptorSchema])
type Json = Record<string, any>
interface Dependencies {
    allowCreate?: boolean
    signal?: AbortSignal
    appRegistration?: { name: string; projectRoot: string; outFile: string; rememberSameScope: boolean }
    env: NodeJS.ProcessEnv
    output(value: unknown): void
    broker(socket: string, action: string, secret: string, body: unknown): Promise<Json>
    runtime(url: string, token: string, operation: string, body: unknown): Promise<Json>
}
function localUrl(value: string): string {
    const url = new URL(value)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid local endpoint')
    return url.origin
}
export function browserClientBrokerCall(socketPath: string, action: string, secret: string, body: unknown): Promise<Json> {
    return new Promise((resolve, reject) => {
        const req = request({ socketPath, path: action.startsWith('v2:') ? `/v2/clients/${action.slice(3)}` : `/v1/clients/${action}`, method: 'POST',
            headers: { 'content-type': 'application/json', 'x-abp-session-secret': secret } }, res => {
            let raw = ''
            res.on('data', chunk => { raw += chunk; if (raw.length > 1024 * 1024) req.destroy(new Error('Response too large')) })
            res.on('error', reject)
            res.on('end', () => {
                try {
                    const reply = JSON.parse(raw)
                    if (res.statusCode !== 200 || reply.ok !== true) throw new Error('Broker refused request')
                    resolve(reply.result)
                } catch { reject(new Error('Broker request failed')) }
            })
        })
        req.setTimeout(30_000, () => req.destroy(new Error('Broker timed out')))
        req.on('error', reject); req.end(JSON.stringify(body))
    })
}
async function runtimeCall(url: string, token: string, operation: string, body: unknown): Promise<Json> {
    const res = await fetch(`${localUrl(url)}/v1/ops/${operation}`, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    const reply = await res.json() as Json
    if (!res.ok || reply.ok !== true) throw new Error('Runtime refused request')
    return reply.result
}
export async function readBrowserClientDescriptor(file: string) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
        const metadata = await handle.stat()
        if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 16 * 1024 || (metadata.mode & 0o077) !== 0
            || (process.getuid && metadata.uid !== process.getuid())) throw new Error('Connection file must be private and owned by the caller')
        const descriptor = anyDescriptor.parse(JSON.parse(await handle.readFile('utf8')))
        if (!isAbsolute(descriptor.brokerSocket)) throw new Error('Invalid socket')
        localUrl(descriptor.runtimeUrl)
        return descriptor
    } finally { await handle.close() }
}
function parse(args: string[]) {
    const [action, ...rest] = args
    const allowed: Record<string, string[]> = { create: ['space', 'profile', 'origin', 'lease-minutes', 'out'],
        status: ['file'], revoke: ['file'], collect: ['file', 'url'] }
    if (!action || !allowed[action]) throw new Error('Unknown command')
    const values = new Map<string, string[]>();
    for (let i = 0; i < rest.length; i += 2) {
        const flag = rest[i].replace(/^--/, '')
        if (!rest[i].startsWith('--') || !allowed[action].includes(flag) || !rest[i + 1] || rest[i + 1].startsWith('--')
            || (flag !== 'origin' && values.has(flag))) throw new Error('Invalid arguments')
        values.set(flag, [...values.get(flag) ?? [], rest[i + 1]])
    }
    const required = (name: string) => { const v = values.get(name)?.[0]; if (!v) throw new Error(`Missing ${name}`); return v }
    return { action, values, required }
}
export async function handleBrowserClientCommand(args: string[], overrides: Partial<Dependencies> = {}): Promise<number> {
    const deps: Dependencies = { env: process.env, output: value => console.log(JSON.stringify(value)), broker: browserClientBrokerCall, runtime: runtimeCall, ...overrides }
    if (args.length === 0 || args[0] === '--help') {
        deps.output({ ok: true, schemaVersion: 1, usage: [
            'Ask the session browser_task_create_client tool to create a connection after user approval.',
            'happy browser-client status|revoke --file CONNECTION_FILE',
            'happy browser-client collect --file CONNECTION_FILE --url URL',
        ], note: 'Create from an authenticated browser-task session. Files contain secrets; never share or commit them.' })
        return 0
    }
    try {
        const { action, values, required } = parse(args)
        if (action === 'create') {
            if (!overrides.allowCreate) throw new Error('Use the approved session tool to create connections')
            const space = required('space'), profile = required('profile'), origins = values.get('origin') ?? [], out = required('out')
            const minutes = Number(values.get('lease-minutes')?.[0] ?? 60)
            if (!origins.length || !Number.isInteger(minutes) || minutes < 1 || minutes > (overrides.appRegistration ? 1440 : 60)) throw new Error('Invalid scope')
            for (const origin of origins) { const url = new URL(origin); if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('Invalid origin') }
            const env = loadBrowserTaskEnv({ ...deps.env }, undefined, () => {})
            const secret = env.HAPPY_BROWSER_TASK_SESSION_SECRET, socket = env.HAPPY_BROWSER_TASK_BROKER_SOCKET
            if (!secret || !socket || !isAbsolute(socket)) throw new Error('Authenticated owner session required')
            const runtimeUrl = localUrl(env.HAPPY_BROWSER_TASK_RUNTIME_URL ?? '')
            // Reserve first: an existing file never causes a remote connection to be created.
            const file = await open(out, 'wx', 0o600)
            let created: Json | undefined
            try {
                deps.signal?.throwIfAborted()
                created = await deps.broker(socket, overrides.appRegistration ? 'v2:register-app' : 'register', secret, overrides.appRegistration
                    ? { schemaVersion: 2, requestId: randomUUID(), requestedAtMs: Date.now(), ...overrides.appRegistration, profileId: profile, taskSpaceId: space, origins, leaseMinutes: minutes }
                    : { schemaVersion: 1, profileId: profile, taskSpaceId: space, origins, leaseMs: minutes * 60_000 })
                // Cancellation must revoke any authority already issued.
                deps.signal?.throwIfAborted()
                const descriptor = anyDescriptor.parse({ schemaVersion: overrides.appRegistration ? 2 : 1, brokerSocket: socket, runtimeUrl,
                    ...(overrides.appRegistration ? { appId: created.appId, appSecret: created.appSecret, projectRoot: overrides.appRegistration.projectRoot, outFile: overrides.appRegistration.outFile, origins, name: overrides.appRegistration.name, maxLeaseMinutes: minutes } : {}),
                    clientSecret: created.clientSecret, clientSessionId: created.clientSessionId, profileId: created.profileId,
                    taskSpaceId: created.taskSpaceId, expiresAtMs: created.expiresAtMs })
                await file.writeFile(JSON.stringify(descriptor) + '\n'); await file.sync()
                deps.signal?.throwIfAborted()
                deps.output({ ok: true, file: out, clientSessionId: descriptor.clientSessionId, expiresAtMs: descriptor.expiresAtMs })
            } catch (error) {
                if (created?.clientSecret) await deps.broker(socket, overrides.appRegistration ? 'v2:revoke-app' : 'revoke', overrides.appRegistration ? secret : created.clientSecret, overrides.appRegistration ? { schemaVersion: 2, profileId: profile, appId: created.appId } : { schemaVersion: 1 }).catch(() => undefined)
                await rm(out, { force: true }); throw error
            } finally { await file.close() }
            return 0
        }
        const descriptor = await readBrowserClientDescriptor(required('file'))
        if (action === 'status' || action === 'revoke') {
            const result = await deps.broker(descriptor.brokerSocket, descriptor.schemaVersion === 2 ? `v2:${action}` : action, descriptor.clientSecret, { schemaVersion: descriptor.schemaVersion })
            // Explicit allowlist: never relay a broker credential by accident.
            deps.output({ ok: true, result: action === 'revoke' ? { revoked: result.revoked === true, cleanupPending: result.cleanupPending === true } : {
                clientSessionId: result.clientSessionId, taskSpaceId: result.taskSpaceId, profileId: result.profileId,
                origins: result.origins, expiresAtMs: result.expiresAtMs } })
            return 0
        }
        const url = new URL(required('url'))
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid collection URL')
        const call = async (op: string, body: unknown) => {
            // Each request, especially cleanup, gets a currently valid bounded grant.
            const grant = await deps.broker(descriptor.brokerSocket, descriptor.schemaVersion === 2 ? 'v2:grant' : 'grant', descriptor.clientSecret, { schemaVersion: descriptor.schemaVersion })
            if (typeof grant.token !== 'string') throw new Error('Missing token')
            return deps.runtime(descriptor.runtimeUrl, grant.token, op, body)
        }
        const task = await call('createTask', { taskSpaceId: descriptor.taskSpaceId, requestId: randomUUID() })
        let finished = false
        let tabId: string | undefined
        try {
            const page = await call('openPage', { taskId: task.taskId, url: url.href, requestId: randomUUID() })
            tabId = page.tabId
            if (page.task?.status === 'awaiting-user') {
                deps.output({ ok: false, state: 'awaiting-user', waitReason: page.task.waitReason, message: 'Complete login or verification in the browser profile, then collect again.' })
                return 3
            }
            const result = await call('observe', { taskId: task.taskId, tabId: page.tabId })
            const current = await call('getTask', { taskId: task.taskId })
            await call('finishTask', { taskId: task.taskId, expectedVersion: current.stateVersion, requestId: randomUUID() }); finished = true
            const closed = await call('closePage', { taskSpaceId: descriptor.taskSpaceId, tabId, requestId: randomUUID() })
            if (!closed.closed) throw new Error('Tab cleanup needs user attention')
            tabId = undefined
            deps.output({ ok: true, collectedAt: new Date().toISOString(), result })
        } finally {
            if (!finished) await call('cancel', { taskId: task.taskId, requestId: randomUUID() }).catch(() => undefined)
            if (tabId) await call('closePage', { taskSpaceId: descriptor.taskSpaceId, tabId, requestId: randomUUID() }).catch(() => undefined)
        }
        return 0
    } catch {
        // Transport and page errors may contain secrets/URLs. They are not safe diagnostic output.
        deps.output({ ok: false, error: 'browser_client_failed', message: 'Check arguments, private connection file, runtime availability and connection expiry. A failed mutation may require status inspection; it is not retried automatically.' })
        return 3
    }
}
