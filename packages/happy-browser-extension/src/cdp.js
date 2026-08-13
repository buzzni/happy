/**
 * Chrome DevTools Protocol tier (Phase 5).
 *
 * Attaching puts a "Chrome is being debugged" banner on the tab and grants
 * far more power than the tabs/scripting tier, so it stays off until the
 * user turns it on.
 *
 * That gate is a stored setting rather than an optional Chrome permission,
 * because Chrome does not allow one: `debugger` is on the documented list of
 * permissions that cannot appear in `optional_permissions` (alongside
 * `proxy`, `devtools`, ...). Declaring it there is silently ignored, and the
 * runtime request then fails with "Only permissions specified in the
 * manifest may be requested" — which is how this was found. So `debugger` is
 * a required permission and we enforce the opt-in ourselves.
 *
 * The security property that matters is preserved: the agent has no protocol
 * command that writes extension storage, so it cannot switch this on for
 * itself — the same reasoning as the allowlist. What is weaker than a real
 * optional permission: Chrome grants the capability at install time, so the
 * install prompt warns about it and the guard is our code rather than the
 * browser's. Per-use visibility still comes from Chrome's own banner.
 *
 * Scope is limited to what genuinely needs CDP:
 *   - trusted input (isTrusted events; synthetic ones are refused by some
 *     editors and by anything guarding against scripted clicks)
 *   - full-page screenshots (captureBeyondViewport)
 * iframe/shadow-DOM traversal is deliberately NOT here — executeScript's
 * `allFrames` and `element.shadowRoot` cover it without any of this.
 */

const PROTOCOL_VERSION = '1.3'

export class DebuggerUnavailableError extends Error {
    constructor() {
        super('The debugger tier is turned off. Ask the user to enable "정밀 제어(디버거)" in the Happy Browser Bridge options page — only they can turn it on.')
        this.code = 'DEBUGGER_NOT_AVAILABLE'
    }
}

export async function isDebuggerTierEnabled(chrome) {
    try {
        const { debuggerTier } = await chrome.storage.local.get(['debuggerTier'])
        return debuggerTier === true
    } catch {
        // A stripped-down test double, or storage unavailable: treat as off
        // rather than letting the whole command fail — and off is the safe
        // direction for a capability this broad.
        return false
    }
}

/** Attach for the duration of `body`, and always detach afterwards. */
export async function withDebugger(chrome, tabId, body) {
    if (!(await isDebuggerTierEnabled(chrome))) throw new DebuggerUnavailableError()

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

/**
 * The same shot `chrome.tabs.captureVisibleTab` gives, taken through CDP.
 *
 * Only used as its fallback: captureVisibleTab needs a composited, visible
 * window surface, which a headless Chrome does not have. Deliberately NOT
 * captureBeyondViewport — this must stay the viewport shot the caller asked
 * for, not a quiet upgrade to a full-page one.
 */
export async function captureViewport(chrome, tabId) {
    return withDebugger(chrome, tabId, async ({ send }) => {
        const { data } = await send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: false,
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
