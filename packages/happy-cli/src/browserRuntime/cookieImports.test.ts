import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCookieImports, type CdpCookieParam } from './cookieImports'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(reject: (cookie: CdpCookieParam) => boolean = () => false) {
    const stateDir = await mkdtemp(join(tmpdir(), 'abp-cookies-')); cleanups.push(() => rm(stateDir, { recursive: true, force: true }))
    const written: CdpCookieParam[] = []
    let starts = 0
    const imports = createCookieImports({
        stateDir, now: () => 1000,
        browser: async () => {
            starts++
            return { setCookies: async (cookies) => { for (const cookie of cookies) { if (reject(cookie)) throw new Error('Invalid cookie fields'); written.push(cookie) } } }
        },
    })
    return { stateDir, written, imports, starts: () => starts }
}

const session = { name: 'sid', value: 'secret-value', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' as const, expiresAt: 2_000_000_000 }
const source = { browser: 'Google Chrome', profile: 'Default' }

describe('AI browser cookie imports', () => {
    it('writes host-scoped cookies through the browser and records only their keys', async () => {
        const { stateDir, written, imports } = await fixture()
        const hostOnly = { ...session, name: 'csrf', domain: 'app.example.com', secure: false, sameSite: 'unspecified' as const, expiresAt: null }

        expect(await imports.set({ host: 'app.example.com', source, cookies: [session, hostOnly] })).toEqual({ host: 'app.example.com', imported: 2, skipped: 0 })

        expect(written).toEqual([
            { name: 'sid', value: 'secret-value', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: 2_000_000_000 },
            // A host-only cookie is set through a URL so Chrome keeps it host-only.
            { name: 'csrf', value: 'secret-value', url: 'http://app.example.com/', path: '/', secure: false, httpOnly: true },
        ])
        expect(await imports.list()).toEqual([{ host: 'app.example.com', source, importedAtMs: 1000, count: 2 }])
        const record = await readFile(join(stateDir, 'cookie-imports.json'), 'utf8')
        expect(record).not.toContain('secret-value')
        expect((await stat(join(stateDir, 'cookie-imports.json'))).mode & 0o777).toBe(0o600)
    })

    it('refuses cookies the host would never receive and an invalid host', async () => {
        const { written, imports } = await fixture()
        await expect(imports.set({ host: 'app.example.com', source, cookies: [{ ...session, domain: '.other.com' }] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
        await expect(imports.set({ host: 'https://app.example.com', source, cookies: [session] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
        expect(written).toEqual([])
    })

    it('skips a cookie the browser rejects and keeps the rest', async () => {
        const { imports } = await fixture(cookie => cookie.name === 'bad')
        expect(await imports.set({ host: 'example.com', source, cookies: [{ ...session, name: 'bad' }, session] })).toEqual({ host: 'example.com', imported: 1, skipped: 1 })
        expect((await imports.list())[0].count).toBe(1)
    })

    it('reports none imported without recording when the browser takes none', async () => {
        const { imports } = await fixture(() => true)
        expect(await imports.set({ host: 'example.com', source, cookies: [session] })).toEqual({ host: 'example.com', imported: 0, skipped: 1 })
        expect(await imports.list()).toEqual([])
    })

    it('removes what it imported by expiring the recorded keys and forgets the host', async () => {
        const { written, imports } = await fixture()
        await imports.set({ host: 'example.com', source, cookies: [session] })
        written.length = 0

        expect(await imports.remove('example.com')).toEqual({ host: 'example.com', removed: 1, failed: 0 })

        expect(written).toEqual([{ name: 'sid', value: '', domain: '.example.com', path: '/', expires: 1 }])
        expect(await imports.list()).toEqual([])
        await expect(imports.remove('example.com')).rejects.toMatchObject({ code: 'TARGET_GONE' })
    })

    it('keeps the record across restarts and merges a repeated import of the same host', async () => {
        const { stateDir, imports } = await fixture()
        await imports.set({ host: 'example.com', source, cookies: [session] })
        await imports.set({ host: 'example.com', source: { browser: 'Safari', profile: 'Safari' }, cookies: [session, { ...session, name: 'pref' }] })
        const reopened = createCookieImports({ stateDir, now: () => 2000, browser: async () => ({ setCookies: async () => {} }) })
        expect(await reopened.list()).toEqual([{ host: 'example.com', source: { browser: 'Safari', profile: 'Safari' }, importedAtMs: 1000, count: 2 }])
    })

    it('lists without starting the browser', async () => {
        const { imports, starts } = await fixture()
        expect(await imports.list()).toEqual([])
        expect(starts()).toBe(0)
    })
})
