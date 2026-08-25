#!/usr/bin/env node

/**
 * Install this workspace into an ISOLATED prefix + home dir, so a development
 * build can be exercised without touching the global `happy` or the daemon
 * other sessions are using.
 *
 * This automates the manual procedure in
 * `docs/runbooks/happy-cli-dev-e2e-verification.md` §2, including the parts
 * that are easy to get wrong by hand:
 *
 *   - a separate npm prefix, so the global install is untouched
 *   - a separate HAPPY_HOME_DIR, so the shared daemon's state/lock are untouched
 *   - postinstall actually run, so node-pty's spawn-helper gets its execute bit
 *     (the tarball ships it 0644) and the bundled tools are unpacked
 *   - the inherited HAPPY_* session variables scrubbed from the printed command,
 *     because a session already exports HAPPY_HOME_DIR and HAPPY_RECONNECT_*,
 *     and leaving them in makes the isolated daemon read production settings
 *
 * It deliberately does NOT start a daemon or copy credentials: both are choices
 * the operator should make explicitly. It prints the exact command to run.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_DIR = path.resolve(__dirname, '..');
const PACKAGE_NAME = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')).name;
const IS_WINDOWS = process.platform === 'win32';

// Same reason as install-local.cjs: an inherited npm prefix can redirect
// `npm install -g` back into the workspace and shadow what we meant to build.
const CHILD_ENV = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^npm_config_(?:global_|local_)?prefix$/i.test(key))
);

// Session-scoped variables that must not leak into the isolated daemon. Kept in
// sync with the runbook's `env -u` list.
const INHERITED_SESSION_VARS = [
    'HAPPY_HOME_DIR',
    'HAPPY_SERVER_URL',
    'HAPPY_RECONNECT_SNAPSHOT',
    'HAPPY_RECONNECT_SESSION_ID',
    'HAPPY_RECONNECT_ENCRYPTION_KEY',
    'HAPPY_RECONNECT_ENCRYPTION_VARIANT',
    'HAPPY_APLUS_MCP_CALLER_GRANT',
    'HAPPY_APLUS_MCP_CONFIG_URL',
];

function run(cmd, args, options = {}) {
    const label = [cmd, ...args].join(' ');
    console.log(`\n▶ ${label}`);
    const result = spawnSync(cmd, args, {
        cwd: PACKAGE_DIR,
        stdio: 'inherit',
        env: CHILD_ENV,
        shell: IS_WINDOWS,
        ...options,
    });
    if (result.error) {
        console.error(`Failed to spawn: ${label}`, result.error.message);
        process.exit(1);
    }
    const status = result.status ?? 1;
    if (status !== 0) {
        console.error(`\nExit ${status}: ${label}`);
        process.exit(status);
    }
}

function runPnpm(args) {
    const npmExecPath = process.env.npm_execpath;
    if (npmExecPath && /(?:^|[\\/])pnpm(?:\.c?js)?$/i.test(npmExecPath)) {
        return run(process.execPath, [npmExecPath, ...args]);
    }
    return run('pnpm', args);
}

function packPreparedPackage(preparedDir, outputDir) {
    const result = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', outputDir], {
        cwd: preparedDir,
        encoding: 'utf8',
        env: CHILD_ENV,
        shell: IS_WINDOWS,
    });
    const status = result.status ?? 1;
    if (result.error || status !== 0) {
        console.error('npm pack failed', result.error ? result.error.message : result.stderr);
        process.exit(status || 1);
    }
    const stdout = result.stdout;
    const packed = JSON.parse(stdout.slice(stdout.indexOf('['), stdout.lastIndexOf(']') + 1));
    const filename = packed[0] && packed[0].filename;
    if (!filename) {
        console.error(`npm pack did not return a tarball filename:\n${stdout}`);
        process.exit(1);
    }
    return path.join(outputDir, filename);
}

const root = process.env.HAPPY_CLI_ISOLATED_ROOT
    ? path.resolve(process.env.HAPPY_CLI_ISOLATED_ROOT.replace(/^~/, os.homedir()))
    : path.join(os.homedir(), '.happy-cli-isolated');

const prefix = path.join(root, 'prefix');
const home = path.join(root, 'home');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-cli-isolated-'));
const preparedDir = path.join(tempDir, 'package');

try {
    runPnpm(['--filter', '@slopus/happy-wire', 'run', 'build']);
    runPnpm(['run', 'build']);
    run('node', ['scripts/prepare-publish-package.cjs', '--out', preparedDir]);

    const tarball = packPreparedPackage(preparedDir, tempDir);

    fs.mkdirSync(prefix, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    // Postinstall runs deliberately: it unpacks the bundled tools and chmod +x's
    // node-pty's spawn-helper, which the npm tarball ships without the execute
    // bit. Skipping it (as the runbook's manual steps did) produces an install
    // that starts but cannot spawn a PTY.
    run('npm', ['install', '-g', '--prefix', prefix, tarball]);
} finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
}

const happy = path.join(prefix, 'bin', 'happy');
const scrub = INHERITED_SESSION_VARS.map((name) => `-u ${name}`).join(' ');

console.log(`
✓ Isolated install ready — the global \`happy\` and its daemon were not touched.

  binary : ${happy}
  home   : ${home}

Run it (the \`env -u\` is load-bearing: a session exports HAPPY_HOME_DIR and
HAPPY_RECONNECT_*, and without scrubbing them the isolated daemon reads
production settings and dies on an invalid token):

  env ${scrub} \\
      HAPPY_HOME_DIR="${home}" \\
      "${happy}" daemon start

Authenticate it, or copy an existing credential in:

  cp <authenticated>/access.key "${home}/access.key"

Tear it down (the credential copy is why this matters):

  env ${scrub} HAPPY_HOME_DIR="${home}" "${happy}" daemon stop
  rm -rf "${root}"

Full procedure and the verification patterns it supports:
  docs/runbooks/happy-cli-dev-e2e-verification.md §2
`);
