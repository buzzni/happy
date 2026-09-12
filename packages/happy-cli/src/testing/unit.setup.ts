/**
 * Unit-project setup — runs in every worker BEFORE the test file is imported.
 *
 * `configuration` resolves HAPPY_HOME_DIR once, at import time, and freezes the
 * paths. A test that changes the env in `beforeEach` is already too late: anything
 * it imported statically (persistence, logger, …) keeps writing to the developer's
 * real home. On 2026-09-10 such a write put a live vitest pid into the real
 * daemon.state.json and the live daemon shut itself down.
 *
 * So the override is unconditional here — even when the shell already exports a
 * HAPPY_HOME_DIR — and happens before any of that resolution can run. This must
 * stay a `setupFiles` entry, not `globalSetup`: globalSetup runs in a separate
 * process and its env never reaches the workers.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const isolatedHome = mkdtempSync(join(tmpdir(), 'happy-unit-home-'))
process.env.HAPPY_HOME_DIR = isolatedHome

afterAll(() => {
    rmSync(isolatedHome, { recursive: true, force: true })
})
