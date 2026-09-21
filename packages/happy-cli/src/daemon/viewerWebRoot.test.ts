import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, readlinkSync, lstatSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
    buildViewerBridgeModule,
    buildViewerIndexHtml,
    ensureViewerWebRoot,
    installViewerClipboardBridge,
    VIEWER_BRIDGE_PATH,
} from './viewerWebRoot'

const STOCK_HTML = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '    <title>noVNC</title>',
    '    <script type="module" crossorigin="anonymous" src="app/ui.js"></script>',
    '</head>',
    '<body></body>',
    '</html>',
].join('\n')

describe('buildViewerIndexHtml', () => {
    it('seeds the resize default the backend can actually honour', () => {
        const remote = buildViewerIndexHtml({ sourceHtml: STOCK_HTML, resizeMode: 'remote' })
        const scale = buildViewerIndexHtml({ sourceHtml: STOCK_HTML, resizeMode: 'scale' })

        expect(remote).toContain("'resize', 'remote'")
        expect(remote).not.toContain("'resize', 'scale'")
        expect(scale).toContain("'resize', 'scale'")
        expect(scale).not.toContain("'resize', 'remote'")
    })

    it('keeps noVNC\'s own scripts and adds the bridge module inside head', () => {
        const html = buildViewerIndexHtml({ sourceHtml: STOCK_HTML, resizeMode: 'remote' })

        expect(html).toContain('src="app/ui.js"')
        expect(html).toContain(`src="${VIEWER_BRIDGE_PATH}"`)
        expect(html.indexOf(VIEWER_BRIDGE_PATH)).toBeLessThan(html.indexOf('</head>'))
    })

    // The seed only works as a default because noVNC reads the query string
    // first and localStorage second: a user who picked a mode in the settings
    // panel must keep it.
    it('never overwrites a resize mode the user already chose', () => {
        const html = buildViewerIndexHtml({ sourceHtml: STOCK_HTML, resizeMode: 'remote' })

        expect(html).toMatch(/getItem\('resize'\) === null/)
    })

    it('refuses to build a page it cannot patch instead of serving a silent stock copy', () => {
        expect(() => buildViewerIndexHtml({ sourceHtml: '<html><body></body></html>', resizeMode: 'remote' }))
            .toThrow(/head/)
    })
})

describe('buildViewerBridgeModule', () => {
    // The module gets its RFB handle by importing the very module noVNC's own
    // page imports — ES modules are per-URL singletons, so this is the same
    // UI object, without forking noVNC.
    it('imports noVNC\'s UI module and installs the bridge against it', () => {
        const source = buildViewerBridgeModule()

        expect(source).toContain("from '../app/ui.js'")
        expect(source).toContain('installViewerClipboardBridge')
        expect(source).toContain('window, document')
    })
})

describe('ensureViewerWebRoot', () => {
    let sourceRoot: string
    let baseDir: string

    beforeEach(() => {
        const base = mkdtempSync(join(tmpdir(), 'viewer-web-root-'))
        sourceRoot = join(base, 'novnc')
        baseDir = join(base, 'mirror')
        mkdirSync(join(sourceRoot, 'app'), { recursive: true })
        writeFileSync(join(sourceRoot, 'vnc.html'), STOCK_HTML)
        writeFileSync(join(sourceRoot, 'app', 'ui.js'), 'export default {}')
    })

    it('serves a patched page while leaving noVNC\'s assets where they are', () => {
        const root = ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'remote' })

        expect(root.startsWith(join(baseDir, 'remote-'))).toBe(true)
        expect(readFileSync(join(root, 'vnc.html'), 'utf8')).toContain(VIEWER_BRIDGE_PATH)
        expect(lstatSync(join(root, 'app')).isSymbolicLink()).toBe(true)
        expect(readlinkSync(join(root, 'app'))).toBe(join(sourceRoot, 'app'))
        expect(existsSync(join(root, VIEWER_BRIDGE_PATH))).toBe(true)
    })

    // Debian's package makes / an alias of vnc.html; a symlink there would
    // serve the unpatched original and quietly undo both fixes.
    it('patches the directory index too', () => {
        symlinkSync(join(sourceRoot, 'vnc.html'), join(sourceRoot, 'index.html'))

        const root = ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'remote' })

        expect(lstatSync(join(root, 'index.html')).isSymbolicLink()).toBe(false)
        expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain(VIEWER_BRIDGE_PATH)
    })

    it('gives each mode its own root instead of overwriting the other', () => {
        const scale = ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'scale' })
        const remote = ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'remote' })

        expect(remote).not.toBe(scale)
        expect(readFileSync(join(remote, 'vnc.html'), 'utf8')).toContain("'resize', 'remote'")
        expect(readFileSync(join(scale, 'vnc.html'), 'utf8')).toContain("'resize', 'scale'")
    })

    // A machine whose noVNC install does not look like we expect still has a
    // working remote screen — losing the enhancements must not lose the screen.
    it('falls back to the stock root rather than serving nothing', () => {
        writeFileSync(join(sourceRoot, 'vnc.html'), '<html><body>no head</body></html>')

        expect(ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'remote' })).toBe(sourceRoot)
    })
})

