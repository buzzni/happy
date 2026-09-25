/**
 * Runtime viewer (D2): the Runtime is the RFB endpoint between the human
 * viewer and the browser container's x11vnc. Human input reaches the browser
 * only through here, and only while the viewer's capability owns the profile's
 * takeover lease.
 *
 * Per connection there are two independent RFB sessions: an RFB 3.8 server
 * for the viewer (security None; the one-time ticket authenticated the
 * WebSocket) and an RFB client of x11vnc (VNC authentication with the per-run
 * password, shared). Viewer messages are parsed and re-decided one by one:
 * display messages pass, input passes only under control. Server messages are
 * framed and length-checked by rfb.ts before they reach the viewer.
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { connect as connectTcp, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import { assertOperation } from './auth'
import { BrowserRuntimeError, VIEWER_LIMITS, type AuthContext, type InputOwner, type InteractiveCapability, type ProfileId, type TabId,
    type ViewerTicket, type ViewerTicketRequest } from './contracts'
import { ALLOWED_ENCODINGS, StreamFramer, clientParser, keyEvent, pointerEvent, serverInitMessage, setEncodingsMessage, upstreamParser,
    type ClientMessage, type RfbSession, type ServerInit } from './rfb'

export const VIEWER_WEBSOCKET_PATH = '/v1/viewer/websockify'
const DESKTOP_NAME = 'Agent Browser'
const HANDSHAKE_TIMEOUT_MS = 10_000
const LIVENESS_CHECK_MS = 1_000
const MAX_CONNECTIONS = 16
/** A viewer frame may hold a whole 64 KiB cut text plus headers; nothing larger is ever needed. */
const MAX_WEBSOCKET_MESSAGE_BYTES = 256 * 1024
const MAX_VIEWER_BACKLOG_BYTES = 256 * 1024
const MAX_UPSTREAM_BACKLOG_BYTES = 1024 * 1024
const MAX_UPSTREAM_HEADER_BACKLOG_BYTES = 1024 * 1024
const MAX_HELD_SERVER_BYTES = 4 * 1024 * 1024
const WEBSOCKET_HIGH_WATER_BYTES = 8 * 1024 * 1024
const WEBSOCKET_LOW_WATER_BYTES = 1024 * 1024
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** Close codes: protocol violation, upstream failure, capability expired/revoked. */
const CLOSE_POLICY = 1008
const CLOSE_UPSTREAM = 1011
const CLOSE_CAPABILITY = 4001

export interface ViewerEndpoint { host: string; port: number }

/** The part of InputLeaseManager the viewer reads. */
export interface ViewerLeaseView {
    userControl(profileId: ProfileId): { tabs: Array<{ tabId: TabId; leaseEpoch: number; owner: Extract<InputOwner, { kind: 'user' }> }>; settling: boolean }
    subscribe(listener: () => void): () => void
}

export interface ViewerProxyOptions {
    leases: ViewerLeaseView
    /** x11vnc of the profile's browser container, on the profile network. */
    endpoint(profileId: ProfileId): ViewerEndpoint | undefined
    /** Per-run x11vnc password (VNC authentication, at most 8 characters). */
    vncPassword: string
    /** Expiry and revocation, checked again on every input and every second. */
    isCapabilityLive(capability: InteractiveCapability): boolean
    /** Tunnel origins allowed besides the Runtime's own loopback origin. */
    allowedOrigins: readonly string[]
    now?: () => number
    log?: (line: string) => void
    /** Tests only: how to reach the endpoint. */
    connectUpstream?: (endpoint: ViewerEndpoint) => Socket
}

interface TicketEntry { capability: InteractiveCapability; profileId: ProfileId; expiresAtMs: number }

export class ViewerProxy {
    private readonly tickets = new Map<string, TicketEntry>()
    private readonly connections = new Set<ViewerConnection>()
    private readonly webSockets = new WebSocketServer({
        noServer: true, maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES, perMessageDeflate: false,
        handleProtocols: (protocols) => protocols.has('binary') ? 'binary' : false,
    })
    private readonly now: () => number

    constructor(private readonly options: ViewerProxyOptions) {
        this.now = options.now ?? Date.now
    }

