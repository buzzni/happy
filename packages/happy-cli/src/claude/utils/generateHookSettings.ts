/**
 * Generate temporary settings file with Claude hooks for session tracking
 * 
 * Creates a settings.json file that configures Claude's SessionStart hook
 * to notify our HTTP server when sessions change (new session, resume, compact, etc.)
 */

import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';
import {
    managedCredentialDenyRules,
    resolveMachineLockdownPolicy,
    type MachineLockdownPolicy,
} from '@/daemon/machineLockdownPolicy';
import { buildToolPolicyHookEntries } from '@/toolPolicy/claudeHook';

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
}): Record<string, unknown> {
    return {
        permissions: {
            deny: [
                "Bash(killall:*)",
                ...(input.policy.protectManagedCredentials ? managedCredentialDenyRules(input.homeDir) : []),
            ]
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
export function toolPolicyHookCommands(input: { execPath: string; scriptsDir: string; port: number; secretFile: string; policyFile: string }): { forwarderCommand: string; fileGuardCommand: string } {
    return {
        forwarderCommand: `"${input.execPath}" "${join(input.scriptsDir, 'policy_hook_forwarder.cjs')}" ${input.port} "${input.secretFile}"`,
        fileGuardCommand: `"${input.execPath}" "${join(input.scriptsDir, 'tool_policy_file_guard.cjs')}" "${input.policyFile}"`,
    };
}

/**
 * Generate a temporary settings file with SessionStart hook configuration
 * 
 * @param port - The port where Happy server is listening
 * @returns Path to the generated settings file
 */
export function generateHookSettingsFile(port: number, toolPolicy?: { secretFile: string; policyFile: string }): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    // Unique filename per process to avoid conflicts
    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    // Path to the hook forwarder script
    const forwarderScript = resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs');
    const hookCommand = `node "${forwarderScript}" ${port}`;

    // Guard against broad kills (`killall node`, `pkill -f node`, ...) that
    // would take down the happy daemon and every agent session on the machine.
    const broadKillGuardScript = resolve(projectPath(), 'scripts', 'broad_kill_guard.cjs');
    const broadKillGuardCommand = `node "${broadKillGuardScript}"`;

    const settings = buildHookSettings({
        hookCommand,
        broadKillGuardCommand,
        policy: resolveMachineLockdownPolicy(process.env),
        homeDir: homedir(),
        ...(toolPolicy ? {
            toolPolicy: toolPolicyHookCommands({
                execPath: process.execPath,
                scriptsDir: resolve(projectPath(), 'scripts'),
                port,
                secretFile: toolPolicy.secretFile,
                policyFile: toolPolicy.policyFile,
            }),
        } : {}),
    });

    writeFileSync(filepath, JSON.stringify(settings, null, 2), { mode: 0o600 });
    logger.debug(`[generateHookSettings] Created hook settings file: ${filepath}`);

    return filepath;
}

/**
 * Clean up the temporary hook settings file
 * 
 * @param filepath - Path to the settings file to remove
 */
export function cleanupHookSettingsFile(filepath: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[generateHookSettings] Cleaned up hook settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook settings file: ${error}`);
    }
}

