import { describe, it, expect } from 'vitest'
import { handleCommand } from './protocol.js'

/** Minimal stand-in for the parts of the chrome API the protocol uses. */
function fakeChrome({ tabs = [], executeScript, captureVisibleTab } = {}) {
    return {
        tabs: {
            query: async (query) => (query && query.active ? tabs.filter((t) => t.active) : tabs),
            captureVisibleTab: captureVisibleTab ?? (async () => 'data:image/png;base64,AAAA'),
        },
        scripting: {
            executeScript: executeScript ?? (async () => [{ result: { url: 'https://a.com', title: 'A', elements: [], truncated: false } }]),
        },
    }
}

const ACTIVE_TAB = { id: 7, windowId: 1, index: 0, url: 'https://a.com', title: 'A', active: true }

describe('handleCommand', () => {
    it('answers ping with pong', async () => {
        const response = await handleCommand({ id: 1, method: 'ping' }, fakeChrome())
        expect(response).toEqual({ id: 1, result: 'pong' })
    })

    it('returns the open tabs for tabs_list', async () => {
        const chrome = fakeChrome({
            tabs: [
                { id: 7, windowId: 1, index: 0, url: 'https://a.com', title: 'A', active: true },
                { id: 8, windowId: 1, index: 1, url: 'https://b.com', title: 'B', active: false },
            ],
        })
        const response = await handleCommand({ id: 2, method: 'tabs_list' }, chrome)
        expect(response).toEqual({
            id: 2,
            result: {
                tabs: [
                    { id: 7, windowId: 1, index: 0, url: 'https://a.com', title: 'A', active: true },
                    { id: 8, windowId: 1, index: 1, url: 'https://b.com', title: 'B', active: false },
                ],
            },
        })
    })

    it('omits tabs that have no id (a tab Chrome cannot address)', async () => {
        const chrome = fakeChrome({
            tabs: [
                { id: undefined, url: 'about:blank' },
                { id: 9, windowId: 1, index: 0, url: 'https://a.com', title: 'A', active: true },
            ],
        })
        const response = await handleCommand({ id: 3, method: 'tabs_list' }, chrome)
        expect(response.result.tabs).toHaveLength(1)
        expect(response.result.tabs[0].id).toBe(9)
    })

    it('reports UNKNOWN_METHOD for a command it does not implement', async () => {
        const response = await handleCommand({ id: 4, method: 'browser_teleport' }, fakeChrome())
        expect(response).toEqual({
            id: 4,
            error: { code: 'UNKNOWN_METHOD', message: 'Unsupported method: browser_teleport' },
        })
    })

    it('turns a thrown chrome API error into an error response, not a crash', async () => {
        const chrome = {
            tabs: {
                query: async () => {
                    throw new Error('Tabs API unavailable')
                },
            },
        }
        const response = await handleCommand({ id: 5, method: 'tabs_list' }, chrome)
        expect(response).toEqual({
            id: 5,
            error: { code: 'COMMAND_FAILED', message: 'Tabs API unavailable' },
        })
    })

    describe('snapshot', () => {
        it('injects the collector into the active tab and returns its result', async () => {
            let injectedTarget
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                executeScript: async (options) => {
                    injectedTarget = options.target
                    return [{ result: { url: 'https://a.com', title: 'A', elements: [{ ref: '@e1' }], truncated: false } }]
                },
            })
            const response = await handleCommand({ id: 6, method: 'snapshot' }, chrome)
            expect(injectedTarget).toEqual({ tabId: 7 })
            expect(response.result.elements).toEqual([{ ref: '@e1' }])
        })

        it('targets an explicit tabId when given one', async () => {
            let injectedTarget
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB, { id: 42, active: false, url: 'https://b.com' }],
                executeScript: async (options) => {
                    injectedTarget = options.target
                    return [{ result: { elements: [] } }]
                },
            })
            await handleCommand({ id: 7, method: 'snapshot', params: { tabId: 42 } }, chrome)
            expect(injectedTarget).toEqual({ tabId: 42 })
        })

        it('reports NO_ACTIVE_TAB when there is nothing to snapshot', async () => {
            const response = await handleCommand({ id: 8, method: 'snapshot' }, fakeChrome({ tabs: [] }))
            expect(response.error.code).toBe('NO_ACTIVE_TAB')
        })

        it('reports INJECTION_FAILED when Chrome refuses to inject', async () => {
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                executeScript: async () => {
                    throw new Error('Cannot access a chrome:// URL')
                },
            })
            const response = await handleCommand({ id: 9, method: 'snapshot' }, chrome)
            expect(response.error).toEqual({
                code: 'INJECTION_FAILED',
                message: 'Cannot access a chrome:// URL',
            })
        })
    })

    describe('screenshot', () => {
        it('captures the visible tab and returns the image without its data-url prefix', async () => {
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                captureVisibleTab: async () => 'data:image/png;base64,SGVsbG8=',
            })
            const response = await handleCommand({ id: 10, method: 'screenshot' }, chrome)
            expect(response.result).toEqual({ mimeType: 'image/png', dataB64: 'SGVsbG8=' })
        })

        it('reports NO_ACTIVE_TAB when no tab is focused', async () => {
            const response = await handleCommand({ id: 11, method: 'screenshot' }, fakeChrome({ tabs: [] }))
            expect(response.error.code).toBe('NO_ACTIVE_TAB')
        })
    })
})
