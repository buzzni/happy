/**
 * HTTP + WebSocket server that streams an Electron window to the studio's
 * preview sidecar and returns the user's input — the "cdp-screencast"
 * provider for host-mode (no docker) Electron previews.
 *
 * It intentionally mirrors the URL shape of the noVNC provider used inside
 * containers: the viewer page is served at `/` and `/vnc.html`, the socket at
 * `<base>/websockify`. The desktop's viewer URL builder and its WebSocket
 * liveness probe were written for noVNC and keep working unchanged; only the
 * payload on the socket differs (JSON frames/input instead of RFB).
 *
 * Wire protocol (all text JSON):
 *   server → viewer  { t: 'ready' }
 *                    { t: 'frame', data: <base64 jpeg>, width, height }
 *                    { t: 'error', reason }
 *   viewer → server  { t: 'mouse', kind, nx, ny, button, clickCount }
 *                    { t: 'wheel', nx, ny, deltaX, deltaY }
 *                    { t: 'key', kind, key, code, text, modifiers }
 * Coordinates are normalized (0..1) against the last frame so the viewer can
 * scale freely; the source maps them back onto CSS pixels.
 *
 * aplus-dev-studio specs/electron-gui-preview-cross-platform §3.2/§3.4.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { ELECTRON_GUI_VIEWER_HTML } from './viewerPage'

export type ElectronGuiFrame = { data: string; width: number; height: number }

export type ElectronGuiMouseKind = 'mousePressed' | 'mouseReleased' | 'mouseMoved'
export type ElectronGuiKeyKind = 'keyDown' | 'keyUp' | 'char'

export type ElectronGuiInputEvent =
    | { t: 'mouse'; kind: ElectronGuiMouseKind; nx: number; ny: number; button: 'left' | 'middle' | 'right' | 'none'; clickCount: number; modifiers?: number }
    | { t: 'wheel'; nx: number; ny: number; deltaX: number; deltaY: number; modifiers?: number }
    | { t: 'key'; kind: ElectronGuiKeyKind; key: string; code: string; text: string; modifiers: number }

export interface ElectronGuiScreencastSource {
    startScreencast(onFrame: (frame: ElectronGuiFrame) => void): Promise<void>
    stopScreencast(): Promise<void>
    dispatchInput(event: ElectronGuiInputEvent): Promise<void>
}

export interface ElectronGuiBridgeServer {
    port: number
    close(): Promise<void>
}

const MOUSE_KINDS = new Set<string>(['mousePressed', 'mouseReleased', 'mouseMoved'])
const KEY_KINDS = new Set<string>(['keyDown', 'keyUp', 'char'])
const BUTTONS = new Set<string>(['left', 'middle', 'right', 'none'])

function isUnit(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

/** Viewer messages are untrusted; anything off-shape is dropped, never thrown. */
export function parseElectronGuiInput(raw: string): ElectronGuiInputEvent | null {
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch {
        return null
    }
    if (!value || typeof value !== 'object') return null
    const message = value as Record<string, unknown>
    const modifiers = isFiniteNumber(message.modifiers) ? message.modifiers : undefined
    if (message.t === 'mouse') {
        if (!MOUSE_KINDS.has(String(message.kind)) || !isUnit(message.nx) || !isUnit(message.ny)) return null
        if (!BUTTONS.has(String(message.button)) || !isFiniteNumber(message.clickCount)) return null
        return {
            t: 'mouse',
            kind: message.kind as ElectronGuiMouseKind,
            nx: message.nx,
            ny: message.ny,
            button: message.button as 'left' | 'middle' | 'right' | 'none',
            clickCount: message.clickCount,
            ...(modifiers === undefined ? {} : { modifiers }),
        }
    }
    if (message.t === 'wheel') {
        if (!isUnit(message.nx) || !isUnit(message.ny) || !isFiniteNumber(message.deltaX) || !isFiniteNumber(message.deltaY)) return null
        return {
            t: 'wheel',
            nx: message.nx,
            ny: message.ny,
            deltaX: message.deltaX,
            deltaY: message.deltaY,
            ...(modifiers === undefined ? {} : { modifiers }),
        }
    }
    if (message.t === 'key') {
        if (!KEY_KINDS.has(String(message.kind)) || typeof message.key !== 'string' || typeof message.code !== 'string') return null
        return {
            t: 'key',
            kind: message.kind as ElectronGuiKeyKind,
            key: message.key,
            code: message.code,
            text: typeof message.text === 'string' ? message.text : '',
            modifiers: isFiniteNumber(message.modifiers) ? message.modifiers : 0,
        }
    }
    return null
}

function pathnameOf(request: IncomingMessage): string {
    try {
        return new URL(request.url ?? '/', 'http://localhost').pathname
    } catch {
        return '/'
    }
}

function isViewerPath(pathname: string): boolean {
    const last = pathname.replace(/\/+$/, '').split('/').pop() ?? ''
    return last === '' || last === 'vnc.html' || last === 'index.html'
}

function isSocketPath(pathname: string): boolean {
    return pathname.replace(/\/+$/, '').endsWith('/websockify')
}

export async function createElectronGuiBridgeServer(options: {
    port: number
    host: string
    source: ElectronGuiScreencastSource
    log?: (message: string) => void
}): Promise<ElectronGuiBridgeServer> {
    const { source } = options
    const log = options.log ?? (() => {})
    let active: WebSocket | null = null

    const server: Server = createServer((request, response) => {
        const pathname = pathnameOf(request)
        if (request.method === 'GET' && isViewerPath(pathname)) {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            response.end(ELECTRON_GUI_VIEWER_HTML)
            return
        }
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('not found')
    })

    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
        if (!isSocketPath(pathnameOf(request))) {
            socket.destroy()
            return
        }
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request))
    })

    wss.on('connection', (ws) => {
        if (active) {
            // A second attach would restart the screencast under the first
            // viewer's feet; the desktop only ever holds one sidecar per app.
            ws.send(JSON.stringify({ t: 'error', reason: 'busy' }))
            ws.close(1013, 'busy')
            return
        }
        active = ws
        let stopped = false
        const stop = async () => {
            if (stopped) return
            stopped = true
            if (active === ws) active = null
            try {
                await source.stopScreencast()
            } catch (error) {
                log(`stopScreencast failed: ${String(error)}`)
            }
        }
        ws.on('close', () => { void stop() })
        ws.on('error', () => { void stop() })
        ws.on('message', (raw) => {
            const event = parseElectronGuiInput(raw.toString())
            if (!event) return
            source.dispatchInput(event).catch((error) => log(`dispatchInput failed: ${String(error)}`))
        })
        ws.send(JSON.stringify({ t: 'ready' }))
        source
            .startScreencast((frame) => {
                if (ws.readyState !== ws.OPEN) return
                ws.send(JSON.stringify({ t: 'frame', data: frame.data, width: frame.width, height: frame.height }))
            })
            .catch((error) => {
                log(`startScreencast failed: ${String(error)}`)
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'error', reason: 'screencast-failed', message: String(error) }))
                ws.close(1011, 'screencast failed')
            })
    })

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port, options.host, () => {
            server.off('error', reject)
            resolve()
        })
    })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : options.port

    return {
        port,
        close: () =>
            new Promise<void>((resolve) => {
                for (const client of wss.clients) client.terminate()
                wss.close(() => server.close(() => resolve()))
            }),
    }
}
