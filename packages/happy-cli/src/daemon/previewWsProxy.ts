/**
 * Raw TCP tunnel for remote preview WebSocket upgrades.
 *
 * Counterpart to happy-server's previewWebSocketRelay. The buffered
 * `proxy-http-request` path (previewProxy.ts) cannot carry a WebSocket, so this
 * opens a raw `net` socket to `127.0.0.1:{port}` and pipes bytes verbatim in
 * both directions over the daemon's Socket.IO connection:
 *
 *   server 'proxy-ws-open'  { tunnelId, port, dataB64 }  → connect + write handshake bytes
 *   server 'proxy-ws-data'  { tunnelId, dataB64 }        → write to upstream
 *   server 'proxy-ws-close' { tunnelId }                 → destroy upstream
 *   upstream 'data'   → emit 'proxy-ws-data'  { tunnelId, dataB64 }
 *   upstream 'close'  → emit 'proxy-ws-close' { tunnelId }
 *
 * The upstream (e.g. websockify) performs the actual WebSocket handshake with
 * the browser end-to-end; this side only moves bytes, so it is protocol
 * agnostic (works for VNC/noVNC, Vite HMR, plain ws, etc.).
 *
 * Pure of any specific socket library — the caller passes an `emit` function so
 * this stays unit-testable and decoupled from apiMachine's Socket.IO client.
 */

import net from 'node:net'
import { Buffer } from 'node:buffer'

export const DEFAULT_PORT_MIN = 1024
export const DEFAULT_PORT_MAX = 65535

export interface PreviewWsEmitter {
    emit(event: 'proxy-ws-data', payload: { tunnelId: string; dataB64: string }): void
    emit(event: 'proxy-ws-close', payload: { tunnelId: string }): void
}

export interface OpenTunnelParams {
    tunnelId: string
    port: number
    dataB64: string
}

export interface OpenTunnelAck {
    ok: boolean
    code?: string
    message?: string
}

export interface PreviewWsProxyOptions {
    portMin?: number
    portMax?: number
    connectTimeoutMs?: number
    logger?: { debug: (msg: string) => void }
    onActivity?: (port: number) => void
}

/**
 * Manages the set of live raw-TCP tunnels on the daemon. One instance is wired
 * to the daemon's server socket; it survives reconnects by being reset on
 * disconnect (call `closeAll`).
 */
export class PreviewWsProxy {
    private readonly tunnels = new Map<string, { socket: net.Socket; port: number }>()
    private readonly portMin: number
    private readonly portMax: number
    private readonly connectTimeoutMs: number
    private readonly logger?: { debug: (msg: string) => void }
    private readonly onActivity?: (port: number) => void

    constructor(private readonly emitter: PreviewWsEmitter, opts: PreviewWsProxyOptions = {}) {
        this.portMin = opts.portMin ?? DEFAULT_PORT_MIN
        this.portMax = opts.portMax ?? DEFAULT_PORT_MAX
        this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000
        this.logger = opts.logger
        this.onActivity = opts.onActivity
    }

    /**
     * Open a tunnel to 127.0.0.1:{port} and replay the serialized upgrade
     * request bytes. Resolves the ack once connected (or on failure). Bytes
     * from the upstream are streamed back via the emitter.
     */
    open(params: OpenTunnelParams): Promise<OpenTunnelAck> {
        const { tunnelId, port, dataB64 } = params ?? ({} as OpenTunnelParams)
        if (!tunnelId || typeof tunnelId !== 'string') {
            return Promise.resolve({ ok: false, code: 'INVALID_TUNNEL', message: 'Missing tunnelId' })
        }
        if (!Number.isInteger(port) || port < this.portMin || port > this.portMax) {
            return Promise.resolve({ ok: false, code: 'INVALID_PORT', message: `Port out of range: ${port}` })
        }
        // A duplicate tunnelId should never happen (server uses UUIDs); if it
        // does, tear the stale one down rather than leak it.
        this.close(tunnelId)

        return new Promise<OpenTunnelAck>((resolve) => {
            let settled = false
            const settle = (ack: OpenTunnelAck) => {
                if (settled) return
                settled = true
                resolve(ack)
            }

            const upstream = net.connect({ host: '127.0.0.1', port })
            const timer = setTimeout(() => {
                upstream.destroy()
                settle({ ok: false, code: 'TIMEOUT', message: `Upstream connect timed out after ${this.connectTimeoutMs}ms` })
            }, this.connectTimeoutMs)

            upstream.once('connect', () => {
                clearTimeout(timer)
                this.tunnels.set(tunnelId, { socket: upstream, port })
                this.onActivity?.(port)
                const initial = dataB64 ? Buffer.from(dataB64, 'base64') : null
                if (initial && initial.length > 0) upstream.write(initial)
                this.logger?.debug(`[preview-ws] tunnel ${tunnelId} open → 127.0.0.1:${port}`)
                settle({ ok: true })
            })

            upstream.on('data', (chunk: Buffer) => {
                this.emitter.emit('proxy-ws-data', { tunnelId, dataB64: chunk.toString('base64') })
            })

            upstream.on('close', () => {
                clearTimeout(timer)
                if (this.tunnels.delete(tunnelId)) {
                    this.emitter.emit('proxy-ws-close', { tunnelId })
                }
            })

            upstream.once('error', (err: NodeJS.ErrnoException) => {
                clearTimeout(timer)
                const code = err.code === 'ECONNREFUSED' ? 'CONNECTION_REFUSED' : 'UPSTREAM_ERROR'
                this.logger?.debug(`[preview-ws] tunnel ${tunnelId} error: ${code} ${err.message}`)
                // Don't delete the tunnel here — the 'close' event always follows
                // 'error' on a net socket, and its handler owns teardown + the
                // 'proxy-ws-close' notify. Deleting now would make that emit a
                // no-op and leak the browser socket on a mid-stream error.
                // Pre-connect errors resolve the ack; post-connect they're a
                // no-op settle and 'close' notifies the server.
                settle({ ok: false, code, message: err.message })
            })
        })
    }

    /** Write browser→upstream bytes for an existing tunnel. */
    data(payload: { tunnelId: string; dataB64: string }): void {
        const tunnel = this.tunnels.get(payload?.tunnelId)
        if (tunnel && tunnel.socket.writable && payload.dataB64) {
            this.onActivity?.(tunnel.port)
            tunnel.socket.write(Buffer.from(payload.dataB64, 'base64'))
        }
    }

    /** Close a single tunnel (server-initiated or on error). */
    close(tunnelId: string): void {
        const tunnel = this.tunnels.get(tunnelId)
        if (tunnel) {
            this.tunnels.delete(tunnelId)
            tunnel.socket.destroy()
        }
    }

    /** Tear down every tunnel — call on daemon socket disconnect. */
    closeAll(): void {
        for (const { socket } of this.tunnels.values()) socket.destroy()
        this.tunnels.clear()
    }

    /** Number of live tunnels (test/introspection). */
    get size(): number {
        return this.tunnels.size
    }
}
