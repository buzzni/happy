/**
 * Formatting layer for the `mcp__happy__browser_*` tools.
 *
 * Separate from startHappyServer so the agent-facing text — which is the whole
 * product of these tools — is testable without standing up an MCP server.
 */

import { BrowserClientError } from '@/daemon/browserClient'

export const BROWSER_TOOL_NAMES = [
    'browser_tabs',
    'browser_snapshot',
    'browser_screenshot',
    'browser_click',
    'browser_fill',
    'browser_scroll',
    'browser_navigate',
    'browser_open_tab',
    'browser_close_tab',
    'browser_capabilities',
] as const

type ToolContent =
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }

export interface BrowserToolResult {
    // The MCP SDK's CallToolResult carries an index signature; without it the
    // handler return type is rejected.
    [key: string]: unknown
    content: ToolContent[]
    isError: boolean
}

export type BridgeRequest = (method: string, params: unknown, opts?: { profile?: string }) => Promise<unknown>

const PAIRING_HINT =
    'No Chrome extension is connected to this machine\'s browser bridge. Ask the user to load the Happy Browser Bridge extension in Chrome and paste the token from ~/.happy/browser-bridge.token into its options page.'

function describeError(error: BrowserClientError): string {
    switch (error.code) {
        case 'NO_EXTENSION_CONNECTED':
            return PAIRING_HINT
        case 'BRIDGE_UNAVAILABLE':
        case 'DAEMON_UNREACHABLE':
            return `${error.message} (the daemon may need a restart on a build that includes browser support)`
        case 'DEBUGGER_NOT_AVAILABLE':
            // Actionable, and clear that it is the user's call — the agent
            // cannot grant this to itself, by design.
            return `${error.message} Without it, use a normal screenshot or an untrusted click/fill, which work for most pages.`
        case 'AMBIGUOUS_PROFILE':
            // Naming the profiles is not enough: which one holds the user's
            // tabs is unknowable from here (a profile with no open windows
            // answers every command, just with nothing in it).
            return `${error.message}. Retry with profile set to one of them — browser_tabs on each shows which Chrome profile has the tabs you want.`
        default:
            return `${error.code}: ${error.message}`
    }
}

/** What the daemon knows about who is paired; only read when something looks wrong. */
export interface BridgeStatus {
    connections: Array<{ profile: string }>
    hasRecentAuthFailure: boolean
}

function describeProfile(result: any): string {
    const parts = [result?.profile ? `profile: ${result.profile}` : null]
    if (typeof result?.windowCount === 'number') parts.push(`${result.windowCount} window(s)`)
    const known = parts.filter(Boolean)
    return known.length > 0 ? `(${known.join(', ')})` : ''
}

/**
 * An empty tab list has three very different causes and the agent used to see
 * one sentence for all of them. The costly one: the extension is paired in a
 * Chrome profile the user has no windows open in — it answers every command,
 * so nothing else in the response says the agent is looking at the wrong
 * browser.
 */
function renderEmptyTabs(result: any, status: BridgeStatus | null): string {
    const lines = [`No tabs are visible to the bridge. ${describeProfile(result)}`.trim()]

    if (result?.windowCount === 0) {
        lines.push(
            'That Chrome profile has no open windows, so it can never show tabs or open one ("No current window").',
            'The extension is most likely paired in a different Chrome profile than the one the user is looking at.',
            'Ask the user to run `happy browser` and open the auto-connect link in the profile they actually use.',
        )
    } else if (typeof result?.totalTabs === 'number' && result.totalTabs > 0) {
        lines.push(`All ${result.totalTabs} tab(s) in this profile are hidden by the site allowlist in the extension options.`)
    }

    return [...lines, ...describeStatus(status)].join('\n')
}

function describeStatus(status: BridgeStatus | null): string[] {
    if (!status) return []
    const lines: string[] = []
    if (status.hasRecentAuthFailure) {
        lines.push(
            'A Chrome extension is being rejected right now for a stale pairing token — that is likely the profile the user means.',
            'Ask them to re-pair it: run `happy browser` and open the auto-connect link in that Chrome profile.',
        )
    }
    if (status.connections.length > 1) {
        lines.push(`Connected profiles: ${status.connections.map((c) => c.profile).join(', ')} — pass profile to pick one.`)
    }
    return lines
}

function renderTabs(result: any, status: BridgeStatus | null): string {
    const tabs = result?.tabs ?? []
    if (tabs.length === 0) return renderEmptyTabs(result, status)
    const listing = tabs
        .map((tab: any) => `${tab.id}${tab.active ? ' *' : ''} ${tab.url} — ${tab.title ?? ''}`.trimEnd())
        .join('\n')
    const header = describeProfile(result)
    return header ? `${header}\n${listing}` : listing
}

