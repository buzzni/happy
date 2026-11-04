/** Private CDP page viewport port. Does not mutate allowed origins or call agent screenshot. */
import { BrowserRuntimeError, type TabId } from '../contracts'
import type { PageGeometry, PageImage, PageInput, PageViewDriver } from '../pageViewContracts'
import type { CdpConnection } from './cdpConnection'

interface Tab { sessionId: string; generation: number }
interface Port { connection(): CdpConnection; tab(tabId: TabId): Tab; checkFrames(tabId: TabId, conn: CdpConnection): Promise<string> }
function stale(): never { throw new BrowserRuntimeError('STALE_REF', 'Page document or viewport changed') }
/** CDP needs a virtual key code for native editing, even when key/code are present. */
function virtualKey(code: string): number {
    const named: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, Escape: 27,
        Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39,
        ArrowDown: 40, Insert: 45, Delete: 46, ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17,
        AltLeft: 18, AltRight: 18, MetaLeft: 91, MetaRight: 92, CapsLock: 20 }
    if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3)
    if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5)
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return 111 + Number(code.slice(1))
    return named[code] ?? 0
}
/** JPEG SOF dimensions are the encoded pixel dimensions, including Retina and CDP scaling. */
function jpegSize(data: string): { width: number; height: number } {
    const bytes = Buffer.from(data, 'base64')
    for (let at = 2; at + 8 < bytes.length;) {
        if (bytes[at] !== 0xff) break
        const marker = bytes[at + 1]
        const size = bytes.readUInt16BE(at + 2)
        if ([0xc0, 0xc1, 0xc2].includes(marker)) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) }
        if (size < 2) break
        at += size + 2
    }
    throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'Invalid page image')
}
export class CdpPageViewDriver implements PageViewDriver {
    private captureFlight?: Promise<PageImage>
    /** A timed out capture might still be running in Chrome. Fail closed until connection replacement. */
    private captureBlocked?: CdpConnection
    private readonly held = new Map<TabId, { keys: Map<string, Extract<PageInput, { kind: 'key' }>>; buttons: Map<string, Extract<PageInput, { kind: 'pointer' }>> }>()
    constructor(private readonly port: Port) {}
    capture(tabId: TabId, validate: () => void, quality: number, maxDimension: number): Promise<PageImage> {
        const conn = this.port.connection()
        if (this.captureFlight || this.captureBlocked === conn) throw new BrowserRuntimeError('CONFLICT', 'Previous page capture has not settled')
        const flight = this.captureBody(conn, tabId, validate, quality, maxDimension)
        this.captureFlight = flight
        return flight.finally(() => { if (this.captureFlight === flight) this.captureFlight = undefined })
    }
    private async geometry(conn: CdpConnection, tab: Tab): Promise<PageGeometry> {
        const metrics = await conn.send('Page.getLayoutMetrics', {}, tab.sessionId)
        const v = metrics.cssVisualViewport ?? metrics.visualViewport
        return { documentGeneration: tab.generation, viewport: { width: v.clientWidth, height: v.clientHeight, offsetX: v.pageX, offsetY: v.pageY, scale: v.scale } }
    }
    private async captureBody(conn: CdpConnection, tabId: TabId, validate: () => void, quality: number, maxDimension: number): Promise<PageImage> {
        const started = Date.now()
        const tab = this.port.tab(tabId)
        validate()
        const before = await this.port.checkFrames(tabId, conn)
        const geometry = await this.geometry(conn, tab)
        validate()
        let data: string
        try {
            const v = geometry.viewport
            const result = await conn.send('Page.captureScreenshot', { format: 'jpeg', quality, fromSurface: true, captureBeyondViewport: false,
                clip: { x: v.offsetX, y: v.offsetY, width: v.width, height: v.height, scale: Math.min(1, maxDimension / Math.max(v.width, v.height)) } }, tab.sessionId)
            data = result.data
        } catch (error) { this.captureBlocked = conn; throw error }
        const after = await this.geometry(conn, tab)
        if (JSON.stringify(geometry) !== JSON.stringify(after) || before !== await this.port.checkFrames(tabId, conn)
            || this.port.connection() !== conn || this.port.tab(tabId) !== tab) stale()
        validate()
        const size = jpegSize(data)
        return { ...geometry, data, mimeType: 'image/jpeg', pixelWidth: size.width, pixelHeight: size.height,
            capturedAtMs: Date.now(), captureDurationMs: Date.now() - started }
    }
    async input(tabId: TabId, frame: PageGeometry, event: PageInput, validate: () => void): Promise<void> {
        const conn = this.port.connection()
        const tab = this.port.tab(tabId)
        await this.port.checkFrames(tabId, conn)
        const current = await this.geometry(conn, tab)
        if (JSON.stringify(frame.viewport) !== JSON.stringify(current.viewport) || frame.documentGeneration !== current.documentGeneration) stale()
        if ('x' in event && (event.x >= current.viewport.width || event.y >= current.viewport.height)) stale()
        // No browser/OS activation: commands are sent only to this owned page session.
        validate()
        if (this.port.connection() !== conn || this.port.tab(tabId) !== tab || tab.generation !== frame.documentGeneration) stale()
        const held = this.held.get(tabId) ?? { keys: new Map(), buttons: new Map() }
        this.held.set(tabId, held)
        try {
            if (event.kind === 'pointer') {
                if (event.type === 'mousePressed') held.buttons.set(event.button, event)
                const { kind: _, ...params } = event
                await conn.send('Input.dispatchMouseEvent', params, tab.sessionId)
                if (event.type === 'mouseReleased') held.buttons.delete(event.button)
            } else if (event.kind === 'wheel') {
                const { kind: _, ...params } = event
                await conn.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...params }, tab.sessionId)
            } else if (event.kind === 'key') {
                if (event.type === 'keyDown') held.keys.set(event.code, event)
                const { kind: _, ...params } = event
                await conn.send('Input.dispatchKeyEvent', { ...params, windowsVirtualKeyCode: virtualKey(event.code) }, tab.sessionId)
                if (event.type === 'keyUp') held.keys.delete(event.code)
            } else await conn.send('Input.insertText', { text: event.text }, tab.sessionId)
        } catch { throw new BrowserRuntimeError('OUTCOME_UNKNOWN', 'Page input outcome is unknown', false, true) }
    }
    async release(tabId: TabId): Promise<void> {
        const held = this.held.get(tabId)
        if (!held) return
        const conn = this.port.connection()
        const tab = this.port.tab(tabId)
        for (const [code, key] of held.keys) {
            await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', key: key.key, code, windowsVirtualKeyCode: virtualKey(code), modifiers: 0 }, tab.sessionId)
            held.keys.delete(code)
        }
        for (const [button, pointer] of held.buttons) {
            await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pointer.x, y: pointer.y, button, buttons: 0, clickCount: 1, modifiers: 0 }, tab.sessionId)
            held.buttons.delete(button)
        }
        this.held.delete(tabId)
    }
}