type Listener = (event: any) => void

function fakeDom() {
    const windowListeners = new Map<string, Array<{ listener: Listener; capture: boolean }>>()
    const elementListeners = new Map<string, Listener[]>()
    const timeouts: Array<() => void> = []
    const warnings: unknown[][] = []
    const written: string[] = []

    const textarea = {
        value: 'stale',
        style: {} as Record<string, string>,
        focused: false,
        setAttribute() { },
        focus() { textarea.focused = true },
        addEventListener(type: string, listener: Listener) {
            const list = elementListeners.get(type) ?? []
            list.push(listener)
            elementListeners.set(type, list)
        },
    }

    const doc = {
        body: { appended: [] as unknown[], appendChild(node: unknown) { doc.body.appended.push(node) } },
        createElement: () => textarea,
    }

    const win = {
        addEventListener(type: string, listener: Listener, capture?: boolean) {
            const list = windowListeners.get(type) ?? []
            list.push({ listener, capture: capture === true })
            windowListeners.set(type, list)
        },
        setTimeout(fn: () => void) { timeouts.push(fn); return timeouts.length },
        setInterval() { return 0 },
        clearTimeout() { },
        console: { warn: (...args: unknown[]) => { warnings.push(args) } },
        navigator: {
            clipboard: {
                readText: null as null | (() => Promise<string>),
                writeText(text: string) { written.push(text); return Promise.resolve() },
            },
        },
    }

    return {
        win,
        doc,
        textarea,
        warnings,
        written,
        fireKeydown(event: Record<string, unknown>) {
            for (const { listener } of windowListeners.get('keydown') ?? []) listener(event)
        },
        firePaste(event: Record<string, unknown>) {
            for (const listener of elementListeners.get('paste') ?? []) listener(event)
        },
        runTimeouts() {
            while (timeouts.length > 0) (timeouts.shift() as () => void)()
        },
        keydownIsCapturing() {
            return (windowListeners.get('keydown') ?? []).every((entry) => entry.capture)
        },
    }
}

function fakeRfb() {
    const keys: Array<[number, string, boolean]> = []
    const pasted: string[] = []
    const listeners = new Map<string, Listener[]>()
    return {
        keys,
        pasted,
        focused: 0,
        clipboardPasteFrom(text: string) { pasted.push(text) },
        sendKey(keysym: number, code: string, down: boolean) { keys.push([keysym, code, down]) },
        focus() { this.focused += 1 },
        addEventListener(type: string, listener: Listener) {
            const list = listeners.get(type) ?? []
            list.push(listener)
            listeners.set(type, list)
        },
        emit(type: string, event: unknown) {
            for (const listener of listeners.get(type) ?? []) listener(event)
        },
    }
}

const CONTROL_L = 0xffe3
const ALT_L = 0xffe9
const LOWERCASE_V = 0x76
const LOWERCASE_C = 0x63

