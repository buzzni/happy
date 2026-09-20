/**
 * Vitest global setup — runs ONCE before all tests.
 *
 * We only build the CLI here. Integration suites now provision their own
 * isolated environments so each suite can get a fresh lab-rat project copy.
 */

import { spawnSync } from 'node:child_process'

export async function setup() {
    process.env.VITEST_POOL_TIMEOUT = '60000'
    process.env.HAPPY_RUN_SANDBOX_NETWORK_TESTS = '1'

    const buildResult = spawnSync('pnpm', ['build'], { stdio: 'pipe' })
    const buildStdout = buildResult.stdout ? buildResult.stdout.toString() : ''
    const buildStderr = buildResult.stderr ? buildResult.stderr.toString() : ''
    // The exit code is the only reliable signal. `tsc` writes its diagnostics
    // to stdout and pnpm reports `Exit status 2`, neither of which matches the
    // stderr text this used to look for — so type errors were swallowed and
    // the whole suite ran green against a stale dist (caught by CI 2026-09-20,
    // after two local runs reported a build that had actually failed).
    if (buildResult.status !== 0) {
        throw new Error(
            `Build failed (exit ${buildResult.status}):\n${buildStdout}\n${buildStderr}`,
        )
    }
    if (buildStderr.length > 0) {
        console.error(`Build stderr (could be debugger output): ${buildStderr}`)
    }
}

export async function teardown() {
    // Per-suite integration environments clean themselves up.
}
