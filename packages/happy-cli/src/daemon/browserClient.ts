/**
 * Session-side client for the Chrome extension bridge.
 *
 * Talks to the daemon's `/browser/request` route (controlServer.ts), which
 * relays to the extension. Kept separate from controlClient's `daemonPost`
 * because the browser tools need the structured `code` — "no extension
 * connected" must read differently to the agent than "the tab is gone".
 */

import { readDaemonState } from '@/persistence'
import { logger } from '@/ui/logger'

export class BrowserClientError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message)
        this.name = 'BrowserClientError'
    }
}

const DEFAULT_TIMEOUT_MS = 35_000

export async function requestBrowser({ port, method, params, timeoutMs, profile }: {
    port: number
    method: string
    params?: unknown
    timeoutMs?: number
    profile?: string
}): Promise<unknown> {
    let response: Response
    try {
        response = await fetch(`http://127.0.0.1:${port}/browser/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method, params: params ?? {}, timeoutMs, profile }),
            signal: AbortSignal.timeout(timeoutMs ? timeoutMs + 5_000 : DEFAULT_TIMEOUT_MS),
        })
    } catch (e) {
        throw new BrowserClientError('DAEMON_UNREACHABLE', `Could not reach the happy daemon on 127.0.0.1:${port}: ${e instanceof Error ? e.message : String(e)}`)
    }

    if (response.status === 404) {
        throw new BrowserClientError('BRIDGE_UNAVAILABLE', 'This daemon has no browser bridge — restart it with a happy-cli build that includes browser support.')
    }

    const body = await response.json().catch(() => ({})) as { result?: unknown; code?: string; error?: string }
    if (!response.ok) {
        throw new BrowserClientError(body.code ?? 'BROWSER_REQUEST_FAILED', body.error ?? `Browser request failed with HTTP ${response.status}`)
    }
    return body.result
}

/** Resolve the running daemon's control port, or null when no daemon is up. */
export async function readDaemonControlPort(): Promise<number | null> {
    const state = await readDaemonState()
    if (!state?.httpPort) {
        logger.debug('[BROWSER CLIENT] No daemon state file; browser tools unavailable')
        return null
    }
    return state.httpPort
}
