import { describe, it, expect } from 'vitest'
import { hasDebuggerPermission, withDebugger, captureFullPage, dispatchTrustedClick, insertTrustedText, DebuggerUnavailableError } from './cdp.js'

function fakeChrome({ granted = true, sendCommand, attach, detach } = {}) {
    const calls = []
    return {
        calls,
        permissions: { contains: async () => granted },
        debugger: {
            attach: attach ?? (async (target, version) => { calls.push(['attach', target, version]) }),
            detach: detach ?? (async (target) => { calls.push(['detach', target]) }),
            sendCommand: sendCommand ?? (async (target, method, params) => {
                calls.push(['send', method, params])
                return {}
            }),
        },
    }
}

describe('hasDebuggerPermission', () => {
    it('is true when the optional permission has been granted', async () => {
        expect(await hasDebuggerPermission(fakeChrome({ granted: true }))).toBe(true)
    })

    it('is false when it has not', async () => {
        expect(await hasDebuggerPermission(fakeChrome({ granted: false }))).toBe(false)
    })

    it('is false rather than throwing when the API is missing entirely', async () => {
        expect(await hasDebuggerPermission({})).toBe(false)
    })
})

describe('withDebugger', () => {
    it('attaches, runs the body, and detaches', async () => {
        const chrome = fakeChrome()
        const result = await withDebugger(chrome, 7, async () => 'done')
        expect(result).toBe('done')
        expect(chrome.calls[0]).toEqual(['attach', { tabId: 7 }, '1.3'])
        expect(chrome.calls[chrome.calls.length - 1]).toEqual(['detach', { tabId: 7 }])
    })

    it('detaches even when the body throws', async () => {
        // Otherwise a failure leaves Chrome's "being debugged" banner up and
        // the tab attached, which the user has to clear by hand.
        const chrome = fakeChrome()
        await expect(withDebugger(chrome, 7, async () => { throw new Error('boom') })).rejects.toThrow('boom')
        expect(chrome.calls[chrome.calls.length - 1]).toEqual(['detach', { tabId: 7 }])
    })

    it('does not fail the whole call if detaching fails', async () => {
        // The tab may have closed mid-command; the result the caller asked
        // for is still valid.
        const chrome = fakeChrome({ detach: async () => { throw new Error('No target with given id') } })
        await expect(withDebugger(chrome, 7, async () => 'done')).resolves.toBe('done')
    })

    it('refuses up front when the permission is not granted', async () => {
        const chrome = fakeChrome({ granted: false })
        await expect(withDebugger(chrome, 7, async () => 'done')).rejects.toBeInstanceOf(DebuggerUnavailableError)
        expect(chrome.calls).toEqual([])
    })

    it('explains how to turn the permission on', async () => {
        const chrome = fakeChrome({ granted: false })
        await expect(withDebugger(chrome, 7, async () => 'x')).rejects.toThrow(/options/i)
    })
})

describe('captureFullPage', () => {
    it('captures beyond the viewport and returns the raw base64', async () => {
        const chrome = fakeChrome({
            sendCommand: async (_target, method) => {
                if (method === 'Page.captureScreenshot') return { data: 'PNGDATA' }
                return {}
            },
        })
        const result = await captureFullPage(chrome, 7)
        expect(result).toEqual({ mimeType: 'image/png', dataB64: 'PNGDATA' })
    })

    it('asks for the whole page, not just what is on screen', async () => {
        const chrome = fakeChrome({
            sendCommand: async (_t, method, params) => {
                chrome.calls.push(['send', method, params])
                return method === 'Page.captureScreenshot' ? { data: 'X' } : {}
            },
        })
        await captureFullPage(chrome, 7)
        const shot = chrome.calls.find((c) => c[1] === 'Page.captureScreenshot')
        expect(shot[2]).toMatchObject({ captureBeyondViewport: true, format: 'png' })
    })
})

describe('dispatchTrustedClick', () => {
    it('sends a press and a release at the given point', async () => {
        const chrome = fakeChrome()
        await dispatchTrustedClick(chrome, 7, { x: 10, y: 20 })
        const events = chrome.calls.filter((c) => c[1] === 'Input.dispatchMouseEvent').map((c) => c[2])
        expect(events.map((e) => e.type)).toEqual(['mousePressed', 'mouseReleased'])
        expect(events[0]).toMatchObject({ x: 10, y: 20, button: 'left', clickCount: 1 })
    })
})

describe('insertTrustedText', () => {
    it('inserts the text as real input', async () => {
        const chrome = fakeChrome()
        await insertTrustedText(chrome, 7, 'hello')
        const insert = chrome.calls.find((c) => c[1] === 'Input.insertText')
        expect(insert[2]).toEqual({ text: 'hello' })
    })
})
