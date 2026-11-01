/**
 * Dedicated loopback WebSocket listener for the Chrome extension bridge.
 *
 * Separate from the fastify control server because the control port is
 * ephemeral (discovered via daemon.state.json), which the extension cannot
 * read — it needs a stable default port to be configured against in its
 * options page. Sessions keep using the control server's /browser routes;
 * both sides share one BrowserBridge instance.
 */

import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import type { BrowserBridge } from './browserBridge'
import { logger } from '@/ui/logger'
import { DEFAULT_BROWSER_BRIDGE_PORT } from './browserBridgeConfig'
import { CHROME_WEB_STORE_EXTENSION_ID } from './browserNativeHostRegistration'

const SETUP_ORIGINS = new Set(['emaponnolfbhnoaabgiebjmbdlmoifke', CHROME_WEB_STORE_EXTENSION_ID].map(id => `chrome-extension://${id}`))

export { DEFAULT_BROWSER_BRIDGE_PORT, resolveBrowserBridgeHost } from './browserBridgeConfig'

export function startBrowserBridgeServer({ bridge, port, host = '127.0.0.1', consumeSetup }: {
    bridge: BrowserBridge
    port: number
    host?: string
    consumeSetup?: (operationId: string) => Promise<unknown>
}): Promise<{ port: number; stop: () => Promise<void> }> {
    return new Promise((resolve, reject) => {
        const wss = new WebSocketServer({ host, port })

        wss.on('listening', () => {
            const actualPort = (wss.address() as AddressInfo).port
            logger.debug(`[BROWSER BRIDGE] Listening on ${host}:${actualPort}`)
            resolve({
                port: actualPort,
                stop: () => new Promise<void>((resolveStop) => {
                    for (const client of wss.clients) client.terminate()
                    wss.close(() => resolveStop())
                })
            })
        })

        wss.on('error', (err) => {
            logger.debug(`[BROWSER BRIDGE] Server error: ${err.message}`)
            reject(err)
        })

        wss.on('connection', (socket, request) => {
            // The base only anchors relative-URL parsing; its host part is
            // never read. It must NOT be built from the bind host: a bare
            // IPv6 host ('::1', '::') is invalid in a URL authority, and the
            // resulting throw inside this handler killed the process on every
            // incoming connection once HAPPY_BROWSER_BRIDGE_HOST allowed IPv6
            // binds.
            const url = new URL(request.url ?? '/', 'http://bridge.invalid')
            if (url.pathname === '/setup-pair') {
                const operationId = url.searchParams.get('operationId') ?? ''
                if (!consumeSetup || host !== '127.0.0.1' || request.socket.remoteAddress !== '127.0.0.1'
                    || !SETUP_ORIGINS.has(request.headers.origin ?? '')
                    || [...url.searchParams.keys()].join(',') !== 'operationId'
                    || !/^[A-Za-z0-9_-]{32}$/.test(operationId)) {
                    socket.close(4403, 'setup exchange refused'); return
                }
                void consumeSetup(operationId).then(config => {
                    socket.send(JSON.stringify({ ok: true, config }))
                    socket.close(1000)
                }).catch(() => socket.close(4403, 'setup expired'))
                return
            }
            bridge.handleConnection(socket, {
                token: url.searchParams.get('token') ?? undefined,
                profile: url.searchParams.get('profile') ?? undefined,
                pairingId: url.searchParams.get('pairingId') ?? undefined,
                viewerKey: url.searchParams.get('viewerKey') ?? undefined,
            })
        })
    })
}

const DEFAULT_PORT_RETRY_MS = 10_000

/**
 * The port is fixed, so a daemon that starts while another process holds it would otherwise stay
 * without browser control until restart. Retries while the port is taken and takes it over once
 * that process exits; any other bind error ends the retries.
 */
export function retryBrowserBridgeServer({ bridge, port, host = '127.0.0.1', retryMs = DEFAULT_PORT_RETRY_MS }: {
    bridge: BrowserBridge
    port: number
    host?: string
    retryMs?: number
}): { stop: () => Promise<void> } {
    let stopped = false
    let timer: NodeJS.Timeout | undefined
    let stopServer: (() => Promise<void>) | undefined
    bridge.setListenerUnavailable(port)
    const attempt = () => {
        startBrowserBridgeServer({ bridge, port, host }).then(async (server) => {
            if (stopped) { await server.stop(); return }
            stopServer = server.stop
            bridge.setListenerUnavailable(null)
            logger.debug(`[BROWSER BRIDGE] Took over ${host}:${port} after it was released`)
        }, (err: NodeJS.ErrnoException) => {
            if (stopped) return
            if (err.code === 'EADDRINUSE') { timer = setTimeout(attempt, retryMs); return }
            bridge.setListenerUnavailable(null)
            logger.debug(`[BROWSER BRIDGE] Gave up retrying ${host}:${port}: ${err.message}`)
        })
    }
    timer = setTimeout(attempt, retryMs)
    return {
        stop: async () => {
            stopped = true
            clearTimeout(timer)
            await stopServer?.()
        },
    }
}
