/**
 * CdpDriver against a real local Chrome (headless=new, --site-per-process).
 * Sites: a.poc-one.test (A), b.poc-two.test (B), c.poc-three.test (C), each on
 * its own local port; ledgers are server-side so a click counts only if the
 * page really received a trusted input event.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { BrowserRuntimeError, type BrowserInstanceId, type ElementRef, type Observation, type TabId } from '../contracts'
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
        c.route('/plain', `<title>Plain C</title><body>Charlie page</body>`)
        b.route('/frame', `${HIT_SCRIPT}<body style="margin:0"><p>Bravo frame canary-b-7788</p><button onclick="hit('b-buy')">Buy</button></body>`)
        a.route('/inner', `${HIT_SCRIPT}<body><button onclick="hit('inner')">Inner</button></body>`)
        a.route('/oopif', () => `<title>OOPIF A</title>${HIT_SCRIPT}<body style="margin:0">
            <p>Alpha visible text</p>
            <button onclick="hit('a-buy')">Buy</button>
            <div id="host"></div>
            <script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML = '<button onclick="hit(\\'a-shadow\\')">Shadow Buy</button>'</script>
            <button style="display:none" onclick="hit('a-hidden')">Hidden</button>
            <button disabled onclick="hit('a-disabled')">Disabled</button>
            <label>Password <input type="password" id="pw"></label>
            <script>document.getElementById('pw').value = 'synthetic-pass-canary-123'</script>
            <iframe id="fb" src="${b.url('/frame')}" style="width:400px;height:150px;border:0"></iframe>
        </body>`)
        a.route('/frames', () => `${HIT_SCRIPT}<body><iframe id="same" src="${a.url('/inner')}"></iframe><iframe id="cross" src="${b.url('/frame')}"></iframe></body>`)
        a.route('/spa', `${HIT_SCRIPT}<body style="margin:0"><div id="slot"><button id="pay" style="position:absolute;left:20px;top:20px;width:120px;height:40px" onclick="hit('pay')">Pay</button></div>
            <script>window.swap = () => {
                document.getElementById('pay').remove()
                const d = document.createElement('button')
                d.textContent = 'Pay'
                d.style.cssText = 'position:absolute;left:20px;top:20px;width:120px;height:40px'
                d.onclick = () => hit('decoy')
                document.getElementById('slot').appendChild(d)
            }</script></body>`)
        a.route('/spa-hover', `${HIT_SCRIPT}<body style="margin:0"><div id="slot"><button id="pay" style="position:absolute;left:20px;top:20px;width:120px;height:40px" onclick="hit('pay')">Pay</button></div>
            <script>document.addEventListener('pointermove', () => {
                const old = document.getElementById('pay'); if (!old) return
                old.remove()
                const d = document.createElement('button')
                d.textContent = 'Pay'
                d.style.cssText = 'position:absolute;left:20px;top:20px;width:120px;height:40px'
                d.onclick = () => hit('decoy')
                document.getElementById('slot').appendChild(d)
            }, { once: true })</script></body>`)
        a.route('/pay-form', `${HIT_SCRIPT}<body><form action="/submit-order" onsubmit="event.preventDefault(); hit('submit')"><label>Amount <input name="amount" value="10"></label><label>Secret <input type="password" name="pw" value="synthetic-pw"></label><button id="go">Confirm payment</button></form></body>`)
        a.route('/dialogs', `${HIT_SCRIPT}<body><button onclick="alert('hello'); hit('after-alert')">Alert</button><button onclick="hit(confirm('sure?') ? 'confirmed' : 'declined')">Confirm</button></body>`)
        a.route('/focus-thief', `<body><label>Code <input id="code" onfocus="document.getElementById('other').focus()"></label><label>Other <input id="other"></label></body>`)
        a.route('/slow-load', `<body>slow<script>const until = Date.now() + 4000; while (Date.now() < until) {}</script></body>`)
        a.route('/reload-loop', `<body>reloading<script>setTimeout(() => location.reload(), 150)</script></body>`)
        for (const [name, color] of [['red', '#ff0000'], ['green', '#00ff00'], ['blue', '#0000ff']]) {
            a.route(`/color/${name}`, `<body style="margin:0;background:${color};height:100vh"></body>`)
        }
        a.route('/redirect-to-c', () => ({ status: 302, headers: { location: c.url('/plain') } }))
        a.route('/popup', () => `<body><button onclick="window.open('${c.url('/plain')}', '_blank')">Open C</button><button onclick="window.open('${a.url('/plain')}', '_blank')">Open A</button></body>`)
        a.route('/later', `<body><p>Waiting</p><script>setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<p>Arrived later</p>'); history.pushState({}, '', '/later/done') }, 400)</script></body>`)
        a.route('/reveal', `${HIT_SCRIPT}<body><button id="r" style="visibility:hidden" onclick="hit('reveal')">Reveal</button><script>setTimeout(() => { document.getElementById('r').style.visibility = 'visible' }, 300)</script></body>`)
        a.route('/form', `${HIT_SCRIPT}<body><input id="name" aria-label="Name" value="old"><button onclick="hit('v-' + encodeURIComponent(document.getElementById('name').value))">Send</button></body>`)
        a.route('/beforeunload', `${HIT_SCRIPT}<body><script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = '' })</script><button onclick="hit('bu')">Touch</button></body>`)
        a.route('/many', `<body>${Array.from({ length: 5 }, (_, i) => `<button>First ${i}</button>`).join('')}
            <section aria-label="Second list">${Array.from({ length: 30 }, (_, i) => `<button>Second ${i}</button>`).join('')}</section></body>`)
    })

    const opened: TabId[] = []
    async function open(path: string, origins: string[]) {
        const tab = await driver.openTab(a.url(path), origins, OPTS)
        opened.push(tab.tabId)
        return tab
    }
    function refOf(obs: Observation, name: string, origin?: string): ElementRef {
        const found = obs.elements.filter((e) => e.name === name && (!origin || e.frameOrigin === origin))
        expect(found, `exactly one element named ${name}`).toHaveLength(1)
        return found[0].ref
    }

    beforeEach(() => {
        for (const site of [a, b, c]) site.resetHits()
    })

    afterEach(async () => {
        for (const tabId of opened.splice(0)) {
            if (driver.hasTab(tabId)) await driver.closeTab(tabId, OPTS).catch(() => undefined)
        }
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

    describe('agent window cap', () => {
        it('gives each owned tab its own window and refuses a tab beyond maxAgentWindows before creating any target', async () => {
            const capped = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => instanceId, maxAgentWindows: 2 })
            await capped.connect()
            try {
                const first = await capped.openTab(a.url('/plain'), [a.origin], OPTS)
                const second = await capped.openTab(a.url('/plain'), [a.origin], OPTS)
                const windowOf = async (targetId: string) => (await harness.conn.send('Browser.getWindowForTarget', { targetId })).windowId as number
                expect(await windowOf(first.targetId)).not.toBe(await windowOf(second.targetId))
                const before = (await harness.targets()).length
                const refused = await expectCode(capped.openTab(a.url('/plain'), [a.origin], OPTS), 'QUOTA_EXCEEDED')
                expect(refused.mayHaveSideEffects).toBe(false)
                expect((await harness.targets()).length).toBe(before)
                await capped.closeTab(first.tabId, OPTS)
                const third = await capped.openTab(a.url('/plain'), [a.origin], OPTS)
                expect(capped.debugCounts().tabs).toBe(2)
                await capped.closeTab(second.tabId, OPTS)
                await capped.closeTab(third.tabId, OPTS)
            } finally {
                await capped.close()
            }
        })

        it('counts opens that are still in flight, so concurrent opens never exceed the cap', async () => {
            const capped = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => instanceId, maxAgentWindows: 2 })
            await capped.connect()
            try {
                const results = await Promise.allSettled([0, 1, 2, 3].map(() => capped.openTab(a.url('/plain'), [a.origin], OPTS)))
                const opened = results.filter((r) => r.status === 'fulfilled')
                const refused = results.filter((r) => r.status === 'rejected' && (r.reason as BrowserRuntimeError).code === 'QUOTA_EXCEEDED')
                expect(opened).toHaveLength(2)
                expect(refused).toHaveLength(2)
                for (const r of opened) await capped.closeTab((r as PromiseFulfilledResult<{ tabId: TabId }>).value.tabId, OPTS)
                // A failed open releases its slot too.
                await expectCode(capped.openTab('http://unlisted.invalid/', [a.origin], OPTS), 'ORIGIN_DENIED')
                const again = await Promise.all([0, 1].map(() => capped.openTab(a.url('/plain'), [a.origin], OPTS)))
                for (const tab of again) await capped.closeTab(tab.tabId, OPTS)
            } finally {
                await capped.close()
            }
        })
    })

    describe('OOPIF and snapshot', () => {
        it('attaches the cross-site iframe as a separate child target and observes both frames', async () => {
            const tab = await open('/oopif', [a.origin, b.origin])
            const targets = await harness.targets()
            const child = targets.find((t) => t.type === 'iframe' && t.url === b.url('/frame'))
            expect(child, 'real OOPIF child target').toBeDefined()
            console.info(`[browser-poc] OOPIF child target observed: ${!!child}`)

            const obs = await driver.observe(tab.tabId, [a.origin, b.origin], OPTS)
            const frameB = obs.frames.find((f) => f.origin === b.origin)
            expect(frameB).toMatchObject({ allowed: true, outOfProcess: true })
            expect(frameB?.text).toContain('Bravo frame')
            expect(obs.frames[0]).toMatchObject({ origin: a.origin, allowed: true, outOfProcess: false })
            const buyA = refOf(obs, 'Buy', a.origin)
            const buyB = refOf(obs, 'Buy', b.origin)
            expect(buyA).not.toBe(buyB)
            expect(buyB).toMatch(/^@f\d+:e\d+$/)
            expect(obs.elements.find((e) => e.name === 'Shadow Buy')).toBeDefined()
            expect(obs.elements.find((e) => e.name === 'Hidden')).toMatchObject({ visible: false })
            expect(obs.elements.find((e) => e.name === 'Disabled')).toMatchObject({ disabled: true })
            const password = obs.elements.find((e) => e.name === 'Password')
            expect(password).toBeDefined()
            expect(password?.value).toBeUndefined()
            expect(JSON.stringify(obs)).not.toContain('synthetic-pass-canary')
        })

        it('returns no text or refs from a frame whose origin is not allowed', async () => {
            const tab = await open('/oopif', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            const frameB = obs.frames.find((f) => f.origin === b.origin)
            expect(frameB).toMatchObject({ allowed: false })
            expect(frameB?.text).toBeUndefined()
            expect(obs.elements.every((e) => e.frameOrigin === a.origin)).toBe(true)
            const serialized = JSON.stringify(obs)
            expect(serialized).not.toContain('canary-b-7788')
            expect(serialized).not.toContain('Bravo')
        })

        it('truncates at the element budget and can observe a subtree via scopeRef', async () => {
            const tab = await open('/many', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], { ...OPTS, maxElements: 8 })
            expect(obs.truncated).toBe(true)
            expect(obs.elements).toHaveLength(8)
            const section = refOf(obs, 'Second list')
            const scoped = await driver.observe(tab.tabId, [a.origin], { ...OPTS, scopeRef: section, maxElements: 100 })
            expect(scoped.truncated).toBe(false)
            expect(scoped.elements).toHaveLength(30)
            expect(scoped.elements.every((e) => e.name.startsWith('Second '))).toBe(true)
        })
    })

    describe('trusted input', () => {
        it('clicks only the addressed frame when two frames have a same-label button', async () => {
            const tab = await open('/oopif', [a.origin, b.origin])
            const obs = await driver.observe(tab.tabId, [a.origin, b.origin], OPTS)
            await driver.click(tab.tabId, refOf(obs, 'Buy', b.origin), obs.snapshotId, OPTS)
            expect(await eventually(() => b.hits('b-buy'), (n) => n === 1)).toBe(1)
            await driver.click(tab.tabId, refOf(obs, 'Buy', a.origin), obs.snapshotId, OPTS)
            expect(await eventually(() => a.hits('a-buy'), (n) => n === 1)).toBe(1)
            await driver.click(tab.tabId, refOf(obs, 'Shadow Buy'), obs.snapshotId, OPTS)
            expect(await eventually(() => a.hits('a-shadow'), (n) => n === 1)).toBe(1)
            await delay(200)
            expect(b.hits('b-buy')).toBe(1)
            expect(a.hits('a-buy')).toBe(1)
        })

        it('refuses hidden and disabled elements without dispatching', async () => {
            const tab = await open('/oopif', [a.origin, b.origin])
            const obs = await driver.observe(tab.tabId, [a.origin, b.origin], OPTS)
            await expectCode(driver.click(tab.tabId, refOf(obs, 'Hidden'), obs.snapshotId, OPTS), 'INVALID_REQUEST')
            await expectCode(driver.click(tab.tabId, refOf(obs, 'Disabled'), obs.snapshotId, OPTS), 'INVALID_REQUEST')
            await delay(200)
            expect(a.hits('a-hidden')).toBe(0)
            expect(a.hits('a-disabled')).toBe(0)
        })

        it('fills a text field with trusted input, replacing its value', async () => {
            const tab = await open('/form', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            await driver.fill(tab.tabId, refOf(obs, 'Name'), obs.snapshotId, 'Neo', OPTS)
            await driver.click(tab.tabId, refOf(obs, 'Send'), obs.snapshotId, OPTS)
            expect(await eventually(() => a.hits('v-Neo'), (n) => n === 1)).toBe(1)
            expect(a.hits('v-old')).toBe(0)
        })
    })

    describe('closeTab during a reload', () => {
        it('closes a tab that is reloading itself (20x) and leaves no registrations', async () => {
            const before = driver.debugCounts()
            for (let i = 0; i < 20; i++) {
                const tab = await driver.openTab(a.url('/reload-loop'), [a.origin], OPTS)
                await delay(100 + (i % 5) * 20)
                expect(await driver.closeTab(tab.tabId, OPTS)).toEqual({ closed: true })
            }
            expect(driver.debugCounts()).toEqual(before)
        })
    })

    describe('openTab timeout', () => {
        it('discards the half-opened target when the caller already gave up (no leaked owned tab)', async () => {
            const before = driver.debugCounts()
            await expectCode(driver.openTab(a.url('/slow-load'), [a.origin], { timeoutMs: 1_000 }), 'OUTCOME_UNKNOWN')
            // Even after the page finally loads, nothing is left registered.
            await delay(5_000)
            expect(driver.debugCounts()).toEqual(before)
        })
    })

    describe('fill focus', () => {
        it('refuses to type when the page moves focus away from the target', async () => {
            const tab = await open('/focus-thief', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            const error = await expectCode(driver.fill(tab.tabId, refOf(obs, 'Code'), obs.snapshotId, 'secret-otp', OPTS), 'INVALID_REQUEST')
            expect(error.mayHaveSideEffects).toBe(false)
            expect(await harness.evaluate(tab.targetId, "document.getElementById('other').value")).toBe('')
        })
    })

    describe('javascript dialogs', () => {
        it('dismisses alert/confirm opened by an agent click instead of freezing the tab, and never accepts on the user\'s behalf', async () => {
            const tab = await open('/dialogs', [a.origin])
            let obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            await driver.click(tab.tabId, refOf(obs, 'Alert'), obs.snapshotId, { timeoutMs: 5_000 })
            expect(await eventually(() => a.hits('after-alert'), (n) => n === 1)).toBe(1)
            obs = await driver.observe(tab.tabId, [a.origin], { timeoutMs: 5_000 })
            await driver.click(tab.tabId, refOf(obs, 'Confirm'), obs.snapshotId, { timeoutMs: 5_000 })
            expect(await eventually(() => a.hits('declined'), (n) => n === 1)).toBe(1)
            expect(a.hits('confirmed')).toBe(0)
            expect(driver.dialogReports().filter((report) => report.tabId === tab.tabId).map((report) => report.type)).toEqual(['alert', 'confirm'])
        })
    })

    describe('describeRef', () => {
        it('describes the element of the agent snapshot with live form values, without superseding that snapshot', async () => {
            const tab = await open('/pay-form', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            const confirm = refOf(obs, 'Confirm payment')
            await harness.evaluate(tab.targetId, "document.querySelector('[name=amount]').value = '999'")
            const described = await driver.describeRef(tab.tabId, confirm, obs.snapshotId, OPTS)
            expect(described).toMatchObject({ name: 'Confirm payment', frameOrigin: a.origin, formValues: { amount: '999' } })
            expect(described.formAction).toBe(a.url('/submit-order'))
            expect(described.formValues).not.toHaveProperty('pw')
            // The agent's snapshot is still the current one: its ref can be clicked.
            await driver.click(tab.tabId, confirm, obs.snapshotId, OPTS)
            expect(await eventually(() => a.hits('submit'), (n) => n === 1)).toBe(1)
        })

        it('restores a ref from its persisted identity on a new driver (Runtime-only restart) only while the document is unchanged', async () => {
            const tab = await open('/pay-form', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            const confirm = refOf(obs, 'Confirm payment')
            const described = await driver.describeRef(tab.tabId, confirm, obs.snapshotId, OPTS)
            expect(Buffer.from(described.identity, 'base64url').toString()).not.toContain('Confirm payment')
            const restarted = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => instanceId })
            try {
                await restarted.connect()
                expect(await restarted.adoptTab(tab.tabId, tab.targetId, [a.origin], OPTS)).toBe(true)
                expect(await restarted.restoreRef(tab.tabId, obs.snapshotId, confirm, described.identity, OPTS)).toBe('restored')
                const again = await restarted.describeRef(tab.tabId, confirm, obs.snapshotId, OPTS)
                expect(again.documentGeneration).toBe(described.documentGeneration)
                expect(again.formValues).toEqual(described.formValues)
                // A reload is a new document: the persisted identity no longer binds.
                await harness.evaluate(tab.targetId, 'location.reload()')
                await delay(1_000)
                const fresh = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => instanceId })
                await fresh.connect()
                try {
                    expect(await fresh.adoptTab(tab.tabId, tab.targetId, [a.origin], OPTS)).toBe(true)
                    expect(await fresh.restoreRef(tab.tabId, obs.snapshotId, confirm, described.identity, OPTS)).toBe('gone')
                } finally {
                    await fresh.close()
                }
            } finally {
                await restarted.close()
                await driver.closeTab(tab.tabId, OPTS)
            }
        })

        it('fails with STALE_REF when the node behind the ref was replaced', async () => {
            const tab = await open('/spa', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            await harness.evaluate(tab.targetId, 'swap()')
            await expectCode(driver.describeRef(tab.tabId, refOf(obs, 'Pay'), obs.snapshotId, OPTS), 'STALE_REF')
        })
    })

    describe('stale refs', () => {
        it('rejects a ref whose node was replaced by a same-position decoy (10x, decoy clicks 0)', async () => {
            const tab = await open('/spa', [a.origin])
            for (let i = 0; i < 10; i++) {
                await driver.navigate(tab.tabId, a.url('/spa'), [a.origin], OPTS)
                const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
                const pay = refOf(obs, 'Pay')
                await harness.evaluate(tab.targetId, 'swap()')
                await expectCode(driver.click(tab.tabId, pay, obs.snapshotId, OPTS), 'STALE_REF')
            }
            await delay(200)
            expect(a.hits('decoy')).toBe(0)
            expect(a.hits('pay')).toBe(0)
            // A fresh observe sees the new button; clicking it is legitimate.
            const fresh = await driver.observe(tab.tabId, [a.origin], OPTS)
            await driver.click(tab.tabId, refOf(fresh, 'Pay'), fresh.snapshotId, OPTS)
            expect(await eventually(() => a.hits('decoy'), (n) => n === 1)).toBe(1)
        })

        it('re-verifies the target after the pointer arrives, so a hover-triggered swap is never clicked', async () => {
            const tab = await open('/spa-hover', [a.origin])
            for (let i = 0; i < 5; i++) {
                await driver.navigate(tab.tabId, a.url('/spa-hover'), [a.origin], OPTS)
                const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
                const error = await expectCode(driver.click(tab.tabId, refOf(obs, 'Pay'), obs.snapshotId, OPTS), 'STALE_REF')
                // Only a hover was sent; no press reached the page.
                expect(error.mayHaveSideEffects).toBe(false)
            }
            await delay(200)
            expect(a.hits('decoy')).toBe(0)
            expect(a.hits('pay')).toBe(0)
        })

        it('rejects refs after navigation and after a newer snapshot', async () => {
            const tab = await open('/spa', [a.origin])
            const first = await driver.observe(tab.tabId, [a.origin], OPTS)
            const second = await driver.observe(tab.tabId, [a.origin], OPTS)
            await expectCode(driver.click(tab.tabId, refOf(first, 'Pay'), first.snapshotId, OPTS), 'STALE_REF')
            await driver.navigate(tab.tabId, a.url('/spa'), [a.origin], OPTS)
            await expectCode(driver.click(tab.tabId, refOf(second, 'Pay'), second.snapshotId, OPTS), 'STALE_REF')
            await delay(200)
            expect(a.hits('pay')).toBe(0)
        })

        it('rejects refs into an iframe that was detached and re-attached (same-process and OOPIF)', async () => {
            const origins = [a.origin, b.origin]
            const tab = await open('/frames', origins)
            const obs = await driver.observe(tab.tabId, origins, OPTS)
            expect(obs.frames.find((f) => f.origin === b.origin)?.outOfProcess).toBe(true)
            const inner = refOf(obs, 'Inner')
            const buyB = refOf(obs, 'Buy', b.origin)
            const reattach = (id: string) => harness.evaluate(tab.targetId, `new Promise((resolve) => {
                const old = document.getElementById('${id}'); const src = old.src; old.remove()
                const f = document.createElement('iframe'); f.id = '${id}'; f.onload = () => resolve(1); f.src = src; document.body.appendChild(f)
            })`)
            await reattach('same')
            await reattach('cross')
            await expectCode(driver.click(tab.tabId, inner, obs.snapshotId, OPTS), 'STALE_REF')
            await expectCode(driver.click(tab.tabId, buyB, obs.snapshotId, OPTS), 'STALE_REF')
            await delay(200)
            expect(a.hits('inner')).toBe(0)
            expect(b.hits('b-buy')).toBe(0)
        })
    })

    describe('target screenshot', () => {
        it('captures the addressed background tab, not the tab in front (10x)', async () => {
            const red = await open('/color/red', [a.origin])
            const green = await open('/color/green', [a.origin])
            const front = await harness.openFrontTab(a.url('/color/blue'))
            try {
                for (let i = 0; i < 10; i++) {
                    for (const [tab, rgb] of [[red, [255, 0, 0]], [green, [0, 255, 0]]] as const) {
                        const shot = await driver.screenshot(tab.tabId, [a.origin], OPTS)
                        expect(shot.targetId).toBe(tab.targetId)
                        expect(shot.mimeType).toBe('image/png')
                        const png = decodePng(shot.data)
                        const [r, g, bl] = png.pixel(10, 10)
                        expect([r, g, bl]).toEqual(rgb)
                    }
                }
            } finally {
                await harness.closeTarget(front)
            }
        })

        it('returns ORIGIN_DENIED when any frame origin is not allowed, and an image when all are', async () => {
            const tab = await open('/oopif', [a.origin, b.origin])
            await expectCode(driver.screenshot(tab.tabId, [a.origin], OPTS), 'ORIGIN_DENIED')
            const shot = await driver.screenshot(tab.tabId, [a.origin, b.origin], OPTS)
            expect(decodePng(shot.data).width).toBeGreaterThan(0)
        })

        it('discards the image when the frame tree changes during capture', async () => {
            let targetId = ''
            const hooked = new CdpDriver({
                browserWsUrl: chrome.browserWsUrl,
                browserInstanceIdProvider: async () => instanceId,
                testHooks: {
                    afterCapture: async () => {
                        await harness.evaluate(targetId, `new Promise((resolve) => { const f = document.getElementById('fb'); f.onload = () => resolve(1); f.src = f.src.split('?')[0] + '?n=' + Date.now() })`)
                    },
                },
            })
            await hooked.connect()
            try {
                const tab = await hooked.openTab(a.url('/oopif'), [a.origin, b.origin], OPTS)
                targetId = tab.targetId
                const error = await expectCode(hooked.screenshot(tab.tabId, [a.origin, b.origin], OPTS), 'ORIGIN_DENIED')
                expect(error.retryable).toBe(true)
                await hooked.closeTab(tab.tabId, OPTS)
            } finally {
                await hooked.close()
            }
        })
    })

    describe('navigation origin checks and popups', () => {
        it('refuses to open a disallowed origin or a redirect to one, leaving no owned tab', async () => {
            const before = driver.debugCounts()
            await expectCode(driver.openTab(c.url('/plain'), [a.origin], OPTS), 'ORIGIN_DENIED')
            await expectCode(driver.openTab(a.url('/redirect-to-c'), [a.origin], OPTS), 'ORIGIN_DENIED')
            expect(driver.debugCounts()).toEqual(before)
            const pages = await harness.targets()
            expect(pages.some((t) => t.url.startsWith(c.origin))).toBe(false)
        })

        it('stops a navigation that redirects to a disallowed origin', async () => {
            const tab = await open('/plain', [a.origin])
            const error = await expectCode(driver.navigate(tab.tabId, a.url('/redirect-to-c'), [a.origin], OPTS), 'ORIGIN_DENIED')
            expect(error.mayHaveSideEffects).toBe(true)
            await expectCode(driver.observe(tab.tabId, [a.origin], OPTS), 'ORIGIN_DENIED')
            await expectCode(driver.screenshot(tab.tabId, [a.origin], OPTS), 'ORIGIN_DENIED')
        })

        it('does not adopt popups and closes those on disallowed origins', async () => {
            const tab = await open('/popup', [a.origin])
            const before = driver.debugCounts()
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            await driver.click(tab.tabId, refOf(obs, 'Open C'), obs.snapshotId, OPTS)
            const reports = await eventually(() => driver.popupReports(), (r) => r.some((p) => p.origin === c.origin && p.closed))
            expect(reports.find((p) => p.origin === c.origin)).toMatchObject({ openerTabId: tab.tabId, closed: true })
            const gone = await eventually(() => harness.targets(), (t) => !t.some((x) => x.url.startsWith(c.origin)))
            expect(gone.some((t) => t.url.startsWith(c.origin))).toBe(false)

            await driver.click(tab.tabId, refOf(obs, 'Open A'), obs.snapshotId, OPTS)
            const withA = await eventually(() => driver.popupReports(), (r) => r.some((p) => p.origin === a.origin))
            const popupA = withA.find((p) => p.origin === a.origin)!
            expect(popupA.closed).toBe(false)
            expect(driver.debugCounts()).toEqual(before)
            await harness.closeTarget(popupA.targetId)
        })
    })

    describe('waitFor', () => {
        it('resolves text and url predicates', async () => {
            const tab = await open('/later', [a.origin])
            await driver.waitFor(tab.tabId, { kind: 'text', text: 'Arrived later' }, [a.origin], OPTS)
            await driver.waitFor(tab.tabId, { kind: 'url', urlPrefix: a.url('/later/done') }, [a.origin], OPTS)
        })

        it('resolves a ref predicate once the element becomes visible', async () => {
            const tab = await open('/reveal', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            const reveal = refOf(obs, 'Reveal')
            await driver.waitFor(tab.tabId, { kind: 'ref', ref: reveal }, [a.origin], OPTS)
            await driver.click(tab.tabId, reveal, obs.snapshotId, OPTS)
            expect(await eventually(() => a.hits('reveal'), (n) => n === 1)).toBe(1)
        })

        it('rejects within 50ms of abort and honours timeoutMs', async () => {
            const tab = await open('/plain', [a.origin])
            const controller = new AbortController()
            const pending = driver.waitFor(tab.tabId, { kind: 'text', text: 'never-appears' }, [a.origin], { timeoutMs: 30_000, signal: controller.signal })
            await delay(250)
            const abortedAt = Date.now()
            controller.abort()
            await expectCode(pending, 'OUTCOME_UNKNOWN')
            expect(Date.now() - abortedAt).toBeLessThan(50)

            const started = Date.now()
            const error = await expectCode(driver.waitFor(tab.tabId, { kind: 'text', text: 'never-appears' }, [a.origin], { timeoutMs: 300 }), 'OUTCOME_UNKNOWN')
            expect(error.mayHaveSideEffects).toBe(false)
            expect(Date.now() - started).toBeGreaterThanOrEqual(290)
            expect(Date.now() - started).toBeLessThan(1_000)
        })

        it('does not match text inside a frame whose origin is not allowed', async () => {
            const tab = await open('/oopif', [a.origin])
            await expectCode(driver.waitFor(tab.tabId, { kind: 'text', text: 'canary-b-7788' }, [a.origin], { timeoutMs: 600 }), 'OUTCOME_UNKNOWN')
        })
    })

    describe('closeTab', () => {
        it('closes the target and releases tab and session registrations (5 cycles, OOPIF page)', async () => {
            const baseline = driver.debugCounts()
            for (let i = 0; i < 5; i++) {
                const tab = await driver.openTab(a.url('/oopif'), [a.origin, b.origin], OPTS)
                await driver.observe(tab.tabId, [a.origin, b.origin], OPTS)
                expect(driver.debugCounts().sessions).toBeGreaterThan(baseline.sessions + 1)
                expect(await driver.closeTab(tab.tabId, OPTS)).toEqual({ closed: true })
                expect(driver.hasTab(tab.tabId)).toBe(false)
                expect(await driver.closeTab(tab.tabId, OPTS)).toEqual({ closed: true })
                const targets = await harness.targets()
                expect(targets.some((t) => t.targetId === tab.targetId)).toBe(false)
            }
            expect(driver.debugCounts()).toEqual(baseline)
        })

        it('does not accept a beforeunload prompt and reports it', async () => {
            const tab = await open('/beforeunload', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            await driver.click(tab.tabId, refOf(obs, 'Touch'), obs.snapshotId, OPTS)
            await eventually(() => a.hits('bu'), (n) => n === 1)
            expect(await driver.closeTab(tab.tabId, OPTS)).toEqual({ closed: false, beforeUnloadBlocked: true })
            expect(driver.hasTab(tab.tabId)).toBe(true)
            await harness.closeTarget(tab.targetId)
            expect(await eventually(() => driver.hasTab(tab.tabId), (owned) => !owned)).toBe(false)
        })
    })

    describe('runtime restart', () => {
        it('lets a new driver re-take an owned tab by targetId and never adopts unknown targets', async () => {
            const tab = await driver.openTab(a.url('/plain'), [a.origin], OPTS)
            // A second driver on the same browser plays the restarted Runtime.
            const restarted = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => instanceId })
            try {
                await restarted.connect()
                expect(restarted.hasTab(tab.tabId)).toBe(false)
                expect(await restarted.adoptTab(tab.tabId, tab.targetId, [a.origin], OPTS)).toBe(true)
                expect(restarted.hasTab(tab.tabId)).toBe(true)
                const observation = await restarted.observe(tab.tabId, [a.origin], OPTS)
                expect(observation.text).toContain('Alpha plain page')
                expect(await restarted.adoptTab('tab-other' as TabId, 'no-such-target', [a.origin], OPTS)).toBe(false)
                expect(restarted.hasTab('tab-other' as TabId)).toBe(false)
            } finally {
                await restarted.close()
                await driver.closeTab(tab.tabId, OPTS)
            }
        })
    })

    describe('connection loss', () => {
        it('rejects pending calls with RUNTIME_UNAVAILABLE, drops tabs, and reconnects only explicitly', async () => {
            const first = await launchChrome()
            let second: LaunchedChrome | undefined
            let n = 0
            const lossy = new CdpDriver({ browserWsUrl: first.browserWsUrl, browserInstanceIdProvider: async () => `bi-loss-${++n}` as BrowserInstanceId })
            try {
                const firstId = await lossy.connect()
                let disconnects = 0
                lossy.onDisconnect(() => { disconnects++ })
                const tab = await lossy.openTab(a.url('/plain'), [a.origin], OPTS)
                const pending = lossy.waitFor(tab.tabId, { kind: 'text', text: 'never-appears' }, [a.origin], { timeoutMs: 30_000 })
                // Observe the rejection before killing Chrome, so it is never momentarily unhandled.
                const pendingRejected = expectCode(pending, 'RUNTIME_UNAVAILABLE')
                await delay(200)
                await first.kill()
                await pendingRejected
                expect(lossy.hasTab(tab.tabId)).toBe(false)
                expect(lossy.debugCounts()).toEqual({ tabs: 0, sessions: 0 })
                expect(disconnects).toBe(1)
                expect(lossy.isConnected()).toBe(false)
                expect(() => lossy.browserInstanceId()).toThrow()
                await expectCode(lossy.observe(tab.tabId, [a.origin], OPTS), 'RUNTIME_UNAVAILABLE')

                second = await launchChrome()
                const secondId = await lossy.reconnect(second.browserWsUrl)
                expect(secondId).not.toBe(firstId)
                expect(lossy.isConnected()).toBe(true)
                expect(disconnects).toBe(1)
                expect(lossy.browserInstanceId()).toBe(secondId)
                expect(lossy.hasTab(tab.tabId)).toBe(false)
                await expectCode(lossy.observe(tab.tabId, [a.origin], OPTS), 'TARGET_GONE')
            } finally {
                await lossy.close()
                await first.stop()
                await second?.stop()
            }
        })
    })
})
