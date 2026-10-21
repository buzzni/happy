/**
 * Claude adapter for the tool policy (aplus-dev-studio specs/agent-tool-policy plan "I1a").
 *
 * Builds the PreToolUse hook entries and assembles one session's gate: the per-process secret the
 * hook script presents to the session hook server, the machine policy loader, target resolver,
 * grants and audit log. Rollback: `HAPPY_TOOL_POLICY=off` (no hook entries, no capability).
 *
 * Not installed for process-sandbox sessions: they get no hook settings at all and load no
 * user-scope MCP servers (`settingSources: []`, measured 2026-10-22), so their only MCP servers are
 * the ones Saycode injects — enforced at the stdio bridge in I1b.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createToolPolicyAuditLog, type ToolPolicyAuditRecord } from './audit';
import { createPolicyGrantStore, type PolicyGrantStore } from './grants';
import { createToolPolicyGate, type PolicyApprover, type ToolPolicyGate } from './policyGate';
import { BUILTIN_TABLES, createMachinePolicyLoader, type ToolPolicyTables } from './rules';
import { createTargetResolver } from './targetResolver';

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

export interface ClaudeToolPolicyRuntime {
    gate: ToolPolicyGate;
    grants: PolicyGrantStore;
    secret: string;
    secretFile: string;
    policyFile: string;
    dispose(): void;
}

export function createClaudeToolPolicyRuntime(input: {
    happyHomeDir: string;
    sessionId: () => string | null;
    publishRecent: (recent: ToolPolicyAuditRecord[]) => void;
    approver: () => PolicyApprover | null;
    unattended: boolean;
    terminalPrompt: () => boolean;
    grantTtlMs: number | null;
}): ClaudeToolPolicyRuntime {
    const secret = randomBytes(32).toString('hex');
    const hooksDir = join(input.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
    const secretFile = join(hooksDir, `policy-secret-${process.pid}`);
    writeFileSync(secretFile, secret, { mode: 0o600 });
    chmodSync(secretFile, 0o600);

    const policyFile = toolPolicyFilePath(input.happyHomeDir);
    const grants = createPolicyGrantStore({ grantTtlMs: input.grantTtlMs });
    const gate = createToolPolicyGate({
        loadMachinePolicy: createMachinePolicyLoader(policyFile),
        resolver: createTargetResolver(),
        grants,
        audit: createToolPolicyAuditLog({
            path: join(input.happyHomeDir, 'logs', 'tool-policy.jsonl'),
            sessionId: input.sessionId,
            publishRecent: input.publishRecent,
        }),
        approver: input.approver,
        unattended: input.unattended,
        terminalPrompt: input.terminalPrompt,
    });

    return {
        gate,
        grants,
        secret,
        secretFile,
        policyFile,
        dispose: () => {
            grants.clear();
            try { unlinkSync(secretFile); } catch { /* already gone */ }
        },
    };
}
