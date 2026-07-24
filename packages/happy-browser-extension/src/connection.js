/**
 * Bridge connection state machine for the service worker.
 *
 * Extracted from background.js so it can be unit-tested with a fake chrome and
 * a fake WebSocket — the real thing only exists inside a browser.
 */

import { handleCommand } from './protocol.js'
import { reconnectDelayMs } from './backoff.js'

export const DEFAULT_PORT = 41777
export const KEEPALIVE_INTERVAL_MS = 20_000

export function createConnection({
    chrome,
    WebSocketImpl,
    keepaliveIntervalMs = KEEPALIVE_INTERVAL_MS,
    defaultPort = DEFAULT_PORT,
}) {
    let socket = null
    // Set synchronously so two overlapping connect() calls cannot both get past
    // the guard while the first is awaiting the stored config.
    let connecting = false
    let reconnectTimer = null
    let consecutiveFailures = 0

    async function readConfig() {
        const { port, token, profile } = await chrome.storage.local.get(['port', 'token', 'profile'])
        return { port: port || defaultPort, token: token || '', profile: profile || 'default' }
    }

    function scheduleReconnect() {
        if (reconnectTimer !== null) return
        const delay = reconnectDelayMs(consecutiveFailures)
        consecutiveFailures += 1
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null
            connect()
        }, delay)
    }

    async function connect() {
        if (socket || connecting) return
        connecting = true

        let config
        try {
            config = await readConfig()
        } finally {
            connecting = false
        }
        const { port, token, profile } = config
        if (!token) {
            // Not paired yet — the options page starts the connection once saved.
            return
        }

        const url = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}&profile=${encodeURIComponent(profile)}`
        const ws = new WebSocketImpl(url)
        socket = ws
        // Per-socket so a late close from a replaced socket cannot stop the
        // live one's keepalive — that let the service worker go idle and die.
        let keepaliveTimer = null

        ws.addEventListener('open', () => {
            consecutiveFailures = 0
            chrome.action?.setBadgeText?.({ text: '●' })
            keepaliveTimer = setInterval(() => {
                if (ws.readyState === WebSocketImpl.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
            }, keepaliveIntervalMs)
        })

        ws.addEventListener('message', async (event) => {
            let message
            try {
                message = JSON.parse(event.data)
            } catch {
                return
            }
            // The daemon's reply to our keepalive; nothing to answer.
            if (message.type === 'pong') return

            const response = await handleCommand(message, chrome)
            if (ws.readyState === WebSocketImpl.OPEN) ws.send(JSON.stringify(response))
        })

        const onGone = () => {
            if (keepaliveTimer !== null) {
                clearInterval(keepaliveTimer)
                keepaliveTimer = null
            }
            // A socket we already replaced is expected to close; only the live
            // one losing the daemon warrants a badge reset and a reconnect.
            if (socket !== ws) return
            socket = null
            chrome.action?.setBadgeText?.({ text: '' })
            scheduleReconnect()
        }
        ws.addEventListener('close', onGone)
        ws.addEventListener('error', onGone)
    }

    /** Drop the current connection and reconnect — used when settings change. */
    function restart() {
        consecutiveFailures = 0
        if (socket) {
            const stale = socket
            socket = null
            stale.close()
        }
        connect()
    }

    return { connect, restart }
}
