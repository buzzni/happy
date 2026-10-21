/**
 * Claude adapter for the tool policy (aplus-dev-studio specs/agent-tool-policy plan "I1a").
 *
 * Builds the PreToolUse hook entries; the session's gate itself is assembled in runtime.ts.
 * Rollback: `HAPPY_TOOL_POLICY=off` (no hook entries, no capability).
 *
 * Not installed for process-sandbox sessions: they get no hook settings at all and load no
 * user-scope MCP servers (`settingSources: []`, measured 2026-10-22), so their only MCP servers are
 * the ones Saycode injects — enforced at the stdio bridge in I1b.
 */

import { join } from 'node:path';
import { BUILTIN_TABLES, type ToolPolicyTables } from './rules';

/** Above the 30-minute approval wait (R11.5), so Claude never times the hook out first. */
export const POLICY_HOOK_TIMEOUT_SECONDS = 1900;

export const TOOL_POLICY_FILE_NAME = 'tool-policy.json';

export function isToolPolicyEnabled(env: NodeJS.ProcessEnv): boolean {
    return env.HAPPY_TOOL_POLICY?.trim().toLowerCase() !== 'off';
}

/** Machine metadata `toolPolicy`; absent when the policy is switched off. */
export function toolPolicyMachineCapability(env: NodeJS.ProcessEnv): { version: 1; enforcement: string[] } | undefined {
    return isToolPolicyEnabled(env) ? { version: 1, enforcement: ['claude-hook'] } : undefined;
}

export function toolPolicyFilePath(happyHomeDir: string): string {
    return join(happyHomeDir, TOOL_POLICY_FILE_NAME);
}

/**
 * The stored machine metadata with this daemon's `toolPolicy` capability, or undefined when it
 * already matches. The server keeps a machine's metadata from its first registration, so turning
 * the policy on (new build) or off (`HAPPY_TOOL_POLICY=off`) reaches Desktop only through this.
 */
export function toolPolicyMetadataUpdate<M extends { toolPolicy?: unknown }>(stored: M | null, capability: ReturnType<typeof toolPolicyMachineCapability>): M | undefined {
    if (!stored || JSON.stringify(stored.toolPolicy) === JSON.stringify(capability)) return undefined;
    const { toolPolicy: _previous, ...rest } = stored;
    return (capability ? { ...rest, toolPolicy: capability } : rest) as M;
}

/** Every `mcp__*` tool except the servers the daemon provides itself. */
export function policyHookMatcher(tables: ToolPolicyTables = BUILTIN_TABLES): string {
    const excluded = tables.mcp.excludedServers.map((server) => `${server.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}__`).join('|');
    return `^mcp__(?!${excluded}).*`;
}

export function buildToolPolicyHookEntries(input: { forwarderCommand: string; fileGuardCommand: string }): Array<Record<string, unknown>> {
    return [
        {
            matcher: policyHookMatcher(),
            hooks: [{
                type: 'command',
                command: input.forwarderCommand,
                timeout: POLICY_HOOK_TIMEOUT_SECONDS,
                // Honoured by newer Claude builds only; the forwarder fails closed on its own.
                onFailure: 'block',
            }],
        },
        {
            matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
            hooks: [{ type: 'command', command: input.fileGuardCommand }],
        },
    ];
}
