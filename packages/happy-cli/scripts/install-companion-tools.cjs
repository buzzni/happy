#!/usr/bin/env node

/**
 * Best-effort postinstall step: put the companion CLIs `codex-multi-auth`
 * (npm) and `claude-swap` (uv) in place alongside a global `happy`.
 *
 * BOTH are PINNED, never tracked to latest, because Happy manages both itself
 * and demands exact versions:
 *
 *   codex-multi-auth  aiCredentialRuntime.hasPinnedGlobalCodexMultiAuthPackage
 *                     and codexMultiAuthProxy.startPinnedRuntimeRotationProxy
 *                     read the npm global root and require
 *                     CODEX_MULTI_AUTH_VERSION exactly, else they throw
 *                     CODEX_MULTI_AUTH_VERSION_MISMATCH / "Managed
 *                     codex-multi-auth <v> is not installed".
 *   claude-swap       aiCredentialRuntime.ensureClaudeSwap matches
 *                     `cswap --version` against a regex hard-coded to
 *                     CLAUDE_SWAP_VERSION. The binary is named `cswap`, which
 *                     is why grepping for "claude-swap" alone suggests Happy
 *                     does not use it.
 *
 * Installing `latest` over either one makes Happy reinstall its pinned copy at
 * runtime, and the next Happy update clobbers it again. Pre-installing the
 * pinned versions instead spares that first use the on-demand install.
 * installCompanionTools.test.ts fails if either constant drifts from the
 * source of truth in src/daemon/aiCredentialRuntime.ts.
 *
 * Two conditions gate the normal path:
 *
 *   npm_config_global  Only a global CLI install should reach out and put
 *                      two more binaries on the user's PATH. npm leaves
 *                      this unset for a local dependency install, and so
 *                      does pnpm when it runs this package's postinstall
 *                      during a workspace install of the monorepo.
 *   CI (truthy)        cli-smoke-test.yml and the post-publish check in
 *                      docs/happy-cli-release.md both do a real
 *                      `npm install -g` of this package. Those runs verify
 *                      the artifact and must not start depending on two
 *                      unrelated registries being reachable.
 *
 * `HAPPY_SKIP_COMPANION_TOOLS` opts out regardless. guard-publish-artifact.cjs
 * sets it so its smoke install stays hermetic: it asserts the dependency
 * closure with `npm ls --global --prefix`, which covers everything in that
 * prefix, and codex-multi-auth ships nested packages npm reports as `invalid`
 * — enough to fail the guard and blame Happy's own artifact for it. The same
 * switch lets an image build or an offline install skip the network entirely.
 *
 * Under sudo only the npm half runs — see shouldInstallUvTools below.
 *
 * This never fails the happy install: a missing npm/uv or a failed
 * companion install is reported as a warning and nothing more.
 */

const { spawnSync } = require('node:child_process');

const IS_WINDOWS = process.platform === 'win32';

// Must equal the same-named constants in src/daemon/aiCredentialRuntime.ts.
const CODEX_MULTI_AUTH_VERSION = '2.15.0';
const CLAUDE_SWAP_VERSION = '0.25.0';

// An unbounded child here would hang `npm install -g happy` itself. Matches the
// timeoutMs aiCredentialRuntime uses for these same two install commands — a
// tighter bound would fail on links where Happy's own install would have
// succeeded.
const COMPANION_INSTALL_TIMEOUT_MS = 300_000;

function shouldInstallCompanionTools(env) {
    if (env.HAPPY_SKIP_COMPANION_TOOLS) {
        return false;
    }
    // `CI=false` / `CI=0` is a deliberate "not CI" signal, not a CI marker.
    const inCi = Boolean(env.CI) && env.CI !== '0' && env.CI !== 'false';
    // `npm i -g` sets npm_config_global; `npm i --location=global` sets only
    // npm_config_location, and reading just the first silently skips that user.
    const global = env.npm_config_global === 'true' || env.npm_config_location === 'global';
    return global && !inCi;
}

// sudo resets HOME to root's, and uv installs its tools under HOME — so
// claude-swap would land where the real user cannot reach it. npm needs no
// such check: its global prefix is shared, and it is where happy itself just
// went. Skipping with the command to run is honest; installing into root's
// home and reporting success is not.
function shouldInstallUvTools(env) {
    return !env.SUDO_USER;
}

// The retry hint is meant to be pasted into a shell, and `>=3.12` is a
// redirection there — zsh fails with "3.12 not found", bash silently writes a
// file named `=3.12` and drops the --python value.
function shellQuote(value) {
    return /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function installTool(name, command, args) {
    console.log(`[happy-cli postinstall] ensuring ${name}...`);
    // `shell` on Windows because npm is npm.cmd there, which CreateProcess
    // cannot launch directly. Every argument is a fixed literal.
    const result = spawnSync(command, args, {
        stdio: 'inherit',
        shell: IS_WINDOWS,
        timeout: COMPANION_INSTALL_TIMEOUT_MS,
        killSignal: 'SIGTERM',
    });
    const retry = `${command} ${args.map(shellQuote).join(' ')}`;
    if (result.error && result.error.code === 'ENOENT') {
        console.warn(`[happy-cli postinstall] ${command} is not on PATH — skipping ${name}`);
        return;
    }
    // A timeout leaves status null and signal SIGTERM, so say so rather than
    // reporting a plain failure: the fix is a working network, not a retry.
    if (result.error && result.error.code === 'ETIMEDOUT') {
        console.warn(
            `[happy-cli postinstall] ${name} timed out after ` +
            `${COMPANION_INSTALL_TIMEOUT_MS / 1000}s — skipping (to retry: ${retry})`
        );
        return;
    }
    if (result.error || result.status !== 0) {
        console.warn(
            `[happy-cli postinstall] ${name} failed — skipping (to retry: ${retry})`
        );
    }
}

function main() {
    if (!shouldInstallCompanionTools(process.env)) {
        return;
    }
    const codexMultiAuth = `codex-multi-auth@${CODEX_MULTI_AUTH_VERSION}`;
    installTool(codexMultiAuth, 'npm', ['install', '-g', codexMultiAuth]);
    if (shouldInstallUvTools(process.env)) {
        const claudeSwap = `claude-swap==${CLAUDE_SWAP_VERSION}`;
        // `--python` mirrors ensureClaudeSwap so both resolve the same runtime.
        installTool(claudeSwap, 'uv', ['tool', 'install', claudeSwap, '--python', '>=3.12']);
    } else {
        console.warn(
            '[happy-cli postinstall] running under sudo — skipping claude-swap, which uv ' +
            `would install into root's home. Run as yourself: uv tool install claude-swap==${CLAUDE_SWAP_VERSION}`
        );
    }
}

module.exports = {
    shouldInstallCompanionTools,
    shouldInstallUvTools,
    shellQuote,
    CODEX_MULTI_AUTH_VERSION,
    CLAUDE_SWAP_VERSION,
    COMPANION_INSTALL_TIMEOUT_MS,
};

if (require.main === module) {
    main();
}
