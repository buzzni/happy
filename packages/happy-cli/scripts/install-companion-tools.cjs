#!/usr/bin/env node

/**
 * Best-effort postinstall step: put the companion CLIs `codex-multi-auth`
 * (npm) and `claude-swap` (uv) in place alongside a global `happy`.
 *
 * codex-multi-auth is PINNED, not tracked to latest. Happy resolves this exact
 * version out of the npm global root — see CODEX_MULTI_AUTH_VERSION in
 * src/daemon/aiCredentialRuntime.ts and src/codex/codexMultiAuthProxy.ts —
 * and installing `latest` over it makes those paths throw
 * CODEX_MULTI_AUTH_VERSION_MISMATCH / "Managed codex-multi-auth <v> is not
 * installed". Pre-installing the pinned version instead spares the first
 * codex multi-auth use the on-demand install Happy would otherwise run.
 * installCompanionTools.test.ts fails if this constant drifts from the source.
 *
 * claude-swap has no such coupling — nothing in Happy resolves it — so it
 * tracks latest: `uv tool install --upgrade` installs when absent and
 * upgrades when outdated.
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

// Must equal CODEX_MULTI_AUTH_VERSION in src/daemon/aiCredentialRuntime.ts.
const CODEX_MULTI_AUTH_VERSION = '2.8.5';

function shouldInstallCompanionTools(env) {
    if (env.HAPPY_SKIP_COMPANION_TOOLS) {
        return false;
    }
    // `CI=false` / `CI=0` is a deliberate "not CI" signal, not a CI marker.
    const inCi = Boolean(env.CI) && env.CI !== '0' && env.CI !== 'false';
    return env.npm_config_global === 'true' && !inCi;
}

// sudo resets HOME to root's, and uv installs its tools under HOME — so
// claude-swap would land where the real user cannot reach it. npm needs no
// such check: its global prefix is shared, and it is where happy itself just
// went. Skipping with the command to run is honest; installing into root's
// home and reporting success is not.
function shouldInstallUvTools(env) {
    return !env.SUDO_USER;
}

function installTool(name, command, args) {
    console.log(`[happy-cli postinstall] installing/updating ${name}...`);
    // `shell` on Windows because npm is npm.cmd there, which CreateProcess
    // cannot launch directly. Every argument is a fixed literal.
    const result = spawnSync(command, args, { stdio: 'inherit', shell: IS_WINDOWS });
    if (result.error && result.error.code === 'ENOENT') {
        console.warn(`[happy-cli postinstall] ${command} is not on PATH — skipping ${name}`);
        return;
    }
    if (result.error || result.status !== 0) {
        console.warn(
            `[happy-cli postinstall] ${name} failed — skipping ` +
            `(to retry: ${command} ${args.join(' ')})`
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
        installTool('claude-swap', 'uv', ['tool', 'install', '--upgrade', 'claude-swap']);
    } else {
        console.warn(
            '[happy-cli postinstall] running under sudo — skipping claude-swap, which uv ' +
            "would install into root's home. Run as yourself: uv tool install --upgrade claude-swap"
        );
    }
}

module.exports = { shouldInstallCompanionTools, shouldInstallUvTools, CODEX_MULTI_AUTH_VERSION };

if (require.main === module) {
    main();
}