describe('installViewerClipboardBridge', () => {
    it('intercepts the paste shortcut before noVNC swallows the keystroke', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        let stopped = 0
        dom.fireKeydown({ key: 'v', metaKey: true, stopImmediatePropagation: () => { stopped += 1 } })

        // noVNC preventDefaults every keydown on its canvas and rewrites Meta
        // to Alt for the remote end, so unless the event is stopped in the
        // capture phase nothing about this shortcut works.
        expect(dom.keydownIsCapturing()).toBe(true)
        expect(stopped).toBe(1)
    })

    // Chrome picks the paste target when it handles the shortcut, and the
    // canvas is not editable — focusing a hidden textarea mid-keydown produces
    // no paste event at all (measured against the live screen 2026-09-19).
    it('reads the clipboard directly instead of waiting for a paste event', async () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        dom.win.navigator.clipboard.readText = () => Promise.resolve('sts-json')
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'v', ctrlKey: true, stopImmediatePropagation: () => { } })
        await Promise.resolve()
        await Promise.resolve()
        dom.runTimeouts()

        expect(dom.textarea.focused).toBe(false)
        expect(rfb.pasted).toEqual(['sts-json'])
        expect(rfb.keys).toEqual([
            [CONTROL_L, 'ControlLeft', true],
            [LOWERCASE_V, 'KeyV', true],
            [LOWERCASE_V, 'KeyV', false],
            [CONTROL_L, 'ControlLeft', false],
        ])
    })

    it('falls back to the browser\'s own paste event when the clipboard is refused', async () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        dom.win.navigator.clipboard.readText = () => Promise.reject(new Error('denied'))
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'v', ctrlKey: true, stopImmediatePropagation: () => { } })
        await Promise.resolve()
        await Promise.resolve()

        expect(dom.textarea.focused).toBe(true)
        expect(dom.warnings.length).toBe(1)
    })

    it('falls back on a browser with no clipboard read at all', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'v', ctrlKey: true, stopImmediatePropagation: () => { } })

        expect(dom.textarea.focused).toBe(true)
    })

    it('leaves every other keystroke to noVNC', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        let stopped = 0
        const stopImmediatePropagation = () => { stopped += 1 }
        dom.fireKeydown({ key: 'v', stopImmediatePropagation })
        dom.fireKeydown({ key: 'a', metaKey: true, stopImmediatePropagation })
        dom.fireKeydown({ key: 'v', ctrlKey: true, altKey: true, stopImmediatePropagation })
        // Cmd+C and Ctrl+C are copy — the bridge owns those too (see the
        // dedicated describe block below) precisely so this one stays
        // untouched.
        dom.fireKeydown({ key: 'c', ctrlKey: true, altKey: true, stopImmediatePropagation })

        expect(stopped).toBe(0)
        expect(dom.textarea.focused).toBe(false)
    })

    it('does not steal the shortcut before a session exists', () => {
        const dom = fakeDom()
        installViewerClipboardBridge({ rfb: null }, dom.win, dom.doc)

        let stopped = 0
        dom.fireKeydown({ key: 'v', ctrlKey: true, stopImmediatePropagation: () => { stopped += 1 } })

        expect(stopped).toBe(0)
    })

    it('sends the text to the remote clipboard and then presses Ctrl+V there', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'v', metaKey: true, stopImmediatePropagation: () => { } })
        dom.firePaste({
            clipboardData: { getData: () => 'aws-secret' },
            preventDefault: () => { },
        })
        dom.runTimeouts()

        expect(rfb.pasted).toEqual(['aws-secret'])
        // Copying the text into the remote clipboard is only half of it: the
        // focused remote app still has to be told to paste, and ⌘V never
        // reaches it (noVNC maps Meta to Alt for the remote end). That same
        // remap also leaves Alt down, so it is released first — the dedicated
        // test below pins why.
        expect(rfb.keys).toEqual([
            [ALT_L, 'AltLeft', false],
            [CONTROL_L, 'ControlLeft', true],
            [LOWERCASE_V, 'KeyV', true],
            [LOWERCASE_V, 'KeyV', false],
            [CONTROL_L, 'ControlLeft', false],
        ])
    })

    it('hands the keyboard back to the screen after pasting', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'v', metaKey: true, stopImmediatePropagation: () => { } })
        dom.firePaste({ clipboardData: { getData: () => 'text' }, preventDefault: () => { } })

        // Focus parked in the hidden textarea would send every later keystroke
        // there instead of to the remote screen.
        expect(rfb.focused).toBeGreaterThan(0)
    })

    it('restores focus even when the browser fires no paste at all', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'v', metaKey: true, stopImmediatePropagation: () => { } })
        dom.runTimeouts()

        expect(rfb.focused).toBeGreaterThan(0)
    })

    it('sends nothing when the clipboard turns out to be empty', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'v', metaKey: true, stopImmediatePropagation: () => { } })
        dom.firePaste({ clipboardData: { getData: () => '' }, preventDefault: () => { } })
        dom.runTimeouts()

        expect(rfb.pasted).toEqual([])
        expect(rfb.keys).toEqual([])
    })

    it('copies text selected on the remote screen into the local clipboard', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        rfb.emit('clipboard', { detail: { text: 'from-remote' } })

        expect(dom.written).toEqual(['from-remote'])
    })

    it('says why a refused local clipboard write was dropped', async () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        dom.win.navigator.clipboard.writeText = () => Promise.reject(new Error('denied'))
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        rfb.emit('clipboard', { detail: { text: 'from-remote' } })
        await Promise.resolve()
        await Promise.resolve()

        expect(dom.warnings.length).toBe(1)
    })
})

