/**
 * Bridge between happy sessions and the Chrome extension controlling the
 * user's logged-in browser (specs/chrome-extension-bridge/).
 *
 * The extension's MV3 service worker connects over a WebSocket — loopback by
 * default, or a remote host when HAPPY_BROWSER_BRIDGE_HOST opts in
 * (browserBridgeServer.ts) — and answers JSON-RPC-style requests:
 *
 *   daemon → extension  { id, method, params }
 *   extension → daemon  { id, result } | { id, error: { code, message } }
 *   extension → daemon  { type: 'ping' }  → daemon replies { type: 'pong' }
 *                       (keepalive — WS traffic keeps the service worker alive)
 *
 * Pure of any specific socket library — the caller hands in a socket with
 * send/close/on, so this stays unit-testable (same pattern as PreviewWsProxy).
 */

import { timingSafeEqual } from 'node:crypto'

export interface BridgeSocket {
    send(data: string): void
    close(code?: number, reason?: string): void
    on(event: 'message', handler: (data: { toString(): string }) => void): void
    on(event: 'close', handler: () => void): void
}

export interface BridgeConnectionParams {
    token?: string
    profile?: string
}

export class BridgeRequestError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message)
        this.name = 'BridgeRequestError'
    }
}

interface PendingRequest {
    resolve: (result: unknown) => void
    reject: (error: BridgeRequestError) => void
    timer: NodeJS.Timeout
}

interface Connection {
    profile: string
    socket: BridgeSocket
    pending: Map<number, PendingRequest>
}

const DEFAULT_PROFILE = 'default'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const AUTH_FAILURE_WINDOW_MS = 60_000

/**
 * Constant-time token comparison.
 *
 * A plain `!==` was fine while the bridge only ever heard from loopback, but
 * HAPPY_BROWSER_BRIDGE_HOST (browserBridgeServer.ts) can now put it on a
 * network an attacker reaches — at which point the token is the only thing
 * standing between them and the user's browser, and a length/prefix-dependent
 * compare timing is a real (if slow) way to recover it.
 *
 * timingSafeEqual throws on a length mismatch rather than returning false, so
 * that has to be handled first — comparing against the expected token's own
 * length keeps that branch's timing independent of the *offered* token's
 * length too.
 */
function tokensMatch(offered: string, expected: string): boolean {
    const offeredBuf = Buffer.from(offered)
    const expectedBuf = Buffer.from(expected)
    if (offeredBuf.length !== expectedBuf.length) {
        // No real timing signal to protect here: this only tells an attacker
        // the token's length, which readOrCreateBrowserBridgeToken fixes at
        // 64 hex chars for every install anyway.
        return false
    }
    return timingSafeEqual(offeredBuf, expectedBuf)
}

export class BrowserBridge {
    private readonly authToken: string
    private readonly requestTimeoutMs: number
    private readonly byProfile = new Map<string, Connection>()
    private nextRequestId = 1
    private lastAuthFailureAt: number | null = null

    constructor(opts: { authToken: string; requestTimeoutMs?: number }) {
        this.authToken = opts.authToken
        this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    }

    /**
     * Register an extension connection. Returns false (and closes the socket)
     * when the token doesn't match. A reconnect for the same profile replaces
     * the previous connection — the extension is the source of truth for
     * "the live service worker".
     */
    handleConnection(socket: BridgeSocket, params: BridgeConnectionParams): boolean {
        if (!params.token || !tokensMatch(params.token, this.authToken)) {
            this.lastAuthFailureAt = Date.now()
            socket.close(4401, 'invalid token')
            return false
        }
        this.lastAuthFailureAt = null
        const profile = params.profile || DEFAULT_PROFILE

        const stale = this.byProfile.get(profile)
        if (stale) {
            this.byProfile.delete(profile)
            this.rejectAllPending(stale, new BridgeRequestError('EXTENSION_DISCONNECTED', 'replaced by a new connection'))
            stale.socket.close(4409, 'replaced by a new connection')
        }

        const connection: Connection = { profile, socket, pending: new Map() }
        this.byProfile.set(profile, connection)

        socket.on('message', (data) => this.onMessage(connection, data.toString()))
        socket.on('close', () => {
            if (this.byProfile.get(profile) === connection) {
                this.byProfile.delete(profile)
            }
            this.rejectAllPending(connection, new BridgeRequestError('EXTENSION_DISCONNECTED', 'extension disconnected'))
        })
        return true
    }

