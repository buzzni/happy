/**
 * Admin API of the Browser Runtime: stands in for the auth server (grant
 * revocation) and the trusted fixture postcondition (reconciliation). Never
 * reachable with an agent grant or an interactive capability.
 */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { BrowserRuntimeError, type ActionId, type GrantId, type ProfileId, type TaskId } from './contracts'
import type { CdpDriver } from './drivers/cdpDriver'
import type { BrowserRuntime } from './runtime'

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
export function startAdminServer(input: { runtime: BrowserRuntime; drivers: Map<ProfileId, CdpDriver>; adminToken: string; host: string; port: number }) {
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
