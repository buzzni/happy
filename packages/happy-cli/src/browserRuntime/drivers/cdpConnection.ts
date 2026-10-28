/**
 * Minimal raw CDP client over one browser-level WebSocket or inherited pipe with flattened
 * sessions. Every command names its session explicitly; there is no notion of
 * a "current" or "active" target here.
 */
import WebSocket from 'ws'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { BrowserRuntimeError } from '../contracts'

export type CdpListener = (params: any, sessionId: string | undefined) => void

/** A protocol-level error returned by the browser for one command. */
export class CdpProtocolError extends Error {
    constructor(readonly method: string, readonly cdpCode: number, message: string) {
        super(`${method}: ${message}`)
        this.name = 'CdpProtocolError'
    }
}

interface Pending {
    method: string
    resolve: (value: any) => void
    reject: (error: Error) => void
    timer?: ReturnType<typeof setTimeout>
}

interface CdpTransport {
    on(event: string, listener: (...args: any[]) => void): unknown
    send(data: string, callback: (error?: Error) => void): void
    close(): void
}

const MAX_PAYLOAD = 256 * 1024 * 1024

/** Chromium's inherited debugging pipes use NUL-delimited UTF-8 JSON. These
 * descriptors belong to the supervisor; no TCP listener or discovery URL is made. */
class PipeTransport extends EventEmitter implements CdpTransport {
    private chunks: Buffer[] = []
    private bytes = 0
    private closed = false

    constructor(private readonly input: Writable, private readonly output: Readable, private readonly maxPayload: number) {
        super()
        output.on('data', this.receive)
        for (const stream of [input, output]) {
            stream.on('error', () => this.close())
            stream.on('close', () => this.close())
        }
        output.on('end', () => this.close())
        input.on('finish', () => this.close())
    }

    private receive = (chunk: Buffer): void => {
        if (this.closed) return
        let start = 0
        while (start < chunk.length) {
            const delimiter = chunk.indexOf(0, start)
            const end = delimiter < 0 ? chunk.length : delimiter
            const part = chunk.subarray(start, end)
            this.bytes += part.length
            if (this.bytes > this.maxPayload) { this.close(); return }
            if (part.length) this.chunks.push(part)
            if (delimiter < 0) return
            const raw = Buffer.concat(this.chunks, this.bytes).toString('utf8')
            this.chunks = []
            this.bytes = 0
            this.emit('message', raw)
            if (this.closed) return
            start = end + 1
        }
    }

    send(data: string, callback: (error?: Error) => void): void {
        if (this.closed) { callback(connectionClosedError()); return }
        try {
            this.input.write(`${data}\0`, error => {
                if (error) this.close()
                callback(error ?? undefined)
            })
        } catch {
            this.close()
            callback(connectionClosedError())
        }
    }

    close(): void {
        if (this.closed) return
        this.closed = true
        this.output.off('data', this.receive)
        this.chunks = []
        this.bytes = 0
        this.input.destroy()
        this.output.destroy()
        this.emit('close')
    }
}

export function connectionClosedError(): BrowserRuntimeError {
    return new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'browser connection closed', true, false)
}

export class CdpConnection {
    private nextId = 1
    private readonly pending = new Map<number, Pending>()
    private readonly listeners = new Map<string, Set<CdpListener>>()
    private readonly closeListeners = new Set<() => void>()
    private closedFlag = false
    /** Resolves when the socket is gone; never rejects. */
    readonly closedPromise: Promise<void>
    private resolveClosed!: () => void

    private constructor(private readonly ws: CdpTransport, private readonly timeoutMs?: number) {
        this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve })
        ws.on('message', (data) => this.onMessage(data.toString()))
        ws.on('close', () => this.onClosed())
        ws.on('error', () => this.onClosed())
    }

    /** Use only descriptors inherited from a supervisor-owned Chrome process.
     * This transport does not attest the service identity or profile storage. */
    static fromPipe(input: Writable, output: Readable, options: { timeoutMs?: number; maxPayload?: number } = {}): CdpConnection {
        const timeoutMs = options.timeoutMs ?? 10_000, maxPayload = options.maxPayload ?? MAX_PAYLOAD
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 ||
            !Number.isSafeInteger(maxPayload) || maxPayload < 1 || maxPayload > MAX_PAYLOAD) throw new Error('Invalid CDP pipe limits')
        const transport = new PipeTransport(input, output, maxPayload)
        const connection = new CdpConnection(transport, timeoutMs)
        if (input.destroyed || input.writableEnded || output.destroyed || output.readableEnded) connection.close()
        return connection
    }

    static connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: MAX_PAYLOAD })
            const timer = setTimeout(() => {
                ws.terminate()
                reject(new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'browser connection timed out', true, false))
            }, timeoutMs)
            ws.once('open', () => {
                clearTimeout(timer)
                resolve(new CdpConnection(ws))
            })
            ws.once('error', () => {
                clearTimeout(timer)
                reject(new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'browser connection failed', true, false))
            })
        })
    }

    get closed(): boolean {
        return this.closedFlag
    }

    send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
        if (this.closedFlag) return Promise.reject(connectionClosedError())
        const id = this.nextId++
        const message: Record<string, unknown> = { id, method, params }
        if (sessionId) message.sessionId = sessionId
        return new Promise<T>((resolve, reject) => {
            // Losing a pipe response makes execution unknown. Close the entire
            // connection so no later command runs through that uncertain state.
            const timer = this.timeoutMs === undefined ? undefined : setTimeout(() => this.close(), this.timeoutMs)
            this.pending.set(id, { method, resolve, reject, timer })
            this.ws.send(JSON.stringify(message), (error) => {
                if (error && this.pending.delete(id)) { clearTimeout(timer); reject(connectionClosedError()) }
            })
        })
    }

    /** Subscribe to an event on any session. Returns an unsubscribe function. */
    on(method: string, listener: CdpListener): () => void {
        let set = this.listeners.get(method)
        if (!set) {
            set = new Set()
            this.listeners.set(method, set)
        }
        set.add(listener)
        return () => { set!.delete(listener) }
    }

    onClose(listener: () => void): () => void {
        this.closeListeners.add(listener)
        return () => { this.closeListeners.delete(listener) }
    }

    close(): void {
        this.ws.close()
        this.onClosed()
    }

    private onMessage(raw: string): void {
        let message: any
        try {
            message = JSON.parse(raw)
        } catch {
            return
        }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return
        if (typeof message.id === 'number') {
            const pending = this.pending.get(message.id)
            if (!pending) return
            this.pending.delete(message.id)
            clearTimeout(pending.timer)
            if (message.error) {
                pending.reject(new CdpProtocolError(pending.method, message.error.code, message.error.message))
            } else {
                pending.resolve(message.result ?? {})
            }
            return
        }
        if (typeof message.method === 'string') {
            const set = this.listeners.get(message.method)
            if (!set) return
            for (const listener of [...set]) {
                try {
                    listener(message.params ?? {}, message.sessionId)
                } catch {
                    // A listener bug must not break the dispatch loop.
                }
            }
        }
    }

    private onClosed(): void {
        if (this.closedFlag) return
        this.closedFlag = true
        const error = this.timeoutMs === undefined ? connectionClosedError()
            : new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'browser pipe closed before command acknowledgement', false, true)
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
        this.pending.clear()
        this.resolveClosed()
        for (const listener of [...this.closeListeners]) {
            try {
                listener()
            } catch {
                // ignore
            }
        }
    }
}
