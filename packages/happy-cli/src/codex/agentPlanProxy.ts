/**
 * aplus-dev-studio specs/org-agent-plan §6.3-2 — the runner's local proxy between Codex and the plan gateway.
 *
 * Same shape as the codex-multi-auth runtime proxy: a loopback HTTP server in the runner process (outside any
 * sandbox), which Codex calls with a per-session random client key. The proxy swaps that key for the current
 * `agps_` session key and streams the gateway's answer back. The grant secret and `agps_` never enter Codex's
 * environment — only the client key does, and it opens only this proxy. Cross-session isolation is not
 * claimed: any process of the same user can reach a loopback port, and cost is enforced by the server ledger.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { timingSafeEqual } from 'node:crypto'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

/** Large enough for a full context of input; images and files are refused by the gateway anyway. */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'user-agent'] as const
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'retry-after'] as const

export type AgentPlanProxy = { baseUrl: string; close(): Promise<void> }

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
    if (res.headersSent) {
        res.destroy()
        return
    }
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: { code, message, type: 'agent_plan_proxy_error' } }))
}

function authorized(req: IncomingMessage, expected: Buffer): boolean {
    const presented = Buffer.from(req.headers.authorization ?? '', 'utf8')
    return presented.length === expected.length && timingSafeEqual(presented, expected)
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > MAX_REQUEST_BYTES) return null
        chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks)
}

export async function startAgentPlanProxy(options: {
    /** The gateway's Responses endpoint, `<origin>/api/agent-plan/v1/responses`. */
    upstreamUrl: string
    /** What Codex presents (`env_key`); compared in constant time. */
    clientKey: string
    /** The current `agps_` key; refreshed by its owner before expiry. */
    sessionKey: () => Promise<string>
    fetchImpl?: typeof fetch
}): Promise<AgentPlanProxy> {
    const fetchImpl = options.fetchImpl ?? fetch
    const expectedAuthorization = Buffer.from(`Bearer ${options.clientKey}`, 'utf8')
    const inFlight = new Set<AbortController>()

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        if (req.method !== 'POST' || path !== '/v1/responses') {
            sendError(res, 404, 'agent_plan_proxy_not_found', 'Only POST /v1/responses is served')
            return
        }
        if (!authorized(req, expectedAuthorization)) {
            sendError(res, 401, 'agent_plan_proxy_unauthorized', 'Unknown proxy client key')
            return
        }
        const body = await readBody(req)
        if (!body) {
            sendError(res, 413, 'agent_plan_request_too_large', 'Request body is too large')
            return
        }
        let key: string
        try {
            key = await options.sessionKey()
        } catch (error) {
            const code = (error as { code?: unknown }).code
            sendError(res, 503, typeof code === 'string' ? code : 'agent_plan_unavailable', 'The plan session key could not be refreshed')
            return
        }
        const controller = new AbortController()
        inFlight.add(controller)
        // Codex hanging up mid-stream ends the upstream read; the gateway settles usage on its side.
        res.on('close', () => controller.abort())
        try {
            const headers: Record<string, string> = { authorization: `Bearer ${key}` }
            for (const name of FORWARDED_REQUEST_HEADERS) {
                const value = req.headers[name]
                if (typeof value === 'string') headers[name] = value
            }
            const upstream = await fetchImpl(options.upstreamUrl, {
                method: 'POST', headers, body: new Uint8Array(body), signal: controller.signal, redirect: 'error',
            })
            const responseHeaders: Record<string, string> = {}
            for (const name of FORWARDED_RESPONSE_HEADERS) {
                const value = upstream.headers.get(name)
                if (value !== null) responseHeaders[name] = value
            }
            res.writeHead(upstream.status, responseHeaders)
            if (!upstream.body) {
                res.end()
                return
            }
            await new Promise<void>((resolve) => {
                const stream = Readable.fromWeb(upstream.body as unknown as WebReadableStream)
                stream.on('error', () => { res.destroy(); resolve() })
                res.on('close', () => resolve())
                stream.pipe(res)
            })
        } catch {
            if (!controller.signal.aborted) sendError(res, 502, 'agent_plan_gateway_unreachable', 'The plan gateway could not be reached')
        } finally {
            inFlight.delete(controller)
        }
    }

    const server = createServer((req, res) => {
        handle(req, res).catch(() => sendError(res, 500, 'agent_plan_proxy_failed', 'Proxy failure'))
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const { port } = server.address() as AddressInfo
    let closed: Promise<void> | null = null
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => {
            if (!closed) {
                closed = new Promise<void>((resolve) => {
                    for (const controller of inFlight) controller.abort()
                    server.close(() => resolve())
                    server.closeAllConnections()
                })
            }
            return closed
        },
    }
}
