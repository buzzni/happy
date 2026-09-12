import { describe, expect, it } from 'vitest'
import { createDebuggerScreencastSource, type DebuggerLike } from './debuggerSource'

function fakeDebugger() {
    const calls: Array<{ method: string; params?: unknown }> = []
    const listeners: Array<(event: unknown, method: string, params: unknown) => void> = []
    let attached = false
    const dbg: DebuggerLike = {
        isAttached: () => attached,
        attach: () => { attached = true },
        detach: () => { attached = false },
        sendCommand: async (method, params) => { calls.push({ method, params }); return {} },
        on: (_event, listener) => { listeners.push(listener as never) },
        removeListener: (_event, listener) => { const i = listeners.indexOf(listener as never); if (i >= 0) listeners.splice(i, 1) },
    }
    return { dbg, calls, fire: (method: string, params: unknown) => listeners.forEach((l) => l({}, method, params)), attached: () => attached, listeners }
}

describe('debugger screencast source', () => {
    it('attaches, starts a bounded JPEG screencast, forwards frames and acks each one', async () => {
        const fake = fakeDebugger()
        const source = createDebuggerScreencastSource(fake.dbg)
        const frames: unknown[] = []
        await source.startScreencast((frame) => frames.push(frame))
        expect(fake.attached()).toBe(true)
        expect(fake.calls[0]).toMatchObject({ method: 'Page.startScreencast', params: { format: 'jpeg', maxWidth: 1280, maxHeight: 800 } })
        fake.fire('Page.screencastFrame', { data: 'JPEG', sessionId: 7, metadata: { deviceWidth: 640, deviceHeight: 400 } })
        expect(frames).toEqual([{ data: 'JPEG', width: 640, height: 400 }])
        expect(fake.calls.at(-1)).toEqual({ method: 'Page.screencastFrameAck', params: { sessionId: 7 } })
    })

    it('maps normalized viewer coordinates onto the last frame size for mouse and wheel events', async () => {
        const fake = fakeDebugger()
        const source = createDebuggerScreencastSource(fake.dbg)
        await source.startScreencast(() => {})
        fake.fire('Page.screencastFrame', { data: 'x', sessionId: 1, metadata: { deviceWidth: 1000, deviceHeight: 500 } })
        await source.dispatchInput({ t: 'mouse', kind: 'mousePressed', nx: 0.5, ny: 0.2, button: 'left', clickCount: 1 })
        await source.dispatchInput({ t: 'wheel', nx: 0.1, ny: 0.1, deltaX: 0, deltaY: 120 })
        await source.dispatchInput({ t: 'key', kind: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', modifiers: 0 })
        const [, , mouse, wheel, key] = fake.calls
        expect(mouse).toEqual({ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 500, y: 100, button: 'left', clickCount: 1, modifiers: 0 } })
        expect(wheel).toEqual({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 100, y: 50, deltaX: 0, deltaY: 120, modifiers: 0 } })
        expect(key).toEqual({ method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', modifiers: 0, windowsVirtualKeyCode: 13 } })
    })

    it('stops the screencast, removes its listener and detaches', async () => {
        const fake = fakeDebugger()
        const source = createDebuggerScreencastSource(fake.dbg)
        await source.startScreencast(() => {})
        await source.stopScreencast()
        expect(fake.calls.at(-1)).toEqual({ method: 'Page.stopScreencast', params: undefined })
        expect(fake.listeners).toHaveLength(0)
        expect(fake.attached()).toBe(false)
    })

    it('drops input that arrives before the first frame instead of guessing a size', async () => {
        const fake = fakeDebugger()
        const source = createDebuggerScreencastSource(fake.dbg)
        await source.startScreencast(() => {})
        await source.dispatchInput({ t: 'mouse', kind: 'mouseMoved', nx: 0.5, ny: 0.5, button: 'none', clickCount: 0 })
        expect(fake.calls.map((c) => c.method)).toEqual(['Page.startScreencast'])
    })
})
