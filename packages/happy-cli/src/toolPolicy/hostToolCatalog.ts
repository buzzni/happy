import { readFile, realpath, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, isAbsolute, join } from 'node:path';

export type HostMcpSource = { kind: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd: string }
    | { kind: 'http' | 'sse'; url: string; headers: Record<string, string> };
export const hostBinding = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function strings(value: unknown): Record<string, string> {
    if (value === undefined) return {};
    if (!record(value) || Object.values(value).some(v => typeof v !== 'string' || v.includes('\0'))) throw new Error('HOST_TOOL_CONFIG_INVALID');
    return { ...value } as Record<string, string>;
}
/** Never executes a PATH candidate. Fixed argv/cwd are kept out of the model's discovery response. */
export async function executableIdentity(command: string, cwd: string) {
    if (!command || command.includes('\0')) throw new Error('HOST_TOOL_COMMAND_INVALID');
    const candidates = isAbsolute(command) ? [command] : command.includes('/') || command.includes('\\')
        ? [join(cwd, command)] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, command));
    for (const candidate of candidates) {
        try {
            const path = await realpath(candidate);
            await access(path, constants.X_OK);
            const info = await stat(path);
            if (!info.isFile()) continue;
            return { path, identity: hostBinding([path, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]) };
        } catch { /* Try the next exact executable, never a shell or installer. */ }
    }
    throw new Error('HOST_TOOL_EXECUTABLE_NOT_FOUND');
}
export async function resolveHostSource(raw: unknown, cwd: string): Promise<{ source: HostMcpSource; binding: string }> {
    if (!record(raw) || raw.enabled === false || raw.disabled === true) throw new Error('HOST_TOOL_DISABLED');
    let source: HostMcpSource;
    if (typeof raw.command === 'string' && (!raw.type || raw.type === 'stdio') && (!raw.transport || raw.transport === 'stdio')) {
        if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some(a => typeof a !== 'string' || a.includes('\0')))) throw new Error('HOST_TOOL_CONFIG_INVALID');
        const directory = typeof raw.cwd === 'string' ? raw.cwd : cwd;
        const executable = await executableIdentity(raw.command, directory);
        const env = strings(raw.env);
        if (Array.isArray(raw.env_vars)) for (const key of raw.env_vars) {
            if (typeof key !== 'string' || /^(HAPPY_|SAYCODE_)/.test(key)) throw new Error('HOST_TOOL_CONFIG_INVALID');
            if (process.env[key] !== undefined) env[key] = process.env[key]!;
        }
        source = { kind: 'stdio', command: executable.path, args: (raw.args ?? []) as string[], env, cwd: directory };
        return { source, binding: hostBinding([source, executable.identity, raw.enabled_tools, raw.disabled_tools]) };
    }
    if ((raw.type !== undefined && !['http', 'sse', 'streamable-http'].includes(String(raw.type))) || raw.transport !== undefined || raw.env_http_headers !== undefined) throw new Error('HOST_TOOL_TRANSPORT_UNSUPPORTED');
    if (typeof raw.url !== 'string') throw new Error('HOST_TOOL_TRANSPORT_UNSUPPORTED');
    const url = new URL(raw.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('HOST_TOOL_CONFIG_INVALID');
    const headers = { ...strings(raw.headers), ...strings(raw.http_headers) };
    if (typeof raw.bearer_token_env_var === 'string') {
        if (/^(HAPPY_|SAYCODE_)/.test(raw.bearer_token_env_var)) throw new Error('HOST_TOOL_CONFIG_INVALID');
        const token = process.env[raw.bearer_token_env_var];
        if (!token) throw new Error('HOST_TOOL_CREDENTIAL_REQUIRED');
        headers.Authorization = `Bearer ${token}`;
    }
    source = { kind: raw.type === 'sse' ? 'sse' : 'http', url: url.href, headers };
    return { source, binding: hostBinding([source, raw.enabled_tools, raw.disabled_tools]) };
}

/** Only configured provider sources; disabled entries stay disabled and Happy cannot recursively call itself. */
export async function readClaudeHostServers(configDir: string, cwd: string, sources?: readonly string[]): Promise<Record<string, unknown>> {
    const read = async (path: string): Promise<Record<string, unknown>> => {
        try { const value = JSON.parse(await readFile(path, 'utf8')); if (!record(value)) throw new Error(); return value; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('HOST_TOOL_CONFIG_UNREADABLE'); }
    };
    const enabled = (name: string) => sources === undefined || sources.includes(name);
    const config = await read(join(configDir, '.claude.json'));
    const project = record(config.projects) ? config.projects[cwd] : undefined;
    const local = record(project) ? project : {};
    const shared = enabled('project') && local.enableAllProjectMcpServers !== false ? await read(join(cwd, '.mcp.json')) : {};
    const servers = { ...(enabled('user') && record(config.mcpServers) ? config.mcpServers : {}),
        ...(record(shared.mcpServers) ? shared.mcpServers : {}), ...(enabled('local') && record(local.mcpServers) ? local.mcpServers : {}) };
    for (const key of [...(Array.isArray(config.disabledMcpServers) ? config.disabledMcpServers : []), ...(Array.isArray(local.disabledMcpServers) ? local.disabledMcpServers : []), ...(Array.isArray(local.disabledMcpjsonServers) ? local.disabledMcpjsonServers : [])]) {
        if (typeof key === 'string' && Object.hasOwn(servers, key)) servers[key] = { enabled: false };
    }
    delete servers.happy;
    return servers;
}
