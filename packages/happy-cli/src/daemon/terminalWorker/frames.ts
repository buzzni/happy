/**
 * Frames on the terminal worker socket (specs/terminal-survive-runner-restart HR5): a 4-byte
 * big-endian length, then UTF-8 JSON. The frame format belongs to the frozen envelope — every
 * worker protocol version keeps it, so any daemon can at least ask any worker to shut down.
 */
import type { Socket } from 'node:net'

const FRAME_HEADER_BYTES = 4
export const MAX_TERMINAL_WORKER_FRAME_BYTES = 16 * 1024 * 1024

export class TerminalWorkerFrameError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'TerminalWorkerFrameError'
    }
}

export function encodeFrame(value: unknown): Buffer {
    const payload = Buffer.from(JSON.stringify(value), 'utf8')
    if (payload.length > MAX_TERMINAL_WORKER_FRAME_BYTES) {
        throw new TerminalWorkerFrameError(`Terminal worker frame of ${payload.length} bytes is too large`)
    }
    const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES)
    header.writeUInt32BE(payload.length, 0)
    return Buffer.concat([header, payload])
}

/** Reassembles frames from arbitrary chunks. Throws on a frame that is too large or not JSON. */
export class FrameDecoder {
    private buffered: Buffer = Buffer.alloc(0)

    push(chunk: Buffer): unknown[] {
        this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk])
        const messages: unknown[] = []
        while (this.buffered.length >= FRAME_HEADER_BYTES) {
            const length = this.buffered.readUInt32BE(0)
            if (length > MAX_TERMINAL_WORKER_FRAME_BYTES) {
                throw new TerminalWorkerFrameError(`Terminal worker frame of ${length} bytes is too large`)
            }
            const end = FRAME_HEADER_BYTES + length
            if (this.buffered.length < end) break
            const text = this.buffered.subarray(FRAME_HEADER_BYTES, end).toString('utf8')
            this.buffered = this.buffered.subarray(end)
            try {
                messages.push(JSON.parse(text))
            } catch {
                throw new TerminalWorkerFrameError('Terminal worker frame is not JSON')
            }
        }
        return messages
    }
}

export interface FramedSocket {
    readonly socket: Socket
    /** False when the socket is gone or the message cannot be framed. */
    send(message: unknown): boolean
    close(): void
}

/**
 * Wraps a connected socket in frames. A malformed frame destroys the socket: the peer is either
 * not a terminal worker endpoint or corrupt, and both end the connection.
 */
export function attachFramedSocket(socket: Socket, onMessage: (message: unknown) => void): FramedSocket {
    const decoder = new FrameDecoder()
    socket.on('data', (chunk: Buffer) => {
        let messages: unknown[]
        try {
            messages = decoder.push(chunk)
        } catch (error) {
            socket.destroy(error instanceof Error ? error : new Error(String(error)))
            return
        }
        for (const message of messages) {
            if (socket.destroyed) return
            onMessage(message)
        }
    })
    return {
        socket,
        send(message) {
            if (socket.destroyed || !socket.writable) return false
            let frame: Buffer
            try {
                frame = encodeFrame(message)
            } catch {
                return false
            }
            socket.write(frame)
            return true
        },
        close() {
            socket.end(() => socket.destroy())
        },
    }
}
