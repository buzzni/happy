import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import { expect, it } from 'vitest'
import type { BrowserInstanceId } from './contracts'
import { createCookieImports } from './cookieImports'
import { CdpConnection } from './drivers/cdpConnection'
import { CdpDriver } from './drivers/cdpDriver'
import { personalBrowserArgs } from './personalBrowserProcess'

// An actual macOS Chrome check of ADR-087's assumption: cookies written over CDP into a mock-keychain
// profile are sent to the site, survive a browser restart, and an expired write deletes them.
// Never point it at a user's profile or pass --no-sandbox.
it.skipIf(process.platform !== 'darwin')('imports, keeps and removes site cookies in a real mock-keychain profile', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'abp-cookie-chrome-'))
    const stateDir = await mkdtemp(join(tmpdir(), 'abp-cookie-state-'))
    const site = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<title>Cookies</title><p>cookie=[${req.headers.cookie ?? ''}]</p>`) })
    await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
    const port = (site.address() as { port: number }).port
    const origin = `http://app.example.test:${port}`
    const chrome = process.env.SAYCODE_NATIVE_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    const launch = () => {
        const child = spawn(chrome, ['--headless=new', ...personalBrowserArgs('darwin', profile), '--disable-crash-reporter', '--disable-breakpad',
            '--host-resolver-rules=MAP *.example.test 127.0.0.1, MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
        const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
        const connection = CdpConnection.fromPipe(child.stdio[3] as Writable, child.stdio[4] as Readable, { timeoutMs: 8000 })
        const driver = new CdpDriver({ connectPipe: async () => ({ connection, browserInstanceId: `cookie-${child.pid}` as BrowserInstanceId }) })
        // A clean shutdown flushes the cookie store to disk.
        const stop = async () => { await connection.send('Browser.close').catch(() => undefined); await exited }
        return { child, connection, driver, stop }
    }
    const pageCookie = async (driver: CdpDriver) => {
        const tab = await driver.openTab(`${origin}/`, [origin], { timeoutMs: 5000 })
        const text = JSON.stringify(await driver.observe(tab.tabId, [origin], { timeoutMs: 5000 }))
        await driver.closeTab(tab.tabId, { timeoutMs: 5000 })
        return /cookie=\[([^\]]*)\]/.exec(text)?.[1]
    }
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const source = { browser: 'Google Chrome', profile: 'Default' }
    let browser = launch()
    try {
        await browser.driver.connect()
        const imports = createCookieImports({ stateDir, browser: async () => browser.driver })
        expect(await imports.set({ host: 'app.example.test', source, cookies: [
            { name: 'sid', value: 'domain-cookie', domain: '.example.test', path: '/', secure: false, httpOnly: true, sameSite: 'lax', expiresAt },
            { name: 'pref', value: 'host-only', domain: 'app.example.test', path: '/', secure: false, httpOnly: false, sameSite: 'unspecified', expiresAt },
        ] })).toEqual({ host: 'app.example.test', imported: 2, skipped: 0 })
        expect((await pageCookie(browser.driver))?.split('; ').sort()).toEqual(['pref=host-only', 'sid=domain-cookie'])
        const stored = (await browser.connection.send('Storage.getCookies')).cookies as Array<{ name: string; domain: string }>
        expect(stored.find(cookie => cookie.name === 'pref')?.domain).toBe('app.example.test')

        await browser.stop()
        browser = launch()
        await browser.driver.connect()
        expect((await pageCookie(browser.driver))?.split('; ').sort()).toEqual(['pref=host-only', 'sid=domain-cookie'])

        expect(await imports.remove('app.example.test')).toEqual({ host: 'app.example.test', removed: 2, failed: 0 })
        expect(await pageCookie(browser.driver)).toBe('')
    } finally {
        await browser.stop().catch(() => undefined)
        if (browser.child.exitCode === null && browser.child.signalCode === null) browser.child.kill('SIGKILL')
        await rm(profile, { recursive: true, force: true })
        await rm(stateDir, { recursive: true, force: true })
        await new Promise<void>(resolve => site.close(() => resolve()))
    }
}, 40_000)
