import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBrowserExtensionOffer, writeBrowserExtensionOffer } from './browserLocalSetupStore'

const viewerKey = 'bv1_abcdefghijklmnopqrstuvwxyz012345'
let dir = ''
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

describe('extension offer file', () => {
    it('round-trips an offer in a private file and clears it', async () => {
        dir = await mkdtemp(join(tmpdir(), 'offer-'))
        const file = join(dir, 'nested', 'browser-extension-offer.v1.json')
        expect(await readBrowserExtensionOffer(file)).toBeNull()
        await writeBrowserExtensionOffer(file, { viewerKey, account: 'a@example.com' })
        expect(await readBrowserExtensionOffer(file)).toEqual({ viewerKey, account: 'a@example.com' })
        expect((await stat(file)).mode & 0o777).toBe(0o600)
        await writeBrowserExtensionOffer(file, null)
        expect(await readBrowserExtensionOffer(file)).toBeNull()
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, offer: null })
    })
    it.each([
        ['not json', '{'],
        ['wrong version', JSON.stringify({ version: 2, offer: { viewerKey, account: 'a' } })],
        ['bad key', JSON.stringify({ version: 1, offer: { viewerKey: 'forged', account: 'a' } })],
        ['bad account', JSON.stringify({ version: 1, offer: { viewerKey, account: '' } })],
    ])('treats %s as no offer instead of failing', async (_name, content) => {
        dir = await mkdtemp(join(tmpdir(), 'offer-'))
        const file = join(dir, 'offer.json')
        await writeFile(file, content)
        expect(await readBrowserExtensionOffer(file)).toBeNull()
    })
})
