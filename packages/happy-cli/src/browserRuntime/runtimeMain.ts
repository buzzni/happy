/**
 * Browser Runtime process entry (Agent Browser PoC).
 *
 * Runs on the execution machine, independent of any Desktop/viewer/CLI
 * request: it owns the TaskStore writer lock, one CDP driver per profile, the
 * authenticated task API, and a separate admin API used by the harness acting
 * as the auth server (grant revocation, trusted reconciliation).
 *
 * Environment (all required unless noted):
 *   ABP_STATE_DIR            durable store directory (volume)
 *   ABP_KEYS_FILE            JSON {agentKey, interactiveKey, adminToken}
 *   ABP_PROFILES             JSON [{profileId, cdpHttpUrl, instanceUrl}]
 *   ABP_RUNTIME_HOST/PORT    task API bind (default 0.0.0.0:8787 in the container)
 *   ABP_ADMIN_PORT           admin API port (default 8788)
 */
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { verifyToken, type AuthKeys } from './auth'
import { BrowserRuntimeError, type ActionId, type BrowserInstanceId, type GrantId, type ProfileId, type TaskId } from './contracts'
import { CdpDriver } from './drivers/cdpDriver'
import { BrowserRuntime } from './runtime'
import { startRuntimeServer } from './server'
import { TaskStore } from './taskStore'

interface ProfileConfig {
    profileId: ProfileId
    cdpHttpUrl: string
    instanceUrl: string
}

interface KeysFile extends AuthKeys {
    adminToken: string
}

const RECONNECT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000]
const SWEEP_INTERVAL_MS = 1_000

function requiredEnv(name: string): string {
    const value = process.env[name]
    if (!value) throw new Error(`${name} is required`)
    return value
}

async function fetchJson(url: string, timeoutMs = 5_000): Promise<unknown> {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', `${new URL(url).pathname} returned ${response.status}`, true)
    return response.json()
}

/** The browser's identity comes from its supervisor, never from CDP. */
function instanceIdProvider(profile: ProfileConfig): () => Promise<BrowserInstanceId> {
    return async () => {
        const body = await fetchJson(profile.instanceUrl) as { browserInstanceId?: unknown }
        if (typeof body.browserInstanceId !== 'string' || !body.browserInstanceId) {
            throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'browser instance id is unavailable', true)
        }
        return body.browserInstanceId as BrowserInstanceId
    }
}

async function browserWsUrl(profile: ProfileConfig): Promise<string> {
    const version = await fetchJson(new URL('/json/version', profile.cdpHttpUrl).toString()) as { webSocketDebuggerUrl?: unknown }
    if (typeof version.webSocketDebuggerUrl !== 'string') throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'no CDP endpoint', true)
    return version.webSocketDebuggerUrl
}

async function connectWithRetry(driver: CdpDriver, profile: ProfileConfig, log: (line: string) => void): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await driver.reconnect(await browserWsUrl(profile))
            return
        } catch (error) {
            const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]
            if (attempt % 10 === 0) log(`profile=${profile.profileId} browser connect failed code=${(error as BrowserRuntimeError).code ?? 'ERROR'}`)
            await new Promise((resolve) => setTimeout(resolve, delay))
        }
    }
}

