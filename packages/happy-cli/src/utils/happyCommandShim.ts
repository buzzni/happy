/**
 * `happy` command shim
 *
 * The session prompt tells the agent to run `happy agent …` (ADR-052). Whether
 * `happy` resolved used to depend on how the daemon was launched: a daemon
 * started without the CLI's bin on PATH, on a machine with no global install,
 * answered `command not found`. Writing a `happy` shim that execs the CLI
 * running this session — into the shim directory the broad-kill shims already
 * put first on PATH — makes the command available to every session, and pins
 * it to the session's own CLI version rather than an older global install.
 */

import { join } from 'node:path';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { resolveHappyCliSpawnCommand } from '@/utils/spawnHappyCLI';

interface HappyCliCommand {
    runtime: string;
    args: string[];
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Write the `happy` shim and prepend the shim directory to env.PATH.
 *
 * Never throws: a failure is logged and the session starts without the shim.
 * No-op on Windows, where the sh shim cannot run.
 *
 * @returns The shim directory path, or null if not installed
 */
export function installHappyCommandShim(
    env: NodeJS.ProcessEnv = process.env,
    homeDir: string = configuration.happyHomeDir,
    command: HappyCliCommand = resolveHappyCliSpawnCommand([])
): string | null {
    if (process.platform === 'win32') {
        return null;
    }
    try {
        const shimDir = join(homeDir, 'shims');
        mkdirSync(shimDir, { recursive: true });
        // Sessions of the machine share this directory and may run the shim while another
        // session rewrites it: replace it atomically instead of truncating it in place.
        const temporaryPath = join(shimDir, `.happy.${process.pid}`);
        const exec = [command.runtime, ...command.args].map(shellQuote).join(' ');
        writeFileSync(temporaryPath, `#!/bin/sh\n# happy command shim — see happyCommandShim.ts in happy-cli.\nexec ${exec} "$@"\n`, { mode: 0o755 });
        renameSync(temporaryPath, join(shimDir, 'happy'));

        const currentPath = env.PATH ?? '';
        if (!currentPath.split(':').includes(shimDir)) {
            env.PATH = currentPath ? `${shimDir}:${currentPath}` : shimDir;
        }
        logger.debug(`[happyCommandShim] Installed happy shim at ${shimDir}`);
        return shimDir;
    } catch (error) {
        logger.debug(`[happyCommandShim] Failed to install happy shim: ${error}`);
        return null;
    }
}