describe('ensureViewerWebRoot idempotence', () => {
    let sourceRoot: string
    let baseDir: string

    beforeEach(() => {
        const base = mkdtempSync(join(tmpdir(), 'viewer-web-root-again-'))
        sourceRoot = join(base, 'novnc')
        baseDir = join(base, 'mirror')
        mkdirSync(join(sourceRoot, 'app'), { recursive: true })
        writeFileSync(join(sourceRoot, 'vnc.html'), STOCK_HTML)
        writeFileSync(join(sourceRoot, 'app', 'ui.js'), 'export default {}')
    })

    // websockify opens files per request, and several viewer slots share one
    // mirror: tearing down a directory that is already correct would 404
    // whatever asset another user's page is loading right then.
    it('leaves an already-current mirror alone', () => {
        const root = ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'remote' })
        const witness = join(root, 'rebuild-witness')
        writeFileSync(witness, 'x')

        expect(ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'remote' })).toBe(root)
        expect(existsSync(witness)).toBe(true)
    })

    // The rename-collision branch: the name is right but what is under it is
    // not, which no correct viewer can be serving, so it is rebuilt in place.
    // "Not current" is not "not in use": a root with only index.html gone
    // still serves /vnc.html to every session on it. Repair has to publish a
    // fresh directory under the name and move the old one aside — a rename
    // keeps its inode, so a websockify chdir'd into it keeps working — never
    // delete it, which is the outage.
    it('repairs a root that carries the right name with the wrong contents without deleting it', () => {
        const root = ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'remote' })
        writeFileSync(join(root, 'index.html'), 'corrupted')

        const again = ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'remote' })

        expect(again).toBe(root)
        expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain(VIEWER_BRIDGE_PATH)
        const entries = readdirSync(baseDir)
        expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false)
        const movedAside = entries.find((entry) => entry !== basename(root))
        expect(movedAside).toBeDefined()
        expect(readFileSync(join(baseDir, movedAside as string, 'index.html'), 'utf8')).toBe('corrupted')
    })

    // Every asset in the mirror is a symlink into the install it was built
    // from, so reusing a root across installs would serve symlinks pointing
    // at a path that may no longer exist.
    it('does not reuse a root built against a different noVNC install', () => {
        const other = join(baseDir, '..', 'novnc-moved')
        mkdirSync(join(other, 'app'), { recursive: true })
        writeFileSync(join(other, 'vnc.html'), STOCK_HTML)
        writeFileSync(join(other, 'app', 'ui.js'), 'export default {}')

        const fromFirst = ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'remote' })
        const fromOther = ensureViewerWebRoot({ sourceRoot: other, baseDir, resizeMode: 'remote' })

        expect(fromOther).not.toBe(fromFirst)
        expect(readlinkSync(join(fromOther, 'app'))).toBe(join(other, 'app'))
    })

    // 2026-09-21, walter-gpu: one mutable directory was shared by every live
    // websockify, and a rebuild deleted it out from under them. websockify
    // chdir()s into its web root at startup, so once that inode is gone the
    // process is still bound to its port and closes every request unanswered
    // — a screen that answers `read ECONNRESET` on every path.
    it('builds a new root instead of deleting the one a live viewer is serving', () => {
        const inUse = ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'remote' })
        const servedFile = join(inUse, 'vnc.html')
        mkdirSync(join(sourceRoot, 'vendor'))

        const rebuilt = ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'remote' })

        expect(rebuilt).not.toBe(inUse)
        expect(existsSync(join(rebuilt, 'vendor'))).toBe(true)
        // The old viewer keeps a directory it can still read from.
        expect(existsSync(inUse)).toBe(true)
        expect(readFileSync(servedFile, 'utf8')).toContain(VIEWER_BRIDGE_PATH)
    })
})

