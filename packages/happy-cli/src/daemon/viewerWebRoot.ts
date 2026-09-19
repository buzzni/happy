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

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

    const pasteToRemote = (text: string) => {
        const rfb = session()
        if (!rfb || !text) return
        rfb.clipboardPasteFrom(text)
        // Filling the remote clipboard is only half the job: the focused
        // remote app still has to be told to paste, and ⌘V never reaches it
        // (noVNC maps Meta to Alt for the remote end).
        win.setTimeout(() => {
            rfb.sendKey(CONTROL_L, 'ControlLeft', true)
            rfb.sendKey(LOWERCASE_V, 'KeyV', true)
            rfb.sendKey(LOWERCASE_V, 'KeyV', false)
            rfb.sendKey(CONTROL_L, 'ControlLeft', false)
        }, PASTE_KEY_DELAY_MS)
    }

    const armNativePaste = () => {
        textarea.value = ''
        textarea.focus()
        // Backstop for browsers that produce no paste event at all: never
        // strand the keyboard in the hidden textarea.
        win.setTimeout(restoreFocus, FOCUS_RESTORE_MS)
    }

    win.addEventListener('keydown', (event: any) => {
        if (event.key !== 'v' && event.key !== 'V') return
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
            // Reading the clipboard directly, rather than waiting for the
            // browser's own paste event: Chrome decides the paste target when
            // it handles the shortcut, and a canvas is not editable, so
            // focusing a textarea mid-keydown produces no paste at all
            // (measured in a real Chrome against the live screen).
            clipboard.readText().then(pasteToRemote, (error: unknown) => {
                if (win.console) win.console.warn('[aplus] clipboard read refused:', error)
                armNativePaste()
            })
            return
        }
        armNativePaste()
    }, true)

    textarea.addEventListener('paste', (event: any) => {
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
        // Built aside and swapped in, never in place: the slots already
        // serving this directory must keep a complete tree if anything below
        // throws halfway through.
        const stagingRoot = `${targetRoot}.staging-${process.pid}-${Date.now().toString(36)}`
        try {
            rmSync(stagingRoot, { recursive: true, force: true })
            mkdirSync(join(stagingRoot, dirname(VIEWER_BRIDGE_PATH)), { recursive: true })
            for (const entry of readdirSync(sourceRoot)) {
                // Our own copies of both, so the page is patched whether it is
                // reached as /vnc.html or as the directory index.
                if (entry === 'vnc.html' || entry === 'index.html') continue
                symlinkSync(join(sourceRoot, entry), join(stagingRoot, entry))
            }
            writeFileSync(join(stagingRoot, 'vnc.html'), html)
            writeFileSync(join(stagingRoot, 'index.html'), html)
            writeFileSync(join(stagingRoot, VIEWER_BRIDGE_PATH), bridge)
            swapViewerWebRoot({ stagingRoot, targetRoot })
        } finally {
            rmSync(stagingRoot, { recursive: true, force: true })
        }
        return targetRoot
    } catch (error) {
        onFallback?.(String(error))
        // Deliberately leaves targetRoot untouched: it carries no slot
        // identity, so removing it would 404 vnc.html and every asset for
        // whichever slots are serving it right now — this start losing the
        // enhancements must not take their screens down with it.
        return sourceRoot
    }
}

/**
 * Moves a fully built staging tree into place.
 *
 * `renameSync` refuses a non-empty destination, so the live mirror is moved
 * aside first and only dropped once the new tree has landed: a failure
 * mid-swap puts the previous mirror back rather than leaving the slots
 * serving it with nothing.
 */
function swapViewerWebRoot({ stagingRoot, targetRoot }: {
    stagingRoot: string
    targetRoot: string
}): void {
    const retiredRoot = `${targetRoot}.retired-${process.pid}-${Date.now().toString(36)}`
    const retired = existsSync(targetRoot)
    if (retired) renameSync(targetRoot, retiredRoot)
    try {
        renameSync(stagingRoot, targetRoot)
    } catch (error) {
        if (retired) renameSync(retiredRoot, targetRoot)
        throw error
    }
    rmSync(retiredRoot, { recursive: true, force: true })
}