    /** Connected extensions (introspection / status endpoint). */
    connections(): Array<{ profile: string }> {
        return Array.from(this.byProfile.keys()).map(profile => ({ profile }))
    }

    /**
     * True when a connection attempt was rejected for a bad token recently.
     * A stale token (the daemon's token file was regenerated after an
     * extension paired) retries forever and fails silently otherwise —
     * connections() only reports successes, so nothing else distinguishes
     * this from "no extension has ever tried to connect".
     */
    hasRecentAuthFailure(): boolean {
        return this.lastAuthFailureAt !== null && Date.now() - this.lastAuthFailureAt < AUTH_FAILURE_WINDOW_MS
    }

    /**
     * Send a command to the extension and await its response. Targets the
     * given profile, or the only connected one when unspecified.
     *
     * Deliberately refuses to choose when several profiles are connected. The
     * previous behaviour (first-inserted wins) sent every command to whichever
     * Chrome profile happened to pair first — including one with no open
     * windows, which answers `capabilities` happily and then reports zero tabs
     * forever. A named error the caller can act on beats a silent wrong target.
     */
    request(method: string, params: unknown, opts: { timeoutMs?: number; profile?: string } = {}): Promise<unknown> {
        if (!opts.profile && this.byProfile.size > 1) {
            const names = Array.from(this.byProfile.keys()).join(', ')
            return Promise.reject(new BridgeRequestError(
                'AMBIGUOUS_PROFILE',
                `${this.byProfile.size} Chrome profiles are connected (${names}) — pass profile to choose one`
            ))
        }
        const connection = opts.profile
            ? this.byProfile.get(opts.profile)
            : this.byProfile.values().next().value
        if (!connection) {
            // Naming what *is* connected turns "nothing is connected" (false,
            // and unactionable, when the caller simply named the wrong
            // profile) into something the caller can correct on its own.
            const connected = Array.from(this.byProfile.keys())
            const detail = opts.profile && connected.length > 0
                ? `no Chrome extension is connected for profile "${opts.profile}" (connected: ${connected.join(', ')})`
                : 'no Chrome extension is connected to the bridge'
            return Promise.reject(new BridgeRequestError('NO_EXTENSION_CONNECTED', detail))
        }

        const id = this.nextRequestId++
        const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                connection.pending.delete(id)
                reject(new BridgeRequestError('TIMEOUT', `extension did not respond within ${timeoutMs}ms`))
            }, timeoutMs)
            connection.pending.set(id, { resolve, reject, timer })
            connection.socket.send(JSON.stringify({ id, method, params }))
        })
    }

    private onMessage(connection: Connection, raw: string): void {
        let message: any
        try {
            message = JSON.parse(raw)
        } catch {
            return
        }
        if (message?.type === 'ping') {
            connection.socket.send(JSON.stringify({ type: 'pong' }))
            return
        }
        if (typeof message?.id !== 'number') return
        const pending = connection.pending.get(message.id)
        if (!pending) return
        connection.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) {
            pending.reject(new BridgeRequestError(
                typeof message.error.code === 'string' ? message.error.code : 'EXTENSION_ERROR',
                typeof message.error.message === 'string' ? message.error.message : 'extension reported an error'
            ))
        } else {
            pending.resolve(message.result)
        }
    }

    private rejectAllPending(connection: Connection, error: BridgeRequestError): void {
        for (const pending of connection.pending.values()) {
            clearTimeout(pending.timer)
            pending.reject(error)
        }
        connection.pending.clear()
    }
}
