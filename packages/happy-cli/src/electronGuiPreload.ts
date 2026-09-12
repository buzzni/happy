/**
 * Electron main-process preload for host-mode (no docker) `electron-gui`
 * previews — the "cdp-screencast" provider.
 *
 * The daemon injects `NODE_OPTIONS=--require <this file>` (plus
 * APLUS_GUI_STREAM_PORT) into the project's devCommand. Every Node process
 * the command spawns loads this file, so it does nothing unless it finds
 * itself inside an Electron *main* process. There it opens the screencast
 * bridge on the stream port and streams whichever BrowserWindow has focus,
 * through `webContents.debugger` — no `--remote-debugging-port`, no change
 * to the user's app, and the same on macOS, Linux (under Xvfb) and Windows.
 *
 * Built as its own pkgroll entry (package.json exports "./electronGuiPreload")
 * so the daemon can hand Electron a plain CJS path.
 *
 * aplus-dev-studio specs/electron-gui-preview-cross-platform Phase 3.
 */
import { createRequire } from 'node:module'
import { createElectronGuiBridgeServer, type ElectronGuiFrame, type ElectronGuiScreencastSource } from './daemon/electronGuiBridge/bridgeServer'
import { createDebuggerScreencastSource, type DebuggerLike } from './daemon/electronGuiBridge/debuggerSource'

type ElectronWindowLike = {
    isDestroyed(): boolean
    webContents: { debugger: DebuggerLike; isDestroyed(): boolean }
    once(event: 'closed', listener: () => void): void
}

type ElectronLike = {
    app: {
        whenReady(): Promise<void>
        once(event: 'browser-window-created', listener: (event: unknown, window: ElectronWindowLike) => void): void
        on(event: 'will-quit', listener: () => void): void
    }
    BrowserWindow: {
        getFocusedWindow(): ElectronWindowLike | null
        getAllWindows(): ElectronWindowLike[]
    }
}

const LOG_PREFIX = '[electron-gui-bridge]'

function log(message: string): void {
    process.stderr.write(`${LOG_PREFIX} ${message}\n`)
}

function isElectronMainProcess(): boolean {
    const proc = process as NodeJS.Process & { type?: string }
    return Boolean(process.versions.electron) && proc.type === 'browser'
}

function pickWindow(electron: ElectronLike): ElectronWindowLike | null {
    const candidates = [electron.BrowserWindow.getFocusedWindow(), ...electron.BrowserWindow.getAllWindows()]
    return candidates.find((win) => win && !win.isDestroyed() && !win.webContents.isDestroyed()) ?? null
}

function waitForWindow(electron: ElectronLike): Promise<ElectronWindowLike> {
    const existing = pickWindow(electron)
    if (existing) return Promise.resolve(existing)
    // `once`: every viewer connection that arrives before the first window
    // would otherwise leave a permanent listener behind.
    return new Promise((resolve) => {
        electron.app.once('browser-window-created', (_event, window) => resolve(window))
    })
}

/**
 * Follows the app's windows: the screencast attaches to the current focused
 * window, and when that window closes it re-attaches to the next one on its
 * own. Waiting for the viewer to reconnect would never happen — the bridge
 * socket stays open when only the window goes away, so from the viewer's side
 * there is nothing to reconnect; without re-attach the canvas freezes on the
 * last frame forever. (Hot-reload restarts of the main process are different:
 * the whole bridge dies with the process and the socket close does trigger
 * the viewer's reconnect.)
 */
export function createWindowScreencastSource(electron: ElectronLike): ElectronGuiScreencastSource {
    let current: ElectronGuiScreencastSource | null = null
    // Identifies one startScreencast..stopScreencast span; a re-attach from a
    // window that closed after stopScreencast must not revive the capture.
    let session: symbol | null = null

    const attach = async (token: symbol, onFrame: (frame: ElectronGuiFrame) => void): Promise<void> => {
        const window = await waitForWindow(electron)
        if (session !== token) return
        const source = createDebuggerScreencastSource(window.webContents.debugger)
        current = source
        window.once('closed', () => {
            if (session !== token) return
            current = null
            attach(token, onFrame).catch((error) => log(`re-attach failed: ${String(error)}`))
        })
        await source.startScreencast(onFrame)
    }

    return {
        async startScreencast(onFrame: (frame: ElectronGuiFrame) => void) {
            const token = Symbol('screencast')
            session = token
            await attach(token, onFrame)
        },
        async stopScreencast() {
            session = null
            const source = current
            current = null
            if (!source) return
            try {
                await source.stopScreencast()
            } catch {
                // The window may already be gone; nothing left to detach from.
            }
        },
        async dispatchInput(event) {
            await current?.dispatchInput(event)
        },
    }
}

async function start(electron: ElectronLike, port: number): Promise<void> {
    await electron.app.whenReady()
    const server = await createElectronGuiBridgeServer({
        port,
        host: '127.0.0.1',
        source: createWindowScreencastSource(electron),
        log,
    })
    log(`streaming on http://127.0.0.1:${server.port}/ (APLUS_GUI_STREAM_PORT)`)
    electron.app.on('will-quit', () => {
        void server.close()
    })
}

/**
 * `--require` runs during Node bootstrap, before Electron has registered its
 * `electron` module (observed: "Cannot find module 'electron'" from
 * node:electron/js2c/node_init). Poll briefly for it instead of racing.
 */
function loadElectron(): Promise<ElectronLike> {
    const requireFromHere = createRequire(import.meta.url)
    return new Promise((resolve, reject) => {
        let attempts = 0
        const tryLoad = () => {
            try {
                resolve(requireFromHere('electron') as ElectronLike)
            } catch (error) {
                attempts += 1
                if (attempts >= 100) reject(error)
                else setTimeout(tryLoad, 50)
            }
        }
        setImmediate(tryLoad)
    })
}

function main(): void {
    if (!isElectronMainProcess()) return
    const port = Number(process.env.APLUS_GUI_STREAM_PORT)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return
    loadElectron()
        .then((electron) => start(electron, port))
        .catch((error) => {
            // Never take the user's app down with us: the preview shows the
            // sidecar's connection failure and the log explains why.
            log(`failed to start: ${String(error)}`)
        })
}

main()
