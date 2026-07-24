/**
 * Service worker: keeps a WebSocket to the happy daemon's browser bridge and
 * answers its commands against this Chrome profile.
 *
 * MV3 terminates an idle service worker after ~30s. WebSocket activity resets
 * that timer (Chrome 116+), so the 20s ping doubles as the keepalive — the
 * daemon replies `{type:'pong'}` (browserBridge.ts).
 */

import { handleCommand } from './protocol.js'
import { reconnectDelayMs } from './backoff.js'

const DEFAULT_PORT = 41777
const KEEPALIVE_INTERVAL_MS = 20_000

let socket = null
let keepaliveTimer = null
let reconnectTimer = null
let consecutiveFailures = 0

async function readConfig() {
    const { port, token, profile } = await chrome.storage.local.get(['port', 'token', 'profile'])
    return { port: port || DEFAULT_PORT, token: token || '', profile: profile || 'default' }
}

function stopKeepalive() {
    if (keepaliveTimer !== null) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
    }
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
    if (socket) return

    const { port, token, profile } = await readConfig()
    if (!token) {
        // Not paired yet — the options page starts the connection once saved.
        return
    }

    const url = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}&profile=${encodeURIComponent(profile)}`
    const ws = new WebSocket(url)
    socket = ws

    ws.addEventListener('open', () => {
        consecutiveFailures = 0
        chrome.action?.setBadgeText?.({ text: '●' })
        keepaliveTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
        }, KEEPALIVE_INTERVAL_MS)
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
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response))
    })

    const onGone = () => {
        if (socket === ws) socket = null
        stopKeepalive()
        chrome.action?.setBadgeText?.({ text: '' })
        scheduleReconnect()
    }
    ws.addEventListener('close', onGone)
    ws.addEventListener('error', onGone)
}

/** Reconnect immediately after the options page saves new settings. */
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (!('token' in changes || 'port' in changes || 'profile' in changes)) return
    consecutiveFailures = 0
    if (socket) {
        const stale = socket
        socket = null
        stale.close()
    }
    connect()
})

chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
connect()