    /** `GET /v1/viewer/websockify?ticket=` upgrade. The ticket is spent even when the request is refused. */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
        const refuse = (status: number, text: string) => {
            socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
        }
        const ticket = new URL(req.url ?? '/', 'http://localhost').searchParams.get('ticket')
        const granted = ticket ? this.consumeTicket(ticket) : undefined
        if (!this.originAllowed(req)) return refuse(403, 'Forbidden')
        if (!granted) return refuse(401, 'Unauthorized')
        const endpoint = this.options.endpoint(granted.profileId)
        if (!endpoint || this.connections.size >= MAX_CONNECTIONS) return refuse(503, 'Service Unavailable')
        this.webSockets.handleUpgrade(req, socket, head, (ws) => {
            const connection = new ViewerConnection(ws, granted.capability, granted.profileId, endpoint, this.options,
                () => this.connections.delete(connection))
            this.connections.add(connection)
        })
    }

    async close(): Promise<void> {
        for (const connection of [...this.connections]) connection.close(1001, 'runtime stopping')
        await new Promise<void>((resolve) => this.webSockets.close(() => resolve()))
    }

    /**
     * The tunnel origins from the configuration, or the Runtime's own origin
     * when reached on a loopback address: a DNS-rebound name never passes.
     */
    private originAllowed(req: IncomingMessage): boolean {
        const origin = req.headers.origin
        if (!origin) return false
        if (this.options.allowedOrigins.includes(origin)) return true
        const host = req.headers.host
        if (!host) return false
        try {
            return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname) && origin === `http://${host}`
        } catch {
            return false
        }
    }

    issueTicket(auth: AuthContext, req: ViewerTicketRequest): ViewerTicket {
        assertOperation(auth, 'viewerTicket', { profileId: req.profileId })
        const capability = auth.credential
        if (capability.kind !== 'interactive') throw new BrowserRuntimeError('SCOPE_DENIED', 'Viewer tickets need an interactive capability')
        if (!this.options.isCapabilityLive(capability)) throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential has expired or been revoked')
        if (!this.options.endpoint(req.profileId)) throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'No viewer is configured for profile')
        this.sweepTickets()
        if (this.tickets.size >= VIEWER_LIMITS.maxOutstandingTickets) throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'Too many outstanding viewer tickets', true)
        const ticket = randomBytes(32).toString('base64url')
        const expiresAtMs = Math.min(this.now() + VIEWER_LIMITS.ticketTtlMs, capability.expiresAtMs)
        this.tickets.set(ticket, { capability, profileId: req.profileId, expiresAtMs })
        return { ticket, expiresAtMs }
    }

    /** One use only: the ticket is gone whether or not it is still valid. */
    consumeTicket(ticket: string): { capability: InteractiveCapability; profileId: ProfileId } | undefined {
        const entry = this.tickets.get(ticket)
        this.tickets.delete(ticket)
        if (!entry || entry.expiresAtMs <= this.now() || !this.options.isCapabilityLive(entry.capability)) return undefined
        return { capability: entry.capability, profileId: entry.profileId }
    }

    private sweepTickets(): void {
        const now = this.now()
        for (const [ticket, entry] of this.tickets) if (entry.expiresAtMs <= now) this.tickets.delete(ticket)
    }
}

/** One viewer WebSocket and its own x11vnc session. */
class ViewerConnection {
    private readonly session: RfbSession = { width: 0, height: 0, bytesPerPixel: 0, encodings: new Set() }
    private readonly upstream: Socket
    private readonly upstreamFramer: StreamFramer
    private viewerFramer: StreamFramer | undefined
    private readonly earlyViewerBytes: Buffer[] = []
    private earlyViewerLength = 0
    private viewerReady = false
    private readonly heldForViewer: Buffer[] = []
    private heldForViewerLength = 0
    private upstreamOpen = false
    /** Writes waiting for the upstream to drain; input entries are dropped when control is lost. */
    private readonly pendingUpstream: Array<{ bytes: Buffer; input: boolean }> = []
    private pendingUpstreamLength = 0
    private upstreamPaused = false
    private readonly heldKeys = new Set<number>()
    private buttonMask = 0
    private pointer = { x: 0, y: 0 }
    /** The lease (tab@epoch list) this connection's input is bound to; undefined without control. */
    private boundControl: string | undefined
    private closed = false
    private readonly timers: NodeJS.Timeout[] = []
    private readonly unsubscribe: () => void
    private readonly log: (line: string) => void

