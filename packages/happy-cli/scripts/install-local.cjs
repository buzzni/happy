#!/usr/bin/env node

/**
 * Install this workspace as the global `happy` binary for local development.
 *
 * Steps:
 *   1. build happy-wire and happy-cli
 *   2. prepare and guard the publish artifact
 *   3. stop any running daemon (ignores failure)
 *   4. npm install -g the guarded tarball
 *   5. verify bundled runtime deps
 *   6. start the daemon again
 *   7. verify by running `happy --version`
 *
 * Reuses ~/.happy/ - no separate dev home dir. Auth and sessions carry over.
 * To undo: uninstall this manifest's package name and reinstall its latest registry release.
 *
 * Refuses to run when a live daemon is tracking sessions, because replacing the
 * global bundle hands every one of those sessions to a new daemon. Use
 * `pnpm cli:install:isolated` to test a build without touching the global
 * install, or set HAPPY_CLI_INSTALL_GLOBAL=1 to proceed anyway.
 */

const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const path = require('path');
const { decideGlobalInstall } = require('./globalInstallGuard.cjs');

const PACKAGE_DIR = path.resolve(__dirname, '..');
const PACKAGE_NAME = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')).name;
const IS_WINDOWS = process.platform === 'win32';
const CHILD_ENV = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^npm_config_(?:global_|local_)?prefix$/i.test(key))
);

function run(cmd, args, { allowFailure = false } = {}) {
    const label = [cmd, ...args].join(' ');
    console.log(`\n▶ ${label}`);
    const result = spawnSync(cmd, args, {
        cwd: PACKAGE_DIR,
        stdio: 'inherit',
        env: CHILD_ENV,
        // shell: true resolves `.cmd` shims on Windows so `pnpm` / `npm` / `happy` are found.
        shell: IS_WINDOWS,
    });
    if (result.error) {
        console.error(`Failed to spawn: ${label}`, result.error.message);
        if (!allowFailure) process.exit(1);
        return 1;
    }
    const status = result.status ?? 1;
    if (status !== 0 && !allowFailure) {
        console.error(`\nExit ${status}: ${label}`);
        process.exit(status);
    }
    return status;
}

function runOutput(cmd, args) {
    const label = [cmd, ...args].join(' ');
    console.log(`\n▶ ${label}`);
    const result = spawnSync(cmd, args, {
        cwd: PACKAGE_DIR,
        encoding: 'utf8',
        env: CHILD_ENV,
        shell: IS_WINDOWS,
    });

    if (result.error) {
        console.error(`Failed to spawn: ${label}`, result.error.message);
        process.exit(1);
    }

    const status = result.status ?? 1;
    if (status !== 0) {
        console.error(`\nExit ${status}: ${label}`);
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(status);
    }

    return result.stdout;
}

function runPnpm(args) {
    const npmExecPath = process.env.npm_execpath;
    if (npmExecPath && /(?:^|[\\/])pnpm(?:\.c?js)?$/i.test(npmExecPath)) {
        return run(process.execPath, [npmExecPath, ...args]);
    }
    return run('pnpm', args);
}

function packPreparedPackage(preparedDir, outputDir) {
    const result = spawnSync('npm', [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        outputDir
    ], {
        cwd: preparedDir,
        encoding: 'utf8',
        env: CHILD_ENV,
        shell: IS_WINDOWS,
    });

    if (result.error) {
        console.error('Failed to spawn: npm pack', result.error.message);
        process.exit(1);
    }

    const status = result.status ?? 1;
    if (status !== 0) {
        console.error('\nExit ' + status + ': npm pack');
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(status);
    }

    const stdout = result.stdout;
    const jsonStart = stdout.indexOf('[');
    const jsonEnd = stdout.lastIndexOf(']');

    if (jsonStart === -1 || jsonEnd === -1) {
        console.error(`Unable to parse npm pack output:\n${stdout}`);
        process.exit(1);
    }

    const packed = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
    const filename = packed[0] && packed[0].filename;

    if (!filename) {
        console.error(`npm pack did not return a tarball filename:\n${stdout}`);
        process.exit(1);
    }

    return path.join(outputDir, filename);
}

function globalBinPath(globalPrefix, command) {
    return IS_WINDOWS
        ? path.join(globalPrefix, `${command}.cmd`)
        : path.join(globalPrefix, 'bin', command);
}

