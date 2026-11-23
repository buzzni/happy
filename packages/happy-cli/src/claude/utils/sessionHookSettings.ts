import { dirname, join, resolve } from 'node:path';
import { managedCredentialDenyRules, resolveMachineLockdownPolicy, type MachineLockdownPolicy } from '@/daemon/machineLockdownPolicy';
import { buildToolPolicyHookEntries, skillLocksFilePath } from '@/toolPolicy/claudeHook';
import { orgEndpointRoutingSettingsEnv } from './orgEndpointEnvKeys';

/**
 * Pure settings document. `permissions.deny` always guards broad kills; under
 * the trial lockdown policy it also hides the daemon-managed credential files
 * and environment dumps from the agent (aplus-dev-studio
 * specs/trial-auto-onboarding-budget D7 — a mitigation, not a sandbox).
 */
export function buildHookSettings(input: {
    hookCommand: string;
    broadKillGuardCommand: string;
    policy: MachineLockdownPolicy;
    homeDir: string;
    /** aplus-dev-studio specs/agent-tool-policy — absent when `HAPPY_TOOL_POLICY=off`. */
    toolPolicy?: { forwarderCommand: string; fileGuardCommand: string };
    /**
     * An organization permission ceiling below bypass (aplus-dev-studio-desktop specs/codexcli-org-requirements
     * R10.10): Claude refuses bypass from the command line and from its own mode cycling in the terminal.
     */
    disableBypassPermissions?: boolean;
    /** An organization LLM endpoint session's routing (`orgEndpointRoutingSettingsEnv`), above the settings files. */
    env?: Record<string, string>;
}): Record<string, unknown> {
    return {
        ...(input.env ? { env: input.env } : {}),
        permissions: {
            deny: [
                "Bash(killall:*)",
                ...(input.policy.protectManagedCredentials ? managedCredentialDenyRules(input.homeDir) : []),
            ],
            ...(input.disableBypassPermissions ? { disableBypassPermissionsMode: 'disable' } : {}),
        },
        hooks: {
            SessionStart: [
                {
                    matcher: "*",
                    hooks: [
                        {
                            type: "command",
                            command: input.hookCommand
                        }
                    ]
                }
            ],
            PreToolUse: [
                {
                    matcher: "Bash",
                    hooks: [
                        {
                            type: "command",
                            command: input.broadKillGuardCommand
                        }
                    ]
                },
                ...(input.toolPolicy ? buildToolPolicyHookEntries(input.toolPolicy) : [])
            ]
        }
    };
}

/**
 * The tool policy hook commands, exactly as Claude runs them. The gate must not depend on `node`
 * being on the hook shell's PATH: a hook that cannot start is a non-blocking error to Claude, i.e.
 * the call runs unchecked — so the daemon's own executable is quoted in.
 */
export function toolPolicyHookCommands(input: { execPath: string; scriptsDir: string; port: number; secretFile: string; policyFile: string; protectedDirs?: string[] }): { forwarderCommand: string; fileGuardCommand: string } {
    const dirs = (input.protectedDirs ?? []).map((dir) => ` --dir "${dir}"`).join('');
    // aplus-dev-studio-desktop specs/skill-lock: the lock file sits beside the policy file Desktop writes.
    const skillLocks = ` --skill-locks "${skillLocksFilePath(dirname(input.policyFile))}" --hook ${input.port} "${input.secretFile}"`;
    return {
        forwarderCommand: `"${input.execPath}" "${join(input.scriptsDir, 'policy_hook_forwarder.cjs')}" ${input.port} "${input.secretFile}"`,
        fileGuardCommand: `"${input.execPath}" "${join(input.scriptsDir, 'tool_policy_file_guard.cjs')}" "${input.policyFile}"${dirs}${skillLocks}`,
    };
}

export type SessionToolPolicyHooks = { secretFile: string; policyFile: string; protectedDirs?: string[] };

/** Build the same startup settings before the worker has loaded session state. */
export function buildSessionHookSettings(input: {
    installRoot: string;
    execPath: string;
    homeDir: string;
    env: NodeJS.ProcessEnv;
    port: number;
    toolPolicy?: SessionToolPolicyHooks;
    disableBypassPermissions?: boolean;
}): Record<string, unknown> {
    const scriptsDir = resolve(input.installRoot, 'scripts');
    return buildHookSettings({
        hookCommand: `node "${join(scriptsDir, 'session_hook_forwarder.cjs')}" ${input.port}`,
        broadKillGuardCommand: `node "${join(scriptsDir, 'broad_kill_guard.cjs')}"`,
        policy: resolveMachineLockdownPolicy(input.env),
        homeDir: input.homeDir,
        ...(input.toolPolicy ? {
            toolPolicy: toolPolicyHookCommands({
                execPath: input.execPath,
                scriptsDir,
                port: input.port,
                ...input.toolPolicy,
            }),
        } : {}),
        disableBypassPermissions: input.disableBypassPermissions,
        env: orgEndpointRoutingSettingsEnv(input.env),
    });
}
