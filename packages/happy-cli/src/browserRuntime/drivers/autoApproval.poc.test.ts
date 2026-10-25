/** Real DOM evidence and the last input fence used by task Auto. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserRuntimeError, type BrowserInstanceId, type ElementDescription } from '../contracts'
import { CdpDriver } from './cdpDriver'
import { HarnessCdp, eventually, findChrome, launchChrome, startSite, type LaunchedChrome, type Site } from './pocTestKit'

const opts = { timeoutMs: 10_000 }
const expectation = (e: ElementDescription) => ({ role: e.currentRole!, name: e.currentName!, uiAction: e.uiAction })

describe.skipIf(!findChrome())('Auto input evidence (real Chrome)', () => {
    let chrome: LaunchedChrome, site: Site, driver: CdpDriver, harness: HarnessCdp
    beforeAll(async () => {
        chrome = await launchChrome()
        site = await startSite('a.poc-one.test')
        site.route('/ui', `<body>
            <details><summary>Show filters</summary><p>Filter options</p></details>
            <button id="menu" aria-expanded="false" aria-controls="panel">Show menu</button><div id="panel">Menu panel</div>
            <div role="tablist"><button role="tab" aria-controls="tab-panel">Overview</button></div><div id="tab-panel" role="tabpanel">Overview panel</div>
            <button>Unknown action</button>
            <form><button aria-expanded="false" aria-controls="panel">Form disclosure</button></form>
            <script>document.getElementById('menu').onclick=()=>fetch('/hit/menu')</script></body>`)
        site.route('/hover', `<body><button id="menu" style="margin:40px;width:160px;height:40px" aria-expanded="false" aria-controls="panel" onclick="fetch('/hit/unsafe')">Show menu</button><div id="panel">Menu</div>
            <script>document.addEventListener('pointermove',()=>document.getElementById('menu').removeAttribute('aria-controls'),{once:true})</script></body>`)
        driver = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => 'browser-auto-test' as BrowserInstanceId })
        await driver.connect()
        harness = await HarnessCdp.connect(chrome.browserWsUrl)
    })
    afterAll(async () => { await driver?.close(); harness?.close(); await chrome?.stop(); await site?.close() })

    it('derives disclosure/tab evidence from DOM and leaves ordinary/form buttons unknown', async () => {
        const tab = await driver.openTab(site.url('/ui'), [site.origin], opts)
        try {
            const observation = await driver.observe(tab.tabId, [site.origin], opts)
            const descriptions = await Promise.all(observation.elements.map(e => driver.describeRef(tab.tabId, e.ref, observation.snapshotId, opts)))
            expect(descriptions.find(e => e.name === 'Show filters')?.uiAction).toBe('disclosure')
            expect(descriptions.find(e => e.name === 'Overview')?.uiAction).toBe('tab')
            expect(descriptions.find(e => e.name === 'Unknown action')?.uiAction).toBeUndefined()
            expect(descriptions.find(e => e.name === 'Form disclosure')?.uiAction).toBeUndefined()
            const summary = descriptions.find(e => e.name === 'Show filters')!
            await driver.click(tab.tabId, summary.ref, observation.snapshotId, { ...opts, expect: expectation(summary) })
            expect(await harness.evaluate(tab.targetId, 'document.querySelector("details").open')).toBe(true)
        } finally { await driver.closeTab(tab.tabId, opts) }
    })

    it('rejects UI evidence removed on hover before sending a click', async () => {
        const tab = await driver.openTab(site.url('/hover'), [site.origin], opts)
        try {
            const observation = await driver.observe(tab.tabId, [site.origin], opts)
            const ref = observation.elements.find(e => e.name === 'Show menu')!.ref
            const description = await driver.describeRef(tab.tabId, ref, observation.snapshotId, opts)
            expect(description.uiAction).toBe('disclosure')
            await expect(driver.click(tab.tabId, ref, observation.snapshotId, { ...opts, expect: expectation(description) })).rejects.toMatchObject({ code: 'STALE_REF', mayHaveSideEffects: false })
            expect(site.hits('unsafe')).toBe(0)
        } finally { await driver.closeTab(tab.tabId, opts) }
    })

    it('checks current consent at the final input boundary', async () => {
        const tab = await driver.openTab(site.url('/ui'), [site.origin], opts)
        try {
            const observation = await driver.observe(tab.tabId, [site.origin], opts)
            const ref = observation.elements.find(e => e.name === 'Show menu')!.ref
            const description = await driver.describeRef(tab.tabId, ref, observation.snapshotId, opts)
            await expect(driver.click(tab.tabId, ref, observation.snapshotId, { ...opts, expect: expectation(description),
                validateDispatch: () => { throw new BrowserRuntimeError('APPROVAL_REQUIRED', 'Auto revoked') } })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED', mayHaveSideEffects: false })
            expect(site.hits('menu')).toBe(0)
        } finally { await driver.closeTab(tab.tabId, opts) }
    })
    it('does not impose Auto evidence on a manually authorized click', async () => {
        const tab = await driver.openTab(site.url('/hover'), [site.origin], opts)
        try {
            const observation = await driver.observe(tab.tabId, [site.origin], opts)
            const ref = observation.elements.find(e => e.name === 'Show menu')!.ref
            const description = await driver.describeRef(tab.tabId, ref, observation.snapshotId, opts)
            // Manual approval binds the existing label/link/form contract, not Auto's extra proof.
            await driver.click(tab.tabId, ref, observation.snapshotId, { ...opts,
                expect: { role: description.currentRole!, name: description.currentName! } })
            expect(await eventually(() => site.hits('unsafe'), hits => hits === 1)).toBe(1)
        } finally { await driver.closeTab(tab.tabId, opts) }
    })

})
