import { describe, it, expect } from 'vitest'
import { runBrowserTool, BROWSER_TOOL_NAMES, type BrowserToolResult } from './browserTools'
import { BrowserClientError } from '@/daemon/browserClient'

const textOf = (result: BrowserToolResult): string => {
    const block = result.content[0]
    if (block.type !== 'text') throw new Error(`expected a text block, got ${block.type}`)
    return block.text
}

const ok = (result: unknown) => async () => result
const fails = (code: string, message: string) => async () => {
    throw new BrowserClientError(code, message)
}

describe('BROWSER_TOOL_NAMES', () => {
    it('exposes the read and interaction browser tools', () => {
        expect(BROWSER_TOOL_NAMES).toEqual([
            'browser_tabs',
            'browser_snapshot',
            'browser_screenshot',
            'browser_click',
            'browser_fill',
            'browser_navigate',
            'browser_open_tab',
            'browser_close_tab',
            'browser_capabilities',
        ])
    })
})

describe('debugger tier reporting', () => {
    it('says plainly when the debugger tier is off and that it still works without it', async () => {
        const result = await runBrowserTool({
            request: ok({ debugger: false, commands: ['snapshot', 'click'] }),
            method: 'capabilities',
            params: {},
        })
        expect(textOf(result)).toMatch(/OFF/)
        expect(textOf(result)).toContain('snapshot')
    })

    it('says when it is on', async () => {
        const result = await runBrowserTool({
            request: ok({ debugger: true, commands: [] }),
            method: 'capabilities',
            params: {},
        })
        expect(textOf(result)).toMatch(/ON/)
    })

    it('turns a missing debugger permission into advice, including the fallback', async () => {
        const result = await runBrowserTool({
            request: fails('DEBUGGER_NOT_AVAILABLE', 'The debugger permission is not granted. Ask the user to enable it in the options page.'),
            method: 'screenshot',
            params: { fullPage: true },
        })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toContain('options page')
        expect(textOf(result)).toMatch(/normal screenshot|untrusted/)
    })
})

describe('runBrowserTool', () => {
    it('returns the tab list as readable text', async () => {
        const result = await runBrowserTool({
            request: ok({ tabs: [{ id: 7, url: 'https://a.com', title: 'A', active: true }] }),
            method: 'tabs_list',
            params: {},
        })
        expect(result.isError).toBe(false)
        expect(textOf(result)).toContain('https://a.com')
        expect(textOf(result)).toContain('7')
    })

    it('returns a screenshot as an image block the agent can look at', async () => {
        const result = await runBrowserTool({
            request: ok({ mimeType: 'image/png', dataB64: 'SGVsbG8=' }),
            method: 'screenshot',
            params: {},
        })
        expect(result.isError).toBe(false)
        expect(result.content[0]).toEqual({ type: 'image', data: 'SGVsbG8=', mimeType: 'image/png' })
    })

    it('tells the agent how to pair when no extension is connected', async () => {
        const result = await runBrowserTool({
            request: fails('NO_EXTENSION_CONNECTED', 'no Chrome extension is connected to the bridge'),
            method: 'tabs_list',
            params: {},
        })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toContain('browser-bridge.token')
    })

    it('explains that the daemon predates browser support', async () => {
        const result = await runBrowserTool({
            request: fails('BRIDGE_UNAVAILABLE', 'This daemon has no browser bridge'),
            method: 'tabs_list',
            params: {},
        })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toContain('restart')
    })

    it('surfaces an injection refusal with the page it happened on', async () => {
        const result = await runBrowserTool({
            request: fails('INJECTION_FAILED', 'Cannot access a chrome:// URL'),
            method: 'snapshot',
            params: {},
        })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toContain('Cannot access a chrome:// URL')
    })

    it('reports a timeout without pretending the command succeeded', async () => {
        const result = await runBrowserTool({
            request: fails('TIMEOUT', 'extension did not respond within 30000ms'),
            method: 'snapshot',
            params: {},
        })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toContain('TIMEOUT')
    })

    it('renders a snapshot as one line per element with its ref', async () => {
        const result = await runBrowserTool({
            request: ok({
                url: 'https://a.com',
                title: 'A',
                elements: [
                    { ref: '@e1', tag: 'button', role: 'button', name: 'Save' },
                    { ref: '@e2', tag: 'input', role: 'textbox', name: 'Email', value: 'x@y.z' },
                ],
                truncated: false,
            }),
            method: 'snapshot',
            params: {},
        })
        const text = textOf(result)
        expect(text).toContain('@e1 button "Save"')
        expect(text).toContain('@e2 textbox "Email"')
        expect(text).toContain('x@y.z')
    })

    it('warns when a snapshot was truncated so the agent knows it is partial', async () => {
        const result = await runBrowserTool({
            request: ok({ url: 'https://a.com', title: 'A', elements: [], truncated: true }),
            method: 'snapshot',
            params: {},
        })
        expect(textOf(result)).toContain('truncated')
    })

    it('passes the caller params through to the bridge', async () => {
        let seen: unknown
        await runBrowserTool({
            request: async (method, params) => {
                seen = { method, params }
                return { tabs: [] }
            },
            method: 'snapshot',
            params: { tabId: 42 },
        })
        expect(seen).toEqual({ method: 'snapshot', params: { tabId: 42 } })
    })

    describe('interaction commands', () => {
        it('confirms a click in plain text', async () => {
            const result = await runBrowserTool({ request: ok({ ok: true }), method: 'click', params: { ref: '@e1' } })
            expect(result.isError).toBe(false)
            expect(textOf(result)).toContain('@e1')
        })

        it('confirms a fill in plain text', async () => {
            const result = await runBrowserTool({ request: ok({ ok: true }), method: 'fill', params: { ref: '@e2', value: 'hi' } })
            expect(result.isError).toBe(false)
            expect(textOf(result)).toContain('@e2')
        })

        it('confirms navigation with the destination url', async () => {
            const result = await runBrowserTool({ request: ok({ ok: true }), method: 'navigate', params: { url: 'https://b.com' } })
            expect(textOf(result)).toContain('https://b.com')
        })

        it('reports the new tab id after tabs_open', async () => {
            const result = await runBrowserTool({ request: ok({ id: 55, windowId: 2, url: 'https://c.com' }), method: 'tabs_open', params: { url: 'https://c.com' } })
            expect(textOf(result)).toContain('55')
        })

        it('confirms tabs_close', async () => {
            const result = await runBrowserTool({ request: ok({ ok: true }), method: 'tabs_close', params: { tabId: 7 } })
            expect(result.isError).toBe(false)
        })

        it('surfaces a stale-ref failure with its re-snapshot guidance intact', async () => {
            const result = await runBrowserTool({
                request: fails('ACTION_FAILED', 'No element for @e9 — the page may have changed since the last snapshot. Take a new snapshot and use its refs.'),
                method: 'click',
                params: { ref: '@e9' },
            })
            expect(result.isError).toBe(true)
            expect(textOf(result)).toContain('Take a new snapshot')
        })
    })
})
