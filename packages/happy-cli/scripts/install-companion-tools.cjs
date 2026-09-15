#!/usr/bin/env node

/**
 * Best-effort postinstall step: keep the companion CLIs that Happy's auth
 * switching relies on — `codex-multi-auth` (npm) and `claude-swap` (uv) —
 * installed and up to date alongside a global `happy`.
 *
 * Both commands are idempotent and double as the update path: a bare
 * `npm install -g <pkg>` resolves the `latest` dist-tag and replaces an
 * older global copy, and `uv tool install --upgrade` installs when absent
 * and upgrades when outdated.
 *
 * Two conditions gate the work:
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
 * This never fails the happy install: a missing npm/uv or a failed
 * companion install is reported as a warning and nothing more.
 */

const { spawnSync } = require('node:child_process');

const IS_WINDOWS = process.platform === 'win32';

function shouldInstallCompanionTools(env) {
    // `CI=false` / `CI=0` is a deliberate "not CI" signal, not a CI marker.
    const inCi = Boolean(env.CI) && env.CI !== '0' && env.CI !== 'false';
    return env.npm_config_global === 'true' && !inCi;
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
    installTool('codex-multi-auth', 'npm', ['install', '-g', 'codex-multi-auth']);
    installTool('claude-swap', 'uv', ['tool', 'install', '--upgrade', 'claude-swap']);
}

module.exports = { shouldInstallCompanionTools };

if (require.main === module) {
    main();
}
