import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { browserSetupHomes, readBrowserBridgeOwnerHome, writeBrowserBridgeOwnerHome } from './browserBridgeOwner'

let userHome = ''
afterEach(async () => { if (userHome) await rm(userHome, { recursive: true, force: true }) })

describe('the daemon home that owns the machine-wide browser bridge', () => {
    it('is recorded next to the bridge token so a native host started by Chrome can find a Desktop-managed daemon', async () => {
        userHome = await mkdtemp(join(tmpdir(), 'bridge-owner-'))
        const desktopHome = join(userHome, 'Library', 'Application Support', 'Saycode', 'machine-links', 'machines', 'abc')
        expect(await readBrowserBridgeOwnerHome(userHome)).toBeNull()
        await writeBrowserBridgeOwnerHome(userHome, desktopHome)
        expect(await readBrowserBridgeOwnerHome(userHome)).toBe(desktopHome)
        expect((await stat(join(userHome, '.happy', 'browser-bridge.owner.json'))).mode & 0o777).toBe(0o600)
    })
    it.each([
        ['not json', '{'],
        ['relative home', JSON.stringify({ version: 1, home: 'relative/path' })],
        ['wrong version', JSON.stringify({ version: 2, home: '/abs' })],
    ])('ignores %s', async (_name, content) => {
        userHome = await mkdtemp(join(tmpdir(), 'bridge-owner-'))
        await mkdir(join(userHome, '.happy'))
        await writeFile(join(userHome, '.happy', 'browser-bridge.owner.json'), content)
        expect(await readBrowserBridgeOwnerHome(userHome)).toBeNull()
    })
    it('asks the bridge owner first, then the documented homes, without duplicates', () => {
        expect(browserSetupHomes({ userHome: '/u', happyHomeDir: '/u/.happy', ownerHome: '/u/Desktop/home' }))
            .toEqual(['/u/Desktop/home', '/u/.happy', '/u/.happy_local', '/u/.happy_local_dev'])
        expect(browserSetupHomes({ userHome: '/u', happyHomeDir: '/u/.happy', ownerHome: '/u/.happy_local' }))
            .toEqual(['/u/.happy_local', '/u/.happy', '/u/.happy_local_dev'])
        expect(browserSetupHomes({ userHome: '/u', happyHomeDir: '/u/.happy', ownerHome: null }))
            .toEqual(['/u/.happy', '/u/.happy_local', '/u/.happy_local_dev'])
    })
})
