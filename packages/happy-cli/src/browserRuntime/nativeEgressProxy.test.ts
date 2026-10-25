import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { createNativeEgressProxy, endpointsFromOrigins, type NativeEgressProxy } from './nativeEgressProxy'

describe('origin to endpoint mapping', () => {
    it('maps exact http(s) origins to lowercase host:port with scheme default ports', () => {
        expect([...endpointsFromOrigins(['https://Example.com', 'http://example.com', 'https://a.test:8443', 'https://[2606:4700::1111]', 'https://8.8.8.8'])].sort()).toEqual([
            '2606:4700::1111:443', '8.8.8.8:443', 'a.test:8443', 'example.com:443', 'example.com:80',
        ])
    })

    it.each(['ftp://example.com', 'https://user:pw@example.com', 'https://example.com/path', 'example.com', 'null', 'file:///etc/passwd', 'https://example.com.'])('rejects non-origin %s', (origin) => {
        expect(() => endpointsFromOrigins([origin])).toThrow()
    })
})

type Harness = { proxy: NativeEgressProxy; port: number; upstream: Server; upstreamPort: number; dial: ReturnType<typeof vi.fn>; lookup: ReturnType<typeof vi.fn> }
const open: Array<() => Promise<void>> = []
afterEach(async () => { while (open.length) await open.pop()!() })

async function harness(origins: string[], answers: Array<{ address: string; family: number }> = [{ address: '8.8.8.8', family: 4 }], onDecision?: (decision: { endpoint: string; verdict: string }) => void): Promise<Harness> {
    const upstream = createServer((socket) => socket.on('data', (data) => socket.write(data)).on('error', () => undefined))
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as { port: number }).port
    const lookup = vi.fn(async () => answers)
    const dial = vi.fn(() => createConnection({ host: '127.0.0.1', port: upstreamPort }))
    const proxy = createNativeEgressProxy({ lookup, connect: dial as unknown as typeof createConnection, onDecision })
    proxy.setAllowedOrigins(origins)
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve))
    const port = (proxy.server.address() as { port: number }).port
    open.push(async () => {
        await Promise.all([new Promise<void>((resolve) => proxy.server.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))])
    })
    upstream.on('connection', (socket) => open.push(async () => { socket.destroy() }))
    return { proxy, port, upstream, upstreamPort, dial, lookup }
}

function domainRequest(host: string, port: number, command = 1): Buffer {
    const name = Buffer.from(host, 'ascii')
    return Buffer.concat([Buffer.from([5, command, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])])
}

function ipv4Request(address: string, port: number): Buffer {
    return Buffer.from([5, 1, 0, 1, ...address.split('.').map(Number), port >> 8, port & 255])
}

/** Speaks SOCKS5 and resolves with every byte the proxy sent until it closed or `until` matched. */
function socks(port: number, frames: Buffer[], until?: (received: Buffer) => boolean): Promise<{ received: Buffer; socket: Socket }> {
    return new Promise((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port })
        open.push(async () => { socket.destroy() })
        let received = Buffer.alloc(0)
        let sent = 0
        const done = () => resolve({ received, socket })
        socket.on('error', reject).on('close', done).on('data', (data) => {
            received = Buffer.concat([received, data])
            if (sent < frames.length && received.length >= 2 && sent === 1) socket.write(frames[sent++])
            if (until?.(received)) done()
        })
        socket.on('connect', () => socket.write(frames[sent++]))
    })
}

const GREETING = Buffer.from([5, 1, 0])
const replyCode = (received: Buffer) => received[3]

