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
import { parseMcpToolName } from './evaluate';
import { snapshotContradictsTarget, type ToolPolicyGate } from './policyGate';
import { BUILTIN_TABLES, type ToolPolicyTables } from './rules';

/** Hook-decided calls the proxy may still be waiting for; a declined prompt never reaches it. */
const MAX_HOOK_DECIDED_CALLS = 256;

/** Above the 30-minute approval wait (R11.5), so Claude never times the hook out first. */
export const POLICY_HOOK_TIMEOUT_SECONDS = 1900;

export const TOOL_POLICY_FILE_NAME = 'tool-policy.json';

export function isToolPolicyEnabled(env: NodeJS.ProcessEnv): boolean {
    return env.HAPPY_TOOL_POLICY?.trim().toLowerCase() !== 'off';
}

/** Machine metadata `toolPolicy`; absent when the policy is switched off. */
/**
 * Machine metadata `toolPolicy`; absent when the policy is switched off. `enforcement` names the
 * adapters this runtime has: every Claude `mcp__*` call (hook), cua-driver for both providers
 * (shadow proxy) and Saycode-injected servers under Codex (stdio bridge). A user's own non-cua MCP
 * server under Codex has no adapter (Q5) — hence no `codex-user-mcp`. `verb-words:<rule>` names the MCP
 * verb rule this daemon decides by (policy-tables §4), so Desktop labels a conversation's tools by its PC's rule.
 * `policyVersion` names its table: Desktop's labels use its own PC's dictionary, so a different version labels nothing.
 */
export function toolPolicyMachineCapability(env: NodeJS.ProcessEnv): { version: 1; enforcement: string[]; policyVersion: string } | undefined {
    return isToolPolicyEnabled(env)
        ? { version: 1, enforcement: ['claude-hook', 'cua-proxy', 'codex-bridge', `verb-words:${BUILTIN_TABLES.mcp.verbWords}`], policyVersion: BUILTIN_TABLES.policyVersion }
        : undefined;
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
                // Blocks a forwarder that cannot start, times out or dies (Claude 2.1.295+; older
                // builds ignore it). Once running, the forwarder fails closed on its own.
                onFailure: 'block',
            }],
        },
        {
            matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
            hooks: [{ type: 'command', command: input.fileGuardCommand }],
        },
    ];
}

/**
 * While cua-driver runs behind the shadow proxy, each of its calls is decided exactly once:
 * - remote (SDK) mode under bypassPermissions (what Desktop sends): the proxy decides — only it saw
 *   which app an `element_token` names — and the hook steps aside;
 * - local (terminal) mode, or any other permission mode: the hook decides — only it can hand `ask`
 *   to Claude's own prompt, and only its `allow` skips Claude's own approval card, which would
 *   otherwise come first and share the proxy's request id — and the proxy then lets through exactly
 *   the call (by tool_use_id) the hook let through. The target the hook judged is not looked up
 *   again when the call reaches the proxy (as in I1a's hook path).
 * A proxy call the hook did not let through is decided by the proxy, so a mode switch between the
 * two never skips a decision. The proxy lets through only the same tool, in the same provider run
 * (generation), as the hook's verdict — and decides again when the call's `element_token` names an
 * app other than the pid the hook judged (only the proxy saw that snapshot). A token-only call keeps
 * the hook's verdict: the hook judged an unknown target and a person answered for it.
 */
export function handOffCuaToShadowProxy(gate: ToolPolicyGate, options: { terminalPrompt: () => boolean; tables?: ToolPolicyTables }): ToolPolicyGate & {
    /**
     * A new provider run (query restart, abort, `/clear`, mode switch): ids the hook let through in
     * an earlier run are dropped — the provider may reuse one for a different call.
     */
    newProviderGeneration(): void;
} {
    const tables = options.tables ?? BUILTIN_TABLES;
    let generation = 0;
    const decidedByHook = new Map<string, { toolName: string; generation: number }>();
    return {
        toolsListed: gate.toolsListed,
        newProviderGeneration: () => {
            generation += 1;
            decidedByHook.clear();
        },
        decide: async (call, signal) => {
            if (parseMcpToolName(call.toolName)?.server !== tables.cuaDriver.server) return gate.decide(call, signal);
            if (call.origin === undefined) {
                const hookDecides = options.terminalPrompt() || (call.permissionMode !== undefined && call.permissionMode !== 'bypassPermissions');
                if (!hookDecides || !call.toolUseId) return { kind: 'pass' };
                const decidedIn = generation;
                const verdict = await gate.decide(call, signal);
                // A verdict that outlived its provider run (a 30-minute prompt) is not handed on.
                if (verdict.kind !== 'deny' && decidedIn === generation) {
                    decidedByHook.set(call.toolUseId, { toolName: call.toolName, generation });
                    if (decidedByHook.size > MAX_HOOK_DECIDED_CALLS) decidedByHook.delete(decidedByHook.keys().next().value as string);
                }
                return verdict;
            }
            const handed = call.origin === 'cua-proxy' && call.toolUseId ? decidedByHook.get(call.toolUseId) : undefined;
            if (handed && call.toolUseId) {
                decidedByHook.delete(call.toolUseId);
                if (handed.generation === generation && handed.toolName === call.toolName && !snapshotContradictsTarget(call, tables)) return { kind: 'pass' };
            }
            return gate.decide(call, signal);
        },
    };
}
