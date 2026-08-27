import { lstat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { validateViewerKey } from './remoteViewer'

export type BrowserSessionBrokerRequest =
    | { op: 'ensure'; viewerKey: string; bridgeToken: string }
    | { op: 'lookup' | 'stop' | 'touch' | 'migrate-legacy'; viewerKey: string }
    | { op: 'touch-port'; webPort: number }

export type BrowserSessionBrokerLease = {
    viewerKey: string
    webPort: number
    profileVolume: string
    ready: boolean
    lastUsedAt: number
    isolation: 'container'
}

export type BrowserSessionBrokerResponse =
    | { ok: true; lease: BrowserSessionBrokerLease | null; stopped?: boolean; migrated?: boolean }
    | { ok: false; code: string; error: string }

export function parseBrowserSessionBrokerRequest(value: unknown): BrowserSessionBrokerRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid broker request')
    const input = value as Record<string, unknown>
    if (input.op === 'touch-port') {
        if (!Number.isInteger(input.webPort) || Number(input.webPort) < 1 || Number(input.webPort) > 65_535) {
            throw new Error('invalid broker request')
        }
        return { op: input.op, webPort: Number(input.webPort) }
    }
    if (typeof input.viewerKey !== 'string' || !validateViewerKey(input.viewerKey)) {
        throw new Error('invalid broker request')
    }
    if (input.op === 'ensure') {
        if (typeof input.bridgeToken !== 'string' || input.bridgeToken.length < 16 || input.bridgeToken.length > 256) {
            throw new Error('invalid broker request')
        }
        return { op: input.op, viewerKey: input.viewerKey, bridgeToken: input.bridgeToken }
    }
    if (['lookup', 'stop', 'touch', 'migrate-legacy'].includes(String(input.op))) {
        return { op: input.op as 'lookup' | 'stop' | 'touch' | 'migrate-legacy', viewerKey: input.viewerKey }
    }
    throw new Error('invalid broker request')
}

export function assertSecureBrokerSocket(stat: { uid: number; mode: number; isSocket: boolean }): void {
    if (!stat.isSocket) throw new Error('browser broker path is not a Unix socket')
    if (stat.uid !== 0) throw new Error('browser broker socket must be root-owned')
    if ((stat.mode & 0o007) !== 0) throw new Error('browser broker socket grants other-user permissions')
    if ((stat.mode & 0o777) !== 0o660) throw new Error('browser broker socket permissions must be 0660')
}

export class BrowserSessionBrokerClient {
    constructor(
        private readonly socketPath: string,
        private readonly timeoutMs = 30_000,
    ) {}

    async request(request: BrowserSessionBrokerRequest): Promise<BrowserSessionBrokerResponse> {
        const stat = await lstat(this.socketPath)
        assertSecureBrokerSocket({ uid: stat.uid, mode: stat.mode, isSocket: stat.isSocket() })
        return new Promise((resolve, reject) => {
            const socket = createConnection(this.socketPath)
            let buffer = ''
            const timer = setTimeout(() => {
                socket.destroy()
                reject(new Error('browser broker request timed out'))
            }, this.timeoutMs)
            const finish = (callback: () => void) => {
                clearTimeout(timer)
                socket.destroy()
                callback()
            }
            socket.setEncoding('utf8')
            socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
            socket.on('data', (chunk) => {
                buffer += chunk
                if (buffer.length > 64 * 1024) {
                    finish(() => reject(new Error('browser broker response is too large')))
                    return
                }
                const newline = buffer.indexOf('\n')
                if (newline < 0) return
                try {
                    const response = JSON.parse(buffer.slice(0, newline)) as BrowserSessionBrokerResponse
                    finish(() => resolve(response))
                } catch {
                    finish(() => reject(new Error('browser broker response is invalid')))
                }
            })
            socket.on('error', (error) => finish(() => reject(error)))
        })
    }
}
