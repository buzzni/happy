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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/** Git Bash (Claude Code on Windows) and POSIX shells run this one. */
function shScript(command: HappyCliCommand): string {
    // Like spawnHappyCLI, a source-mode CLI gets its tsconfig unless the caller set one.
    const tsconfig = command.tsconfigPath
        ? `[ "\${TSX_TSCONFIG_PATH+set}" = set ] || TSX_TSCONFIG_PATH=${shellQuote(command.tsconfigPath)}\nexport TSX_TSCONFIG_PATH\n`
        : '';
    const exec = [command.runtime, ...command.args].map(shellQuote).join(' ');
    return `#!/bin/sh\n# happy command shim — see happyCommandShim.ts in happy-cli.\n${tsconfig}exec ${exec} "$@"\n`;
}

/**
 * cmd and PowerShell (Codex on Windows) find this one through PATHEXT. cmd decodes a batch file in
 * the console code page, which would garble a non-ASCII profile path, so the file names no path: it
 * runs the command the session put in its environment, which stays Unicode.
 */
const CMD_SCRIPT = [
    '@rem happy command shim - see happyCommandShim.ts in happy-cli.',
    '@setlocal',
    '@if not defined HAPPY_COMMAND_SHIM_COMMAND (echo happy: run this from a Saycode session 1>&2 & exit /b 127)',
    // Like spawnHappyCLI, a source-mode CLI gets its tsconfig unless the caller set one.
    '@if not defined TSX_TSCONFIG_PATH if defined HAPPY_COMMAND_SHIM_TSCONFIG set "TSX_TSCONFIG_PATH=%HAPPY_COMMAND_SHIM_TSCONFIG%"',
    '@%HAPPY_COMMAND_SHIM_COMMAND% %*',
    '',
].join('\r\n');

// Sessions of the same CLI may rewrite a shim while another runs it. Replace it atomically, not in
// place, and leave an identical one alone: Windows refuses to replace a batch file cmd is running.
function writeShim(path: string, content: string): void {
    try {
        if (readFileSync(path, 'utf8') === content) return;
    } catch {
        // Not written yet.
    }
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, content, { mode: 0o755 });
    renameSync(temporaryPath, path);
}

/**
 * Write the `happy` shims and prepend their directory to the environment's PATH.
 *
 * Never throws: a failure is logged and the session starts without the shim.
 *
 * @returns The shim directory path, or null if not installed
 */
export function installHappyCommandShim(
    env: NodeJS.ProcessEnv = process.env,
    homeDir: string = configuration.happyHomeDir,
    command: HappyCliCommand = resolveHappyCliSpawnCommand([]),
    platform: NodeJS.Platform = process.platform
): string | null {
    try {
        const script = shScript(command);
        // One directory per CLI command: sessions of different CLI versions share the home, and a
        // session starting later must not redirect another session's `happy`.
        const shimDir = join(homeDir, 'happy-shims', createHash('sha256').update(script).digest('hex').slice(0, 16));
        mkdirSync(shimDir, { recursive: true });
        writeShim(join(shimDir, 'happy'), script);
        if (platform === 'win32') {
            writeShim(join(shimDir, 'happy.cmd'), CMD_SCRIPT);
            // Windows paths cannot contain `"`, and cmd expands the variable once, so `%` stays literal.
            env.HAPPY_COMMAND_SHIM_COMMAND = [command.runtime, ...command.args].map((part) => `"${part}"`).join(' ');
            if (command.tsconfigPath) env.HAPPY_COMMAND_SHIM_TSCONFIG = command.tsconfigPath;
        }

        const delimiter = platform === 'win32' ? ';' : ':';
        const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
        const currentPath = env[pathKey] ?? '';
        if (!currentPath.split(delimiter).includes(shimDir)) {
            env[pathKey] = currentPath ? `${shimDir}${delimiter}${currentPath}` : shimDir;
        }
        logger.debug(`[happyCommandShim] Installed happy shim at ${shimDir}`);
        return shimDir;
    } catch (error) {
        logger.debug(`[happyCommandShim] Failed to install happy shim: ${error}`);
        return null;
    }
}