describe('SOCKS5 egress proxy', () => {
    it('denies everything until a policy is set', async () => {
        const h = await harness([])
        const { received } = await socks(h.port, [GREETING, domainRequest('example.com', 443)])
        expect(received.subarray(0, 2)).toEqual(Buffer.from([5, 0]))
        expect(replyCode(received)).toBe(2)
        expect(h.lookup).not.toHaveBeenCalled()
        expect(h.dial).not.toHaveBeenCalled()
    })

    it('tunnels an allowed origin to the single resolved public address without resolving twice', async () => {
        const h = await harness(['https://example.com'])
        const { received } = await socks(h.port, [GREETING, Buffer.concat([domainRequest('Example.COM', 443), Buffer.from('synthetic-tunnel')])], (r) => r.includes('synthetic-tunnel'))
        expect(received.subarray(2, 4)).toEqual(Buffer.from([5, 0]))
        expect(received.includes('synthetic-tunnel')).toBe(true)
        expect(h.lookup).toHaveBeenCalledTimes(1)
        expect(h.lookup).toHaveBeenCalledWith('example.com')
        expect(h.dial).toHaveBeenCalledWith({ host: '8.8.8.8', family: 4, port: 443 })
    })

    it.each([
        ['other host', domainRequest('evil.test', 443)],
        ['suffix confusion', domainRequest('example.com.evil.test', 443)],
        ['allowed host on another port', domainRequest('example.com', 80)],
        ['unlisted IPv4 literal', ipv4Request('1.1.1.1', 443)],
        ['loopback literal', ipv4Request('127.0.0.1', 443)],
        ['trailing dot', domainRequest('example.com.', 443)],
    ])('refuses %s before DNS', async (_name, request) => {
        const h = await harness(['https://example.com'])
        const { received } = await socks(h.port, [GREETING, request])
        expect(replyCode(received)).toBe(2)
        expect(h.lookup).not.toHaveBeenCalled()
        expect(h.dial).not.toHaveBeenCalled()
    })

    it.each([
        ['loopback', [{ address: '127.0.0.1', family: 4 }]],
        ['private', [{ address: '192.168.1.10', family: 4 }]],
        ['metadata', [{ address: '169.254.169.254', family: 4 }]],
        ['mixed public/private', [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]],
        ['ULA IPv6', [{ address: 'fd00::1', family: 6 }]],
        ['empty answer', []],
    ])('refuses an allowed name that resolves to %s', async (_name, answers) => {
        const h = await harness(['https://example.com'], answers)
        const { received } = await socks(h.port, [GREETING, domainRequest('example.com', 443)])
        expect(replyCode(received)).toBe(2)
        expect(h.dial).not.toHaveBeenCalled()
    })

    it('allows a listed public IPv4 literal without DNS', async () => {
        const h = await harness(['https://8.8.8.8'])
        const { received } = await socks(h.port, [GREETING, ipv4Request('8.8.8.8', 443)], (r) => r.length >= 12)
        expect(replyCode(received)).toBe(0)
        expect(h.lookup).not.toHaveBeenCalled()
        expect(h.dial).toHaveBeenCalledWith({ host: '8.8.8.8', family: 4, port: 443 })
    })

    it('refuses clients that do not offer the no-auth method', async () => {
        const h = await harness(['https://example.com'])
        const { received } = await socks(h.port, [Buffer.from([5, 1, 2])])
        expect(received).toEqual(Buffer.from([5, 0xff]))
    })

    it.each([['BIND', 2], ['UDP ASSOCIATE', 3]])('refuses %s', async (_name, command) => {
        const h = await harness(['https://example.com'])
        const { received } = await socks(h.port, [GREETING, domainRequest('example.com', 443, command)])
        expect(replyCode(received)).toBe(7)
        expect(h.dial).not.toHaveBeenCalled()
    })

    it('closes a non-SOCKS5 client without a reply', async () => {
        const h = await harness(['https://example.com'])
        const { received } = await socks(h.port, [Buffer.from('CONNECT example.com:443 HTTP/1.1\r\n\r\n')])
        expect(received.length).toBe(0)
    })

    it('tears down open tunnels whose endpoint is removed and refuses new ones', async () => {
        const h = await harness(['https://example.com', 'https://keep.test'])
        const first = await socks(h.port, [GREETING, domainRequest('example.com', 443)], (r) => r.length >= 12)
        const kept = await socks(h.port, [GREETING, domainRequest('keep.test', 443)], (r) => r.length >= 12)
        const closed = new Promise<void>((resolve) => first.socket.once('close', () => resolve()))
        h.proxy.setAllowedOrigins(['https://keep.test'])
        await closed
        expect(kept.socket.destroyed).toBe(false)
        const again = await socks(h.port, [GREETING, domainRequest('example.com', 443)])
        expect(replyCode(again.received)).toBe(2)
    })

    it('revokes every tunnel when the policy is cleared', async () => {
        const h = await harness(['https://example.com'])
        const tunnel = await socks(h.port, [GREETING, domainRequest('example.com', 443)], (r) => r.length >= 12)
        const closed = new Promise<void>((resolve) => tunnel.socket.once('close', () => resolve()))
        h.proxy.setAllowedOrigins([])
        await closed
    })

    it('fails closed on an invalid policy: throws, closes open tunnels and denies new ones', async () => {
        const h = await harness(['https://example.com'])
        const tunnel = await socks(h.port, [GREETING, domainRequest('example.com', 443)], (r) => r.length >= 12)
        const closed = new Promise<void>((resolve) => tunnel.socket.once('close', () => resolve()))
        expect(() => h.proxy.setAllowedOrigins(['https://example.com', 'ftp://example.com'])).toThrow()
        await closed
        const again = await socks(h.port, [GREETING, domainRequest('example.com', 443)])
        expect(replyCode(again.received)).toBe(2)
    })

    it('reports each decision for audit without the client payload', async () => {
        const decisions: Array<{ endpoint: string; verdict: string }> = []
        const h = await harness(['https://example.com'], undefined, (decision) => decisions.push(decision))
        await socks(h.port, [GREETING, domainRequest('example.com', 443)], (r) => r.length >= 12)
        await socks(h.port, [GREETING, domainRequest('evil.test', 443)])
        await socks(h.port, [GREETING, ipv4Request('127.0.0.1', 8080)])
        expect(decisions).toEqual([
            { endpoint: 'example.com:443', verdict: 'tunnel' },
            { endpoint: 'evil.test:443', verdict: 'denied' },
            { endpoint: '127.0.0.1:8080', verdict: 'denied' },
        ])
    })

    it('does not open a tunnel when the policy is revoked while DNS is in flight', async () => {
        let release!: (value: Array<{ address: string; family: number }>) => void
        const h = await harness(['https://example.com'])
        h.lookup.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
        const pending = socks(h.port, [GREETING, domainRequest('example.com', 443)])
        await vi.waitFor(() => expect(h.lookup).toHaveBeenCalled())
        h.proxy.setAllowedOrigins([])
        release([{ address: '8.8.8.8', family: 4 }])
        const { received } = await pending
        expect(replyCode(received)).toBe(2)
        expect(h.dial).not.toHaveBeenCalled()
    })
})
