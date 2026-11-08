/**
 * MCP servers a Saycode Desktop extension adds to one session launch
 * (aplus-dev-studio-desktop specs/extension-session-and-worktree-hooks, "happy-cli 영향").
 *
 * `spawn-happy-session` and `resume-happy-session` take an optional `launchMcpServers` map. The daemon
 * checks it (`parseLaunchMcpServers`, `prepareLaunchMcpServers`), hands what survives to the session
 * process as a one-shot `HAPPY_INITIAL_` seed, and answers which names it dropped. The session process
 * reads the seed once (`consumeLaunchMcpServersSeed`) and adds the servers under every server it already
 * has: the internal ones and the organization's `/api/me/mcp-config` servers always win a name.
 *
 * Arguments, env values and header values can carry secrets. Nothing here logs, reports or persists
 * them: log lines and drop reports carry names and counts only, and the seed is not one of the keys
 * `captureSaycodeAgentEnvironment` records.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '@/ui/logger'
import { CUA_DRIVER_SERVER } from '@/toolPolicy/cuaShadow'
import { LAUNCH_MCP_SERVERS_ENV, takeLaunchMcpServersSeed } from './launchMcpSeed'
import type { AplusMcpServersMap } from './fetchAplusMcpServers'
import type { McpServersMap } from './mergeAplusMcpServers'

export type LaunchMcpServer =
    | { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
    | { transport: 'http'; url: string; headers?: Record<string, string> }

export type LaunchMcpDropReason = 'name-conflict' | 'invalid' | 'unsupported-agent'

export type LaunchMcpDropped = { name: string; reason: LaunchMcpDropReason }

/** The request after the RPC boundary: the entries that passed validation and the ones that did not. */
export type LaunchMcpRequest = { servers: Record<string, LaunchMcpServer>; dropped: LaunchMcpDropped[] }

/** `daemonState.launchMcpServers`: this daemon takes the field. Desktop sends it only when advertised. */
export const LAUNCH_MCP_SERVERS_CAPABILITY = 1 as const

/** Servers the session process itself names. An injected server never takes one of these. */
export const RESERVED_LAUNCH_MCP_SERVER_NAMES: readonly string[] = ['happy', CUA_DRIVER_SERVER]

export { LAUNCH_MCP_SERVERS_ENV }

const SUPPORTED_AGENTS = new Set(['claude', 'codex'])
const MAX_SERVERS = 8
const MAX_ARGS = 32
const NAME = /^[a-z][a-z0-9_-]{0,31}$/
const ENV_KEY = /^[^=\0]+$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])
/** A rejected name is echoed back so Desktop can tell which one; a name that is not a name is cut short. */
const MAX_REPORTED_NAME = 64

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)

const hasNul = (value: string): boolean => value.includes('\0')

function stringRecord(value: unknown, validKey: RegExp, validValue: (value: string) => boolean): Record<string, string> | null | undefined {
    if (value === undefined) return undefined
    if (!isRecord(value)) return null
    const out: Record<string, string> = {}
    for (const [key, entry] of Object.entries(value)) {
        if (!validKey.test(key) || typeof entry !== 'string' || !validValue(entry)) return null
        out[key] = entry
    }
    return out
}

function allowedUrl(value: unknown): value is string {
    if (typeof value !== 'string') return false
    try {
        const url = new URL(value)
        return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
    } catch {
        return false
    }
}

function parseEntry(value: unknown): LaunchMcpServer | null {
    if (!isRecord(value)) return null
    if (value.transport === 'stdio') {
        const { command, args } = value
        if (typeof command !== 'string' || !command || hasNul(command)) return null
        if (args !== undefined && (!Array.isArray(args) || args.length > MAX_ARGS
            || args.some((arg) => typeof arg !== 'string' || hasNul(arg)))) return null
        const env = stringRecord(value.env, ENV_KEY, (entry) => !hasNul(entry))
        if (env === null) return null
        return { transport: 'stdio', command, ...(args ? { args: [...args] as string[] } : {}), ...(env ? { env } : {}) }
    }
    if (value.transport === 'http') {
        if (!allowedUrl(value.url)) return null
        const headers = stringRecord(value.headers, HEADER_NAME, (entry) => !/[\r\n\0]/.test(entry))
        if (headers === null) return null
        return { transport: 'http', url: value.url, ...(headers ? { headers } : {}) }
    }
    return null
}