function adminAuthorized(req: IncomingMessage, adminToken: string): boolean {
    const header = req.headers.authorization ?? ''
    const supplied = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
    const expected = Buffer.from(adminToken)
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = ''
    for await (const chunk of req) {
        raw += chunk
        if (raw.length > 64 * 1024) throw new BrowserRuntimeError('INVALID_REQUEST', 'body too large')
    }
    const value = raw ? JSON.parse(raw) as unknown : {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrowserRuntimeError('INVALID_REQUEST', 'body must be an object')
    return value as Record<string, unknown>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}

/**
 * Admin operations stand in for the auth server and the trusted fixture
 * postcondition. They are never reachable with an agent grant.
 */
function startAdminServer(input: { runtime: BrowserRuntime; drivers: Map<ProfileId, CdpDriver>; adminToken: string; host: string; port: number }) {
    const server = createServer((req, res) => {
        void (async () => {
            if (!adminAuthorized(req, input.adminToken)) return sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED' } })
            const path = new URL(req.url ?? '/', 'http://admin').pathname
            try {
                if (req.method === 'GET' && path === '/admin/debug') {
                    const drivers = Object.fromEntries([...input.drivers].map(([id, driver]) => [id, {
                        connected: driver.isConnected(),
                        counts: driver.debugCounts(),
                    }]))
                    return sendJson(res, 200, { ok: true, result: { drivers, pinnedProfiles: input.runtime.pinnedProfiles(), memory: process.memoryUsage() } })
                }
                if (req.method !== 'POST') return sendJson(res, 404, { ok: false, error: { code: 'UNSUPPORTED_OPERATION' } })
                const body = await readBody(req)
                if (path === '/admin/revoke-grant') {
                    await input.runtime.revokeGrant(String(body.grantId) as GrantId)
                    return sendJson(res, 200, { ok: true, result: { revoked: true } })
                }
                if (path === '/admin/reconcile-action') {
                    const task = await input.runtime.reconcileAction(body.taskId as TaskId, body.actionId as ActionId, body.confirmed === true)
                    return sendJson(res, 200, { ok: true, result: task })
                }
                return sendJson(res, 404, { ok: false, error: { code: 'UNSUPPORTED_OPERATION' } })
            } catch (error) {
                const body = error instanceof BrowserRuntimeError ? error.toBody() : { code: 'RUNTIME_UNAVAILABLE', message: 'admin operation failed', retryable: true, mayHaveSideEffects: true }
                return sendJson(res, 500, { ok: false, error: body })
            }
        })()
    })
    return new Promise<void>((resolve) => server.listen(input.port, input.host, resolve))
}

async function main(): Promise<void> {
    const log = (line: string) => process.stderr.write(`[abp-runtime] ${new Date().toISOString()} ${line}\n`)
    const stateDir = requiredEnv('ABP_STATE_DIR')
    const keys = JSON.parse(readFileSync(requiredEnv('ABP_KEYS_FILE'), 'utf8')) as KeysFile
    const profiles = JSON.parse(requiredEnv('ABP_PROFILES')) as ProfileConfig[]
    const host = process.env.ABP_RUNTIME_HOST ?? '0.0.0.0'
    const port = Number(process.env.ABP_RUNTIME_PORT ?? '8787')
    const adminPort = Number(process.env.ABP_ADMIN_PORT ?? '8788')

    // A second Runtime on the same state dir fails here (writer lock).
    const store = await TaskStore.open(stateDir)

    const drivers = new Map<ProfileId, CdpDriver>()
    for (const profile of profiles) {
        drivers.set(profile.profileId, new CdpDriver({ browserWsUrl: '', browserInstanceIdProvider: instanceIdProvider(profile) }))
    }
    // Connect before recovery so it can compare browser instance ids.
    await Promise.all(profiles.map((profile) => connectWithRetry(drivers.get(profile.profileId)!, profile, log)))

    const runtime = new BrowserRuntime({ store, drivers })

    for (const profile of profiles) {
        const driver = drivers.get(profile.profileId)!
        driver.onDisconnect(() => {
            log(`profile=${profile.profileId} browser disconnected`)
            void runtime.onDriverDisconnected(profile.profileId)
                .catch((error) => log(`disconnect handling failed code=${(error as BrowserRuntimeError).code ?? 'ERROR'}`))
                .then(() => connectWithRetry(driver, profile, log))
                .then(() => runtime.onDriverReconnected(profile.profileId))
                .then(() => log(`profile=${profile.profileId} browser reconnected`))
                .catch((error) => log(`reconnect handling failed code=${(error as BrowserRuntimeError).code ?? 'ERROR'}`))
        })
    }

    const sweep = setInterval(() => {
        void runtime.sweep(Date.now()).catch((error) => log(`sweep failed code=${(error as BrowserRuntimeError).code ?? 'ERROR'}`))
    }, SWEEP_INTERVAL_MS)
    sweep.unref()

    const startedAtMs = Date.now()
    const server = await startRuntimeServer({
        api: runtime,
        verifyToken: (bearer) => verifyToken(bearer, keys, Date.now(), store.getRevocations()),
        host,
        port,
        health: () => ({
            pid: process.pid,
            startedAtMs,
            profiles: profiles.map((profile) => ({ profileId: profile.profileId, connected: drivers.get(profile.profileId)!.isConnected() })),
        }),
        log: (line: string) => log(line),
    })
    await startAdminServer({ runtime, drivers, adminToken: keys.adminToken, host, port: adminPort })
    log(`listening api=${server.url} adminPort=${adminPort} profiles=${profiles.length}`)

    const shutdown = async () => {
        clearInterval(sweep)
        await server.close()
        for (const driver of drivers.values()) await driver.close()
        await store.close()
        process.exit(0)
    }
    process.once('SIGTERM', () => void shutdown())
    process.once('SIGINT', () => void shutdown())
}

void main().catch((error) => {
    process.stderr.write(`[abp-runtime] fatal ${error instanceof BrowserRuntimeError ? error.code : ''} ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
})
