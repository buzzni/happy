/**
 * Service-owned SOCKS5 egress proxy for the fenced native browser.
 *
 * The browser account can reach only this proxy (see nativeMacEgressFence).
 * The proxy accepts CONNECT to the exact host:port of the task's allowed
 * origins, resolves once, requires every answer to be public and dials the
 * numeric address. Removing an origin tears down its open tunnels. With no
 * policy everything is denied. This holds whether or not the CDP guard is
 * attached, so it is the fail-closed layer under the Driver's Fetch guard.
 *
 * TCP cannot see the URL scheme, so http://h:443 and https://h:443 are the
 * same endpoint here; the Driver guard still checks exact origins.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { createConnection, createServer, isIP, type Server, type Socket } from 'node:net'
import { isPublicAddress } from '../sandbox/egressProxy'

export type NativeEgressLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>

/** Audit record of one CONNECT decision. Carries no client payload. */
export type NativeEgressDecision = { endpoint: string; verdict: 'tunnel' | 'denied' | 'unreachable' }

export type NativeEgressProxy = {
    readonly server: Server
    /** Replaces the allowed origins; closes tunnels to endpoints no longer allowed. */
    setAllowedOrigins(origins: readonly string[]): void
}

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const DEFAULT_PORT: Record<string, string> = { 'http:': '80', 'https:': '443' }
const HANDSHAKE_TIMEOUT_MS = 10_000
const TUNNEL_IDLE_TIMEOUT_MS = 300_000
const MAX_HANDSHAKE_BYTES = 512

const REPLY = { succeeded: 0, notAllowed: 2, hostUnreachable: 4, commandNotSupported: 7, addressTypeNotSupported: 8 } as const

/** Canonical IPv6 text, identical to how URL serializes the host. */
function canonicalIpv6(address: string): string {
    return new URL(`http://[${address}]`).hostname.slice(1, -1)
}

function endpointKey(host: string, port: number | string): string {
    return `${host}:${port}`
}

/** Exact http(s) origins → lowercase `host:port` endpoints. Throws on anything that is not an origin. */
export function endpointsFromOrigins(origins: readonly string[]): Set<string> {
    const endpoints = new Set<string>()
    for (const origin of origins) {
        let url: URL
        try { url = new URL(origin) } catch { throw new Error('invalid origin') }
        if (!(url.protocol in DEFAULT_PORT) || url.origin !== origin.toLowerCase()) throw new Error('invalid origin')
        const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
        if (!isIP(host) && !HOSTNAME.test(host)) throw new Error('invalid origin')
        endpoints.add(endpointKey(host, url.port || DEFAULT_PORT[url.protocol]))
    }
    return endpoints
}

type Request = { command: number; host: string; port: number; length: number } | { addressTypeNotSupported: true }

/** Parses a complete SOCKS5 request, or returns undefined when more bytes are needed. */
function parseRequest(buffer: Buffer): Request | undefined | null {
    if (buffer.length < 4) return undefined
    if (buffer[0] !== 5 || buffer[2] !== 0) return null
    const command = buffer[1]
    const type = buffer[3]
    let host: string
    let end: number
    if (type === 1) {
        end = 4 + 4
        if (buffer.length < end + 2) return undefined
        host = [...buffer.subarray(4, end)].join('.')
    } else if (type === 4) {
        end = 4 + 16
        if (buffer.length < end + 2) return undefined
        const words: string[] = []
        for (let offset = 4; offset < end; offset += 2) words.push(buffer.readUInt16BE(offset).toString(16))
        host = canonicalIpv6(words.join(':'))
    } else if (type === 3) {
        if (buffer.length < 5) return undefined
        end = 5 + buffer[4]
        if (buffer.length < end + 2) return undefined
        host = buffer.subarray(5, end).toString('latin1').toLowerCase()
    } else {
        return { addressTypeNotSupported: true }
    }
    return { command, host, port: buffer.readUInt16BE(end), length: end + 2 }
}