    constructor(private readonly ws: WebSocket, private readonly capability: InteractiveCapability, private readonly profileId: ProfileId,
        endpoint: ViewerEndpoint, private readonly options: ViewerProxyOptions, private readonly onClosed: () => void) {
        this.log = options.log ?? (() => undefined)
        this.upstream = options.connectUpstream?.(endpoint) ?? connectTcp({ host: endpoint.host, port: endpoint.port })
        this.upstream.setNoDelay(true)
        this.upstreamFramer = new StreamFramer(upstreamParser(this.session, {
            password: options.vncPassword,
            send: (bytes) => { this.upstream.write(bytes) },
            onServerInit: (init) => this.onUpstreamReady(init),
        }), (bytes) => this.toViewer(bytes), MAX_UPSTREAM_HEADER_BACKLOG_BYTES)
        this.upstream.on('data', (chunk: Buffer) => this.guard(CLOSE_UPSTREAM, 'browser display protocol error', () => this.upstreamFramer.push(chunk)))
        this.upstream.on('drain', () => this.flushUpstream())
        this.upstream.on('error', () => this.close(CLOSE_UPSTREAM, 'browser display unavailable'))
        this.upstream.on('close', () => this.close(CLOSE_UPSTREAM, 'browser display unavailable'))
        ws.on('message', (data: Buffer, isBinary: boolean) => this.guard(CLOSE_POLICY, 'protocol error', () => this.fromViewer(data, isBinary)))
        ws.on('close', () => this.close())
        ws.on('error', () => this.close())
        const now = options.now ?? Date.now
        this.timers.push(
            setTimeout(() => { if (!this.viewerReady) this.close(CLOSE_POLICY, 'handshake timeout') }, HANDSHAKE_TIMEOUT_MS),
            setTimeout(() => this.close(CLOSE_CAPABILITY, 'capability expired'), Math.min(Math.max(0, capability.expiresAtMs - now()), 2 ** 31 - 1)),
            setInterval(() => { if (!options.isCapabilityLive(capability)) this.close(CLOSE_CAPABILITY, 'capability no longer valid') }, LIVENESS_CHECK_MS),
        )
        this.unsubscribe = options.leases.subscribe(() => this.checkControl())
    }

    close(code = 1000, reason = ''): void {
        if (this.closed) return
        // What this viewer holds is released before the upstream goes away.
        this.releaseInput()
        this.closed = true
        for (const timer of this.timers) clearTimeout(timer)
        this.unsubscribe()
        if (this.upstream.writable) {
            for (const { bytes } of this.pendingUpstream.splice(0)) this.upstream.write(bytes)
            this.upstream.end()
        }
        setTimeout(() => this.upstream.destroy(), 2_000).unref()
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(code, reason)
        this.log(`[viewer] profile=${this.profileId} closed code=${code}${reason ? ` reason=${reason}` : ''}`)
        this.onClosed()
    }

    private guard(code: number, reason: string, action: () => void): void {
        if (this.closed) return
        try {
            action()
        } catch {
            this.close(code, reason)
        }
    }

    private fromViewer(data: Buffer, isBinary: boolean): void {
        if (!isBinary) throw new Error('text frame')
        if (this.viewerFramer) return this.viewerFramer.push(data)
        // The viewer may not speak before the Runtime has, but a bounded amount is tolerated.
        this.earlyViewerBytes.push(data)
        this.earlyViewerLength += data.length
        if (this.earlyViewerLength > MAX_VIEWER_BACKLOG_BYTES) throw new Error('viewer backlog')
    }

    private onUpstreamReady(init: ServerInit): void {
        this.upstreamOpen = true
        this.viewerFramer = new StreamFramer(clientParser({
            send: (bytes) => this.sendViewer(bytes),
            serverInit: serverInitMessage(init, DESKTOP_NAME),
            onReady: () => {
                this.viewerReady = true
                for (const bytes of this.heldForViewer.splice(0)) this.sendViewer(bytes)
            },
            onMessage: (message) => this.onViewerMessage(message),
        }), () => undefined, MAX_VIEWER_BACKLOG_BYTES)
        for (const bytes of this.earlyViewerBytes.splice(0)) this.viewerFramer.push(bytes)
    }