function globalNodeModulesPath(globalPrefix) {
    return IS_WINDOWS
        ? path.join(globalPrefix, 'node_modules')
        : path.join(globalPrefix, 'lib', 'node_modules');
}

function waitForDaemonHandoff(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isDaemonRunning(happyExecutable) {
    const output = runOutput(happyExecutable, ['daemon', 'status']);
    process.stdout.write(output);
    return output.includes('Daemon is running');
}

function verifyBundledDependency(globalPrefix) {
    const npmRoot = globalNodeModulesPath(globalPrefix);
    const wireEntry = path.join(
        npmRoot,
        ...PACKAGE_NAME.split('/'),
        'node_modules',
        '@slopus',
        'happy-wire',
        'dist',
        'index.mjs'
    );

    if (!fs.existsSync(wireEntry)) {
        console.error(`Installed happy-cli is missing bundled @slopus/happy-wire: ${wireEntry}`);
        process.exit(1);
    }

    console.log(`\n✓ Bundled @slopus/happy-wire found at ${wireEntry}`);
}

function happyHomeDir() {
    const configured = process.env.HAPPY_HOME_DIR;
    if (configured) return configured.replace(/^~/, os.homedir());
    return path.join(os.homedir(), '.happy');
}

function readDaemonState() {
    try {
        return JSON.parse(fs.readFileSync(path.join(happyHomeDir(), 'daemon.state.json'), 'utf8'));
    } catch {
        // No daemon has ever run here, or the file is unreadable — nothing to protect.
        return null;
    }
}

function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function assertGlobalInstallIsSafe() {
    const decision = decideGlobalInstall({
        state: readDaemonState(),
        isPidAlive,
        override: process.env.HAPPY_CLI_INSTALL_GLOBAL,
    });

    if (!decision.blocked) return;

    console.error(`
\u2716 Global daemon (pid ${decision.pid}) is tracking ${decision.sessionCount} session(s).
  Installing globally replaces the bundle it watches, so every one of those
  sessions is handed to a new daemon. That handoff failed twice — 2026-08-23
  and 2026-08-25 — leaving the machine without a daemon for about six hours.

  Test this build without touching them:
      pnpm cli:install:isolated

  Install globally anyway (you are replacing those sessions' daemon):
      HAPPY_CLI_INSTALL_GLOBAL=1 pnpm cli:install
`);
    process.exit(1);
}

assertGlobalInstallIsSafe();

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-cli-local-install-'));
const preparedDir = path.join(tempDir, 'package');

try {
    // Pin the destination before pnpm runs nested lifecycle commands. Otherwise an inherited
    // npm prefix can redirect `npm install -g` into the workspace and shadow the real CLI.
    const globalPrefix = runOutput('npm', ['prefix', '-g']).trim();
    const globalHappy = globalBinPath(globalPrefix, 'happy');

    runPnpm(['--filter', '@slopus/happy-wire', 'run', 'build']);
    runPnpm(['run', 'build']);
    run('node', ['scripts/prepare-publish-package.cjs', '--out', preparedDir]);
    run('node', ['scripts/guard-publish-artifact.cjs', preparedDir, '--install-smoke']);

    const tarball = packPreparedPackage(preparedDir, tempDir);

    const happyForStop = fs.existsSync(globalHappy) ? globalHappy : 'happy';
    run(happyForStop, ['daemon', 'stop'], { allowFailure: true });
    run('npm', ['install', '-g', '--prefix', globalPrefix, tarball]);
    verifyBundledDependency(globalPrefix);
    // A running daemon watches its bundle and may already be handing itself over to the
    // newly installed copy. Let that handoff settle before issuing a start command.
    waitForDaemonHandoff(2000);
    const startStatus = run(globalHappy, ['daemon', 'start'], { allowFailure: true });
    if (startStatus !== 0) {
        console.log('\nDaemon start raced with the previous daemon shutdown; checking the handoff result.');
        waitForDaemonHandoff(2000);
        if (!isDaemonRunning(globalHappy)) {
            run(globalHappy, ['daemon', 'start']);
        }
    }
    run(globalHappy, ['--version']);
} finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
}

console.log(`\n✓ Installed from ${PACKAGE_DIR}`);
console.log(`  To undo: npm uninstall -g ${PACKAGE_NAME} && npm i -g ${PACKAGE_NAME}@latest`);
