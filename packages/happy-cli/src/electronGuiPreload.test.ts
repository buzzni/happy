import { describe, expect, it } from 'vitest'
import { createWindowScreencastSource } from './electronGuiPreload'
import type { DebuggerLike } from './daemon/electronGuiBridge/debuggerSource'

type Listener = (event: unknown, method: string, params: unknown) => void

function fakeWindow() {
    const calls: string[] = []
    const listeners: Listener[] = []
    let closedListener: (() => void) | null = null
    let destroyed = false
    const dbg: DebuggerLike = {
        isAttached: () => false,
        attach: () => { calls.push('attach') },
        detach: () => { calls.push('detach') },
        sendCommand: async (method) => { calls.push(method); return {} },
        on: (_event, listener) => { listeners.push(listener as Listener) },
        removeListener: (_event, listener) => {
            const index = listeners.indexOf(listener as Listener)
            if (index >= 0) listeners.splice(index, 1)
        },
    }
    return {
        window: {
            isDestroyed: () => destroyed,
            webContents: { debugger: dbg, isDestroyed: () => destroyed },
            once: (_event: 'closed', listener: () => void) => { closedListener = listener },
        },
        calls,
        emitFrame(data: string) {
            for (const listener of [...listeners]) {
                listener({}, 'Page.screencastFrame', { data, sessionId: 1, metadata: { deviceWidth: 100, deviceHeight: 50 } })
            }
        },
        close() { destroyed = true; closedListener?.() },
    }
}

function fakeElectron() {
    const windows: ReturnType<typeof fakeWindow>[] = []
    let createdListener: ((event: unknown, window: unknown) => void) | null = null
    return {
        electron: {
            app: {
                whenReady: () => Promise.resolve(),
                once: (_event: 'browser-window-created', listener: (event: unknown, window: unknown) => void) => {
                    createdListener = listener
                },
                on: () => {},
            },
            BrowserWindow: {
                getFocusedWindow: () => windows.find((w) => !w.window.isDestroyed())?.window ?? null,
                getAllWindows: () => windows.filter((w) => !w.window.isDestroyed()).map((w) => w.window),
            },
        },
        openWindow() {
            const next = fakeWindow()
            windows.push(next)
            const listener = createdListener
            createdListener = null
            listener?.({}, next.window)
            return next
        },
    }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('createWindowScreencastSource', () => {
    it('closed 된 창을 뒤따라 다음 창에 다시 붙는다 — 뷰어 소켓은 계속 열려 있어 재접속이 일어나지 않기 때문', async () => {
        const fake = fakeElectron()
        const first = fake.openWindow()
        const source = createWindowScreencastSource(fake.electron as never)
        const frames: string[] = []
        await source.startScreencast((frame) => frames.push(frame.data))
        first.emitFrame('ONE')
        expect(frames).toEqual(['ONE'])

        first.close()
        await tick()
        const second = fake.openWindow()
        await tick()
        expect(second.calls).toContain('Page.startScreencast')
        second.emitFrame('TWO')
        expect(frames).toEqual(['ONE', 'TWO'])
        await source.stopScreencast()
    })

    it('stopScreencast 뒤에는 창이 닫혀도 다시 붙지 않는다', async () => {
        const fake = fakeElectron()
        const first = fake.openWindow()
        const source = createWindowScreencastSource(fake.electron as never)
        await source.startScreencast(() => {})
        await source.stopScreencast()
        first.close()
        await tick()
        const second = fake.openWindow()
        await tick()
        expect(second.calls).not.toContain('Page.startScreencast')
    })
})