    private onViewerMessage(message: ClientMessage): void {
        switch (message.kind) {
            case 'setPixelFormat':
                this.session.bytesPerPixel = message.bytesPerPixel
                return this.writeUpstream(message.bytes, false)
            case 'setEncodings': {
                const encodings = message.encodings.filter((encoding) => ALLOWED_ENCODINGS.has(encoding))
                for (const encoding of encodings) this.session.encodings.add(encoding)
                return this.writeUpstream(setEncodingsMessage(encodings), false)
            }
            case 'framebufferUpdateRequest':
                return this.writeUpstream(message.bytes, false)
            case 'key':
                if (!this.hasControl()) return
                if (message.down) this.heldKeys.add(message.keysym)
                else this.heldKeys.delete(message.keysym)
                return this.writeUpstream(message.bytes, true)
            case 'pointer':
                if (!this.hasControl()) return
                this.buttonMask = message.buttonMask
                this.pointer = { x: message.x, y: message.y }
                return this.writeUpstream(message.bytes, true)
            case 'cutText':
                if (!this.hasControl()) return
                return this.writeUpstream(message.bytes, true)
        }
    }

    private hasControl(): boolean {
        if (!this.options.isCapabilityLive(this.capability)) {
            this.close(CLOSE_CAPABILITY, 'capability no longer valid')
            return false
        }
        return this.checkControl()
    }

    /**
     * Input is allowed while every user-owned tab of the profile belongs to
     * this capability's viewer and no takeover is settling. Any change of that
     * lease (release, new epoch, another owner) first releases what was held.
     */
    private checkControl(): boolean {
        if (this.closed) return false
        const { tabs, settling } = this.options.leases.userControl(this.profileId)
        const mine = !settling && tabs.length > 0 && tabs.every(({ owner }) =>
            owner.principalId === this.capability.principalId && owner.viewerSessionId === this.capability.viewerSessionId)
        const control = mine ? tabs.map(({ tabId, leaseEpoch }) => `${tabId}@${leaseEpoch}`).sort().join(',') : undefined
        if (this.boundControl !== undefined && control !== this.boundControl) this.releaseInput()
        this.boundControl = control
        return control !== undefined
    }

    /** Drops queued input and sends key-up / button-up for everything this viewer still holds. */
    private releaseInput(): void {
        for (let index = this.pendingUpstream.length - 1; index >= 0; index--) {
            if (!this.pendingUpstream[index].input) continue
            this.pendingUpstreamLength -= this.pendingUpstream[index].bytes.length
            this.pendingUpstream.splice(index, 1)
        }
        if (!this.upstreamOpen || this.closed) return
        for (const keysym of this.heldKeys) this.writeUpstream(keyEvent(false, keysym), false)
        if (this.buttonMask) this.writeUpstream(pointerEvent(0, this.pointer.x, this.pointer.y), false)
        this.heldKeys.clear()
        this.buttonMask = 0
    }

    private writeUpstream(bytes: Buffer, input: boolean): void {
        if (this.closed || !this.upstream.writable) return
        if (this.pendingUpstream.length === 0 && !this.upstream.writableNeedDrain) {
            this.upstream.write(bytes)
            return
        }
        this.pendingUpstream.push({ bytes, input })
        this.pendingUpstreamLength += bytes.length
        if (this.pendingUpstreamLength > MAX_UPSTREAM_BACKLOG_BYTES) this.close(CLOSE_UPSTREAM, 'browser display too slow')
    }

    private flushUpstream(): void {
        while (!this.closed && this.pendingUpstream.length && !this.upstream.writableNeedDrain) {
            const { bytes } = this.pendingUpstream.shift()!
            this.pendingUpstreamLength -= bytes.length
            this.upstream.write(bytes)
        }
    }

    /** Server messages wait for the viewer's handshake: x11vnc may send cut text or a bell right after ServerInit. */
    private toViewer(bytes: Buffer): void {
        if (this.viewerReady) return this.sendViewer(bytes)
        this.heldForViewer.push(bytes)
        this.heldForViewerLength += bytes.length
        if (this.heldForViewerLength > MAX_HELD_SERVER_BYTES) throw new Error('viewer handshake too slow')
    }

    private sendViewer(bytes: Buffer): void {
        if (this.ws.readyState !== WebSocket.OPEN) return
        this.ws.send(bytes, { binary: true }, () => {
            if (this.upstreamPaused && this.ws.bufferedAmount < WEBSOCKET_LOW_WATER_BYTES) {
                this.upstreamPaused = false
                this.upstream.resume()
            }
        })
        if (!this.upstreamPaused && this.ws.bufferedAmount > WEBSOCKET_HIGH_WATER_BYTES) {
            this.upstreamPaused = true
            this.upstream.pause()
        }
    }
}