/**
 * The RPC boundary. Absent stays absent (today's behaviour). Each entry is kept or dropped as
 * `invalid` on its own — never thrown, so a bad entry neither fails the launch nor reaches an error
 * message. The first 8 valid entries are kept; later ones are dropped as `invalid`.
 */
export function parseLaunchMcpServers(raw: unknown): LaunchMcpRequest | undefined {
    if (raw === undefined) return undefined
    const request: LaunchMcpRequest = { servers: {}, dropped: [] }
    if (!isRecord(raw)) return request
    for (const [name, value] of Object.entries(raw)) {
        const entry = NAME.test(name) ? parseEntry(value) : null
        if (entry && Object.keys(request.servers).length < MAX_SERVERS) request.servers[name] = entry
        else request.dropped.push({ name: name.slice(0, MAX_REPORTED_NAME), reason: 'invalid' })
    }
    return request
}

/** Injected servers whose names nobody else holds. */
export function launchMcpServersBeside(
    servers: Record<string, LaunchMcpServer>,
    takenNames: Iterable<string>,
): Record<string, LaunchMcpServer> {
    const taken = new Set([...RESERVED_LAUNCH_MCP_SERVER_NAMES, ...takenNames])
    return Object.fromEntries(Object.entries(servers).filter(([name]) => !taken.has(name)))
}

export type PreparedLaunchMcpServers = {
    /** Merge into the session process environment, after `${VAR}` expansion like every spawn seed. */
    environment: Record<string, string>
    /** The `launchMcpDropped` answer; undefined when nothing was dropped. Never rejects. */
    report: () => Promise<LaunchMcpDropped[] | undefined>
}

/**
 * The daemon's half for one launch. Drops by agent and by internal name now; the organization's
 * server names are looked up alongside the launch (`lookupServerNames`, started here so it overlaps
 * the child start) and only change the answer — the session process applies the same rule itself
 * against the configuration it fetches, so the existing server wins even when the lookup fails.
 */
export function prepareLaunchMcpServers(input: {
    request: LaunchMcpRequest | undefined
    agent: string
    lookupServerNames: () => Promise<readonly string[] | null>
}): PreparedLaunchMcpServers {
    const { request } = input
    if (!request) return { environment: {}, report: async () => undefined }
    const dropped = [...request.dropped]
    let servers: Record<string, LaunchMcpServer> = {}
    if (SUPPORTED_AGENTS.has(input.agent)) {
        servers = launchMcpServersBeside(request.servers, [])
        for (const name of Object.keys(request.servers)) {
            if (!servers[name]) dropped.push({ name, reason: 'name-conflict' })
        }
    } else {
        for (const name of Object.keys(request.servers)) dropped.push({ name, reason: 'unsupported-agent' })
    }
    const names = Object.keys(servers)
    const serverNames = names.length > 0
        ? input.lookupServerNames().catch(() => null)
        : Promise.resolve(null)
    logger.debug(`[launch-mcp] agent=${input.agent} accepted=${names.length}${names.length ? ` (${names.join(',')})` : ''} dropped=${dropped.length}`)
    return {
        environment: names.length > 0 ? { [LAUNCH_MCP_SERVERS_ENV]: JSON.stringify(servers) } : {},
        report: async () => {
            const existing = new Set(await serverNames ?? [])
            const conflicts = names.filter((name) => existing.has(name))
            if (conflicts.length > 0) logger.debug(`[launch-mcp] organization servers hold ${conflicts.join(',')}`)
            const all = [...dropped, ...conflicts.map((name) => ({ name, reason: 'name-conflict' as const }))]
            return all.length > 0 ? all : undefined
        },
    }
}

