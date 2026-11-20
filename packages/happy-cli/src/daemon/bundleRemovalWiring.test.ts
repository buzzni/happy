/**
 * Which file the removed-install shutdown watches. run.ts is one large closure, so the wiring is
 * checked in source (the watcher itself is unit-tested in daemonIdentity.test.ts).
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function runSource(): Promise<string> {
    return readFile(fileURLToPath(new URL('./run.ts', import.meta.url)), 'utf8')
}

describe('removed install shutdown wiring', () => {
    it('watches the file sessions are spawned from, so a tsx daemon does not go down when dist/ is gone', async () => {
        const source = await runSource()
        expect(source).toContain('const spawnEntrypoint = resolveHappyCliSpawnCommand([]).entrypoint;')
        expect(source).toContain('createBundleRemovalWatcher(spawnEntrypoint, { graceMs: BUNDLE_REMOVAL_GRACE_MS })')
        expect(source).not.toContain('createBundleRemovalWatcher(bundlePath')
    })
})