describe('installViewerClipboardBridge on a non-Latin keyboard layout', () => {
    // With a Korean layout active the browser can report the composed letter
    // for the same physical key; the shortcut has to keep working there.
    it('accepts the physical V key when the reported letter is not Latin', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        let stopped = 0
        dom.fireKeydown({ key: 'ㅍ', code: 'KeyV', metaKey: true, stopImmediatePropagation: () => { stopped += 1 } })

        expect(stopped).toBe(1)
    })

    // On Dvorak that same physical key is a different letter, and typing it
    // with a modifier must stay that letter.
    it('leaves the physical V key alone when it types another Latin letter', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        let stopped = 0
        dom.fireKeydown({ key: 'k', code: 'KeyV', ctrlKey: true, stopImmediatePropagation: () => { stopped += 1 } })

        expect(stopped).toBe(0)
    })
})

describe('ensureViewerWebRoot failure handling', () => {
    // Several viewer slots share one mirror. A read failure that happens
    // before any rebuild starts must not delete the mirror another slot's
    // websockify is serving right now.
    it('keeps a working mirror when the source becomes unreadable later', () => {
        const base = mkdtempSync(join(tmpdir(), 'viewer-web-root-keep-'))
        const sourceRoot = join(base, 'novnc')
        const baseDir = join(base, 'mirror')
        mkdirSync(join(sourceRoot, 'app'), { recursive: true })
        writeFileSync(join(sourceRoot, 'vnc.html'), STOCK_HTML)
        const inUse = ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'remote' })

        writeFileSync(join(sourceRoot, 'vnc.html'), '<html><body>no head</body></html>')
        const root = ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'remote' })

        expect(root).toBe(sourceRoot)
        expect(existsSync(join(inUse, 'vnc.html'))).toBe(true)
    })

    // A failure partway through assembly must fall back, remove its own
    // staging, and leave every existing root alone. The failure is real: the
    // bridge lives under `aplus/`, and a source entry of that name collides
    // with the directory assembly made for it — after staging exists.
    it('falls back and cleans only its own staging when assembly fails', () => {
        const base = mkdtempSync(join(tmpdir(), 'viewer-web-root-partial-'))
        const sourceRoot = join(base, 'novnc')
        const baseDir = join(base, 'mirror')
        mkdirSync(join(sourceRoot, 'app'), { recursive: true })
        writeFileSync(join(sourceRoot, 'vnc.html'), STOCK_HTML)
        const healthy = ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'remote' })
        mkdirSync(join(sourceRoot, dirname(VIEWER_BRIDGE_PATH)))
        const reasons: string[] = []

        const root = ensureViewerWebRoot({ sourceRoot, baseDir, resizeMode: 'remote', onFallback: (r) => reasons.push(r) })

        expect(root).toBe(sourceRoot)
        expect(reasons).toHaveLength(1)
        expect(readdirSync(baseDir).some((entry) => entry.endsWith('.tmp'))).toBe(false)
        expect(readFileSync(join(healthy, 'vnc.html'), 'utf8')).toContain(VIEWER_BRIDGE_PATH)
    })
})

