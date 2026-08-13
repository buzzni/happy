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

export const DEFAULT_BROWSER_BRIDGE_PORT = 41777

/**
 * Bind address for the bridge, from `HAPPY_BROWSER_BRIDGE_HOST`.
 *
 * Loopback by default — a user's own PC pointing its Chrome at a remote
 * happy session has to opt in explicitly, since anything else turns the
 * pairing token into the sole defense on a public interface.
 */
export function resolveBrowserBridgeHost(env: NodeJS.ProcessEnv): string {
    return env.HAPPY_BROWSER_BRIDGE_HOST?.trim() || '127.0.0.1'
}

export function startBrowserBridgeServer({ bridge, port, host = '127.0.0.1' }: {
    bridge: BrowserBridge
    port: number
    host?: string
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
            bridge.handleConnection(socket, {
                token: url.searchParams.get('token') ?? undefined,
                profile: url.searchParams.get('profile') ?? undefined,
            })
        })
    })
}
