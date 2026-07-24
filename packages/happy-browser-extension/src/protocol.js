/**
 * Command dispatch for the happy browser bridge.
 *
 * Kept free of globals — `chrome` is passed in — so the whole protocol is
 * unit-testable outside a browser. The daemon side lives in
 * happy-cli/src/daemon/browserBridge.ts.
 */

import { collectSnapshot } from './snapshot.js'
import { clickRef, fillRef } from './actions.js'

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

function requireParam(params, name) {
    const value = params[name]
    if (value === undefined || value === null || value === '') {
        throw new CommandError('MISSING_PARAM', `Missing required param: ${name}`)
    }
    return value
}

/**
 * Run a ref-targeted action (clickRef/fillRef) in the page.
 *
 * clickRef/fillRef never throw — confirmed against real Chrome that a
 * thrown error crossing chrome.scripting.executeScript's boundary can
 * resolve as silent success instead of rejecting the call, which read to
 * the caller as the action having worked. So failure is a normal return
 * value (`{ok: false, code, message}`), checked here explicitly.
 */
async function runPageAction(func, args, params, chrome) {
    const tab = await resolveTab(params, chrome)
    let results
    try {
        results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func,
            args,
        })
    } catch (e) {
        // A true injection-time refusal (chrome:// pages, PDF viewer, ...),
        // distinct from the action itself failing.
        throw new CommandError('INJECTION_FAILED', e instanceof Error ? e.message : String(e))
    }
    const injectionResult = results[0]
    const result = injectionResult.result
    // A missing result is not success — surface it instead of silently
    // treating "we don't know what happened" as "it worked". Includes the
    // raw injection result so a real-Chrome mismatch is diagnosable without
    // needing the service worker's own devtools console.
    if (result === undefined || result === null) {
        throw new CommandError('NO_RESULT', `Action produced no result. raw=${JSON.stringify(injectionResult)}`)
    }
    if (result.ok === false) {
        throw new CommandError(result.code ?? 'ACTION_FAILED', result.message ?? 'action failed')
    }
    return result
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

    click: async (params, chrome) => {
        const ref = requireParam(params, 'ref')
        return runPageAction(clickRef, [ref], params, chrome)
    },

    fill: async (params, chrome) => {
        const ref = requireParam(params, 'ref')
        // Unlike the other params, an empty string is valid here — it clears a field.
        if (params.value === undefined || params.value === null) {
            throw new CommandError('MISSING_PARAM', 'Missing required param: value')
        }
        return runPageAction(fillRef, [ref, params.value], params, chrome)
    },

    navigate: async (params, chrome) => {
        const url = requireParam(params, 'url')
        const tab = await resolveTab(params, chrome)
        await chrome.tabs.update(tab.id, { url })
        return { ok: true }
    },

    tabs_open: async (params, chrome) => {
        const url = requireParam(params, 'url')
        return chrome.tabs.create({ url })
    },

    tabs_close: async (params, chrome) => {
        const tabId = requireParam(params, 'tabId')
        await chrome.tabs.remove(tabId)
        return { ok: true }
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