describe('buildViewerBridgeModule ships browser-safe source', () => {
    // The module is this function's own text (Function.prototype.toString), so
    // anything the bundler injects into the body — a `__name()` call from
    // --keep-names, a `__spreadValues` helper — would be an undefined
    // identifier in the browser and kill the bridge with no clue why.
    it('references no bundler helper from inside the served function', () => {
        const source = buildViewerBridgeModule()

        expect(source).not.toMatch(/__[A-Za-z]+\s*\(/)
    })

    // Same reason: the function must not reach for anything in module scope.
    it('closes over nothing but its own arguments', () => {
        const source = buildViewerBridgeModule()

        expect(source).not.toContain('VIEWER_BRIDGE_PATH')
        expect(source).not.toContain('logger')
    })
})

describe('installViewerClipboardBridge while the clipboard permission prompt is open', () => {
    // Chrome asks once, and that prompt is exactly when people press the
    // shortcut again. Every extra press would queue another paste for the
    // moment they allow it.
    it('pastes once however many times the shortcut is pressed', async () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        // Granting permission settles every read that was waiting on it, so
        // the fake has to release all of them — not just the last one.
        const pending: Array<(text: string) => void> = []
        dom.win.navigator.clipboard.readText = () => new Promise((resolve) => { pending.push(resolve) })
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'v', ctrlKey: true, stopImmediatePropagation: () => { } })
        dom.fireKeydown({ key: 'v', ctrlKey: true, stopImmediatePropagation: () => { } })
        dom.fireKeydown({ key: 'v', ctrlKey: true, stopImmediatePropagation: () => { } })
        expect(pending.length).toBe(1)
        for (const resolve of pending) resolve('sts-json')
        await Promise.resolve()
        await Promise.resolve()
        dom.runTimeouts()

        expect(rfb.pasted).toEqual(['sts-json'])
    })

    it('accepts the next shortcut once the read has settled', async () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        dom.win.navigator.clipboard.readText = () => Promise.resolve('again')
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'v', ctrlKey: true, stopImmediatePropagation: () => { } })
        await Promise.resolve()
        await Promise.resolve()
        dom.fireKeydown({ key: 'v', ctrlKey: true, stopImmediatePropagation: () => { } })
        await Promise.resolve()
        await Promise.resolve()
        dom.runTimeouts()

        expect(rfb.pasted).toEqual(['again', 'again'])
    })
})

describe('installViewerClipboardBridge when the clipboard read throws outright', () => {
    // An insecure context throws from readText() instead of rejecting. The
    // in-flight flag must not stay set, or pasting dies for the session.
    it('falls back and stays usable for the next attempt', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        dom.win.navigator.clipboard.readText = () => { throw new Error('insecure context') }
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'v', ctrlKey: true, stopImmediatePropagation: () => { } })
        expect(dom.textarea.focused).toBe(true)
        expect(dom.warnings.length).toBe(1)

        dom.textarea.focused = false
        dom.fireKeydown({ key: 'v', ctrlKey: true, stopImmediatePropagation: () => { } })

        expect(dom.textarea.focused).toBe(true)
    })
})

