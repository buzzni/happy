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
import { prepareLocalConnection } from './nativePairing.js'
import { ensureDefaultProfileName } from './profileId.js'

const connection = createConnection({ chrome, WebSocketImpl: WebSocket })
let setupPromise = null

/** Resolves to the startup preparation result; concurrent callers share one run. */
function connectOrPair() {
    if (!setupPromise) {
        setupPromise = (async () => {
            await ensureDefaultProfileName(chrome)
            const prepared = await prepareLocalConnection(chrome)
            if (prepared.status === 'awaiting-approval') await flagApproval()
            await connection.connect()
            return prepared
        })().finally(() => { setupPromise = null })
    }
    return setupPromise
}

/** Approval happens only on the options page; the badge asks for it unless another pairing is already working. */
async function flagApproval() {
    const { token } = await chrome.storage.local.get(['token'])
    if (token) return
    chrome.action.setBadgeText({ text: '!' })
    chrome.action.setBadgeBackgroundColor({ color: '#c2701c' })
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage())

/** Reconnect immediately after the options page saves new settings. */
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (!('token' in changes || 'port' in changes || 'profile' in changes || 'pairingId' in changes || 'viewerKey' in changes || 'host' in changes)) return
    connection.restart()
})

chrome.runtime.onStartup.addListener(() => { void connectOrPair() })
chrome.runtime.onInstalled.addListener(details => {
    void connectOrPair().then(prepared => {
        // Opened once, right after a fresh install, so the user sees the one approval step.
        if (details.reason === 'install' && prepared.status === 'awaiting-approval') return chrome.runtime.openOptionsPage()
    })
})
void connectOrPair()