function renderSnapshot(result: any): string {
    const header = `${result?.title ?? ''} — ${result?.url ?? ''}`.trim()
    const elements = (result?.elements ?? []).map((element: any) => {
        const value = element.value ? ` value=${JSON.stringify(element.value)}` : ''
        const disabled = element.disabled ? ' [disabled]' : ''
        const scrollable = element.scrollable
            ? ` [scrollable${element.scrollable.x ? ` x=${element.scrollable.left}/${element.scrollable.maxLeft}` : ''}${element.scrollable.y ? ` y=${element.scrollable.top}/${element.scrollable.maxTop}` : ''}]`
            : ''
        return `${element.ref} ${element.role} ${JSON.stringify(element.name ?? '')}${value}${disabled}${scrollable}`
    })
    const body = elements.length > 0 ? elements.join('\n') : 'No interactive elements found.'
    const note = result?.truncated
        ? '\n\n(truncated — only the first elements of the page are listed)'
        : ''
    return `${header}\n\n${body}${note}`
}

export type BrowserBridgeMethod =
    | 'tabs_list' | 'snapshot' | 'screenshot'
    | 'click' | 'fill' | 'scroll' | 'navigate' | 'tabs_open' | 'tabs_close'
    | 'capabilities'

function renderCapabilities(result: any): string {
    return [
        result?.profile ? `Answering Chrome profile: ${result.profile}` : null,
        result?.debugger
            ? 'Debugger tier: ON — fullPage screenshots and trusted click/fill are available.'
            : 'Debugger tier: OFF — fullPage screenshots and trusted click/fill will fail. Only the user can enable it, in the extension options page; everything else works without it.',
        `Commands: ${(result?.commands ?? []).join(', ')}`,
    ].filter(Boolean).join('\n')
}

function renderSuccess(method: BrowserBridgeMethod, params: any, result: any): string {
    switch (method) {
        case 'click':
            return `Clicked ${params.ref}.`
        case 'fill':
            return `Filled ${params.ref} with ${JSON.stringify(params.value)}.`
        case 'scroll': {
            const before = `(${result.before?.x ?? '?'},${result.before?.y ?? '?'})`
            const after = `(${result.after?.x ?? '?'},${result.after?.y ?? '?'})`
            const max = `(${result.max?.x ?? '?'},${result.max?.y ?? '?'})`
            const boundaries = Object.entries(result.atBoundary ?? {})
                .filter(([, reached]) => reached)
                .map(([name]) => name)
                .join(', ')
            const movement = result.moved
                ? `Scrolled ${result.target ?? params.ref ?? 'document'} from ${before} to ${after} of ${max}.`
                : `Scroll target ${result.target ?? params.ref ?? 'document'} did not move${boundaries ? ` (at boundary: ${boundaries})` : ''}; position remains ${after} of ${max}.`
            return `${movement} Run browser_snapshot again before using refs because scrolling may lazy-load or replace page content.`
        }
        case 'navigate':
            return `Navigated to ${params.url}.`
        case 'tabs_open':
            // chrome.tabs.create resolves before the tab finishes loading, so
            // result.url is often empty at this point — fall back to what the
            // caller asked to open.
            return `Opened tab ${result.id} at ${result.url || params.url}.`
        case 'tabs_close':
            return `Closed tab ${params.tabId}.`
        default:
            return 'Done.'
    }
}

export async function runBrowserTool({ request, method, params, status }: {
    request: BridgeRequest
    method: BrowserBridgeMethod
    params: any
    /**
     * Who is paired, read lazily — only when the answer looks wrong (nothing
     * connected, or zero tabs). A per-command status round-trip would be pure
     * overhead on the healthy path.
     */
    status?: () => Promise<BridgeStatus | null>
}): Promise<BrowserToolResult> {
    const readStatus = async (): Promise<BridgeStatus | null> => {
        if (!status) return null
        try {
            return await status()
        } catch {
            // Diagnostics must never turn a working command into a failure.
            return null
        }
    }

    // `profile` selects which connected Chrome answers; it is not a command
    // param, and forwarding it to the extension would be meaningless there.
    const { profile, ...commandParams } = (params ?? {}) as Record<string, unknown>
    let result: any
    try {
        result = await request(method, commandParams, profile === undefined ? {} : { profile: profile as string })
    } catch (error) {
        if (error instanceof BrowserClientError && error.code === 'NO_EXTENSION_CONNECTED') {
            const text = [describeError(error), ...describeStatus(await readStatus())].join('\n')
            return { content: [{ type: 'text', text }], isError: true }
        }
        const text = error instanceof BrowserClientError
            ? describeError(error)
            : `Browser command failed: ${error instanceof Error ? error.message : String(error)}`
        return { content: [{ type: 'text', text }], isError: true }
    }

    if (method === 'screenshot') {
        return {
            content: [{ type: 'image', data: result.dataB64, mimeType: result.mimeType }],
            isError: false,
        }
    }
    let text: string
    if (method === 'tabs_list') text = renderTabs(result, (result?.tabs ?? []).length === 0 ? await readStatus() : null)
    else if (method === 'snapshot') text = renderSnapshot(result)
    else if (method === 'capabilities') text = renderCapabilities(result)
    else text = renderSuccess(method, params, result)

    return { content: [{ type: 'text', text }], isError: false }
}
