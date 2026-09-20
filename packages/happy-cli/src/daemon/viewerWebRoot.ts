/**
 * The web root websockify serves for the remote browser screen.
 *
 * Stock noVNC is served straight from `/usr/share/novnc`, and two of its
 * defaults make the screen hard to use:
 *
 * - `resize` defaults to `off`, so a 1920x1080 display is drawn at native
 *   size inside whatever window the user has. Anything narrower is clipped
 *   on the right and letterboxed above and below (reported 2026-09-19).
 * - noVNC `preventDefault()`s every keydown on its canvas, so the browser
 *   never fires a `paste` event and ⌘V/Ctrl+V cannot reach the remote end.
 *   The only working path is the control bar's clipboard panel, which nobody
 *   finds.
 *
 * Neither is fixable from the URL alone (users bookmark and paste the bare
 * `/vnc.html` link), so the daemon mirrors noVNC into a writable directory:
 * every asset stays a symlink to the distribution copy, and only the page
 * itself is ours — it seeds the resize default and loads a bridge module.
 *
 * The bridge reaches noVNC's live `RFB` object by importing the same module
 * URL the page imports. ES modules are singletons per URL, so this is the
 * very object the UI drives — no fork of noVNC, no patched vendor tree.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Where the bridge module lives inside the mirrored web root. */
export const VIEWER_BRIDGE_PATH = 'aplus/viewer-bridge.js'

/**
 * How the client should react to a mismatch between its window and the
 * remote screen.
 *
 * `remote` asks the server to resize its desktop to the window — an exact
 * fill, but only TigerVNC's Xvnc honours `SetDesktopSize`. `scale` shrinks
 * the whole screen to fit, which never clips but leaves bars when the
 * aspect ratios differ. Picking the wrong one is not cosmetic: `remote`
 * against a server that ignores it leaves the original clipping in place.
 */
export type ViewerResizeMode = 'remote' | 'scale'

/**
 * Installed into noVNC's page; runs in the browser, not in the daemon.
 *
 * Kept as a real function (serialised with `toString()`) rather than a
 * string blob so it is type-checked and unit-tested. That costs one
 * constraint: it must be **self-contained** — no imports, no module-scope
 * helpers — because only its own body is shipped.
 */
