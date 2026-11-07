/**
 * `happy` command shim
 *
 * The session prompt tells the agent to run `happy agent …` (ADR-052). Whether
 * `happy` resolved used to depend on how the daemon was launched: a daemon
 * started without the CLI's bin on PATH, on a machine with no global install,
 * answered `command not found`. Writing a `happy` shim that execs the CLI
 * running this session and putting it first on PATH makes the command
 * available to every session, and pins it to the session's own CLI version
 * rather than an older global install.
 */

import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { resolveHappyCliSpawnCommand } from '@/utils/spawnHappyCLI';

interface HappyCliCommand {
    runtime: string;
    args: string[];
    tsconfigPath?: string;
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shScript(command: HappyCliCommand): string {
    // Like spawnHappyCLI, a source-mode CLI gets its tsconfig unless the caller set one.
    const tsconfig = command.tsconfigPath
        ? `[ "\${TSX_TSCONFIG_PATH+set}" = set ] || TSX_TSCONFIG_PATH=${shellQuote(command.tsconfigPath)}\nexport TSX_TSCONFIG_PATH\n`
        : '';
    const exec = [command.runtime, ...command.args].map(shellQuote).join(' ');
    return `#!/bin/sh\n# happy command shim — see happyCommandShim.ts in happy-cli.\n${tsconfig}exec ${exec} "$@"\n`;
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
        const script = shScript(command);
        // One directory per CLI command: sessions of different CLI versions share the home, and a
        // session starting later must not redirect another session's `happy`. Sessions of the same
        // CLI may still rewrite it while one runs it: replace it atomically, not in place.
        const shimDir = join(homeDir, 'happy-shims', createHash('sha256').update(script).digest('hex').slice(0, 16));
        mkdirSync(shimDir, { recursive: true });
        const temporaryPath = join(shimDir, `.happy.${process.pid}`);
        writeFileSync(temporaryPath, script, { mode: 0o755 });
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
