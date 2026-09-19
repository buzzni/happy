import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, readlinkSync, lstatSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    let targetRoot: string

    beforeEach(() => {
        const base = mkdtempSync(join(tmpdir(), 'viewer-web-root-'))
        sourceRoot = join(base, 'novnc')
        targetRoot = join(base, 'mirror')
        mkdirSync(join(sourceRoot, 'app'), { recursive: true })
        writeFileSync(join(sourceRoot, 'vnc.html'), STOCK_HTML)
        writeFileSync(join(sourceRoot, 'app', 'ui.js'), 'export default {}')
    })

    it('serves a patched page while leaving noVNC\'s assets where they are', () => {
        const root = ensureViewerWebRoot({ sourceRoot, targetRoot, resizeMode: 'remote' })

        expect(root).toBe(targetRoot)
        expect(readFileSync(join(targetRoot, 'vnc.html'), 'utf8')).toContain(VIEWER_BRIDGE_PATH)
        expect(lstatSync(join(targetRoot, 'app')).isSymbolicLink()).toBe(true)
        expect(readlinkSync(join(targetRoot, 'app'))).toBe(join(sourceRoot, 'app'))
        expect(existsSync(join(targetRoot, VIEWER_BRIDGE_PATH))).toBe(true)
    })

    // Debian's package makes / an alias of vnc.html; a symlink there would
    // serve the unpatched original and quietly undo both fixes.
    it('patches the directory index too', () => {
        symlinkSync(join(sourceRoot, 'vnc.html'), join(sourceRoot, 'index.html'))

        ensureViewerWebRoot({ sourceRoot, targetRoot, resizeMode: 'remote' })

        expect(lstatSync(join(targetRoot, 'index.html')).isSymbolicLink()).toBe(false)
        expect(readFileSync(join(targetRoot, 'index.html'), 'utf8')).toContain(VIEWER_BRIDGE_PATH)
    })

    it('rebuilds cleanly when the mode changes', () => {
        ensureViewerWebRoot({ sourceRoot, targetRoot, resizeMode: 'scale' })
        ensureViewerWebRoot({ sourceRoot, targetRoot, resizeMode: 'remote' })

        const html = readFileSync(join(targetRoot, 'vnc.html'), 'utf8')
        expect(html).toContain("'resize', 'remote'")
        expect(html).not.toContain("'resize', 'scale'")
    })

    // A machine whose noVNC install does not look like we expect still has a
    // working remote screen — losing the enhancements must not lose the screen.
    it('falls back to the stock root rather than serving nothing', () => {
        writeFileSync(join(sourceRoot, 'vnc.html'), '<html><body>no head</body></html>')

        expect(ensureViewerWebRoot({ sourceRoot, targetRoot, resizeMode: 'remote' })).toBe(sourceRoot)
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
const LOWERCASE_V = 0x76

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
        dom.fireKeydown({ key: 'c', metaKey: true, stopImmediatePropagation })
        dom.fireKeydown({ key: 'v', ctrlKey: true, altKey: true, stopImmediatePropagation })

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
        // reaches it (noVNC maps Meta to Alt for the remote end).
        expect(rfb.keys).toEqual([
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
    let targetRoot: string

    beforeEach(() => {
        const base = mkdtempSync(join(tmpdir(), 'viewer-web-root-again-'))
        sourceRoot = join(base, 'novnc')
        targetRoot = join(base, 'mirror')
        mkdirSync(join(sourceRoot, 'app'), { recursive: true })
        writeFileSync(join(sourceRoot, 'vnc.html'), STOCK_HTML)
        writeFileSync(join(sourceRoot, 'app', 'ui.js'), 'export default {}')
    })

    // websockify opens files per request, and several viewer slots share one
    // mirror: tearing down a directory that is already correct would 404
    // whatever asset another user's page is loading right then.
    it('leaves an already-current mirror alone', () => {
        ensureViewerWebRoot({ sourceRoot, targetRoot, resizeMode: 'remote' })
        const witness = join(targetRoot, 'rebuild-witness')
        writeFileSync(witness, 'x')

        ensureViewerWebRoot({ sourceRoot, targetRoot, resizeMode: 'remote' })

        expect(existsSync(witness)).toBe(true)
    })

    it('rebuilds when noVNC itself gained files the mirror never saw', () => {
        ensureViewerWebRoot({ sourceRoot, targetRoot, resizeMode: 'remote' })
        const witness = join(targetRoot, 'rebuild-witness')
        writeFileSync(witness, 'x')
        mkdirSync(join(sourceRoot, 'vendor'))

        ensureViewerWebRoot({ sourceRoot, targetRoot, resizeMode: 'remote' })

        expect(existsSync(witness)).toBe(false)
        expect(existsSync(join(targetRoot, 'vendor'))).toBe(true)
    })
})
