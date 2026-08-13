/**
 * Command dispatch for the happy browser bridge.
 *
 * Kept free of globals — `chrome` is passed in — so the whole protocol is
 * unit-testable outside a browser. The daemon side lives in
 * happy-cli/src/daemon/browserBridge.ts.
 */

import { collectSnapshot } from './snapshot.js'
import { clickRef, fillRef, locateRef } from './actions.js'
import { parseAllowlist, isUrlAllowed } from './allowlist.js'
import { isDebuggerTierEnabled, captureFullPage, captureViewport, dispatchTrustedClick, insertTrustedText } from './cdp.js'
import { decodeRef, mergeFrameSnapshots } from './frameRefs.js'

export class CommandError extends Error {
    constructor(code, message) {
        super(message)
        this.code = code
    }
}

async function readAllowlist(chrome) {
    const { allowlist } = await chrome.storage.local.get(['allowlist'])
    return parseAllowlist(allowlist)
}

const ALLOWLIST_HINT = 'the site allowlist configured in the Happy Browser Bridge extension'

/**
 * For a URL the caller supplied (a navigate/tabs_open destination). Echoing
 * it back tells them nothing they didn't already know.
 */
function assertDestinationAllowed(url, allowlist) {
    if (!isUrlAllowed(url, allowlist)) {
        throw new CommandError('SITE_NOT_ALLOWED', `${url} is outside ${ALLOWLIST_HINT}`)
    }
}

/**
 * For a tab the caller only named by id. The URL must NOT appear in the
 * refusal: an agent could otherwise walk tab ids and read back the URLs of
 * exactly the tabs tabs_list filtering exists to hide.
 */
function assertTabAllowed(url, allowlist) {
    if (!isUrlAllowed(url, allowlist)) {
        throw new CommandError('SITE_NOT_ALLOWED', `That tab is outside ${ALLOWLIST_HINT}`)
    }
}

/**
 * The tab a command acts on: an explicit tabId, else the focused tab.
 *
 * Always resolves the full tab (not just its id) because the allowlist check
 * needs the real URL — trusting a caller-supplied one would let the agent
 * name any tab and claim it was allowed.
 */
async function resolveTab(params, chrome, allowlist) {
    let tab
    if (params.tabId !== undefined) {
        try {
            tab = await chrome.tabs.get(params.tabId)
        } catch (e) {
            throw new CommandError('TAB_NOT_FOUND', e instanceof Error ? e.message : String(e))
        }
    } else {
        const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
        // A Chrome under Xvfb (or `--headless=new`) has no window manager, so
        // nothing is ever "last focused" and the query above comes back empty
        // even though a perfectly good active tab exists. Falling back to the
        // active tab of any window is not an arbitrary pick — it is the only
        // information left once focus is meaningless.
        tab = focused ?? (await chrome.tabs.query({ active: true }))[0]
    }
    if (!tab || tab.id === undefined) {
        throw new CommandError('NO_ACTIVE_TAB', 'No active tab to act on')
    }
    assertTabAllowed(tab.url, allowlist)
    return tab
}

function requireParam(params, name) {
    const value = params[name]
    if (value === undefined || value === null || value === '') {
        throw new CommandError('MISSING_PARAM', `Missing required param: ${name}`)
    }
    return value
}

/**
 * Trusted (CDP) input addresses top-level viewport coordinates, but a ref
 * inside an iframe is measured relative to that frame — the two coordinate
 * systems don't line up, so a trusted action on a frame element would hit the
 * wrong spot. Refuse rather than mis-click; untrusted click/fill work in
 * frames because they act on the element, not a point.
 */
