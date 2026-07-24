import { describe, it, expect } from 'vitest'
import { handleCommand } from './protocol.js'

/** Minimal stand-in for the parts of the chrome API the protocol uses. */
function fakeChrome({ tabs = [], executeScript, captureVisibleTab, update, create, remove } = {}) {
    return {
        tabs: {
            query: async (query) => (query && query.active ? tabs.filter((t) => t.active) : tabs),
            captureVisibleTab: captureVisibleTab ?? (async () => 'data:image/png;base64,AAAA'),
            update: update ?? (async (tabId, props) => ({ id: tabId, ...props })),
            create: create ?? (async (props) => ({ id: 99, windowId: 1, ...props })),
            remove: remove ?? (async () => {}),
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

    describe('click and fill', () => {
        it('injects clickRef with the given ref into the target tab', async () => {
            let injected
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                executeScript: async (options) => {
                    injected = options
                    return [{ result: { ok: true } }]
                },
            })
            const response = await handleCommand({ id: 12, method: 'click', params: { ref: '@e1' } }, chrome)
            expect(injected.target).toEqual({ tabId: 7 })
            expect(injected.args).toEqual(['@e1'])
            expect(response.result).toEqual({ ok: true })
        })

        it('injects fillRef with ref and value', async () => {
            let injected
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                executeScript: async (options) => {
                    injected = options
                    return [{ result: { ok: true } }]
                },
            })
            await handleCommand({ id: 13, method: 'fill', params: { ref: '@e2', value: 'hi' } }, chrome)
            expect(injected.args).toEqual(['@e2', 'hi'])
        })

        it('reports the code/message an action returns for a stale ref (e.g. REF_NOT_FOUND)', async () => {
            // clickRef/fillRef never throw — a thrown error crossing
            // chrome.scripting.executeScript's boundary was observed in real
            // Chrome to resolve as silent success instead of rejecting, so
            // failure travels as a normal `{ok:false,...}` return value.
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                executeScript: async () => [{ result: { ok: false, code: 'REF_NOT_FOUND', message: 'No element for @e9 — the page may have changed since the last snapshot.' } }],
            })
            const response = await handleCommand({ id: 14, method: 'click', params: { ref: '@e9' } }, chrome)
            expect(response.error.code).toBe('REF_NOT_FOUND')
            expect(response.error.message).toContain('@e9')
        })

        it('reports INJECTION_FAILED when Chrome refuses to run the script at all', async () => {
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                executeScript: async () => {
                    throw new Error('Cannot access a chrome:// URL')
                },
            })
            const response = await handleCommand({ id: 14, method: 'click', params: { ref: '@e1' } }, chrome)
            expect(response.error.code).toBe('INJECTION_FAILED')
        })

        it('reports NO_RESULT instead of treating a missing result as success', async () => {
            // Observed for real against Chrome: some execution paths resolve
            // executeScript with an injectionResult that has no `.result` at
            // all. Silently returning that as success would tell the agent
            // the click/fill worked when we genuinely don't know.
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                executeScript: async () => [{}],
            })
            const response = await handleCommand({ id: 14, method: 'click', params: { ref: '@e1' } }, chrome)
            expect(response.error.code).toBe('NO_RESULT')
        })

        it('reports MISSING_PARAM when click is called without a ref', async () => {
            const response = await handleCommand({ id: 15, method: 'click', params: {} }, fakeChrome({ tabs: [ACTIVE_TAB] }))
            expect(response.error.code).toBe('MISSING_PARAM')
        })
    })

    describe('navigate', () => {
        it('updates the target tab to the given url', async () => {
            let updated
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                update: async (tabId, props) => { updated = { tabId, props }; return { id: tabId } },
            })
            const response = await handleCommand({ id: 16, method: 'navigate', params: { url: 'https://b.com' } }, chrome)
            expect(updated).toEqual({ tabId: 7, props: { url: 'https://b.com' } })
            expect(response.result).toEqual({ ok: true })
        })

        it('reports MISSING_PARAM without a url', async () => {
            const response = await handleCommand({ id: 17, method: 'navigate', params: {} }, fakeChrome({ tabs: [ACTIVE_TAB] }))
            expect(response.error.code).toBe('MISSING_PARAM')
        })
    })

    describe('tabs_open and tabs_close', () => {
        it('opens a new tab at the given url', async () => {
            const chrome = fakeChrome({ create: async (props) => ({ id: 55, windowId: 2, ...props }) })
            const response = await handleCommand({ id: 18, method: 'tabs_open', params: { url: 'https://c.com' } }, chrome)
            expect(response.result).toEqual({ id: 55, windowId: 2, url: 'https://c.com' })
        })

        it('closes the given tab', async () => {
            let removed
            const chrome = fakeChrome({ remove: async (tabId) => { removed = tabId } })
            const response = await handleCommand({ id: 19, method: 'tabs_close', params: { tabId: 7 } }, chrome)
            expect(removed).toBe(7)
            expect(response.result).toEqual({ ok: true })
        })

        it('reports MISSING_PARAM when tabs_close has no tabId', async () => {
            const response = await handleCommand({ id: 20, method: 'tabs_close', params: {} }, fakeChrome())
            expect(response.error.code).toBe('MISSING_PARAM')
        })
    })
})
