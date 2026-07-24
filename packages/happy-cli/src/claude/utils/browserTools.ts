/**
 * Formatting layer for the `mcp__happy__browser_*` tools.
 *
 * Separate from startHappyServer so the agent-facing text — which is the whole
 * product of these tools — is testable without standing up an MCP server.
 */

import { BrowserClientError } from '@/daemon/browserClient'

export const BROWSER_TOOL_NAMES = ['browser_tabs', 'browser_snapshot', 'browser_screenshot'] as const

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

export type BridgeRequest = (method: string, params: unknown) => Promise<unknown>

const PAIRING_HINT =
    'No Chrome extension is connected to this machine\'s browser bridge. Ask the user to load the Happy Browser Bridge extension in Chrome and paste the token from ~/.happy/browser-bridge.token into its options page.'

function describeError(error: BrowserClientError): string {
    switch (error.code) {
        case 'NO_EXTENSION_CONNECTED':
            return PAIRING_HINT
        case 'BRIDGE_UNAVAILABLE':
        case 'DAEMON_UNREACHABLE':
            return `${error.message} (the daemon may need a restart on a build that includes browser support)`
        default:
            return `${error.code}: ${error.message}`
    }
}

function renderTabs(result: any): string {
    const tabs = result?.tabs ?? []
    if (tabs.length === 0) return 'No open tabs.'
    return tabs
        .map((tab: any) => `${tab.id}${tab.active ? ' *' : ''} ${tab.url} — ${tab.title ?? ''}`.trimEnd())
        .join('\n')
}

function renderSnapshot(result: any): string {
    const header = `${result?.title ?? ''} — ${result?.url ?? ''}`.trim()
    const elements = (result?.elements ?? []).map((element: any) => {
        const value = element.value ? ` value=${JSON.stringify(element.value)}` : ''
        const disabled = element.disabled ? ' [disabled]' : ''
        return `${element.ref} ${element.role} ${JSON.stringify(element.name ?? '')}${value}${disabled}`
    })
    const body = elements.length > 0 ? elements.join('\n') : 'No interactive elements found.'
    const note = result?.truncated
        ? '\n\n(truncated — only the first elements of the page are listed)'
        : ''
    return `${header}\n\n${body}${note}`
}

export async function runBrowserTool({ request, method, params }: {
    request: BridgeRequest
    method: 'tabs_list' | 'snapshot' | 'screenshot'
    params: unknown
}): Promise<BrowserToolResult> {
    let result: any
    try {
        result = await request(method, params)
    } catch (error) {
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
    const text = method === 'tabs_list' ? renderTabs(result) : renderSnapshot(result)
    return { content: [{ type: 'text', text }], isError: false }
}
