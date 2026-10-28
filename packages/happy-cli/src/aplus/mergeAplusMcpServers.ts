import type { AplusMcpServersMap } from './fetchAplusMcpServers'

export type McpServersMap<T = unknown> = Record<string, T>

export type StdioMcpServerEntry = {
    command: string
    args?: string[]
    env?: Record<string, string>
    /** Codex only: how long a call may take. A tool policy `ask` waits up to 30 minutes for a person. */
    tool_timeout_sec?: number
}

export function mergeAplusMcpServers(
    baseMcpServers: McpServersMap,
    aplusMcpServers: AplusMcpServersMap,
): McpServersMap {
    return {
        ...baseMcpServers,
        ...aplusMcpServers,
    }
}

/**
 * aplus-common sends a routing block and the common skill catalog in `initialize`.
 * When the user turned Saycode instructions off, the server cannot see that (the
 * switch lives in the encrypted account settings), so the session asks it to skip
 * them. The tools stay connected. specs/saycode-security-hardening D2-1.
 */
export function withSaycodeInstructionsPreference(
    aplusMcpServers: AplusMcpServersMap,
    saycodeSystemPromptEnabled: boolean | undefined,
): AplusMcpServersMap {
    const common = aplusMcpServers['aplus-common']
    if (saycodeSystemPromptEnabled !== false || !common) return aplusMcpServers
    return {
        ...aplusMcpServers,
        'aplus-common': {
            ...common,
            headers: { ...common.headers, 'X-Aplus-Saycode-Instructions': 'off' },
        },
    }
}

export function bridgeAplusMcpServers(
    aplusMcpServers: AplusMcpServersMap,
    opts: {
        bridgeCommand: string
        nodeExecPath?: string
        /** Tool policy (agent-tool-policy I1b): the bridge then asks the session before every call. */
        toolPolicy?: { env: (serverName: string) => Record<string, string>; toolTimeoutSec: number }
    },
): McpServersMap<StdioMcpServerEntry> {
    const result: McpServersMap<StdioMcpServerEntry> = {}
    for (const [name, config] of Object.entries(aplusMcpServers)) {
        const args = opts.nodeExecPath
            ? ['--no-warnings', '--no-deprecation', opts.bridgeCommand, '--url', config.url]
            : ['--url', config.url]
        const env = {
            ...(config.headers ? { HAPPY_HTTP_MCP_HEADERS: JSON.stringify(config.headers) } : {}),
            ...(opts.toolPolicy ? opts.toolPolicy.env(name) : {}),
        }
        result[name] = {
            command: opts.nodeExecPath ?? opts.bridgeCommand,
            args,
            env: Object.keys(env).length > 0 ? env : undefined,
            ...(opts.toolPolicy ? { tool_timeout_sec: opts.toolPolicy.toolTimeoutSec } : {}),
        }
    }
    return result
}

export function mergeMcpServers<TEntry>(
    baseMcpServers: McpServersMap<TEntry>,
    extraMcpServers: McpServersMap<TEntry>,
): McpServersMap<TEntry> {
    return {
        ...baseMcpServers,
        ...extraMcpServers,
    }
}
