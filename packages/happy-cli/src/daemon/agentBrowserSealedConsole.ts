/**
 * aplus-dev-studio-desktop ADR-085 — the AI browser console of a strict machine, carried over a
 * customer-key bound RPC instead of the plaintext preview relay.
 *
 * One request per RPC: the RPC layer already seals it to the customer key and checks nonce,
 * freshness and machine scope. This module only decides what may reach the runtime: the remote
 * page console document and its operations, on this machine's own loopback runtime.
 */

import { z } from 'zod'
import { PreviewProxyError, proxyHttp } from './previewProxy'

export const AGENT_BROWSER_CONSOLE_METHOD = 'agent-browser:console-http-v1'

const REQUEST_HEADERS = ['content-type', 'authorization', 'accept'] as const
const RESPONSE_HEADERS = ['content-type', 'cache-control', 'content-security-policy'] as const
/** Operation DTOs are small JSON; page frames come back, never go out. */
const MAX_REQUEST_BODY_BYTES = 64 * 1024
/** Frames aim at ~100 KiB (`pageViews.ts`); the console document is smaller still. */
const MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024
/** Above the console client's own 6 s request timeout. */
const TIMEOUT_MS = 10_000

const consoleRequest = z.object({
    method: z.string(),
    path: z.string().min(1).max(2048),
    headers: z.record(z.string(), z.string().max(8192)).optional(),
    bodyB64: z.string().max(Math.ceil(MAX_REQUEST_BODY_BYTES / 3) * 4).nullable().optional(),
}).strict()

export type SealedConsoleFailure = 'INVALID_REQUEST' | 'PATH_NOT_ALLOWED' | 'RUNTIME_UNAVAILABLE' | 'RUNTIME_UNREACHABLE' | 'TIMEOUT' | 'TOO_LARGE'

export type SealedConsoleResult =
    | { ok: true; status: number; headers: Record<string, string>; bodyB64: string }
    | { ok: false; code: SealedConsoleFailure }

/** The runtime Desktop configured for this PC: plain HTTP on the loopback address, nothing else. */
function runtimePort(runtimeUrl: string | undefined): number | undefined {
    if (!runtimeUrl) return undefined
    try {
        const url = new URL(runtimeUrl)
        const port = Number(url.port)
        return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number.isInteger(port) && port > 0 ? port : undefined
    } catch {
        return undefined
    }
}

/** The remote page console document, or one of its operations — the only two things it fetches. */
function allowedTarget(method: string, path: string): string | undefined {
    if (!path.startsWith('/') || path.startsWith('//')) return undefined
    const url = new URL(path, 'http://runtime')
    if (url.origin !== 'http://runtime') return undefined
    if (method === 'GET' && url.pathname === '/console' && url.searchParams.get('remotePage') === '1') return url.pathname + url.search
    if (method === 'POST' && /^\/v1\/ops\/[A-Za-z]+$/.test(url.pathname) && url.search === '') return url.pathname
    return undefined
}

function pick<K extends string>(headers: Record<string, string | string[]> | undefined, names: readonly K[]): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers ?? {})) {
        const lower = name.toLowerCase() as K
        if (names.includes(lower) && typeof value === 'string') out[lower] = value
    }
    return out
}

export async function forwardSealedConsoleRequest(params: unknown, runtimeUrl: string | undefined): Promise<SealedConsoleResult> {
    const parsed = consoleRequest.safeParse(params)
    if (!parsed.success) return { ok: false, code: 'INVALID_REQUEST' }
    const { method, path, headers, bodyB64 } = parsed.data
    const target = allowedTarget(method, path)
    if (!target) return { ok: false, code: 'PATH_NOT_ALLOWED' }
    const port = runtimePort(runtimeUrl)
    if (!port) return { ok: false, code: 'RUNTIME_UNAVAILABLE' }
    try {
        const response = await proxyHttp(
            { port, method, path: target, headers: pick(headers, REQUEST_HEADERS), bodyB64: method === 'POST' ? bodyB64 ?? null : null },
            { timeoutMs: TIMEOUT_MS, maxBodyBytes: MAX_RESPONSE_BODY_BYTES },
        )
        // A cut-off page or frame is worse than none: the console would act on half a document.
        if (response.truncated) return { ok: false, code: 'TOO_LARGE' }
        return { ok: true, status: response.status, headers: pick(response.headers, RESPONSE_HEADERS), bodyB64: response.bodyB64 }
    } catch (error) {
        return { ok: false, code: error instanceof PreviewProxyError && error.code === 'TIMEOUT' ? 'TIMEOUT' : 'RUNTIME_UNREACHABLE' }
    }
}
