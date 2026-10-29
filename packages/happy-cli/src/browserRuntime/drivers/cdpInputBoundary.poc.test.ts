/**
 * The CDP driver's input boundary against a real Chrome, with faults injected on the
 * driver's own connection (startCdpFaultProxy): before the first input, a failure is
 * reported side-effect free and retryable; from the first input on, never retryable and
 * possibly effective. Also what a write call reports having seen (dialogs, popups).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BrowserRuntimeError, type ActionObservations, type BrowserDriver, type BrowserInstanceId, type ElementRef, type Observation } from '../contracts'
import { CdpDriver } from './cdpDriver'
import { LABEL_OF } from './pageScripts'
import { eventually, findChrome, HarnessCdp, HIT_SCRIPT, launchChrome, startCdpFaultProxy, startSite, type CdpCommand, type CdpFault, type LaunchedChrome, type Site } from './pocTestKit'

const chromePath = findChrome()
const OPTS = { timeoutMs: 10_000 }
const FENCED = () => { throw new BrowserRuntimeError('STALE_LEASE', 'fenced before input', false, false) }

async function failure(promise: Promise<unknown>): Promise<BrowserRuntimeError> {
    const error = await promise.then(() => undefined, (caught: unknown) => caught)
    expect(error, 'the call must fail').toBeInstanceOf(BrowserRuntimeError)
    return error as BrowserRuntimeError
}

const pressed = (c: CdpCommand) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed'
const released = (c: CdpCommand) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseReleased'
const lastReadBeforeInput = (c: CdpCommand) => c.method === 'Runtime.callFunctionOn' && c.params.functionDeclaration === LABEL_OF

describe.skipIf(!chromePath)('CDP driver input boundary (real Chrome, injected faults)', () => {
    let chrome: LaunchedChrome
    let harness: HarnessCdp
    let driver: CdpDriver
    let a: Site
    let c: Site
    let instances = 0
    const cleanups: Array<() => Promise<void>> = []

    beforeAll(async () => {
        chrome = await launchChrome()
        harness = await HarnessCdp.connect(chrome.browserWsUrl)
        driver = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => 'bi-boundary' as BrowserInstanceId })
        await driver.connect()
        a = await startSite('a.poc-one.test')
        c = await startSite('c.poc-three.test')
        a.route('/stages', `${HIT_SCRIPT}<body><button onmousedown="hit('down')" onmouseup="hit('up')" onclick="hit('click')">Go</button>
            <input id="name" aria-label="Name" value="old"></body>`)
        a.route('/replace-on-input', `<body><input id="code" aria-label="Code" oninput="const next = document.createElement('input'); next.setAttribute('aria-label', 'Code'); next.id = 'code'; next.value = this.value; this.replaceWith(next)"></body>`)
        a.route('/replace-on-focus', `<body><input aria-label="Code" onfocus="const next = document.createElement('input'); next.setAttribute('aria-label', 'Code'); next.id = 'code'; this.replaceWith(next)"></body>`)
        a.route('/dialog', `${HIT_SCRIPT}<body><button onclick="alert('hello'); hit('after-alert')">Alert</button></body>`)
        a.route('/popup', () => `<body><button onclick="window.open('${a.url('/plain')}', '_blank')">Open A</button><button onclick="window.open('${c.url('/plain')}', '_blank')">Open C</button></body>`)
        a.route('/plain', '<body>plain</body>')
        a.route('/upload', `${HIT_SCRIPT}<body><input type="file" aria-label="Upload" onchange="hit('change')" oncancel="hit('cancel')"></body>`)
        c.route('/plain', '<body>plain c</body>')
    })

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
        a.resetHits()
    })

    afterAll(async () => {
        await driver?.close()
        harness?.close()
        await chrome?.stop()
        await Promise.all([a, c].filter(Boolean).map((site) => site.close()))
    })

    function refOf(obs: Observation, name: string): ElementRef {
        const found = obs.elements.filter((element) => element.name === name)
        expect(found, `exactly one element named ${name}`).toHaveLength(1)
        return found[0].ref
    }

    /** A fresh driver whose connection goes through a fault proxy, with one tab on `path`, observed. */
    async function proxied(path: string, fault: { match: (command: CdpCommand) => boolean; fault: CdpFault }) {
        const proxy = await startCdpFaultProxy(chrome.browserWsUrl)
        const lossy = new CdpDriver({ browserWsUrl: proxy.url, browserInstanceIdProvider: async () => `bi-proxy-${++instances}` as BrowserInstanceId })
        await lossy.connect()
        const tab = await lossy.openTab(a.url(path), [a.origin], OPTS)
        cleanups.push(async () => {
            await lossy.close()
            await harness.closeTarget(tab.targetId)
            await proxy.close()
        })
        const obs = await lossy.observe(tab.tabId, [a.origin], OPTS)
        proxy.failNext(fault.match, fault.fault)
        return { proxy, lossy, tab, obs }
    }

    async function ownTab(path: string) {
        const tab = await driver.openTab(a.url(path), [a.origin], OPTS)
        cleanups.push(async () => { await driver.closeTab(tab.tabId, OPTS) })
        return { tab, obs: await driver.observe(tab.tabId, [a.origin], OPTS) }
    }

    it('declares that its writes send nothing before validateDispatch returns', () => {
        expect((driver as BrowserDriver).gatesInputOnValidateDispatch).toBe(true)
    })

    describe('before the first input: side-effect free and retryable', () => {
        it('click: the connection lost on the last read before the press', async () => {
            const { lossy, tab, obs } = await proxied('/stages', { match: lastReadBeforeInput, fault: 'drop-after' })
            const error = await failure(lossy.click(tab.tabId, refOf(obs, 'Go'), obs.snapshotId, OPTS))
            expect(error).toMatchObject({ code: 'RUNTIME_UNAVAILABLE', retryable: true, mayHaveSideEffects: false })
            await new Promise((resolve) => setTimeout(resolve, 300))
            expect([a.hits('down'), a.hits('click')]).toEqual([0, 0])
        })

        it('fill: the connection lost on the last read before typing', async () => {
            const { lossy, tab, obs } = await proxied('/stages', { match: lastReadBeforeInput, fault: 'drop-after' })
            const error = await failure(lossy.fill(tab.tabId, refOf(obs, 'Name'), obs.snapshotId, 'Neo', OPTS))
            expect(error).toMatchObject({ retryable: true, mayHaveSideEffects: false })
            expect(await harness.evaluate(tab.targetId, "document.getElementById('name').value")).toBe('old')
        })

        it.each(['click', 'fill', 'navigate'] as const)('%s: a validateDispatch that refuses sends nothing', async (kind) => {
            const { tab, obs } = await ownTab('/stages')
            const call = kind === 'click' ? driver.click(tab.tabId, refOf(obs, 'Go'), obs.snapshotId, { ...OPTS, validateDispatch: FENCED })
                : kind === 'fill' ? driver.fill(tab.tabId, refOf(obs, 'Name'), obs.snapshotId, 'Neo', { ...OPTS, validateDispatch: FENCED })
                    : driver.navigate(tab.tabId, a.url('/plain'), [a.origin], { ...OPTS, validateDispatch: FENCED })
            expect(await failure(call)).toMatchObject({ code: 'STALE_LEASE', mayHaveSideEffects: false })
            await new Promise((resolve) => setTimeout(resolve, 300))
            expect([a.hits('down'), a.hits('click')]).toEqual([0, 0])
            expect(await harness.evaluate(tab.targetId, "location.pathname + ':' + document.getElementById('name').value")).toBe('/stages:old')
        })

        it('fill: a field the page replaces when it gets focus is refused before typing', async () => {
            const { tab, obs } = await ownTab('/replace-on-focus')
            const error = await failure(driver.fill(tab.tabId, refOf(obs, 'Code'), obs.snapshotId, 'secret-otp', OPTS))
            expect(error.mayHaveSideEffects).toBe(false)
            expect(await harness.evaluate(tab.targetId, "document.getElementById('code').value")).toBe('')
        })
    })

    describe('from the first input on: never retryable, possibly effective', () => {
        it('click: the press delivered, the connection lost before its answer (no release sent)', async () => {
            const { lossy, tab, obs } = await proxied('/stages', { match: pressed, fault: 'drop-after' })
            const error = await failure(lossy.click(tab.tabId, refOf(obs, 'Go'), obs.snapshotId, OPTS))
            expect(error).toMatchObject({ retryable: false, mayHaveSideEffects: true })
            expect(await eventually(() => a.hits('down'), (n) => n === 1)).toBe(1)
            expect(a.hits('click')).toBe(0)
        })

        it('click: the release delivered, its session reported gone (the frame was replaced)', async () => {
            const { lossy, tab, obs } = await proxied('/stages', { match: released, fault: { failWith: 'Session with given id not found' } })
            const error = await failure(lossy.click(tab.tabId, refOf(obs, 'Go'), obs.snapshotId, OPTS))
            expect(error).toMatchObject({ retryable: false, mayHaveSideEffects: true })
            expect(await eventually(() => a.hits('click'), (n) => n === 1)).toBe(1)
        })

        it('fill: the text delivered, the connection lost before its answer', async () => {
            const { lossy, tab, obs } = await proxied('/stages', { match: (c) => c.method === 'Input.insertText', fault: 'drop-after' })
            const error = await failure(lossy.fill(tab.tabId, refOf(obs, 'Name'), obs.snapshotId, 'Neo', OPTS))
            expect(error).toMatchObject({ retryable: false, mayHaveSideEffects: true })
            expect(await eventually(() => harness.evaluate(tab.targetId, "document.getElementById('name').value"), (v) => v === 'Neo')).toBe('Neo')
        })

        it('fill with an empty value: the Delete key down delivered, the connection lost before key up', async () => {
            const { lossy, tab, obs } = await proxied('/stages', { match: (c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'keyDown', fault: 'drop-after' })
            const error = await failure(lossy.fill(tab.tabId, refOf(obs, 'Name'), obs.snapshotId, '', OPTS))
            expect(error).toMatchObject({ retryable: false, mayHaveSideEffects: true })
        })

        it('navigate: the navigation sent, the connection lost before its answer', async () => {
            const { lossy, tab } = await proxied('/stages', { match: (c) => c.method === 'Page.navigate', fault: 'drop-after' })
            const error = await failure(lossy.navigate(tab.tabId, a.url('/plain'), [a.origin], OPTS))
            expect(error).toMatchObject({ retryable: false, mayHaveSideEffects: true })
        })

        it('fill: a field the page replaces while the text goes in is an unknown outcome, not a success', async () => {
            const { tab, obs } = await ownTab('/replace-on-input')
            const error = await failure(driver.fill(tab.tabId, refOf(obs, 'Code'), obs.snapshotId, '1234', OPTS))
            expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false, mayHaveSideEffects: true })
            // The page kept the text in its replacement: the driver must not type it again.
            expect(await harness.evaluate(tab.targetId, "document.getElementById('code').value")).toBe('1234')
        })
    })

    describe('what a write call saw', () => {
        it('reports a dialog it dismissed during a click', async () => {
            const { tab, obs } = await ownTab('/dialog')
            const observed: ActionObservations = {}
            await driver.click(tab.tabId, refOf(obs, 'Alert'), obs.snapshotId, { ...OPTS, observed })
            expect(observed.dialogs).toEqual([{ type: 'alert' }])
            expect(await eventually(() => a.hits('after-alert'), (n) => n === 1)).toBe(1)
        })

        it('reports pages the tab opened during a click, and leaves them as they are', async () => {
            const { tab, obs } = await ownTab('/popup')
            const observed: ActionObservations = {}
            await driver.click(tab.tabId, refOf(obs, 'Open A'), obs.snapshotId, { ...OPTS, observed })
            expect(observed.popups).toHaveLength(1)
            // As known when the call ended: the popup may not have committed its first document yet.
            expect(['', a.origin]).toContain(observed.popups![0].origin)
            expect(observed.popups![0].closed).toBe(false)
            const popup = await eventually(() => driver.popupReports().filter((report) => report.openerTabId === tab.tabId), (reports) => reports.some((report) => report.origin === a.origin))
            const target = popup.find((report) => report.origin === a.origin)!
            expect((await harness.targets()).some((t) => t.targetId === target.targetId)).toBe(true)
            cleanups.push(() => harness.closeTarget(target.targetId))
        })

        it('reports a file chooser a click opened, without intercepting or answering it', async () => {
            const { tab, obs } = await ownTab('/upload')
            const observed: ActionObservations = {}
            await driver.click(tab.tabId, refOf(obs, 'Upload'), obs.snapshotId, { ...OPTS, observed })
            expect(observed.fileChoosers).toEqual([{ mode: 'selectSingle' }])
            // Observed only: the driver chose no file and did not dismiss the chooser itself.
            await new Promise((resolve) => setTimeout(resolve, 300))
            expect(a.hits('change')).toBe(0)
            expect(await harness.evaluate(tab.targetId, "document.querySelector('input').files.length")).toBe(0)
        })

        it('reports nothing for a call during which nothing opened', async () => {
            const { tab, obs } = await ownTab('/stages')
            const observed: ActionObservations = {}
            await driver.click(tab.tabId, refOf(obs, 'Go'), obs.snapshotId, { ...OPTS, observed })
            expect(observed).toEqual({})
        })
    })
})
