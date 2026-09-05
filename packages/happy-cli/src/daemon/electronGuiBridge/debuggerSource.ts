/**
 * Screencast source backed by Electron's `webContents.debugger` (Chrome
 * DevTools Protocol attached in-process). No `--remote-debugging-port`, no
 * target discovery: the preload owns the window, so it attaches directly.
 *
 * Only the DebuggerLike surface is used so the mapping logic (frame metadata
 * → normalized input coordinates, CDP key event shape) is unit-testable
 * without Electron.
 */
import type { ElectronGuiFrame, ElectronGuiInputEvent, ElectronGuiScreencastSource } from './bridgeServer'

export interface DebuggerLike {
    isAttached(): boolean
    attach(protocolVersion?: string): void
    detach(): void
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
    on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): void
    removeListener(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): void
}

/** Bounded so a 4K window does not turn into a multi-MB JPEG per frame over the relay. */
export const SCREENCAST_PARAMS = {
    format: 'jpeg',
    quality: 60,
    maxWidth: 1280,
    maxHeight: 800,
    everyNthFrame: 1,
} as const

const VIRTUAL_KEY_CODES: Record<string, number> = {
    Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, ' ': 32,
    PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Delete: 46, Meta: 91,
}

function virtualKeyCode(key: string): number | undefined {
    if (VIRTUAL_KEY_CODES[key] !== undefined) return VIRTUAL_KEY_CODES[key]
    if (key.length === 1) {
        const upper = key.toUpperCase()
        const code = upper.charCodeAt(0)
        if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90)) return code
    }
    return undefined
}

export function createDebuggerScreencastSource(dbg: DebuggerLike): ElectronGuiScreencastSource {
    let listener: ((event: unknown, method: string, params: unknown) => void) | null = null
    let lastSize: { width: number; height: number } | null = null

    const toPixels = (nx: number, ny: number) =>
        lastSize ? { x: Math.round(nx * lastSize.width), y: Math.round(ny * lastSize.height) } : null

    return {
        async startScreencast(onFrame) {
            if (!dbg.isAttached()) dbg.attach('1.3')
            listener = (_event, method, params) => {
                if (method !== 'Page.screencastFrame') return
                const frame = params as { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } }
                const width = frame.metadata?.deviceWidth ?? lastSize?.width ?? SCREENCAST_PARAMS.maxWidth
                const height = frame.metadata?.deviceHeight ?? lastSize?.height ?? SCREENCAST_PARAMS.maxHeight
                lastSize = { width, height }
                const out: ElectronGuiFrame = { data: frame.data, width, height }
                onFrame(out)
                void dbg.sendCommand('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
            }
            dbg.on('message', listener)
            await dbg.sendCommand('Page.startScreencast', { ...SCREENCAST_PARAMS })
        },

        async stopScreencast() {
            if (listener) {
                dbg.removeListener('message', listener)
                listener = null
            }
            try {
                await dbg.sendCommand('Page.stopScreencast')
            } finally {
                if (dbg.isAttached()) dbg.detach()
            }
        },

        async dispatchInput(event: ElectronGuiInputEvent) {
            if (event.t === 'key') {
                const vk = virtualKeyCode(event.key)
                await dbg.sendCommand('Input.dispatchKeyEvent', {
                    type: event.kind,
                    key: event.key,
                    code: event.code,
                    text: event.text,
                    unmodifiedText: event.text,
                    modifiers: event.modifiers,
                    ...(vk === undefined ? {} : { windowsVirtualKeyCode: vk }),
                })
                return
            }
            // Before the first frame the window size is unknown; guessing would
            // click somewhere arbitrary, so drop pointer input until then.
            const point = toPixels(event.nx, event.ny)
            if (!point) return
            if (event.t === 'wheel') {
                await dbg.sendCommand('Input.dispatchMouseEvent', {
                    type: 'mouseWheel',
                    x: point.x,
                    y: point.y,
                    deltaX: event.deltaX,
                    deltaY: event.deltaY,
                    modifiers: event.modifiers ?? 0,
                })
                return
            }
            await dbg.sendCommand('Input.dispatchMouseEvent', {
                type: event.kind,
                x: point.x,
                y: point.y,
                button: event.button,
                clickCount: event.clickCount,
                modifiers: event.modifiers ?? 0,
            })
        },
    }
}
