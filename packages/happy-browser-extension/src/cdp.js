/**
 * Chrome DevTools Protocol tier (Phase 5).
 *
 * `debugger` is an *optional* permission, and deliberately so: attaching puts
 * a "Chrome is being debugged" banner on the tab and grants far more power
 * than the tabs/scripting tier. Only the user can turn it on (from the
 * options page — chrome.permissions.request needs a user gesture), which is
 * the same property the allowlist relies on: the agent cannot widen its own
 * authority.
 *
 * Scope is limited to what genuinely needs CDP:
 *   - trusted input (isTrusted events; synthetic ones are refused by some
 *     editors and by anything guarding against scripted clicks)
 *   - full-page screenshots (captureBeyondViewport)
 * iframe/shadow-DOM traversal is deliberately NOT here — executeScript's
 * `allFrames` and `element.shadowRoot` cover it without this permission.
 */

const PROTOCOL_VERSION = '1.3'

export class DebuggerUnavailableError extends Error {
    constructor() {
        super('The debugger permission is not granted. Ask the user to enable "정밀 제어(디버거)" in the Happy Browser Bridge options page — only they can grant it.')
        this.code = 'DEBUGGER_NOT_AVAILABLE'
    }
}

export async function hasDebuggerPermission(chrome) {
    try {
        return await chrome.permissions.contains({ permissions: ['debugger'] })
    } catch {
        // Older Chrome, or a stripped-down test double: treat as unavailable
        // rather than letting the whole command fail.
        return false
    }
}

/** Attach for the duration of `body`, and always detach afterwards. */
export async function withDebugger(chrome, tabId, body) {
    if (!(await hasDebuggerPermission(chrome))) throw new DebuggerUnavailableError()

    const target = { tabId }
    await chrome.debugger.attach(target, PROTOCOL_VERSION)
    try {
        return await body({
            send: (method, params) => chrome.debugger.sendCommand(target, method, params),
        })
    } finally {
        try {
            await chrome.debugger.detach(target)
        } catch {
            // The tab may already be gone. Losing the detach must not turn a
            // successful command into a failure.
        }
    }
}

export async function captureFullPage(chrome, tabId) {
    return withDebugger(chrome, tabId, async ({ send }) => {
        const { data } = await send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
        })
        return { mimeType: 'image/png', dataB64: data }
    })
}

export async function dispatchTrustedClick(chrome, tabId, { x, y }) {
    return withDebugger(chrome, tabId, async ({ send }) => {
        const common = { x, y, button: 'left', clickCount: 1 }
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common })
        return { ok: true }
    })
}

export async function insertTrustedText(chrome, tabId, text) {
    return withDebugger(chrome, tabId, async ({ send }) => {
        await send('Input.insertText', { text })
        return { ok: true }
    })
}