describe('installViewerClipboardBridge never swallows the shortcut', () => {
    // Reported live (2026-09-20): after the bridge shipped, pasting *inside*
    // the remote desktop stopped working too. The bridge takes the shortcut in
    // the capture phase, and when the clipboard read is refused it produced
    // nothing at all — so the remote end never even saw Ctrl+V. Intercepting
    // and dropping is worse than not intercepting.
    it('hands Ctrl+V to the remote end when the clipboard read is refused', async () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        dom.win.navigator.clipboard.readText = () => Promise.reject(new Error('denied'))
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'v', ctrlKey: true, stopImmediatePropagation: () => { } })
        await Promise.resolve()
        await Promise.resolve()
        dom.runTimeouts()

        // Nothing was read, so nothing may be pushed into the remote clipboard
        // — but the keystroke itself has to arrive, or the remote desktop's own
        // clipboard is unusable.
        expect(rfb.pasted).toEqual([])
        expect(rfb.keys).toEqual([
            [CONTROL_L, 'ControlLeft', true],
            [LOWERCASE_V, 'KeyV', true],
            [LOWERCASE_V, 'KeyV', false],
            [CONTROL_L, 'ControlLeft', false],
        ])
    })

    it('hands Ctrl+V over on a browser with no clipboard read at all', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'v', ctrlKey: true, stopImmediatePropagation: () => { } })
        dom.runTimeouts()

        expect(rfb.keys.length).toBeGreaterThan(0)
    })

    // The pass-through is a backstop, not a second paste: a browser that does
    // deliver the paste event must not produce two Ctrl+V presses remotely.
    it('does not double-press when the native paste event does arrive', async () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        dom.win.navigator.clipboard.readText = () => Promise.reject(new Error('denied'))
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'v', ctrlKey: true, stopImmediatePropagation: () => { } })
        await Promise.resolve()
        await Promise.resolve()
        dom.firePaste({ clipboardData: { getData: () => 'from-native-paste' }, preventDefault: () => { } })
        dom.runTimeouts()

        expect(rfb.pasted).toEqual(['from-native-paste'])
        expect(rfb.keys).toEqual([
            [CONTROL_L, 'ControlLeft', true],
            [LOWERCASE_V, 'KeyV', true],
            [LOWERCASE_V, 'KeyV', false],
            [CONTROL_L, 'ControlLeft', false],
        ])
    })
})

describe('installViewerClipboardBridge clears the Meta-Alt before pasting too', () => {
    /**
     * 붙여넣기도 같은 구조다 — Cmd+V 면 noVNC 가 이미 Alt_L 을 내려놨고, 60ms
     * 뒤 주입되는 Ctrl+V 는 그 위에 얹힌다. 복사보다 늦게 터질 뿐(그 사이
     * 사용자가 Cmd 를 떼면 우연히 통과) 같은 결함이다.
     */
    it('releases the Alt noVNC sent for Cmd before pressing Ctrl+V', async () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        dom.win.navigator.clipboard.readText = async () => 'hello'
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'v', metaKey: true, stopImmediatePropagation: () => { } })
        await Promise.resolve()
        await Promise.resolve()
        dom.runTimeouts()

        expect(rfb.keys).toEqual([
            [ALT_L, 'AltLeft', false],
            [CONTROL_L, 'ControlLeft', true],
            [LOWERCASE_V, 'KeyV', true],
            [LOWERCASE_V, 'KeyV', false],
            [CONTROL_L, 'ControlLeft', false],
        ])
    })
})

