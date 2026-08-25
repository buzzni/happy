import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

export interface BrowserCdpPipe {
    request<T>(method: string, params?: Record<string, unknown>): Promise<T>
    close(): void
}

interface PendingRequest {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
}

/** Chromium's --remote-debugging-pipe protocol: JSON messages separated by NUL. */
export function createBrowserCdpPipe(input: Writable, output: Readable): BrowserCdpPipe {
    let nextId = 1
    let buffer = ''
    let closed = false
    const decoder = new StringDecoder('utf8')
    const pending = new Map<number, PendingRequest>()

    const rejectAll = (error: Error) => {
        for (const request of pending.values()) {
            clearTimeout(request.timer)
            request.reject(error)
        }
        pending.clear()
    }

    const closeStreams = () => {
        input.destroy()
        output.destroy()
    }

    output.on('data', (chunk) => {
        buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        for (let separator = buffer.indexOf('\0'); separator >= 0; separator = buffer.indexOf('\0')) {
            const frame = buffer.slice(0, separator)
            buffer = buffer.slice(separator + 1)
            if (!frame) continue
            try {
                const message = JSON.parse(frame) as {
                    id?: number
                    result?: unknown
                    error?: { message?: string }
                }
                if (message.id === undefined) continue
                const request = pending.get(message.id)
                if (!request) continue
                pending.delete(message.id)
                clearTimeout(request.timer)
                if (message.error) {
                    request.reject(new Error(message.error.message ?? 'Chrome CDP pipe request failed'))
                } else {
                    request.resolve(message.result)
                }
            } catch {
                // Ignore events or malformed frames that are not our reply.
            }
        }
    })

    const fail = () => {
        if (closed) return
        closed = true
        rejectAll(new Error('Chrome CDP pipe closed'))
        closeStreams()
    }
    input.on('error', fail)
    output.on('error', fail)
    output.on('end', fail)
    output.on('close', fail)

    return {
        request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
            if (closed) return Promise.reject(new Error('Chrome CDP pipe is closed'))
            const id = nextId++
            return new Promise<T>((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id)
                    reject(new Error(`Chrome CDP pipe request timed out: ${method}`))
                }, 10_000)
                pending.set(id, {
                    resolve: (value) => resolve(value as T),
                    reject,
                    timer,
                })
                try {
                    input.write(`${JSON.stringify({ id, method, params })}\0`)
                } catch (error) {
                    clearTimeout(timer)
                    pending.delete(id)
                    reject(error instanceof Error ? error : new Error(String(error)))
                }
            })
        },
        close() {
            if (closed) return
            closed = true
            rejectAll(new Error('Chrome CDP pipe closed'))
            closeStreams()
        },
    }
}
