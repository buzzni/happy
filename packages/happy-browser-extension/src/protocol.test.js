import { describe, it, expect } from 'vitest'
import { handleCommand } from './protocol.js'

/** Minimal stand-in for the parts of the chrome API the protocol uses. */
function fakeChrome(tabs = []) {
    return {
        tabs: {
            query: async () => tabs,
        },
    }
}

describe('handleCommand', () => {
    it('answers ping with pong', async () => {
        const response = await handleCommand({ id: 1, method: 'ping' }, fakeChrome())
        expect(response).toEqual({ id: 1, result: 'pong' })
    })

    it('returns the open tabs for tabs_list', async () => {
        const chrome = fakeChrome([
            { id: 7, windowId: 1, index: 0, url: 'https://a.com', title: 'A', active: true },
            { id: 8, windowId: 1, index: 1, url: 'https://b.com', title: 'B', active: false },
        ])
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
        const chrome = fakeChrome([
            { id: undefined, url: 'about:blank' },
            { id: 9, windowId: 1, index: 0, url: 'https://a.com', title: 'A', active: true },
        ])
        const response = await handleCommand({ id: 3, method: 'tabs_list' }, chrome)
        expect(response.result.tabs).toHaveLength(1)
        expect(response.result.tabs[0].id).toBe(9)
    })

    it('reports UNKNOWN_METHOD for a command it does not implement', async () => {
        const response = await handleCommand({ id: 4, method: 'browser_click' }, fakeChrome())
        expect(response).toEqual({
            id: 4,
            error: { code: 'UNKNOWN_METHOD', message: 'Unsupported method: browser_click' },
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
})
