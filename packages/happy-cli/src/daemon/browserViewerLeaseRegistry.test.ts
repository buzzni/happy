import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
    BrowserViewerLeaseRegistry,
    type BrowserViewerLeaseRecord,
} from './browserViewerLeaseRegistry'

const roots: string[] = []

async function registry() {
    const root = await mkdtemp(join(tmpdir(), 'happy-viewer-leases-'))
    roots.push(root)
    return {
        root,
        filePath: join(root, 'leases.json'),
        value: new BrowserViewerLeaseRegistry(join(root, 'leases.json')),
    }
}

function lease(root: string, viewerKey: string, slot: number): BrowserViewerLeaseRecord {
    return {
        viewerKey,
        slot,
        display: `:${99 + slot}`,
        vncPort: 5900 + slot,
        webPort: 6080 + slot,
        cdpPort: 9222 + slot,
        profileDir: join(root, viewerKey, 'chrome-profile'),
        lastUsedAt: 1000 + slot,
    }
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('BrowserViewerLeaseRegistry', () => {
    it('starts empty when the state file does not exist', async () => {
        const { value } = await registry()

        await expect(value.list()).resolves.toEqual([])
    })

    it('persists leases so a restarted daemon can adopt the same user slot', async () => {
        const { root, value, filePath } = await registry()
        const alice = lease(root, 'bv1_abcdefghijklmnopqrstuvwxyz012345', 0)
        await value.set(alice)

        const restarted = new BrowserViewerLeaseRegistry(filePath)
        await expect(restarted.get(alice.viewerKey)).resolves.toEqual(alice)
    })

    it('updates one viewer without replacing another viewer lease', async () => {
        const { root, value } = await registry()
        const alice = lease(root, 'bv1_abcdefghijklmnopqrstuvwxyz012345', 0)
        const bob = lease(root, 'bv1_abcdefghijklmnopqrstuvwxyz012346', 1)
        await value.set(alice)
        await value.set(bob)
        await value.set({ ...alice, cdpPort: 9230, lastUsedAt: 2000 })

        await expect(value.list()).resolves.toEqual([
            { ...alice, cdpPort: 9230, lastUsedAt: 2000 },
            bob,
        ])
    })

    it('removes only the requested viewer lease', async () => {
        const { root, value } = await registry()
        const alice = lease(root, 'bv1_abcdefghijklmnopqrstuvwxyz012345', 0)
        const bob = lease(root, 'bv1_abcdefghijklmnopqrstuvwxyz012346', 1)
        await value.set(alice)
        await value.set(bob)

        await expect(value.delete(alice.viewerKey)).resolves.toBe(true)
        await expect(value.list()).resolves.toEqual([bob])
    })

    it('drops a persisted lease that points at another profile directory', async () => {
        const { root, value, filePath } = await registry()
        const alice = lease(root, 'bv1_abcdefghijklmnopqrstuvwxyz012345', 0)
        await writeFile(filePath, JSON.stringify({
            version: 1,
            leases: [{ ...alice, profileDir: join(root, 'someone-else', 'chrome-profile') }],
        }))

        await expect(value.list()).resolves.toEqual([])
    })
})
