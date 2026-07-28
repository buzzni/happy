/**
 * LIVE end-to-end verification of the preview WebSocket relay.
 *
 * Wires together the REAL pieces over real sockets:
 *   ws client (browser)
 *     → real socket.io Server (destroyUpgrade:false) + upgrade handler
 *        → socket.io-client (daemon) + REAL PreviewWsProxy (raw TCP tunnel)
 *           → real ws echo server (stands in for websockify)
 *
 * Proves: (1) a genuine WebSocket handshake survives the tunnel end-to-end
 * (Sec-WebSocket-Accept validated by the ws client), (2) frames flow both ways,
 * (3) engine.io does not kill the preview upgrade, and (4) socket.io's own
 * realtime still connects and upgrades to websocket alongside our upgrade
 * listener (the destroyUpgrade:false side-effect check).
 *
 * socket.io (server) is not a happy-cli dep, so it is loaded from the shared
 * pnpm store via the happy-server package context; the test skips if that
 * resolution fails (keeps this green outside the monorepo).
 */
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { createRequire } from 'node:module'
import { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { io as ioClient } from 'socket.io-client'
import { PreviewWsProxy } from './previewWsProxy'

function loadSocketIoServer(): any {
    // socket.io (server) is not a happy-cli dep; resolve it from the sibling
    // happy-server package so this stays portable across checkout locations.
    try {
        const serverPkg = new URL('../../../happy-server/index.js', import.meta.url)
        const r = createRequire(serverPkg)
        return r('socket.io').Server
    } catch {
        return null
    }
}

const listen = (server: http.Server) =>
    new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

describe('preview WS relay (live)', () => {
    it('tunnels a real WebSocket handshake + echo, and socket.io still works', async () => {
        const Server = loadSocketIoServer()
        if (!Server) {
            console.warn('[live] socket.io server not resolvable — skipping')
            return
        }

        // 1) Upstream: real ws echo server (stands in for websockify).
        const upstreamHttp = http.createServer()
        const wss = new WebSocketServer({ server: upstreamHttp })
        wss.on('connection', (sock) => {
            sock.on('message', (data) => sock.send(data.toString()))
        })
        const upstreamPort = await listen(upstreamHttp)

        // 2) Relay: real socket.io Server + our upgrade handler on the same http server.
        const relayHttp = http.createServer()
        const ioServer = new Server(relayHttp, {
            path: '/v1/updates',
            transports: ['websocket', 'polling'],
            destroyUpgrade: false, // the change under test
        })

        // Track the daemon socket once it connects.
        let daemonServerSocket: any = null
        ioServer.on('connection', (s: any) => { daemonServerSocket = s })

        // Minimal faithful mirror of previewWebSocketRelay.handleUpgrade: parse,
        // serialize, proxy-ws-open, then pipe. (Auth is covered by unit tests;
        // here we focus on the live transport + handshake.)
        //
        // This duplicates serializeUpgradeRequest because that lives in
        // happy-server and cannot be imported across packages. Keep the header
        // rewrites below in step with it — a silent divergence would leave this
        // test green while the real relay is broken.
        const browserByTunnel = new Map<string, net.Socket>()
        const wiredSockets = new WeakSet<any>()
        function wire(ms: any) {
            if (wiredSockets.has(ms)) return
            wiredSockets.add(ms)
            ms.on('proxy-ws-data', (p: { tunnelId: string; dataB64: string }) => {
                const b = browserByTunnel.get(p.tunnelId)
                if (b && b.writable) b.write(Buffer.from(p.dataB64, 'base64'))
            })
            ms.on('proxy-ws-close', (p: { tunnelId: string }) => {
                browserByTunnel.get(p.tunnelId)?.end()
                browserByTunnel.delete(p.tunnelId)
            })
        }
        relayHttp.on('upgrade', (req, socket, head) => {
            const m = (req.url ?? '').match(/^\/v1\/preview\/([^/]+)\/(\d+)(\/[^?]*)?/)
            if (!m) return // let socket.io handle /v1/updates
            const port = Number(m[2])
            const subPath = m[3] && m[3].length > 0 ? m[3] : '/'
            let reqBytes = `${req.method} ${subPath} HTTP/1.1\r\n`
            for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
                const k = req.rawHeaders[i]
                const lower = k.toLowerCase()
                const v =
                    lower === 'host' ? `127.0.0.1:${port}` :
                    lower === 'origin' ? `http://127.0.0.1:${port}` :
                    req.rawHeaders[i + 1]
                reqBytes += `${k}: ${v}\r\n`
            }
            reqBytes += '\r\n'
            const dataB64 = Buffer.concat([Buffer.from(reqBytes), head ?? Buffer.alloc(0)]).toString('base64')
            const tunnelId = `t-${Date.now()}-${Math.floor(port)}`
            const ms = daemonServerSocket
            if (!ms) { socket.destroy(); return }
            wire(ms)
            browserByTunnel.set(tunnelId, socket as net.Socket)
            ms.timeout(5000).emitWithAck('proxy-ws-open', { tunnelId, port, dataB64 }).then((ack: any) => {
                if (!ack?.ok) { browserByTunnel.delete(tunnelId); socket.destroy(); return }
                socket.on('data', (chunk: Buffer) => ms.emit('proxy-ws-data', { tunnelId, dataB64: chunk.toString('base64') }))
                const teardown = () => { if (browserByTunnel.delete(tunnelId)) ms.emit('proxy-ws-close', { tunnelId }) }
                socket.on('close', teardown)
                socket.on('error', teardown)
            }).catch(() => { browserByTunnel.delete(tunnelId); socket.destroy() })
        })
        const relayPort = await listen(relayHttp)
        console.warn(`[live] upstream=${upstreamPort} relay=${relayPort}`)

        // 3) Daemon: socket.io-client + REAL PreviewWsProxy.
        const daemon = ioClient(`http://127.0.0.1:${relayPort}`, { path: '/v1/updates', transports: ['websocket'] })
        const proxy = new PreviewWsProxy({ emit: (e: any, p: any) => daemon.emit(e, p) })
        daemon.on('proxy-ws-open', async (params: any, ack: (r: any) => void) => ack(await proxy.open(params)))
        daemon.on('proxy-ws-data', (p: any) => proxy.data(p))
        daemon.on('proxy-ws-close', (p: any) => proxy.close(p?.tunnelId))
        await new Promise<void>((resolve, reject) => {
            daemon.on('connect', () => resolve())
            daemon.on('connect_error', (e: any) => reject(new Error(`daemon connect_error: ${e?.message ?? e}`)))
            setTimeout(() => reject(new Error('daemon connect timeout')), 5000)
        })
        console.warn(`[live] daemon connected, transport=${daemon.io.engine.transport.name}`)
        // Coexistence assertion: socket.io upgraded to a real websocket transport.
        expect(daemon.io.engine.transport.name).toBe('websocket')

        // 4) Browser: real ws client through the preview relay path → tunnel → echo.
        const client = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/preview/mac-1/${upstreamPort}/websockify`)
        const echoed = await new Promise<string>((resolve, reject) => {
            client.on('open', () => { console.warn('[live] ws client open'); client.send('ping-through-tunnel') })
            client.on('message', (data) => resolve(data.toString()))
            client.on('unexpected-response', (_req: any, res: any) => reject(new Error(`ws unexpected-response ${res.statusCode}`)))
            client.on('error', (e) => reject(new Error(`ws client error: ${e.message}`)))
            setTimeout(() => reject(new Error('ws roundtrip timeout')), 5000)
        })
        console.warn('[live] echo received')
        expect(echoed).toBe('ping-through-tunnel')

        // Best-effort synchronous teardown (no awaits — the functional
        // assertions above are the pass criteria; draining keep-alives can
        // block, so we just force everything down and return).
        try {
            client.terminate()
            proxy.closeAll()
            daemon.disconnect()
            ioServer.disconnectSockets(true)
            relayHttp.closeAllConnections?.()
            upstreamHttp.closeAllConnections?.()
            ioServer.close()
            wss.close()
            upstreamHttp.close()
        } catch { /* best effort */ }
        console.warn('[live] teardown done')
    }, 20000)
})
