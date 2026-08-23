/**
 * Cross-platform Happy CLI spawning utility
 * 
 * ## Background
 * 
 * We built a command-line JavaScript program with the entrypoint at `dist/index.mjs`.
 * This needs to be run with `node`, but we want to hide deprecation warnings and other 
 * noise from end users by passing specific flags: `--no-warnings --no-deprecation`.
 * 
 * Users don't care about these technical details - they just want a clean experience
 * with no warning output when using Happy.
 * 
 * ## The Wrapper Strategy
 * 
 * We created a wrapper script `bin/happy.mjs` with a shebang `#!/usr/bin/env node`.
 * This allows direct execution on Unix systems and NPM automatically generates 
 * Windows-specific wrapper scripts (`happy.cmd` and `happy.ps1`) when it sees 
 * the `bin` field in package.json pointing to a JavaScript file with a shebang.
 * 
 * The wrapper script either directly execs `dist/index.mjs` with the flags we want,
 * or imports it directly if Node.js already has the right flags.
 * 
 * ## Execution Chains
 * 
 * **Unix/Linux/macOS:**
 * 1. User runs `happy` command
 * 2. Shell directly executes `bin/happy.mjs` (shebang: `#!/usr/bin/env node`)
 * 3. `bin/happy.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * **Windows:**
 * 1. User runs `happy` command  
 * 2. NPM wrapper (`happy.cmd`) calls `node bin/happy.mjs`
 * 3. `bin/happy.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * ## The Spawning Problem
 * 
 * When our code needs to spawn Happy cli as a subprocess (for daemon processes), 
 * we were trying to execute `bin/happy.mjs` directly. This fails on Windows 
 * because Windows doesn't understand shebangs - you get an `EFTYPE` error.
 * 
 * ## The Solution
 * 
 * Since we know exactly what needs to happen (run `dist/index.mjs` with specific 
 * Node.js flags), we can bypass all the wrapper layers and do it directly:
 * 
 * `spawn('node', ['--no-warnings', '--no-deprecation', 'dist/index.mjs', ...args])`
 * 
 * This works on all platforms and achieves the same result without any of the 
 * middleman steps that were providing workarounds for Windows vs Linux differences.
 */

import { SpawnOptions, type ChildProcess } from 'child_process';
import { spawn as crossSpawn } from 'cross-spawn';
import { join, resolve } from 'node:path';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { existsSync } from 'node:fs';
import { isBun } from './runtime';

type HappyCliSpawnCommand = {
  runtime: string;
  args: string[];
  entrypoint: string;
  tsconfigPath?: string;
};

type HappyCliSpawnRuntime = {
  projectRoot: string;
  execPath: string;
  execArgv: string[];
  argv: string[];
  isBunRuntime: boolean;
};

function withQuietNodeFlags(execArgv: string[]): string[] {
  return [
    ...(execArgv.includes('--no-warnings') ? [] : ['--no-warnings']),
    ...(execArgv.includes('--no-deprecation') ? [] : ['--no-deprecation']),
    ...execArgv,
  ];
}

export function resolveHappyCliSpawnCommand(
  args: string[],
  runtime: HappyCliSpawnRuntime = {
    projectRoot: projectPath(),
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv: process.argv,
    isBunRuntime: isBun(),
  },
): HappyCliSpawnCommand {
  const sourceEntrypoint = join(runtime.projectRoot, 'src', 'index.ts');
  const sourceTsconfigPath = join(runtime.projectRoot, 'tsconfig.json');
  const currentEntrypoint = runtime.argv[1] ? resolve(runtime.argv[1]) : '';
  if (currentEntrypoint === resolve(sourceEntrypoint)) {
    return {
      runtime: runtime.execPath,
      args: [
        ...withQuietNodeFlags(runtime.execArgv),
        sourceEntrypoint,
        ...args,
      ],
      entrypoint: sourceEntrypoint,
      tsconfigPath: sourceTsconfigPath,
    };
  }

  const entrypoint = join(runtime.projectRoot, 'dist', 'index.mjs');
  return {
    runtime: runtime.isBunRuntime ? 'bun' : 'node',
    args: [
      '--no-warnings',
      '--no-deprecation',
      entrypoint,
      ...args,
    ],
    entrypoint,
  };
}

/**
 * Spawn the Happy CLI with the given arguments in a cross-platform way.
 * 
 * This function bypasses the wrapper script (bin/happy.mjs) and spawns the 
 * actual CLI entrypoint (dist/index.mjs) directly with Node.js, ensuring
 * compatibility across all platforms including Windows.
 * 
 * @param args - Arguments to pass to the Happy CLI
 * @param options - Spawn options (same as child_process.spawn)
 * @returns ChildProcess instance
 */