describe('installViewerClipboardBridge sends Ctrl+C for copy, never noVNC\'s own remap', () => {
    // noVNC remaps macOS's own Cmd (Super) key to Alt for the remote end
    // (core/input/keyboard.js: "Alt behaves more like AltGraph on macOS").
    // Left alone, a Mac user's Cmd+C arrives on the (Linux) remote as Alt+C,
    // which copies nothing. The bridge must own the shortcut itself and
    // always send Control_L, the same way it already does for paste.
    it('sends Control_L + KeyC to the remote on Cmd+C', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        let stopped = 0
        dom.fireKeydown({ key: 'c', metaKey: true, stopImmediatePropagation: () => { stopped += 1 } })

        expect(dom.keydownIsCapturing()).toBe(true)
        expect(stopped).toBe(1)
        // 앞머리의 Alt 해제는 아래 전용 테스트가 이유까지 고정한다 — 여기서는
        // 브리지가 가로채 **자기가** Control_L 을 보낸다는 것이 요지다.
        expect(rfb.keys).toEqual([
            [ALT_L, 'AltLeft', false],
            [CONTROL_L, 'ControlLeft', true],
            [LOWERCASE_C, 'KeyC', true],
            [LOWERCASE_C, 'KeyC', false],
            [CONTROL_L, 'ControlLeft', false],
        ])
    })

    /**
     * 실측(2026-09-20, 실제 Chromium on macOS + noVNC 1.7.0): Cmd 를 누르는
     * 순간 noVNC 가 원격에 `Alt_L` **keydown** 을 보내고, Cmd 를 뗄 때까지
     * 눌린 채로 둔다 — `keyboard.js` 의 `case XK_Super_L: keysym = XK_Alt_L`
     * 이고, 바로 아래 macOS 특례는 `code !== 'MetaLeft'` 로 Meta 키 자신을
     * 제외하기 때문이다.
     *
     * 그래서 브리지가 C 만 가로채 Ctrl+C 를 주입하면 원격이 실제로 받는 것은
     * `Alt_L+Control_L+c` 다. 리눅스 원격에서 이 조합은 복사가 아니다.
     * 주입 전에 그 Alt 를 풀어야 한다.
     *
     * 이 시점의 Alt 는 언제나 noVNC 의 Meta 변환분이다 — 사용자가 진짜 Option
     * 을 누르고 있으면 위의 `event.altKey` 가드가 먼저 돌려보낸다.
     */
    it('releases the Alt noVNC sent for Cmd before pressing Ctrl+C', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'c', metaKey: true, stopImmediatePropagation: () => { } })

        expect(rfb.keys).toEqual([
            [ALT_L, 'AltLeft', false],
            [CONTROL_L, 'ControlLeft', true],
            [LOWERCASE_C, 'KeyC', true],
            [LOWERCASE_C, 'KeyC', false],
            [CONTROL_L, 'ControlLeft', false],
        ])
    })

    /** Ctrl+C 에는 Alt 가 끼어들지 않는다 — 그 경로는 한 줄도 바뀌면 안 된다. */
    it('does not touch Alt when the shortcut came from Ctrl, not Cmd', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'c', ctrlKey: true, stopImmediatePropagation: () => { } })

        expect(rfb.keys.some(([keysym]: any[]) => keysym === ALT_L)).toBe(false)
    })

    it('sends the same Control_L + KeyC on Ctrl+C (Windows/Linux)', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'c', ctrlKey: true, stopImmediatePropagation: () => { } })

        expect(rfb.keys).toEqual([
            [CONTROL_L, 'ControlLeft', true],
            [LOWERCASE_C, 'KeyC', true],
            [LOWERCASE_C, 'KeyC', false],
            [CONTROL_L, 'ControlLeft', false],
        ])
    })

    // Same non-Latin-layout fallback as paste: a Korean layout can report a
    // composed letter for the physical C key.
    it('accepts the physical C key when the reported letter is not Latin', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'ㅊ', code: 'KeyC', metaKey: true, stopImmediatePropagation: () => { } })

        expect(rfb.keys.length).toBeGreaterThan(0)
    })

    it('leaves every other Cmd/Ctrl shortcut alone', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        let stopped = 0
        const stopImmediatePropagation = () => { stopped += 1 }
        dom.fireKeydown({ key: 'a', metaKey: true, stopImmediatePropagation })
        dom.fireKeydown({ key: 'c', altKey: true, stopImmediatePropagation })
        dom.fireKeydown({ key: 'c', stopImmediatePropagation })

        expect(stopped).toBe(0)
        expect(rfb.keys).toEqual([])
    })

    // Copying does not touch the clipboard-read machinery at all — it only
    // forwards the keystroke. The existing RFB `clipboard` listener already
    // pulls whatever the remote puts on its selection back to the local
    // clipboard once the remote actually receives a working Ctrl+C.
    it('does not read or write the local clipboard on its own', () => {
        const dom = fakeDom()
        const rfb = fakeRfb()
        dom.win.navigator.clipboard.readText = () => Promise.reject(new Error('should not be called'))
        installViewerClipboardBridge({ rfb }, dom.win, dom.doc)

        dom.fireKeydown({ key: 'c', metaKey: true, stopImmediatePropagation: () => { } })

        expect(dom.written).toEqual([])
    })
})
