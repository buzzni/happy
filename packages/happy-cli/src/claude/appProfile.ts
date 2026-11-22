/**
 * aplus-dev-studio specs/agent-app-api T5 — the app profile of a server-started agent-app session.
 *
 * An agent-app session answers a public service's end users. Run like a Saycode chat it inherits
 * everything a member's session gets on that machine: built-in tools, the happy MCP and the
 * organization's MCP servers, Saycode instructions, the machine's settings files, plugins and hooks
 * (a memory plugin appended "📎 Recalled: …" lines to shopping answers, 2026-11-22). The profile fixes
 * the session at spawn: no built-in tools, only the named MCP servers and their tools, the app's
 * own system prompt, no settings sources, plugins, agents or skills. It is applied last, over every
 * option the session assembled, so no message `meta` can loosen it.
 */
import type { QueryOptions } from '@/claude/sdk';

/** Advertised in machine metadata; an older daemon would drop the field and run the session unrestricted. */
export const APP_PROFILE_CAPABILITY = { version: 1 as const };

export const APP_PROFILE_ENV = 'HAPPY_INITIAL_APP_PROFILE';

export type ClaudeAppProfile = { version: 1; mcpServers: string[]; systemPrompt: string };

/**
 * Claude Code's built-in plugins load whatever the setting sources say (seen with claude-agent-sdk 0.3.308,
 * 2026-11-22). `agents-md` would read the machine's AGENTS.md into the app's context. A release that adds a
 * built-in plugin needs it here; the live check of the profile (tasks T5 P3) looks at the loaded plugins.
 */
const BUILTIN_PLUGINS = ['cc-plugin-agents-md@builtin', 'cc-plugin-telemetry@builtin', 'cc-plugin-plugin-authoring@builtin'];

const MAX_SERVERS = 20;
const MAX_PROMPT_LENGTH = 20_000;
/** No `__`: a name is used as the `mcp__<name>__` tool prefix and must not reach another server's tools. */
const SERVER_NAME = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Throws on anything that would run the session other than as asked. */
export function parseAppProfile(value: unknown): ClaudeAppProfile | undefined {
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) throw new Error('App profile must be an object');
    if (Object.keys(value).some(key => !['version', 'mcpServers', 'systemPrompt'].includes(key))) {
        throw new Error('App profile has an unknown field');
    }
    if (value.version !== 1) throw new Error('App profile version must be 1');
    const servers = value.mcpServers;
    if (!Array.isArray(servers) || servers.length > MAX_SERVERS) {
        throw new Error(`App profile takes at most ${MAX_SERVERS} MCP servers`);
    }
    if (!servers.every(name => typeof name === 'string' && name.length <= 64 && SERVER_NAME.test(name))) {
        throw new Error('App profile MCP server names must be plain names');
    }
    if (new Set(servers).size !== servers.length) throw new Error('App profile names an MCP server twice');
    // Not empty: the SDK wrapper treats an empty custom prompt as none and would bring back the default one.
    if (typeof value.systemPrompt !== 'string' || !value.systemPrompt.trim() || value.systemPrompt.length > MAX_PROMPT_LENGTH) {
        throw new Error(`App profile system prompt must be 1 to ${MAX_PROMPT_LENGTH} characters`);
    }
    return { version: 1, mcpServers: [...servers] as string[], systemPrompt: value.systemPrompt };
}

export function appProfileSeed(profile: ClaudeAppProfile): Record<string, string> {
    return { [APP_PROFILE_ENV]: JSON.stringify(profile) };
}

/**
 * Read once and delete, like every `HAPPY_INITIAL_` seed. Unlike other seeds a malformed one throws:
 * the daemon validated it, and running the session without it is what the profile exists to prevent.
 */
export function consumeAppProfileSeed(env: NodeJS.ProcessEnv): ClaudeAppProfile | null {
    const raw = env[APP_PROFILE_ENV];
    delete env[APP_PROFILE_ENV];
    if (raw === undefined) return null;
    // Empty is the marker a resume carries for a record that no longer parsed (daemon/sessionEnv.ts).
    if (raw.length === 0) throw new Error('App profile seed is empty');
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error('App profile seed is not JSON');
    }
    return parseAppProfile(value) ?? null;
}

export function applyAppProfile(options: QueryOptions, profile: ClaudeAppProfile): QueryOptions {
    const prefixes = profile.mcpServers.map(name => `mcp__${name}__`);
    const allowedTool = (toolName: string) => prefixes.some(prefix => toolName.startsWith(prefix));
    const canCallTool = options.canCallTool;
    return {
        ...options,
        tools: [],
        mcpServers: Object.fromEntries(Object.entries(options.mcpServers ?? {}).filter(([name]) => profile.mcpServers.includes(name))),
        strictMcpConfig: true,
        allowedTools: profile.mcpServers.map(name => `mcp__${name}__*`),
        disallowedTools: undefined,
        permissionMode: 'default',
        customSystemPrompt: profile.systemPrompt,
        appendSystemPrompt: undefined,
        settingSources: [],
        plugins: undefined,
        disabledPlugins: BUILTIN_PLUGINS,
        agents: undefined,
        skills: [],
        promptSuggestions: false,
        // The isolation automation runs use: no auto memory, the memory hook's recall left to the host (which does none here).
        isolatedAutomationContext: true,
        // Nobody answers a permission prompt in a server-started session: anything else is refused here.
        canCallTool: async (toolName, input, callOptions) => (allowedTool(toolName) && canCallTool
            ? canCallTool(toolName, input, callOptions)
            : { behavior: 'deny', message: 'This app session only allows its own tools.' }),
    };
}
