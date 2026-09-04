/**
 * Machine lockdown policy — aplus-dev-studio specs/trial-auto-onboarding-budget D6/D7.
 *
 * Trial (ephemeral) Fly machines run with a shared Z.AI credential that the
 * end user must not be able to read. The daemon is the enforcement point:
 * happy-server only checks "caller owns this daemon", and on a trial machine
 * the trial user *is* the owner. The trial image sets these environment
 * variables; every other machine keeps today's behaviour.
 *
 *  - HAPPY_REMOTE_TERMINAL_POLICY=disabled  → refuse `terminal-open-fwd`.
 *  - HAPPY_RPC_ALLOWED_ROOT=workspace       → file RPCs (readFile, listDirectory,
 *    ...) are confined to the workspace root instead of the whole home
 *    directory, and Claude Code sessions get deny rules for credential paths.
 *
 * This is a mitigation, not a sandbox: the `bash` RPC command string and the
 * agent's own tools can still reach files by other means. The credential
 * blast radius is bounded server-side (per-user budget, key rotation).
 */

export type MachineLockdownPolicy = {
    remoteTerminalDisabled: boolean;
    rpcAllowedRootMode: 'home' | 'workspace';
    protectManagedCredentials: boolean;
};

export const REMOTE_TERMINAL_DISABLED_ERROR = 'TERMINAL_DISABLED';

export function resolveMachineLockdownPolicy(
    env: Record<string, string | undefined> = process.env,
): MachineLockdownPolicy {
    const rpcAllowedRootMode = env.HAPPY_RPC_ALLOWED_ROOT?.trim().toLowerCase() === 'workspace'
        ? 'workspace'
        : 'home';
    return {
        remoteTerminalDisabled: env.HAPPY_REMOTE_TERMINAL_POLICY?.trim().toLowerCase() === 'disabled',
        rpcAllowedRootMode,
        protectManagedCredentials: rpcAllowedRootMode === 'workspace',
    };
}

/**
 * Claude Code `permissions.deny` patterns that keep an agent session from
 * reading the daemon-managed credential files or dumping its own process
 * environment (which carries the injected ANTHROPIC_AUTH_TOKEN).
 */
export function managedCredentialDenyRules(homeDir: string): string[] {
    const home = homeDir.replace(/\/+$/, '');
    const protectedDirs = [
        `${home}/.happy`,
        `${home}/.claude`,
        `${home}/.claude-swap`,
        `${home}/.codex`,
    ];
    return [
        ...protectedDirs.flatMap((dir) => [`Read(${dir}/**)`, `Bash(cat ${dir}/*)`]),
        'Read(/proc/**)',
        'Bash(env)',
        'Bash(env:*)',
        'Bash(printenv:*)',
        'Bash(export)',
        'Bash(set)',
    ];
}