function assertTrustedFrameSupported(frameId) {
    if (frameId !== 0) {
        throw new CommandError(
            'TRUSTED_FRAME_UNSUPPORTED',
            'trusted input is not supported on elements inside an iframe (CDP addresses page coordinates, which do not match frame-local ones). Retry without trusted: true — the normal click/fill works inside frames.',
        )
    }
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
async function runPageAction(func, args, params, chrome, allowlist, frameId = 0) {
    const tab = await resolveTab(params, chrome, allowlist)
    let results
    try {
        results = await chrome.scripting.executeScript({
            // Target one frame explicitly. Without frameIds Chrome runs the
            // action in the main frame only, and with allFrames it would run
            // in every frame against whatever @eN means there.
            target: { tabId: tab.id, frameIds: [frameId] },
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

/**
 * Which Chrome profile is answering, as the user named it in the options page.
 *
 * An extension only ever sees its own profile, so an empty tab list is
 * ambiguous: it could be an empty browser, or the bridge talking to a profile
 * the user has no windows open in. Reporting this is what lets the agent tell
 * the two apart instead of insisting the browser is empty.
 */
async function readProfileName(chrome) {
    try {
        const { profile } = await chrome.storage.local.get(['profile'])
        return profile ?? null
    } catch {
        return null
    }
}

/** Null (not 0) when the API is unavailable — "unknown" is not "none". */
async function countWindows(chrome) {
    try {
        const windows = await chrome.windows.getAll()
        return windows.length
    } catch {
        return null
    }
}

const handlers = {
    // Deliberately unrestricted: pairing has to be verifiable even when the
    // allowlist would block every tab, and it reveals nothing about the user.
    ping: async () => 'pong',

    // So the agent can tell whether the debugger tier is available instead of
    // discovering it by having a command fail.
    capabilities: async (_params, chrome) => ({
        commands: Object.keys(handlers),
        debugger: await isDebuggerTierEnabled(chrome),
        profile: await readProfileName(chrome),
    }),

    tabs_list: async (_params, chrome, allowlist) => {
        const tabs = await chrome.tabs.query({})
        return {
            tabs: tabs
                .filter((tab) => tab.id !== undefined)
                // Filtered, not just blocked-on-use: the URL list itself is
                // what the user is keeping private.
                .filter((tab) => isUrlAllowed(tab.url, allowlist))
                .map((tab) => ({
                    id: tab.id,
                    windowId: tab.windowId,
                    index: tab.index,
                    url: tab.url,
                    title: tab.title,
                    active: tab.active,
                })),
            profile: await readProfileName(chrome),
            windowCount: await countWindows(chrome),
            // Pre-allowlist count. Without it "0 tabs" reads as an empty
            // browser even when the allowlist is hiding every one of them.
            totalTabs: tabs.length,
        }
    },

    snapshot: async (params, chrome, allowlist) => {
        const tab = await resolveTab(params, chrome, allowlist)
        let results
        try {
            results = await chrome.scripting.executeScript({
                // Every frame: an embedded editor or payment form lives in an
                // iframe and is otherwise invisible to the agent.
                target: { tabId: tab.id, allFrames: true },
                func: collectSnapshot,
            })
        } catch (e) {
            // chrome:// pages, the Web Store, and PDF viewers refuse injection.
            throw new CommandError('INJECTION_FAILED', e instanceof Error ? e.message : String(e))
        }
        return mergeFrameSnapshots(results)
    },

    screenshot: async (params, chrome, allowlist) => {
        const tab = await resolveTab(params, chrome, allowlist)
        if (params.fullPage) {
            // No silent downgrade to a viewport shot: that would return an
            // image that isn't what was asked for, with nothing saying so.
            return captureFullPage(chrome, tab.id)
        }
        let dataUrl
        try {
            dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
        } catch (e) {
            // A headless Chrome has no composited window surface, so this call
            // is the one thing that cannot work there. CDP can still take the
            // shot — but only if the user granted that tier, and if they did
            // not, the honest answer is the original failure rather than a
            // DEBUGGER_NOT_AVAILABLE that hides what actually broke.
            if (!(await isDebuggerTierEnabled(chrome))) throw e
            return captureViewport(chrome, tab.id)
        }
        const [, dataB64] = dataUrl.split(',')
        return { mimeType: 'image/png', dataB64 }
    },

    click: async (params, chrome, allowlist) => {
        // The agent holds a possibly frame-qualified ref; the injected
        // function only understands the frame-local one.
        const { frameId, innerRef } = decodeRef(requireParam(params, 'ref'))
        if (params.trusted) {
            assertTrustedFrameSupported(frameId)
            const tab = await resolveTab(params, chrome, allowlist)
            const point = await runPageAction(locateRef, [innerRef], params, chrome, allowlist, frameId)
            return dispatchTrustedClick(chrome, tab.id, point)
        }
        return runPageAction(clickRef, [innerRef], params, chrome, allowlist, frameId)
    },

    fill: async (params, chrome, allowlist) => {
        const { frameId, innerRef } = decodeRef(requireParam(params, 'ref'))
        // Unlike the other params, an empty string is valid here — it clears a field.
        if (params.value === undefined || params.value === null) {
            throw new CommandError('MISSING_PARAM', 'Missing required param: value')
        }
        if (params.trusted) {
            assertTrustedFrameSupported(frameId)
            const tab = await resolveTab(params, chrome, allowlist)
            // locateRef focuses the element, so the inserted text lands in it.
            await runPageAction(locateRef, [innerRef], params, chrome, allowlist, frameId)
            return insertTrustedText(chrome, tab.id, params.value)
        }
        return runPageAction(fillRef, [innerRef, params.value], params, chrome, allowlist, frameId)
    },

    navigate: async (params, chrome, allowlist) => {
        const url = requireParam(params, 'url')
        const tab = await resolveTab(params, chrome, allowlist)
        // Both ends are checked: without the destination check the allowlist
        // is trivially bypassed by navigating a permitted tab elsewhere.
        assertDestinationAllowed(url, allowlist)
        await chrome.tabs.update(tab.id, { url })
        return { ok: true }
    },

    tabs_open: async (params, chrome, allowlist) => {
        const url = requireParam(params, 'url')
        assertDestinationAllowed(url, allowlist)
        return chrome.tabs.create({ url })
    },

    tabs_close: async (params, chrome, allowlist) => {
        const tabId = requireParam(params, 'tabId')
        await resolveTab({ tabId }, chrome, allowlist)
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
        // Read per command rather than caching: the user can edit the
        // allowlist mid-session and expects the next command to respect it.
        const allowlist = await readAllowlist(chrome)
        return { id: message.id, result: await handler(message.params ?? {}, chrome, allowlist) }
    } catch (e) {
        // DebuggerUnavailableError carries its own `code` without being a
        // CommandError — honour any error that names one.
        const code = e?.code ?? 'COMMAND_FAILED'
        return { id: message.id, error: { code, message: e instanceof Error ? e.message : String(e) } }
    }
}