export function installViewerClipboardBridge(UI: any, win: any, doc: any): void {
    const CONTROL_L = 0xffe3
    const LOWERCASE_V = 0x76
    const LOWERCASE_C = 0x63
    // The remote clipboard is set over the same socket, but x11vnc hands the
    // text to the X selection from its own event loop. Pressing Ctrl+V in the
    // same tick can beat it there and paste the previous contents.
    const PASTE_KEY_DELAY_MS = 60
    const FOCUS_RESTORE_MS = 400

    const textarea = doc.createElement('textarea')
    textarea.setAttribute('aria-hidden', 'true')
    textarea.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0'
    doc.body.appendChild(textarea)

    const session = () => (UI && UI.rfb ? UI.rfb : null)

    const restoreFocus = () => {
        const rfb = session()
        // Focus left in the hidden textarea would send every following
        // keystroke there instead of to the remote screen.
        if (rfb && typeof rfb.focus === 'function') rfb.focus()
    }

    /** Presses Ctrl+V on the remote end, which is what actually pastes there. */
    const pressPasteRemotely = () => {
        const rfb = session()
        if (!rfb) return
        rfb.sendKey(CONTROL_L, 'ControlLeft', true)
        rfb.sendKey(LOWERCASE_V, 'KeyV', true)
        rfb.sendKey(LOWERCASE_V, 'KeyV', false)
        rfb.sendKey(CONTROL_L, 'ControlLeft', false)
    }

    const pasteToRemote = (text: string) => {
        const rfb = session()
        if (!rfb || !text) return
        rfb.clipboardPasteFrom(text)
        // Filling the remote clipboard is only half the job: the focused
        // remote app still has to be told to paste, and ⌘V never reaches it
        // (noVNC maps Meta to Alt for the remote end).
        win.setTimeout(pressPasteRemotely, PASTE_KEY_DELAY_MS)
    }

    let nativePasteArrived = false

    const armNativePaste = () => {
        nativePasteArrived = false
        textarea.value = ''
        textarea.focus()
        win.setTimeout(() => {
            // Never strand the keyboard in the hidden textarea.
            restoreFocus()
            if (nativePasteArrived) return
            // No paste event came, so nothing of ours reached the remote end.
            // Hand the shortcut over rather than drop it: the bridge took it
            // in the capture phase, and swallowing it also breaks pasting
            // *within* the remote desktop, which worked before this existed
            // (reported live 2026-09-20).
            pressPasteRemotely()
        }, FOCUS_RESTORE_MS)
    }

    // Chrome asks for clipboard permission on the first read, and that
    // prompt is exactly when people press the shortcut again. Without this,
    // every extra press queues another paste for the moment they allow it.
    let readingClipboard = false

    const isPasteKey = (event: any) => matchesLetterKey(event, 'v', 'KeyV')
    const isCopyKey = (event: any) => matchesLetterKey(event, 'c', 'KeyC')

    // With a Korean (or any non-Latin) layout active the browser can report
    // the composed letter instead of the Latin one. Fall back to the
    // physical key, but only when what it reported is not an ASCII letter of
    // its own — on Dvorak that same key is a different letter and must stay
    // one.
    function matchesLetterKey(event: any, letter: string, code: string): boolean {
        if (event.key === letter || event.key === letter.toUpperCase()) return true
        return event.code === code && !/^[a-zA-Z]$/.test(String(event.key))
    }

    /**
     * noVNC remaps macOS's own Cmd (Super) key itself to Alt for the remote
     * end ("Alt behaves more like AltGraph on macOS" in its keyboard
     * handler). Left alone, a Mac user's Cmd+C reaches a Linux remote as
     * Alt+C, which copies nothing — reported live (2026-09-20). The bridge
     * owns the shortcut instead and always sends Control_L, exactly as it
     * already does for paste.
     */
    const pressCopyRemotely = () => {
        const rfb = session()
        if (!rfb) return
        rfb.sendKey(CONTROL_L, 'ControlLeft', true)
        rfb.sendKey(LOWERCASE_C, 'KeyC', true)
        rfb.sendKey(LOWERCASE_C, 'KeyC', false)
        rfb.sendKey(CONTROL_L, 'ControlLeft', false)
    }

    win.addEventListener('keydown', (event: any) => {
        if (!isCopyKey(event)) return
        if (event.altKey) return
        // Ctrl/Cmd+Shift+C is the element inspector, on both ends — the
        // remote screen runs a browser too. Taking it would rewrite the
        // inspector into a copy and let the remote's answering selection
        // overwrite the local clipboard below. Fall through like Alt does.
        if (event.shiftKey) return
        if (!event.ctrlKey && !event.metaKey) return
        if (!session()) return
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
        // Only the keystroke is forwarded. Whatever the remote's own
        // selection holds comes back through the existing RFB `clipboard`
        // listener below once the remote actually receives a working Ctrl+C.
        pressCopyRemotely()
    }, true)

    win.addEventListener('keydown', (event: any) => {
        if (!isPasteKey(event)) return
        if (event.altKey) return
        if (!event.ctrlKey && !event.metaKey) return
        if (!session()) return
        // Capture phase plus stopImmediatePropagation: noVNC's canvas handler
        // would otherwise preventDefault() this keystroke, and on macOS it
        // rewrites Meta to Alt, so the remote end never sees a paste either
        // way. From here on the bridge owns the shortcut.
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
        const clipboard = win.navigator && win.navigator.clipboard
        if (clipboard && clipboard.readText) {
            if (readingClipboard) return
            readingClipboard = true
            const readText = (text: string) => {
                readingClipboard = false
                pasteToRemote(text)
            }
            const readFailed = (error: unknown) => {
                readingClipboard = false
                if (win.console) win.console.warn('[aplus] clipboard read refused:', error)
                armNativePaste()
            }
            // Reading the clipboard directly, rather than waiting for the
            // browser's own paste event: Chrome decides the paste target when
            // it handles the shortcut, and a canvas is not editable, so
            // focusing a textarea mid-keydown produces no paste at all
            // (measured in a real Chrome against the live screen).
            //
            // The try/catch is not redundant with the rejection handler: a
            // browser that has the method but refuses outright (insecure
            // context) throws instead of rejecting, and leaving the in-flight
            // flag set would disable pasting for the rest of the session.
            try {
                clipboard.readText().then(readText, readFailed)
            } catch (error) {
                readFailed(error)
            }
            return
        }
        armNativePaste()
    }, true)

    textarea.addEventListener('paste', (event: any) => {
        nativePasteArrived = true
        const text = event.clipboardData ? event.clipboardData.getData('text') : ''
        if (typeof event.preventDefault === 'function') event.preventDefault()
        restoreFocus()
        pasteToRemote(text)
    })

    let attached: any = null
    const attachCopyOut = () => {
        const rfb = session()
        if (!rfb || rfb === attached) return
        attached = rfb
        rfb.addEventListener('clipboard', (event: any) => {
            const text = event && event.detail ? event.detail.text : ''
            const clipboard = win.navigator && win.navigator.clipboard
            if (!text || !clipboard || !clipboard.writeText) return
            clipboard.writeText(text).catch((error: unknown) => {
                // Copy-out is a convenience — the text is still in noVNC's own
                // clipboard panel. Say why it was dropped rather than vanish.
                if (win.console) win.console.warn('[aplus] local clipboard write refused:', error)
            })
        })
    }
    attachCopyOut()
    // The RFB object is replaced on every reconnect, so the hook has to be
    // re-attached rather than installed once.
    win.setInterval(attachCopyOut, 500)
}