/**
 * The session process's half: the seed the CLI bootstrap already took out of the environment
 * (launchMcpSeed.ts), or the environment itself, once — neither the agent nor its tool shells see it. The daemon validated it; it is checked again, and anything that no longer
 * parses is read as nothing rather than failing the session.
 */
export function consumeLaunchMcpServersSeed(env: NodeJS.ProcessEnv): Record<string, LaunchMcpServer> {
    const raw = takeLaunchMcpServersSeed(env)
    if (!raw) return {}
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        logger.debug('[launch-mcp] seed does not parse; no servers added')
        return {}
    }
    return parseLaunchMcpServers(parsed)?.servers ?? {}
}

function jsonFile(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
        return undefined
    }
}

/**
 * Names of the MCP servers Claude itself loads for `cwd`: user scope (`.claude.json` `mcpServers`),
 * local scope (`.claude.json` `projects[cwd].mcpServers`) and project scope (`cwd/.mcp.json`). An
 * SDK / `--mcp-config` entry of the same name replaces the user's server (cuaShadow.ts, measured
 * 2026-10-22), so an injected server must stand aside for these. Every scope is counted whatever
 * `settingSources` the session loads: standing aside too often only costs the injected server.
 */
export function readClaudeMcpServerNames(input: { configDir: string; cwd: string }): string[] {
    const names = new Set<string>()
    const add = (servers: unknown) => {
        if (isRecord(servers)) for (const name of Object.keys(servers)) names.add(name)
    }
    const cwds = new Set([input.cwd])
    try { cwds.add(realpathSync(input.cwd)) } catch { /* a missing cwd has no project config */ }
    const config = jsonFile(join(input.configDir, '.claude.json'))
    if (isRecord(config)) {
        add(config.mcpServers)
        const projects = isRecord(config.projects) ? config.projects : {}
        for (const cwd of cwds) {
            const project = projects[cwd]
            if (isRecord(project)) add(project.mcpServers)
        }
    }
    for (const cwd of cwds) {
        const project = jsonFile(join(cwd, '.mcp.json'))
        if (isRecord(project)) add(project.mcpServers)
    }
    return [...names]
}

/**
 * The agent's own configured server names the daemon can read for its `name-conflict` answer: Claude's
 * (`CLAUDE_CONFIG_DIR` from the child's environment, else the home directory). Codex `config.toml` is
 * read by the app-server only, so its conflicts are enforced by the session process and not reported.
 */
export function agentMcpServerNames(agent: string, input: { env: Record<string, string | undefined>; homeDir: string; cwd: string }): string[] {
    if (agent !== 'claude') return []
    return readClaudeMcpServerNames({ configDir: input.env.CLAUDE_CONFIG_DIR || input.homeDir, cwd: input.cwd })
}

/** Claude's `mcpServers` shape (SDK option and `--mcp-config`). */
export function claudeLaunchMcpServers(servers: Record<string, LaunchMcpServer>): McpServersMap {
    return Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, server.transport === 'stdio'
        ? { type: 'stdio', command: server.command, ...(server.args ? { args: server.args } : {}), ...(server.env ? { env: server.env } : {}) }
        : { type: 'http', url: server.url, ...(server.headers ? { headers: server.headers } : {}) }]))
}

/** Codex `mcp_servers`: stdio as is, http through the bridge Codex already uses for organization servers. */
export function codexLaunchMcpServers(
    servers: Record<string, LaunchMcpServer>,
    bridgeHttp: (servers: AplusMcpServersMap) => McpServersMap,
): McpServersMap {
    const stdio: McpServersMap = {}
    const http: AplusMcpServersMap = {}
    for (const [name, server] of Object.entries(servers)) {
        if (server.transport === 'stdio') {
            stdio[name] = { command: server.command, ...(server.args ? { args: server.args } : {}), ...(server.env ? { env: server.env } : {}) }
        } else {
            http[name] = { type: 'http', url: server.url, ...(server.headers ? { headers: server.headers } : {}) }
        }
    }
    return { ...stdio, ...(Object.keys(http).length > 0 ? bridgeHttp(http) : {}) }
}
