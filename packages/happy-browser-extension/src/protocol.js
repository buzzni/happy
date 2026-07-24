/**
 * Command dispatch for the happy browser bridge.
 *
 * Kept free of globals — `chrome` is passed in — so the whole protocol is
 * unit-testable outside a browser. The daemon side lives in
 * happy-cli/src/daemon/browserBridge.ts.
 */

import { collectSnapshot } from './snapshot.js'

export class CommandError extends Error {
    constructor(code, message) {
        super(message)
        this.code = code
    }
}

/** The tab a command acts on: an explicit tabId, else the focused tab. */
async function resolveTab(params, chrome) {
    if (params.tabId !== undefined) return { id: params.tabId }
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (!active || active.id === undefined) {
        throw new CommandError('NO_ACTIVE_TAB', 'No active tab to act on')
    }
    return active
}

const handlers = {
    ping: async () => 'pong',

    tabs_list: async (_params, chrome) => {
        const tabs = await chrome.tabs.query({})
        return {
            tabs: tabs
                .filter((tab) => tab.id !== undefined)
                .map((tab) => ({
                    id: tab.id,
                    windowId: tab.windowId,
                    index: tab.index,
                    url: tab.url,
                    title: tab.title,
                    active: tab.active,
                })),
        }
    },

    snapshot: async (params, chrome) => {
        const tab = await resolveTab(params, chrome)
        let results
        try {
            results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: collectSnapshot,
            })
        } catch (e) {
            // chrome:// pages, the Web Store, and PDF viewers refuse injection.
            throw new CommandError('INJECTION_FAILED', e instanceof Error ? e.message : String(e))
        }
        return results[0].result
    },

    screenshot: async (params, chrome) => {
        const tab = await resolveTab(params, chrome)
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
        const [, dataB64] = dataUrl.split(',')
        return { mimeType: 'image/png', dataB64 }
    },
}

export async function handleCommand(message, chrome) {
    const handler = handlers[message.method]
    if (!handler) {
        return { id: message.id, error: { code: 'UNKNOWN_METHOD', message: `Unsupported method: ${message.method}` } }
    }
    try {
        return { id: message.id, result: await handler(message.params ?? {}, chrome) }
    } catch (e) {
        const code = e instanceof CommandError ? e.code : 'COMMAND_FAILED'
        return { id: message.id, error: { code, message: e instanceof Error ? e.message : String(e) } }
    }
}