export function buildViewerBridgeModule(): string {
    return [
        "// Generated by happy-cli — see src/daemon/viewerWebRoot.ts.",
        "import UI from '../app/ui.js'",
        `;(${installViewerClipboardBridge.toString()})(UI, window, document)`,
        '',
    ].join('\n')
}

function resizeSeedScript(resizeMode: ViewerResizeMode): string {
    return [
        '<script>',
        '    // Default only: noVNC reads the query string first and this',
        '    // second, so a mode picked in the settings panel still wins.',
        '    try {',
        "        if (window.localStorage.getItem('resize') === null) {",
        `            window.localStorage.setItem('resize', '${resizeMode}');`,
        '        }',
        '    } catch (e) { /* private mode: the stock default applies */ }',
        '</script>',
    ].join('\n')
}

export function buildViewerIndexHtml({ sourceHtml, resizeMode }: {
    sourceHtml: string
    resizeMode: ViewerResizeMode
}): string {
    const headClose = sourceHtml.indexOf('</head>')
    if (headClose < 0) {
        throw new Error('noVNC vnc.html has no </head> to patch')
    }
    const injection = [
        resizeSeedScript(resizeMode),
        `<script type="module" crossorigin="anonymous" src="${VIEWER_BRIDGE_PATH}"></script>`,
        '',
    ].join('\n')
    return sourceHtml.slice(0, headClose) + injection + sourceHtml.slice(headClose)
}

function viewerWebRootIsCurrent({ sourceRoot, targetRoot, html, bridge }: {
    sourceRoot: string
    targetRoot: string
    html: string
    bridge: string
}): boolean {
    try {
        if (readFileSync(join(targetRoot, 'vnc.html'), 'utf8') !== html) return false
        if (readFileSync(join(targetRoot, 'index.html'), 'utf8') !== html) return false
        if (readFileSync(join(targetRoot, VIEWER_BRIDGE_PATH), 'utf8') !== bridge) return false
        // An upgraded noVNC can ship new assets while leaving vnc.html alone,
        // and a mirror missing them serves a page that cannot load itself.
        const mirrored = new Set(readdirSync(targetRoot))
        return readdirSync(sourceRoot).every((entry) => mirrored.has(entry))
    } catch {
        return false
    }
}

/**
 * Builds the mirrored web root, returning the directory websockify should
 * serve.
 *
 * Falls back to the distribution root when anything about that install is
 * not what we expect: losing the enhancements is a much smaller failure
 * than losing the remote screen, but it is logged rather than swallowed.
 */
export function ensureViewerWebRoot({ sourceRoot, targetRoot, resizeMode, onFallback }: {
    sourceRoot: string
    targetRoot: string
    resizeMode: ViewerResizeMode
    /** Called with the reason when the mirror could not be built. */
    onFallback?: (reason: string) => void
}): string {
    let rebuilding = false
    try {
        const html = buildViewerIndexHtml({
            sourceHtml: readFileSync(join(sourceRoot, 'vnc.html'), 'utf8'),
            resizeMode,
        })
        const bridge = buildViewerBridgeModule()
        // Another slot's websockify may be serving this very directory, and
        // it opens files per request: rebuilding one that is already correct
        // would 404 whatever asset is in flight for no gain.
        if (viewerWebRootIsCurrent({ sourceRoot, targetRoot, html, bridge })) return targetRoot
        rebuilding = true
        rmSync(targetRoot, { recursive: true, force: true })
        // 0700 like everything else under browser-viewers: this call can be
        // what creates that shared parent, and it must not land looser than
        // the profile directories beside it.
        mkdirSync(join(targetRoot, dirname(VIEWER_BRIDGE_PATH)), { recursive: true, mode: 0o700 })
        for (const entry of readdirSync(sourceRoot)) {
            // Our own copies of both, so the page is patched whether it is
            // reached as /vnc.html or as the directory index.
            if (entry === 'vnc.html' || entry === 'index.html') continue
            symlinkSync(join(sourceRoot, entry), join(targetRoot, entry))
        }
        writeFileSync(join(targetRoot, 'vnc.html'), html)
        writeFileSync(join(targetRoot, 'index.html'), html)
        writeFileSync(join(targetRoot, VIEWER_BRIDGE_PATH), bridge)
        return targetRoot
    } catch (error) {
        onFallback?.(String(error))
        // Only clean up a mirror this call was in the middle of building. A
        // read failure before that leaves the previous mirror alone — another
        // slot's websockify may be serving it right now.
        if (rebuilding && existsSync(targetRoot)) rmSync(targetRoot, { recursive: true, force: true })
        return sourceRoot
    }
}
