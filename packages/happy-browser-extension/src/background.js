/**
 * Service worker: keeps a WebSocket to the happy daemon's browser bridge and
 * answers its commands against this Chrome profile.
 *
 * MV3 terminates an idle service worker after ~30s. WebSocket activity resets
 * that timer (Chrome 116+), so the 20s ping doubles as the keepalive — the
 * daemon replies `{type:'pong'}` (browserBridge.ts).
 *
 * The connection state machine lives in connection.js so it stays testable
 * outside a browser; this file only wires it to the real chrome APIs.
 */

import { createConnection } from './connection.js'
import { attemptNativePairing } from './nativePairing.js'
import { ensureDefaultProfileName } from './profileId.js'

const connection = createConnection({ chrome, WebSocketImpl: WebSocket })
let setupPromise = null

function connectOrPair() {
    if (!setupPromise) {
        setupPromise = (async () => {
            await ensureDefaultProfileName(chrome)
            await attemptNativePairing(chrome)
            await connection.connect()
        })().finally(() => { setupPromise = null })
    }
    return setupPromise
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage())

/** Reconnect immediately after the options page saves new settings. */
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (!('token' in changes || 'port' in changes || 'profile' in changes || 'host' in changes)) return
    connection.restart()
})

chrome.runtime.onStartup.addListener(() => { void connectOrPair() })
chrome.runtime.onInstalled.addListener(() => { void connectOrPair() })
void connectOrPair()