export function createNativeEgressProxy(options: { lookup?: NativeEgressLookup; connect?: typeof createConnection; onDecision?: (decision: NativeEgressDecision) => void } = {}): NativeEgressProxy {
    const resolve: NativeEgressLookup = options.lookup ?? ((host) => dnsLookup(host, { all: true, verbatim: true }))
    const connect = options.connect ?? createConnection
    let allowed = new Set<string>()
    const tunnels = new Map<string, Set<Socket>>()

    const track = (key: string, client: Socket) => {
        const set = tunnels.get(key) ?? new Set<Socket>()
        tunnels.set(key, set.add(client))
        client.once('close', () => { set.delete(client); if (set.size === 0 && tunnels.get(key) === set) tunnels.delete(key) })
    }

    const server = createServer((client) => {
        let buffer = Buffer.alloc(0)
        let stage: 'greeting' | 'request' | 'pending' = 'greeting'
        let upstream: Socket | undefined
        const close = () => { client.destroy(); upstream?.destroy() }
        const reply = (code: number) => {
            client.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]))
            upstream?.destroy()
        }
        client.on('error', close).on('close', () => upstream?.destroy())
        client.setTimeout(HANDSHAKE_TIMEOUT_MS, close)

        const open = async (request: { host: string; port: number }, rest: Buffer) => {
            const key = endpointKey(request.host, request.port)
            const decide = (verdict: NativeEgressDecision['verdict']) => options.onDecision?.({ endpoint: key, verdict })
            const deny = () => { decide('denied'); reply(REPLY.notAllowed) }
            const unreachable = () => { decide('unreachable'); reply(REPLY.hostUnreachable) }
            const literal = isIP(request.host)
            if (!allowed.has(key)) return deny()
            let target: { host: string; family: number; port: number }
            if (literal) {
                if (!isPublicAddress(request.host)) return deny()
                target = { host: request.host, family: literal, port: request.port }
            } else {
                let answers: Array<{ address: string; family: number }>
                try { answers = await resolve(request.host) } catch { return unreachable() }
                if (!answers.length || answers.some((item) => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) return deny()
                target = { host: answers[0].address, family: answers[0].family, port: request.port }
            }
            // The policy may have been revoked while DNS was in flight.
            if (client.destroyed) return
            if (!allowed.has(key)) return deny()
            track(key, client)
            const socket = upstream = connect(target)
            socket.setTimeout(HANDSHAKE_TIMEOUT_MS, unreachable)
            socket.once('error', unreachable)
            socket.once('connect', () => {
                socket.removeAllListeners('error').removeAllListeners('timeout').on('error', close).on('close', () => client.destroy())
                if (client.destroyed || !allowed.has(key)) return close()
                decide('tunnel')
                client.setTimeout(TUNNEL_IDLE_TIMEOUT_MS)
                socket.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, close)
                client.write(Buffer.from([5, REPLY.succeeded, 0, 1, 0, 0, 0, 0, 0, 0]))
                if (rest.length) socket.write(rest)
                client.pipe(socket).pipe(client)
                client.resume()
            })
        }

        const onData = (data: Buffer) => {
            buffer = Buffer.concat([buffer, data])
            if (buffer.length > MAX_HANDSHAKE_BYTES) return close()
            if (stage === 'greeting') {
                if (buffer[0] !== 5) return close()
                if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
                const methods = buffer.subarray(2, 2 + buffer[1])
                buffer = buffer.subarray(2 + buffer[1])
                if (!methods.includes(0)) { client.end(Buffer.from([5, 0xff])); return }
                client.write(Buffer.from([5, 0]))
                stage = 'request'
            }
            if (stage === 'request') {
                const request = parseRequest(buffer)
                if (request === undefined) return
                if (request === null) return close()
                stage = 'pending'
                client.removeListener('data', onData)
                client.pause()
                if ('addressTypeNotSupported' in request) return reply(REPLY.addressTypeNotSupported)
                if (request.command !== 1) return reply(REPLY.commandNotSupported)
                void open(request, buffer.subarray(request.length))
            }
        }
        client.on('data', onData)
    })

    return {
        server,
        setAllowedOrigins(origins) {
            let next = new Set<string>()
            try { next = endpointsFromOrigins(origins) } finally {
                // Invalid input fails closed: nothing stays allowed.
                allowed = next
                for (const [key, clients] of tunnels) {
                    if (allowed.has(key)) continue
                    for (const client of clients) client.destroy()
                    tunnels.delete(key)
                }
            }
        },
    }
}
