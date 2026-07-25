import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { BrowserBridge } from './browserBridge'
import { startBrowserBridgeServer } from './browserBridgeServer'
import { startDaemonControlServer } from './controlServer'
import type { PortRegistry } from './portRegistry'

const TOKEN = 'bridge-test-token'

const stubPortRegistry: PortRegistry = {
    allocate: async () => ({ port: 30000, reused: false }),
    release: async () => false,
    readAll: async () => ({}),
}

/** Connect a fake extension and wait for open (or close before open = rejection). */
function connectExtension(port: number, query: string): Promise<{ ws: WebSocket; closedWith?: number }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/?${query}`)
        ws.on('open', () => resolve({ ws }))
        ws.on('close', (code) => resolve({ ws, closedWith: code }))
        ws.on('error', reject)
    })
}

describe('browserBridgeServer', () => {
    let bridge: BrowserBridge
    let port: number
    let stop: () => Promise<void>

    beforeEach(async () => {
        bridge = new BrowserBridge({ authToken: TOKEN })
        const server = await startBrowserBridgeServer({ bridge, port: 0 })
        port = server.port
        stop = server.stop
    })

    afterEach(async () => {
        await stop()
    })

    it('registers an extension connecting with the right token', async () => {
        const { ws } = await connectExtension(port, `token=${TOKEN}&profile=work`)
        await expect.poll(() => bridge.connections()).toEqual([{ profile: 'work' }])
        ws.close()
    })

    it('closes a connection with a wrong token with code 4401', async () => {
        const { ws } = await connectExtension(port, 'token=wrong')
        const code = await new Promise<number>((resolve) => ws.on('close', resolve))
        expect(code).toBe(4401)
        expect(bridge.connections()).toEqual([])
    })

    it('round-trips a request to the connected extension', async () => {
        const { ws } = await connectExtension(port, `token=${TOKEN}`)
        ws.on('message', (raw) => {
            const message = JSON.parse(raw.toString())
            if (message.method === 'tabs_list') {
                ws.send(JSON.stringify({ id: message.id, result: { tabs: [] } }))
            }
        })
        await expect.poll(() => bridge.connections().length).toBe(1)
        await expect(bridge.request('tabs_list', {})).resolves.toEqual({ tabs: [] })
        ws.close()
    })

    it('answers extension pings with pong', async () => {
        const { ws } = await connectExtension(port, `token=${TOKEN}`)
        const pong = new Promise<any>((resolve) => {
            ws.on('message', (raw) => resolve(JSON.parse(raw.toString())))
        })
        ws.send(JSON.stringify({ type: 'ping' }))
        await expect(pong).resolves.toEqual({ type: 'pong' })
        ws.close()
    })
})

describe('controlServer /browser routes', () => {
    let bridge: BrowserBridge
    let bridgePort: number
    let stopBridge: () => Promise<void>
    let baseUrl: string
    let stopControl: () => Promise<void>

    beforeEach(async () => {
        bridge = new BrowserBridge({ authToken: TOKEN })
        const bridgeServer = await startBrowserBridgeServer({ bridge, port: 0 })
        bridgePort = bridgeServer.port
        stopBridge = bridgeServer.stop
        const control = await startDaemonControlServer({
            getChildren: () => [],
            stopSession: () => ({ stopped: false, reason: 'not-found' }),
            spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            portRegistry: stubPortRegistry,
            browserBridge: bridge,
        })
        baseUrl = `http://127.0.0.1:${control.port}`
        stopControl = control.stop
    })

    afterEach(async () => {
        await stopControl()
        await stopBridge()
    })

    it('GET /browser/status reports connected profiles', async () => {
        const before = await fetch(`${baseUrl}/browser/status`)
        expect(await before.json()).toEqual({ connections: [] })

        const { ws } = await connectExtension(bridgePort, `token=${TOKEN}&profile=work`)
        await expect.poll(() => bridge.connections().length).toBe(1)
        const after = await fetch(`${baseUrl}/browser/status`)
        expect(await after.json()).toEqual({ connections: [{ profile: 'work' }] })
        ws.close()
    })

    it('POST /browser/request relays to the extension and returns its result', async () => {
        const { ws } = await connectExtension(bridgePort, `token=${TOKEN}`)
        ws.on('message', (raw) => {
            const message = JSON.parse(raw.toString())
            ws.send(JSON.stringify({ id: message.id, result: 'pong' }))
        })
        await expect.poll(() => bridge.connections().length).toBe(1)

        const res = await fetch(`${baseUrl}/browser/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'ping' }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ result: 'pong' })
        ws.close()
    })

    it('POST /browser/request returns 503 when no extension is connected', async () => {
        const res = await fetch(`${baseUrl}/browser/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'ping' }),
        })
        expect(res.status).toBe(503)
        const body = await res.json() as { code: string }
        expect(body.code).toBe('NO_EXTENSION_CONNECTED')
    })

    it('POST /browser/request returns 504 on extension timeout', async () => {
        const { ws } = await connectExtension(bridgePort, `token=${TOKEN}`)
        // extension never answers
        await expect.poll(() => bridge.connections().length).toBe(1)
        const res = await fetch(`${baseUrl}/browser/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'ping', timeoutMs: 100 }),
        })
        expect(res.status).toBe(504)
        const body = await res.json() as { code: string }
        expect(body.code).toBe('TIMEOUT')
        ws.close()
    })
})
