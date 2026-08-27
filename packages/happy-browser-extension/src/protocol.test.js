import { describe, it, expect } from 'vitest'
import { handleCommand } from './protocol.js'

/** Minimal stand-in for the parts of the chrome API the protocol uses. */
function fakeChrome({ tabs = [], executeScript, captureVisibleTab, update, create, remove, allowlist, debuggerGranted = false, sendCommand, windows, profile } = {}) {
    const cdpCalls = []
    return {
        cdpCalls,
        storage: {
            local: {
                get: async () => ({
                    ...(allowlist === undefined ? {} : { allowlist }),
                    ...(profile === undefined ? {} : { profile }),
                    debuggerTier: debuggerGranted,
                }),
            },
        },
        ...(windows === undefined ? {} : { windows: { getAll: async () => windows } }),
        debugger: {
            attach: async () => { cdpCalls.push(['attach']) },
            detach: async () => { cdpCalls.push(['detach']) },
            sendCommand: sendCommand ?? (async (_target, method, params) => {
                cdpCalls.push([method, params])
                return method === 'Page.captureScreenshot' ? { data: 'FULLPAGE' } : {}
            }),
        },
        tabs: {
            query: async (query) => (query && query.active ? tabs.filter((t) => t.active) : tabs),
            get: async (tabId) => {
                const found = tabs.find((t) => t.id === tabId)
                if (!found) throw new Error(`No tab with id: ${tabId}`)
                return found
            },
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
                profile: null,
                windowCount: null,
                totalTabs: 2,
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

    /**
     * A Chrome profile with no open windows answers every command happily and
     * returns an empty tab list — indistinguishable, from the agent's side,
     * from "the user closed everything". Reporting who answered and how many
     * windows they have is what makes that diagnosable.
     */
    describe('tabs_list diagnostics', () => {
        it('names the profile that answered and how many windows it has', async () => {
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                windows: [{ id: 1 }, { id: 2 }],
                profile: 'work',
            })
            const response = await handleCommand({ id: 20, method: 'tabs_list' }, chrome)
            expect(response.result.profile).toBe('work')
            expect(response.result.windowCount).toBe(2)
        })

        it('reports zero windows rather than looking like an empty browser', async () => {
            const chrome = fakeChrome({ tabs: [], windows: [], profile: 'ghost' })
            const response = await handleCommand({ id: 21, method: 'tabs_list' }, chrome)
            expect(response.result.tabs).toEqual([])
            expect(response.result.windowCount).toBe(0)
        })

        it('separates "no tabs" from "every tab hidden by the allowlist"', async () => {
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB, { id: 8, windowId: 1, index: 1, url: 'https://b.com', title: 'B', active: false }],
                allowlist: 'nowhere.example',
                windows: [{ id: 1 }],
            })
            const response = await handleCommand({ id: 22, method: 'tabs_list' }, chrome)
            expect(response.result.tabs).toEqual([])
            expect(response.result.totalTabs).toBe(2)
        })

        it('still answers when the chrome build exposes no windows API', async () => {
            const response = await handleCommand({ id: 23, method: 'tabs_list' }, fakeChrome({ tabs: [ACTIVE_TAB] }))
            expect(response.error).toBeUndefined()
            expect(response.result.windowCount).toBeNull()
            expect(response.result.profile).toBeNull()
        })

        it('capabilities names the answering profile too', async () => {
            const response = await handleCommand({ id: 24, method: 'capabilities' }, fakeChrome({ profile: 'work' }))
            expect(response.result.profile).toBe('work')
        })
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
            storage: { local: { get: async () => ({}) } },
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
            expect(injectedTarget).toEqual({ tabId: 7, allFrames: true })
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
            expect(injectedTarget).toEqual({ tabId: 42, allFrames: true })
        })

        it('reports NO_ACTIVE_TAB when there is nothing to snapshot', async () => {
            const response = await handleCommand({ id: 8, method: 'snapshot' }, fakeChrome({ tabs: [] }))
            expect(response.error.code).toBe('NO_ACTIVE_TAB')
        })

        // A headless Linux Chrome under Xvfb has no window manager, so no
        // window is ever "last focused" — the tab is active, but the focused
        // lookup comes back empty and every ref-less command used to fail.
        it('falls back to the active tab of any window when no window is focused', async () => {
            const chrome = fakeChrome({ tabs: [ACTIVE_TAB] })
            const queries = []
            chrome.tabs.query = async (query) => {
                queries.push(query)
                if (query.lastFocusedWindow) return []
                return query.active ? [ACTIVE_TAB] : [ACTIVE_TAB]
            }
            const response = await handleCommand({ id: 9, method: 'snapshot' }, chrome)
            expect(response.error).toBeUndefined()
            expect(queries).toEqual([
                { active: true, lastFocusedWindow: true },
                { active: true },
            ])
        })

        it('still reports NO_ACTIVE_TAB when the fallback finds nothing either', async () => {
            const chrome = fakeChrome({ tabs: [] })
            chrome.tabs.query = async () => []
            const response = await handleCommand({ id: 10, method: 'snapshot' }, chrome)
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

        // captureVisibleTab needs a real composited surface. A headless Chrome
        // has none, so on that box it is the CDP path or nothing.
        it('falls back to CDP when captureVisibleTab fails and the debugger tier is on', async () => {
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                debuggerGranted: true,
                captureVisibleTab: async () => { throw new Error('Failed to capture tab') },
                sendCommand: async (_target, method, params) => {
                    expect(method).toBe('Page.captureScreenshot')
                    expect(params.captureBeyondViewport).toBe(false)
                    return { data: 'VIEWPORT' }
                },
            })
            const response = await handleCommand({ id: 12, method: 'screenshot' }, chrome)
            expect(response.result).toEqual({ mimeType: 'image/png', dataB64: 'VIEWPORT' })
        })

        it('surfaces the original capture failure when the debugger tier is off', async () => {
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                captureVisibleTab: async () => { throw new Error('Failed to capture tab') },
            })
            const response = await handleCommand({ id: 13, method: 'screenshot' }, chrome)
            expect(response.error.message).toContain('Failed to capture tab')
        })
    })

    describe('frames', () => {
        const TAB = { id: 7, windowId: 1, index: 0, url: 'https://a.com', title: 'A', active: true }

        it('snapshots every frame and merges them under non-colliding refs', async () => {
            let injectOptions
            const chrome = fakeChrome({
                tabs: [TAB],
                executeScript: async (options) => {
                    injectOptions = options
                    return [
                        { frameId: 0, result: { url: 'https://a.com/', title: 'A', elements: [{ ref: '@e1', name: 'Main' }], truncated: false } },
                        { frameId: 7, result: { url: 'https://embed.example/', title: 'E', elements: [{ ref: '@e1', name: 'Embedded' }], truncated: false } },
                    ]
                },
            })
            const response = await handleCommand({ id: 60, method: 'snapshot' }, chrome)
            expect(injectOptions.target).toMatchObject({ tabId: 7, allFrames: true })
            expect(response.result.elements.map((e) => e.ref)).toEqual(['@e1', '@f7:e1'])
            expect(response.result.url).toBe('https://a.com/')
        })

        it('sends a click for a frame-qualified ref to that frame only', async () => {
            let injectOptions
            const chrome = fakeChrome({
                tabs: [TAB],
                executeScript: async (options) => {
                    injectOptions = options
                    return [{ frameId: 7, result: { ok: true } }]
                },
            })
            const response = await handleCommand({ id: 61, method: 'click', params: { ref: '@f7:e1' } }, chrome)
            expect(response.error).toBeUndefined()
            // The frame-local ref is what the injected function understands.
            expect(injectOptions.args).toEqual(['@e1'])
            expect(injectOptions.target).toMatchObject({ tabId: 7, frameIds: [7] })
        })

        it('sends a main-frame click to the main frame, not every frame', async () => {
            // Broadcasting to allFrames would run the action in each one and
            // hit whatever @e1 happens to mean there.
            let injectOptions
            const chrome = fakeChrome({
                tabs: [TAB],
                executeScript: async (options) => {
                    injectOptions = options
                    return [{ frameId: 0, result: { ok: true } }]
                },
            })
            await handleCommand({ id: 62, method: 'click', params: { ref: '@e1' } }, chrome)
            expect(injectOptions.args).toEqual(['@e1'])
            expect(injectOptions.target).toMatchObject({ tabId: 7, frameIds: [0] })
        })

        it('fills a frame-qualified ref in its own frame', async () => {
            let injectOptions
            const chrome = fakeChrome({
                tabs: [TAB],
                executeScript: async (options) => {
                    injectOptions = options
                    return [{ frameId: 3, result: { ok: true, value: 'hi' } }]
                },
            })
            await handleCommand({ id: 63, method: 'fill', params: { ref: '@f3:e2', value: 'hi' } }, chrome)
            expect(injectOptions.args).toEqual(['@e2', 'hi'])
            expect(injectOptions.target).toMatchObject({ frameIds: [3] })
        })

        it('ignores frames that returned nothing rather than failing the snapshot', async () => {
            const chrome = fakeChrome({
                tabs: [TAB],
                executeScript: async () => [
                    { frameId: 0, result: { url: 'https://a.com/', title: 'A', elements: [{ ref: '@e1', name: 'Main' }], truncated: false } },
                    { frameId: 4, result: null },
                ],
            })
            const response = await handleCommand({ id: 64, method: 'snapshot' }, chrome)
            expect(response.result.elements.map((e) => e.ref)).toEqual(['@e1'])
        })

        it('refuses a trusted click on a frame-qualified ref instead of clicking the wrong point', async () => {
            // CDP mouse events use top-level viewport coordinates, but
            // locateRef measures inside the frame — so a trusted click on an
            // iframe element would land at the wrong place. Refuse rather than
            // mis-click; the untrusted path (element.click) is coordinate-free
            // and works in frames.
            const chrome = fakeChrome({ tabs: [TAB], debuggerGranted: true })
            const response = await handleCommand({ id: 65, method: 'click', params: { ref: '@f7:e1', trusted: true } }, chrome)
            expect(response.error.code).toBe('TRUSTED_FRAME_UNSUPPORTED')
            expect(response.error.message).toMatch(/without trusted|trusted:\s*false|일반/i)
            expect(chrome.cdpCalls).toEqual([])
        })

        it('refuses a trusted fill on a frame-qualified ref for the same reason', async () => {
            const chrome = fakeChrome({ tabs: [TAB], debuggerGranted: true })
            const response = await handleCommand({ id: 66, method: 'fill', params: { ref: '@f7:e1', value: 'x', trusted: true } }, chrome)
            expect(response.error.code).toBe('TRUSTED_FRAME_UNSUPPORTED')
            expect(chrome.cdpCalls).toEqual([])
        })

        it('still allows a trusted click on a main-frame ref', async () => {
            const chrome = fakeChrome({
                tabs: [TAB],
                debuggerGranted: true,
                executeScript: async () => [{ frameId: 0, result: { ok: true, x: 5, y: 6 } }],
            })
            const response = await handleCommand({ id: 67, method: 'click', params: { ref: '@e1', trusted: true } }, chrome)
            expect(response.error).toBeUndefined()
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
            expect(injected.target).toEqual({ tabId: 7, frameIds: [0] })
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

        it('reports NO_RESULT when a target frame disappears and Chrome returns no injection entry', async () => {
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                executeScript: async () => [],
            })

            const response = await handleCommand({ id: 140, method: 'scroll', params: { ref: '@f12:e4', deltaY: 300 } }, chrome)

            expect(response.error.code).toBe('NO_RESULT')
        })

        it('reports MISSING_PARAM when click is called without a ref', async () => {
            const response = await handleCommand({ id: 15, method: 'click', params: {} }, fakeChrome({ tabs: [ACTIVE_TAB] }))
            expect(response.error.code).toBe('MISSING_PARAM')
        })
    })

    describe('scroll', () => {
        it('injects a document scroll into the main frame', async () => {
            let injected
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                executeScript: async (options) => {
                    injected = options
                    return [{ result: { ok: true, target: 'document', moved: true } }]
                },
            })

            const response = await handleCommand({ id: 70, method: 'scroll', params: { deltaY: 600 } }, chrome)

            expect(injected.target).toEqual({ tabId: 7, frameIds: [0] })
            expect(injected.args).toEqual([null, 0, 600])
            expect(response.result).toMatchObject({ ok: true, moved: true })
        })

        it('routes a frame-qualified ref to that frame only', async () => {
            let injected
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                executeScript: async (options) => {
                    injected = options
                    return [{ result: { ok: true, target: '@e4', moved: true } }]
                },
            })

            const response = await handleCommand({ id: 71, method: 'scroll', params: { ref: '@f12:e4', deltaY: 400 } }, chrome)

            expect(injected.target).toEqual({ tabId: 7, frameIds: [12] })
            expect(injected.args).toEqual(['@e4', 0, 400])
            expect(response.result.target).toBe('@f12:e4')
        })

        it('rejects a zero scroll before injecting', async () => {
            let injections = 0
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                executeScript: async () => {
                    injections += 1
                    return [{ result: { ok: true } }]
                },
            })

            const response = await handleCommand({ id: 72, method: 'scroll', params: { deltaX: 0, deltaY: 0 } }, chrome)

            expect(response.error.code).toBe('INVALID_SCROLL_DELTA')
            expect(injections).toBe(0)
        })

        it('rejects an unbounded pixel delta before injecting', async () => {
            const response = await handleCommand({ id: 73, method: 'scroll', params: { deltaY: 10_001 } }, fakeChrome({ tabs: [ACTIVE_TAB] }))
            expect(response.error.code).toBe('INVALID_SCROLL_DELTA')
            expect(response.error.message).toContain('10000')
        })

        it('rejects an explicitly empty ref instead of scrolling the document', async () => {
            let injections = 0
            const chrome = fakeChrome({
                tabs: [ACTIVE_TAB],
                executeScript: async () => {
                    injections += 1
                    return [{ result: { ok: true } }]
                },
            })

            const response = await handleCommand({ id: 74, method: 'scroll', params: { ref: '', deltaY: 300 } }, chrome)

            expect(response.error.code).toBe('MISSING_PARAM')
            expect(injections).toBe(0)
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
            const chrome = fakeChrome({ tabs: [ACTIVE_TAB], remove: async (tabId) => { removed = tabId } })
            const response = await handleCommand({ id: 19, method: 'tabs_close', params: { tabId: 7 } }, chrome)
            expect(removed).toBe(7)
            expect(response.result).toEqual({ ok: true })
        })

        it('reports MISSING_PARAM when tabs_close has no tabId', async () => {
            const response = await handleCommand({ id: 20, method: 'tabs_close', params: {} }, fakeChrome())
            expect(response.error.code).toBe('MISSING_PARAM')
        })
    })

    describe('allowlist enforcement', () => {
        const BANK_TAB = { id: 3, windowId: 1, index: 1, url: 'https://bank.example/accounts', title: 'Bank', active: false }
        const WORK_TAB = { id: 7, windowId: 1, index: 0, url: 'https://work.test/board', title: 'Work', active: true }

        it('acts normally when no allowlist is configured', async () => {
            const chrome = fakeChrome({ tabs: [WORK_TAB] })
            const response = await handleCommand({ id: 30, method: 'snapshot' }, chrome)
            expect(response.error).toBeUndefined()
        })

        it('refuses to snapshot a tab outside the allowlist', async () => {
            const chrome = fakeChrome({ tabs: [WORK_TAB, BANK_TAB], allowlist: 'work.test' })
            const response = await handleCommand({ id: 31, method: 'snapshot', params: { tabId: 3 } }, chrome)
            expect(response.error.code).toBe('SITE_NOT_ALLOWED')
        })

        it('does not echo a blocked tab\'s url back in the refusal', async () => {
            // Otherwise tabs_list filtering is pointless: the agent walks tab
            // ids and reads the URLs it is not allowed to see straight out of
            // the error messages.
            const chrome = fakeChrome({ tabs: [WORK_TAB, BANK_TAB], allowlist: 'work.test' })
            for (const method of ['snapshot', 'screenshot', 'click', 'scroll', 'tabs_close']) {
                const response = await handleCommand({ id: 31, method, params: { tabId: 3, ref: '@e1', deltaY: 100 } }, chrome)
                expect(response.error.code).toBe('SITE_NOT_ALLOWED')
                expect(response.error.message).not.toContain('bank.example')
                expect(response.error.message).not.toContain('/accounts')
            }
        })

        it('does echo a caller-supplied destination url, which the caller already knows', async () => {
            const chrome = fakeChrome({ tabs: [WORK_TAB], allowlist: 'work.test' })
            const response = await handleCommand({ id: 31, method: 'tabs_open', params: { url: 'https://bank.example/' } }, chrome)
            expect(response.error.message).toContain('bank.example')
        })

        it('refuses to click in a tab outside the allowlist', async () => {
            const chrome = fakeChrome({ tabs: [WORK_TAB, BANK_TAB], allowlist: 'work.test' })
            const response = await handleCommand({ id: 32, method: 'click', params: { tabId: 3, ref: '@e1' } }, chrome)
            expect(response.error.code).toBe('SITE_NOT_ALLOWED')
        })

        it('refuses to screenshot a tab outside the allowlist', async () => {
            const chrome = fakeChrome({ tabs: [WORK_TAB, BANK_TAB], allowlist: 'work.test' })
            const response = await handleCommand({ id: 33, method: 'screenshot', params: { tabId: 3 } }, chrome)
            expect(response.error.code).toBe('SITE_NOT_ALLOWED')
        })

        it('still allows a tab inside the allowlist', async () => {
            const chrome = fakeChrome({ tabs: [WORK_TAB, BANK_TAB], allowlist: 'work.test' })
            const response = await handleCommand({ id: 34, method: 'snapshot', params: { tabId: 7 } }, chrome)
            expect(response.error).toBeUndefined()
        })

        it('refuses to navigate an allowed tab to a disallowed destination', async () => {
            // Otherwise the allowlist is trivially bypassed: navigate a
            // permitted tab to the bank, then act on it.
            const chrome = fakeChrome({ tabs: [WORK_TAB], allowlist: 'work.test' })
            const response = await handleCommand({ id: 35, method: 'navigate', params: { tabId: 7, url: 'https://bank.example/' } }, chrome)
            expect(response.error.code).toBe('SITE_NOT_ALLOWED')
        })

        it('refuses to open a new tab at a disallowed url', async () => {
            const chrome = fakeChrome({ tabs: [WORK_TAB], allowlist: 'work.test' })
            const response = await handleCommand({ id: 36, method: 'tabs_open', params: { url: 'https://bank.example/' } }, chrome)
            expect(response.error.code).toBe('SITE_NOT_ALLOWED')
        })

        it('hides disallowed tabs from tabs_list so their urls never leak', async () => {
            const chrome = fakeChrome({ tabs: [WORK_TAB, BANK_TAB], allowlist: 'work.test' })
            const response = await handleCommand({ id: 37, method: 'tabs_list' }, chrome)
            expect(response.result.tabs.map((t) => t.id)).toEqual([7])
        })

        it('refuses to close a tab outside the allowlist', async () => {
            const chrome = fakeChrome({ tabs: [WORK_TAB, BANK_TAB], allowlist: 'work.test' })
            const response = await handleCommand({ id: 38, method: 'tabs_close', params: { tabId: 3 } }, chrome)
            expect(response.error.code).toBe('SITE_NOT_ALLOWED')
        })

        it('leaves ping unrestricted so pairing can always be verified', async () => {
            const chrome = fakeChrome({ tabs: [], allowlist: 'work.test' })
            const response = await handleCommand({ id: 39, method: 'ping' }, chrome)
            expect(response.result).toBe('pong')
        })
    })

    describe('debugger tier (Phase 5)', () => {
        const TAB = { id: 7, windowId: 1, index: 0, url: 'https://a.com', title: 'A', active: true }

        it('capabilities reports the debugger tier as off by default', async () => {
            const response = await handleCommand({ id: 40, method: 'capabilities' }, fakeChrome({ tabs: [TAB] }))
            expect(response.result.debugger).toBe(false)
        })

        it('capabilities reports it on once the user grants it', async () => {
            const response = await handleCommand({ id: 41, method: 'capabilities' }, fakeChrome({ tabs: [TAB], debuggerGranted: true }))
            expect(response.result.debugger).toBe(true)
        })

        it('capabilities lists the commands so the agent need not guess', async () => {
            const response = await handleCommand({ id: 42, method: 'capabilities' }, fakeChrome({ tabs: [TAB] }))
            expect(response.result.commands).toContain('snapshot')
            expect(response.result.commands).toContain('tabs_close')
        })

        it('a plain screenshot still uses the permission-free path', async () => {
            const chrome = fakeChrome({ tabs: [TAB], debuggerGranted: true })
            const response = await handleCommand({ id: 43, method: 'screenshot' }, chrome)
            expect(response.result.dataB64).toBe('AAAA')
            expect(chrome.cdpCalls).toEqual([])
        })

        it('fullPage screenshot goes through CDP when granted', async () => {
            const chrome = fakeChrome({ tabs: [TAB], debuggerGranted: true })
            const response = await handleCommand({ id: 44, method: 'screenshot', params: { fullPage: true } }, chrome)
            expect(response.result.dataB64).toBe('FULLPAGE')
            expect(chrome.cdpCalls.some((c) => c[0] === 'Page.captureScreenshot')).toBe(true)
        })

        it('fullPage without the permission fails loudly instead of quietly returning a viewport shot', async () => {
            // Silently downgrading would hand back an image that does not
            // show what was asked for, and nothing would say so.
            const chrome = fakeChrome({ tabs: [TAB], debuggerGranted: false })
            const response = await handleCommand({ id: 45, method: 'screenshot', params: { fullPage: true } }, chrome)
            expect(response.error.code).toBe('DEBUGGER_NOT_AVAILABLE')
            expect(response.error.message).toMatch(/options/i)
        })

        it('trusted click dispatches real input events at the ref position', async () => {
            const chrome = fakeChrome({
                tabs: [TAB],
                debuggerGranted: true,
                executeScript: async () => [{ result: { ok: true, x: 12, y: 34 } }],
            })
            const response = await handleCommand({ id: 46, method: 'click', params: { ref: '@e1', trusted: true } }, chrome)
            expect(response.error).toBeUndefined()
            const press = chrome.cdpCalls.find((c) => c[0] === 'Input.dispatchMouseEvent')
            expect(press[1]).toMatchObject({ x: 12, y: 34 })
        })

        it('trusted click without the permission fails loudly', async () => {
            const chrome = fakeChrome({ tabs: [TAB], debuggerGranted: false })
            const response = await handleCommand({ id: 47, method: 'click', params: { ref: '@e1', trusted: true } }, chrome)
            expect(response.error.code).toBe('DEBUGGER_NOT_AVAILABLE')
        })

        it('trusted click surfaces a stale ref rather than clicking a stale point', async () => {
            const chrome = fakeChrome({
                tabs: [TAB],
                debuggerGranted: true,
                executeScript: async () => [{ result: { ok: false, code: 'REF_NOT_FOUND', message: 'No element for @e9' } }],
            })
            const response = await handleCommand({ id: 48, method: 'click', params: { ref: '@e9', trusted: true } }, chrome)
            expect(response.error.code).toBe('REF_NOT_FOUND')
            expect(chrome.cdpCalls.some((c) => c[0] === 'Input.dispatchMouseEvent')).toBe(false)
        })

        it('trusted fill focuses the ref then inserts text as real input', async () => {
            const chrome = fakeChrome({
                tabs: [TAB],
                debuggerGranted: true,
                executeScript: async () => [{ result: { ok: true, x: 5, y: 6 } }],
            })
            const response = await handleCommand({ id: 49, method: 'fill', params: { ref: '@e1', value: 'hi', trusted: true } }, chrome)
            expect(response.error).toBeUndefined()
            const insert = chrome.cdpCalls.find((c) => c[0] === 'Input.insertText')
            expect(insert[1]).toEqual({ text: 'hi' })
        })

        it('untrusted click keeps working with no debugger involvement', async () => {
            const chrome = fakeChrome({
                tabs: [TAB],
                debuggerGranted: true,
                executeScript: async () => [{ result: { ok: true } }],
            })
            const response = await handleCommand({ id: 50, method: 'click', params: { ref: '@e1' } }, chrome)
            expect(response.result).toEqual({ ok: true })
            expect(chrome.cdpCalls).toEqual([])
        })

        it('the debugger tier respects the allowlist like everything else', async () => {
            const chrome = fakeChrome({
                tabs: [TAB, { id: 3, url: 'https://bank.example/', title: 'Bank' }],
                allowlist: 'a.com',
                debuggerGranted: true,
            })
            const response = await handleCommand({ id: 51, method: 'screenshot', params: { tabId: 3, fullPage: true } }, chrome)
            expect(response.error.code).toBe('SITE_NOT_ALLOWED')
            expect(chrome.cdpCalls).toEqual([])
        })
    })
})
