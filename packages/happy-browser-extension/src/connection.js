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

/** Connected and idle. */
const BADGE_IDLE = { text: '●', color: '#4a9d5f' }
/** A command from the agent is running against this profile right now. */
const BADGE_BUSY = { text: '▶', color: '#c2701c' }
const BADGE_OFF = { text: '', color: '#4a9d5f' }
/** The daemon rejected our stored token (4401) — retrying won't help until
 *  the user re-pairs; a bare BADGE_OFF looks identical to a normal drop. */
const BADGE_AUTH_ERROR = { text: '!', color: '#c0392b' }
/** The saved host/port cannot form a URL at all. Same "go fix the options
 *  page" meaning as BADGE_AUTH_ERROR, so it shares its look. */
const BADGE_CONFIG_ERROR = { text: '!', color: '#c0392b' }

/**
 * An IPv6 literal has to be bracketed in a URL authority, or the colons read
 * as the port separator and the whole URL is invalid. Hosts the user already
 * bracketed, and ordinary names/IPv4, pass through untouched.
 */
function formatHost(host) {
    if (host.includes(':') && !host.startsWith('[')) return `[${host}]`
    return host
}

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
    let restartRequested = false
    let reconnectTimer = null
    let consecutiveFailures = 0

    async function readConfig() {
        const { port, token, profile, pairingId, viewerKey, host } = await chrome.storage.local.get([
            'port', 'token', 'profile', 'pairingId', 'viewerKey', 'host',
        ])
        return {
            port: port || defaultPort,
            token: token || '',
            profile: profile || 'default',
            pairingId: pairingId || '',
            viewerKey: viewerKey || '',
            // The daemon is usually on this machine, but not always — a user
            // can point their own, already-running Chrome at a remote happy
            // session's bridge instead.
            host: host || '127.0.0.1',
        }
    }

    function setBadge({ text, color }) {
        chrome.action?.setBadgeText?.({ text })
        chrome.action?.setBadgeBackgroundColor?.({ color })
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
        if (restartRequested) {
            restartRequested = false
            return connect()
        }
        const { port, token, profile, pairingId, viewerKey, host } = config
        if (!token) {
            // Not paired yet — the options page starts the connection once saved.
            return
        }

        const pairingQuery = pairingId ? `&pairingId=${encodeURIComponent(pairingId)}` : ''
        const viewerQuery = viewerKey ? `&viewerKey=${encodeURIComponent(viewerKey)}` : ''
        const url = `ws://${formatHost(host)}:${port}/?token=${encodeURIComponent(token)}&profile=${encodeURIComponent(profile)}${pairingQuery}${viewerQuery}`
        let ws
        try {
            ws = new WebSocketImpl(url)
        } catch {
            // `host` is free-form user input (the remote-daemon setting), so a
            // typo like "http://1.2.3.4" reaches here as a constructor throw.
            // Letting it escape connect() left an unhandled rejection with no
            // badge and no reconnect — a service worker that looks alive but
            // never will be. No reconnect is scheduled on purpose: retrying
            // the same bad URL cannot succeed, and the only thing that can fix
            // it (saving new settings) already calls restart().
            setBadge(BADGE_CONFIG_ERROR)
            return
        }
        socket = ws
        // Per-socket so a late close from a replaced socket cannot stop the
        // live one's keepalive — that let the service worker go idle and die.
        let keepaliveTimer = null

        ws.addEventListener('open', () => {
            consecutiveFailures = 0
            setBadge(BADGE_IDLE)
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
            // The daemon's reply to our keepalive; nothing to answer, and
            // not something to flag to the user as activity.
            if (message.type === 'pong') return

            // The badge is the user's only in-browser signal that an agent is
            // driving their tabs — mark it for the whole command, and restore
            // it in `finally` so a failure can't leave it stuck.
            setBadge(BADGE_BUSY)
            let response
            try {
                response = await handleCommand(message, chrome)
            } finally {
                if (socket === ws) setBadge(BADGE_IDLE)
            }
            if (ws.readyState === WebSocketImpl.OPEN) ws.send(JSON.stringify(response))
        })

        const onGone = (event) => {
            if (keepaliveTimer !== null) {
                clearInterval(keepaliveTimer)
                keepaliveTimer = null
            }
            // A socket we already replaced is expected to close; only the live
            // one losing the daemon warrants a badge reset and a reconnect.
            if (socket !== ws) return
            socket = null
            setBadge(event?.code === 4401 ? BADGE_AUTH_ERROR : BADGE_OFF)
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
        if (connecting) {
            restartRequested = true
            return
        }
        connect()
    }

    return { connect, restart }
}