export function spawnHappyCLI(args: string[], options: SpawnOptions = {}): ChildProcess {
  const command = resolveHappyCliSpawnCommand(args);

  let directory: string | URL | undefined;
  if ('cwd' in options) {
    directory = options.cwd
  } else {
    directory = process.cwd()
  }
  // Note: We're actually executing 'node' with the calculated entrypoint path below,
  // bypassing the 'happy' wrapper that would normally be found in the shell's PATH.
  // However, we log it as 'happy' here because other engineers are typically looking
  // for when "happy" was started and don't care about the underlying node process
  // details and flags we use to achieve the same result.
  const fullCommand = `happy ${args.join(' ')}`;
  logger.debug(`[SPAWN HAPPY CLI] Spawning: ${fullCommand} in ${directory}`);
  
  // Use the same Node.js flags that the wrapper script uses
  // Sanity check of the entrypoint path exists
  if (!existsSync(command.entrypoint)) {
    const errorMessage = `Entrypoint ${command.entrypoint} does not exist`;
    logger.debug(`[SPAWN HAPPY CLI] ${errorMessage}`);
    throw new Error(errorMessage);
  }

  // Use cross-spawn so `node` resolves to `node.exe` on Windows.
  // Since Node's CVE-2024-27980 hardening, child_process.spawn('node', ...)
  // on Windows no longer falls back to appending `.exe`, producing ENOENT
  // even when node is on PATH (issue #1082).
  const env = command.tsconfigPath
    ? {
        ...(options.env ?? process.env),
        TSX_TSCONFIG_PATH: (options.env as NodeJS.ProcessEnv | undefined)?.TSX_TSCONFIG_PATH ?? command.tsconfigPath,
      }
    : options.env;

  return crossSpawn(command.runtime, command.args, {
    windowsHide: true,
    ...options,
    ...(env ? { env } : {}),
  });
}

/**
 * Spawn a detached Happy CLI process and wait until the OS has actually
 * started it.
 *
 * WHY the wait exists: `child_process.spawn` is asynchronous — it returns a
 * handle immediately and libuv performs the fork/exec on a later tick. A caller
 * that spawns and then calls `process.exit()` in the same tick can terminate
 * before the child is ever exec'd, and with `detached` + ignored stdio there is
 * no trace that anything was lost. That is how the 2026-08-23 daemon handoff
 * dropped its replacement: the daemon logged the spawn and its own exit in the
 * same millisecond, and no successor process ever appeared. Resolving on the
 * `spawn` event lets the caller exit only once the child exists.
 */
export async function spawnDetachedHappyCLI(
  args: string[],
  {
    spawn = spawnHappyCLI,
    timeoutMs = 10_000,
    stdio = 'ignore',
  }: {
    spawn?: typeof spawnHappyCLI
    timeoutMs?: number
    stdio?: SpawnOptions['stdio']
  } = {},
): Promise<boolean> {
  const description = `happy ${args.join(' ')}`
  let child: ChildProcess
  try {
    child = spawn(args, { detached: true, stdio })
  } catch (error) {
    logger.debug(`[SPAWN HAPPY CLI] Detached spawn of \`${description}\` threw before starting: ${error}`)
    return false
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (started: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Detach from our event loop either way; on failure there is nothing to
      // hold on to, and on success the child must outlive us.
      try {
        child.unref()
      } catch {
        // Handle already gone — nothing to release.
      }
      resolve(started)
    }

    // NOTE: no `child.kill()` here, unlike preflightInstalledHappyCLI below.
    // Its child is a throwaway probe; ours may be the machine's only daemon
    // that was merely slow to report. Killing it would recreate the outage
    // this function exists to prevent. A timeout here means "could not
    // confirm", not "did not start".
    const timer = setTimeout(() => {
      logger.debug(`[SPAWN HAPPY CLI] Detached spawn of \`${description}\` did not report starting within ${timeoutMs}ms; leaving it alone`)
      finish(false)
    }, timeoutMs)

    child.once('spawn', () => finish(true))
    child.once('error', (error) => {
      logger.debug(`[SPAWN HAPPY CLI] Detached spawn of \`${description}\` failed: ${error}`)
      finish(false)
    })
  })
}

export async function preflightInstalledHappyCLI({
  spawn = spawnHappyCLI,
  timeoutMs = 30_000,
}: {
  spawn?: typeof spawnHappyCLI
  timeoutMs?: number
} = {}): Promise<boolean> {
  let child: ChildProcess
  try {
    child = spawn(['daemon', 'preflight'], { stdio: 'ignore' })
  } catch {
    return false
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ready)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, timeoutMs)

    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
  })
}
