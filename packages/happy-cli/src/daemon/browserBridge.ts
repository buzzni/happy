/**
 * Bridge between happy sessions and the Chrome extension controlling the
 * user's logged-in browser (specs/chrome-extension-bridge/).
 *
 * The extension's MV3 service worker connects over a loopback WebSocket and
 * answers JSON-RPC-style requests:
 *
 *   daemon → extension  { id, method, params }
 *   extension → daemon  { id, result } | { id, error: { code, message } }
 *   extension → daemon  { type: 'ping' }  → daemon replies { type: 'pong' }
 *                       (keepalive — WS traffic keeps the service worker alive)
 *
 * Pure of any specific socket library — the caller hands in a socket with
 * send/close/on, so this stays unit-testable (same pattern as PreviewWsProxy).
 */

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

export class BrowserBridge {
    private readonly authToken: string
    private readonly requestTimeoutMs: number
    private readonly byProfile = new Map<string, Connection>()
    private nextRequestId = 1

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
        if (!params.token || params.token !== this.authToken) {
            socket.close(4401, 'invalid token')
            return false
        }
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
     * Send a command to the extension and await its response. Targets the
     * given profile, or the only connected one when unspecified.
     */
    request(method: string, params: unknown, opts: { timeoutMs?: number; profile?: string } = {}): Promise<unknown> {
        const connection = opts.profile
            ? this.byProfile.get(opts.profile)
            : this.byProfile.values().next().value
        if (!connection) {
            return Promise.reject(new BridgeRequestError('NO_EXTENSION_CONNECTED', 'no Chrome extension is connected to the bridge'))
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
