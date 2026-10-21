/**
 * The cua-driver shadow entry (aplus-dev-studio specs/agent-tool-policy plan "I1b").
 *
 * Saycode does not know the user's cua-driver: the user registered it with `claude mcp add` or in
 * Codex `config.toml`. To put the shadow proxy in front of it, Happy reads that one entry where the
 * provider reads it and gives the provider an entry of the same name that starts the proxy, which
 * starts the user's command. Measured 2026-10-22 (context.md "T10 실측"):
 * - Claude: an SDK `mcpServers` / `--mcp-config` entry beats the same name in user and local scope
 *   (the user's server is not even started); local scope beats user scope.
 * - Codex 0.162: the thread `config.mcp_servers` map deep-merges into `config.toml`'s — other user
 *   servers keep running, a same-name entry's `command`/`args` are replaced and the user's `env`
 *   carries over. `config/read` returns the original command. An entry with `enabled = false`
 *   alone is an invalid transport.
 *
 * No user cua-driver, no shadow. Only the cua-driver entry is kept; other servers' env (secrets) is
 * never copied out of the parsed config.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { CUA_UPSTREAM_ENV_VAR } from './cuaProxy';
import { BUILTIN_TABLES } from './rules';

export const CUA_DRIVER_SERVER = BUILTIN_TABLES.cuaDriver.server;
/** Above the 30-minute approval wait (R11.5); Codex's own default is 60 seconds. */
export const CUA_SHADOW_TOOL_TIMEOUT_SECONDS = 1900;
/** `config/read` failed: Happy cannot tell whether the user runs cua-driver. */
export const CODEX_CONFIG_UNREADABLE = Symbol('codex-config-unreadable');

export interface CuaUpstream {
    command: string;
    args: string[];
    env: Record<string, string>;
}

interface ShadowLaunch {
    execPath: string;
    /** `bin/happy-mcp.mjs`, which runs the proxy with `--cua-proxy`. */
    bridgeEntrypoint: string;
    policyEnv: Record<string, string>;
}

/**
 * The cua-driver command Claude would run for `cwd`, or null. `settingSources` is the session's
 * (undefined = every source): user scope needs `user`, local scope needs `local`.
 */
export function readClaudeCuaUpstream(input: { configDir: string; cwd: string; settingSources?: readonly string[] }): CuaUpstream | null {
    const loads = (source: string) => input.settingSources === undefined || input.settingSources.includes(source);
    let config: unknown;
    try {
        config = JSON.parse(readFileSync(join(input.configDir, '.claude.json'), 'utf8'));
    } catch {
        return null;
    }
    if (!isRecord(config)) return null;
    const projects = isRecord(config.projects) ? config.projects : {};
    const project = [input.cwd, realpathOrSelf(input.cwd)].map((path) => projects[path]).find(isRecord);
    if (project && Array.isArray(project.disabledMcpServers) && project.disabledMcpServers.includes(CUA_DRIVER_SERVER)) return null;
    const local = loads('local') && project && isRecord(project.mcpServers) ? project.mcpServers[CUA_DRIVER_SERVER] : undefined;
    const user = loads('user') && isRecord(config.mcpServers) ? config.mcpServers[CUA_DRIVER_SERVER] : undefined;
    return stdioUpstream(local !== undefined ? local : user);
}

export function claudeCuaShadowEntry(input: ShadowLaunch & { upstream: CuaUpstream }): { type: 'stdio'; command: string; args: string[]; env: Record<string, string> } {
    return {
        type: 'stdio',
        command: input.execPath,
        args: proxyArgs(input, input.upstream),
        // Claude does not merge the user's entry into ours, so its env comes along — by reference:
        // this entry is `--mcp-config` argv, and the caller puts the values in Claude's environment.
        env: {
            ...input.policyEnv,
            ...(Object.keys(input.upstream.env).length > 0 ? { [CUA_UPSTREAM_ENV_VAR]: `\${${CUA_UPSTREAM_ENV_VAR}}` } : {}),
        },
    };
}

/**
 * The thread-config entry for cua-driver from `config/read`'s `mcp_servers`, or null when the
 * user runs none. A cua-driver the proxy cannot front (not stdio), or a config Happy could not
 * read, is turned off rather than left running unjudged.
 */
export function codexCuaShadowConfig(nativeServers: unknown, input: ShadowLaunch): Record<string, unknown> | null {
    const disabled = { command: input.execPath, args: [input.bridgeEntrypoint, '--cua-proxy'], enabled: false };
    if (nativeServers === CODEX_CONFIG_UNREADABLE) return disabled;
    const native = isRecord(nativeServers) ? nativeServers[CUA_DRIVER_SERVER] : undefined;
    if (!isRecord(native) || native.enabled === false) return null;
    const upstream = stdioUpstream(native);
    if (!upstream) return disabled;
    return {
        command: input.execPath,
        args: proxyArgs(input, upstream),
        // Codex 0.162 deep-merges the native entry into this one; carrying the user's env, env_vars
        // and cwd too keeps them where a full map replaces the native one.
        env: { ...upstream.env, ...input.policyEnv },
        ...(Array.isArray(native.env_vars) ? { env_vars: native.env_vars } : {}),
        ...(typeof native.cwd === 'string' ? { cwd: native.cwd } : {}),
        tool_timeout_sec: CUA_SHADOW_TOOL_TIMEOUT_SECONDS,
    };
}

/** Claude: an org server named `cua-driver` must not displace the shadow while the hook steps aside. */
export function withoutCuaDriver<T>(servers: Record<string, T>): Record<string, T> {
    const { [CUA_DRIVER_SERVER]: _displaced, ...rest } = servers;
    return rest;
}

function proxyArgs(launch: ShadowLaunch, upstream: { command: string; args: string[] }): string[] {
    return ['--no-warnings', '--no-deprecation', launch.bridgeEntrypoint, '--cua-proxy', '--', upstream.command, ...upstream.args];
}

function stdioUpstream(entry: unknown): CuaUpstream | null {
    if (!isRecord(entry) || typeof entry.command !== 'string' || !entry.command) return null;
    if (entry.type !== undefined && entry.type !== 'stdio') return null;
    const env: Record<string, string> = {};
    if (isRecord(entry.env)) {
        for (const [key, value] of Object.entries(entry.env)) if (typeof value === 'string') env[key] = value;
    }
    return { command: entry.command, args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : [], env };
}

function realpathOrSelf(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
