/**
 * Broad-kill PATH shims
 *
 * Installs `killall` and `pkill` shim scripts into <happyHomeDir>/shims and
 * prepends that directory to PATH so every process an agent session spawns
 * (Claude Code, Codex, Gemini, and any subshell they run) hits the shim
 * first. The shim blocks kills that target the agent infrastructure itself
 * (node, electron, happy, caffeinate) and delegates everything else to the
 * real binary.
 *
 * This is the agent-agnostic defense layer: Claude Code is additionally
 * guarded by a PreToolUse hook (see broad_kill_guard.cjs), but Codex and
 * other runtimes have no hook system — the shim is what protects them.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

// Shared sh prologue: block if any non-option argument (with ^/$ regex
// anchors stripped) names a protected process. Exit 87 marks a guard block.
const GUARD_CHECK = `
for arg in "$@"; do
    case "$arg" in
        -*) continue ;;
    esac
    p=\${arg#^}
    p=\${p%\\$}
    case "$p" in
        node|node.exe|electron|Electron|happy|happy-cli|caffeinate)
            echo "happy-guard: blocked — killing '$arg' would take down the happy daemon and every agent session on this machine (they all run on node)." >&2
            echo "Instead: kill the specific PID you started (kill <PID>), or use a narrow pattern like: pkill -f vitest" >&2
            exit 87
            ;;
    esac
done
`;

// Delegate to the real binary from the standard system locations. We do not
// search PATH (the shim itself is on PATH — that risks recursion); killall
// and pkill live in these directories on macOS and Linux.
function delegateTo(binary: string): string {
    return `
for d in /usr/bin /bin /usr/sbin /sbin; do
    if [ -x "$d/${binary}" ]; then
        exec "$d/${binary}" "$@"
    fi
done
echo "happy-guard: real ${binary} not found in system paths" >&2
exit 127
`;
}

function shimScript(binary: string): string {
    return `#!/bin/sh
# happy-guard shim for ${binary} — see broadKillShims.ts in happy-cli.
${GUARD_CHECK}${delegateTo(binary)}`;
}

/**
 * Write the shim scripts and prepend the shim directory to env.PATH.
 *
 * Never throws: any failure is logged and the session continues unguarded
 * (the guard must not be able to break session startup). No-op on Windows,
 * where killall/pkill do not exist and sh shims cannot run.
 *
 * @param env - Environment to mutate (defaults to process.env, which child
 *              process spawns inherit)
 * @param homeDir - Base directory for the shims (defaults to happyHomeDir)
 * @returns The shim directory path, or null if not installed
 */
export function installBroadKillShims(
    env: NodeJS.ProcessEnv = process.env,
    homeDir: string = configuration.happyHomeDir
): string | null {
    if (process.platform === 'win32') {
        return null;
    }
    try {
        const shimDir = join(homeDir, 'shims');
        mkdirSync(shimDir, { recursive: true });
        for (const binary of ['killall', 'pkill']) {
            writeFileSync(join(shimDir, binary), shimScript(binary), { mode: 0o755 });
        }

        const currentPath = env.PATH ?? '';
        if (!currentPath.split(':').includes(shimDir)) {
            env.PATH = currentPath ? `${shimDir}:${currentPath}` : shimDir;
        }
        logger.debug(`[broadKillShims] Installed shims at ${shimDir}`);
        return shimDir;
    } catch (error) {
        logger.debug(`[broadKillShims] Failed to install shims: ${error}`);
        return null;
    }
}
