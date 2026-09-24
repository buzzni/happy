/**
 * CdpDriver against a real local Chrome (headless=new, --site-per-process).
 * Sites: a.poc-one.test (A), b.poc-two.test (B), c.poc-three.test (C), each on
 * its own local port; ledgers are server-side so a click counts only if the
 * page really received a trusted input event.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { BrowserRuntimeError, type BrowserInstanceId, type ElementRef, type TabId } from '../contracts'
import { CdpDriver } from './cdpDriver'
import { HIT_SCRIPT, HarnessCdp, decodePng, delay, eventually, findChrome, launchChrome, startSite, type LaunchedChrome, type Site } from './pocTestKit'

const chromePath = findChrome()
if (!chromePath) console.warn('[browser-poc] SKIP cdpDriver suite: no Chrome binary (set CHROME_PATH)')

const OPTS = { timeoutMs: 15_000 }

async function expectCode(promise: Promise<unknown>, code: string): Promise<BrowserRuntimeError> {
    try {
        await promise
    } catch (error) {
        expect(error).toBeInstanceOf(BrowserRuntimeError)
        expect((error as BrowserRuntimeError).code).toBe(code)
        return error as BrowserRuntimeError
    }
    throw new Error(`expected ${code}, but the call succeeded`)
}

describe.skipIf(!chromePath)('CdpDriver (real Chrome)', () => {
    let chrome: LaunchedChrome
    let a: Site
    let b: Site
    let c: Site
    let driver: CdpDriver
    let harness: HarnessCdp
    const instanceId = `bi-${randomUUID()}` as BrowserInstanceId

    beforeAll(async () => {
        chrome = await launchChrome()
        console.info(`[browser-poc] Chrome: ${chrome.version}`)
        ;[a, b, c] = await Promise.all([startSite('a.poc-one.test'), startSite('b.poc-two.test'), startSite('c.poc-three.test')])
        driver = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => instanceId })
        await driver.connect()
        harness = await HarnessCdp.connect(chrome.browserWsUrl)

        a.route('/plain', `<title>Plain A</title><body>Alpha plain page</body>`)
    })

    afterAll(async () => {
        await driver?.close()
        harness?.close()
        await chrome?.stop()
        await Promise.all([a, b, c].filter(Boolean).map((site) => site.close()))
    })

    describe('explicit target', () => {
        it('opens a background target it owns and reports the browser instance', async () => {
            expect(driver.browserInstanceId()).toBe(instanceId)
            const before = await harness.targets()
            const tab = await driver.openTab(a.url('/plain'), [a.origin], OPTS)
            expect(driver.hasTab(tab.tabId)).toBe(true)
            const after = await harness.targets()
            const created = after.find((t) => t.targetId === tab.targetId)
            expect(created?.type).toBe('page')
            expect(created?.url).toBe(a.url('/plain'))
            expect(before.some((t) => t.targetId === tab.targetId)).toBe(false)
            expect(await driver.currentOrigin(tab.tabId)).toBe(a.origin)
            await driver.closeTab(tab.tabId, OPTS)
        })

        it('rejects a TabId it does not own and never falls back to another tab', async () => {
            await expectCode(driver.observe('tab-unknown' as TabId, [a.origin], OPTS), 'TARGET_GONE')
            await expectCode(driver.click('tab-unknown' as TabId, '@e1' as ElementRef, 'snap' as never, OPTS), 'TARGET_GONE')
            expect(driver.hasTab('tab-unknown' as TabId)).toBe(false)
        })
    })
})
