/**
 * The page view in the consoles, in a real Chrome against a fake Runtime: the host first hands over a pageViewInfo-only
 * bootstrap, the console publishes the runtime binding, and only the conversation/binding-scoped capability opens the
 * page. A frame is shown; input reaches dispatchPageInput only while this viewer holds the tab's lease.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderConsolePage } from './consolePage'
import { renderRemoteConsolePage } from './remoteConsolePage'
import { HarnessCdp, eventually, findChrome, launchChrome, type LaunchedChrome } from './drivers/pocTestKit'

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const SESSION = 'session-1'
const BINDING = 'binding-1'
const identity = { kind: 'interactive', profileId: 'profile-a', principalId: 'user-1', viewerSessionId: 'viewer-this' }
const capability = (tag: string, claims: Record<string, unknown>) =>
    `abp2.${b64({ alg: 'EdDSA', kid: 'k', typ: 'abp-cap' })}.${b64({ ...identity, capabilityId: tag, expiresAtMs: Date.now() + 600_000, ...claims })}.sig-${tag}`
/** eventually() that fails the test when the condition never holds (eventually itself returns the last value). */
async function until<T>(fn: () => T | Promise<T>, ok: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
    const value = await eventually(fn, ok, timeoutMs)
    if (!ok(value)) throw new Error(`condition not met within ${timeoutMs} ms; last value: ${JSON.stringify(value)?.slice(0, 300)}`)
    return value
}
const bootstrap = (tag: string) => capability(tag, { operations: ['pageViewInfo'] })
const scoped = (tag: string, runtimeBindingId = BINDING) => capability(tag, { operations: ['listTasks', 'getTask', 'takeOver', 'releaseControl', 'resume', 'cancel', 'approve', 'subscribe',
    'openPageView', 'getPageFrame', 'dispatchPageInput', 'closePageView'], pageViewScope: { schemaVersion: 1, agentSessionId: SESSION, runtimeBindingId } })

describe.skipIf(!findChrome())('page view in the consoles (real Chrome, fake Runtime)', () => {
    let chrome: LaunchedChrome
    let harness: HarnessCdp
    let server: http.Server
    let origin = ''
    let jpeg = ''
    const ops: Array<{ op: string; bearer: string; body: Record<string, any>; at: number }> = []
    let leaseOwner: Record<string, unknown> = { kind: 'none' }
    let frames = 0
    /** Frame reads the fake Runtime refuses as rate limited, as the real one does inside its interval. */
    let refuseFrames = 0
    /** A frame read the fake Runtime answers with this error (a view the Runtime no longer accepts). */
    let frameError: string | null = null
    /** Input answers the fake Runtime loses (the connection drops before the receipt) or holds back. */
    let dropInput = false, inputDelayMs = 0
    /** A second open task of this conversation, for switching while input is under way. */
    let secondTask = false
    /** The Runtime's current binding (a relaunched browser gets a new one) and the capabilities that have run out. */
    let binding = BINDING
    const expired = new Set<string>()
    /** As the Runtime does, a view lives only as long as the capability that opened it, and only under its binding. */
    const views = new Map<string, { bearer: string; binding: string }>()
    const task = (taskId = 'task-1') => ({ taskId, agentSessionId: SESSION, status: 'paused', pauseReason: 'user-control', stateVersion: 3, tabs: ['tab-1'],
        uncertainActions: [], cancelRequested: false, updatedAtMs: Date.now(), tabLeases: [{ tabId: 'tab-1', leaseEpoch: 4, owner: leaseOwner }] })

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            if (url.pathname === '/console') {
                res.writeHead(200, { 'content-type': 'text/html' })
                // remotePage=1 is the remote Mac console; otherwise the personal PC's own console, with the page view only when the Runtime has it.
                res.end(url.searchParams.get('remotePage') === '1' ? renderRemoteConsolePage()
                    : renderConsolePage({ screenMode: 'native-window', pageView: url.searchParams.get('pageView') !== '0' }))
                return
            }
            const m = /^\/v1\/ops\/(\w+)$/.exec(url.pathname)
            if (!m) { res.writeHead(404); res.end(); return }
            let raw = ''
            req.on('data', (chunk) => { raw += chunk })
            req.on('end', () => {
                const body = JSON.parse(raw || '{}')
                ops.push({ op: m[1], bearer: String(req.headers.authorization ?? '').replace(/^Bearer /, ''), body, at: Date.now() })
                const status = { closed: false, draining: false, unknown: false, lastAccepted: 0, lastSettled: 0, receipts: [] }
                if (m[1] === 'getPageFrame' && !body.statusOnly && refuseFrames > 0) {
                    refuseFrames--
                    res.writeHead(429, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: { code: 'QUOTA_EXCEEDED', message: 'Page capture rate limited' } }))
                    return
                }
                if (m[1] === 'dispatchPageInput' && dropInput) { req.socket.destroy(); return }
                const view = views.get(String(body.viewId))
                const refused = m[1] === 'openPageView' && body.runtimeBindingId !== binding ? 'SCOPE_DENIED'
                    : ['getPageFrame', 'dispatchPageInput'].includes(m[1]) && view && (expired.has(view.bearer) || view.binding !== binding) ? 'UNAUTHORIZED' : null
                if (refused) {
                    res.writeHead(403, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: { code: refused, message: 'refused' } }))
                    return
                }
                if (m[1] === 'getPageFrame' && !body.statusOnly && frameError) {
                    res.writeHead(403, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: { code: frameError, message: 'refused' } }))
                    return
                }
                const bearer = ops[ops.length - 1]!.bearer
                if (m[1] === 'openPageView') views.set('view-' + ops.length, { bearer, binding: body.runtimeBindingId })
                const result = m[1] === 'pageViewInfo' ? { schemaVersion: 1, supported: true, input: true, runtimeBindingId: binding }
                    : m[1] === 'listTasks' ? { tasks: secondTask ? [task(), task('task-2')] : [task()] }
                        : m[1] === 'getTask' ? task(body.taskId)
                            : m[1] === 'openPageView' ? { schemaVersion: 1, viewId: 'view-' + ops.length, expiresAtMs: Date.now() + 600_000, input: true }
                                : m[1] === 'getPageFrame' ? body.statusOnly ? { schemaVersion: 1, status } : { schemaVersion: 1, status, frame: {
                                    data: jpeg, mimeType: 'image/jpeg', pixelWidth: 64, pixelHeight: 48, frameId: 'frame-' + ++frames, ageMs: 0, capturedAtMs: Date.now(), captureDurationMs: 1,
                                    documentGeneration: 1, viewport: { width: 640, height: 480, offsetX: 0, offsetY: 0, scale: 1 } } }
                                    : m[1] === 'dispatchPageInput' ? { sequence: body.sequence, state: 'applied' }
                                        : m[1] === 'releaseControl' ? { owner: 'none', task: task() }
                                        : m[1] === 'closePageView' ? status : {}
                setTimeout(() => {
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: true, result }))
                }, m[1] === 'dispatchPageInput' ? inputDelayMs : 0)
            })
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        chrome = await launchChrome()
        harness = await HarnessCdp.connect(chrome.browserWsUrl)
        const blank = await harness.openFrontTab('about:blank')
        jpeg = String(await harness.evaluate(blank, `(() => { const c = document.createElement('canvas'); c.width = 64; c.height = 48;
            const g = c.getContext('2d'); g.fillStyle = '#3366cc'; g.fillRect(0, 0, 64, 48); return c.toDataURL('image/jpeg').split(',')[1] })()`))
        await harness.closeTarget(blank)
    }, 60_000)

    afterAll(async () => {
        harness?.close()
        await chrome?.stop()
        await new Promise<void>((resolve) => server?.close(() => resolve()))
    })

    const hand = (target: string, token: string) => harness.evaluate(target,
        `window.postMessage({ type: 'abp-capability', token: ${JSON.stringify(token)}, expiresAtMs: Date.now() + 600_000 }, location.origin)`)
    const click = async (target: string, x: number, y: number) => {
        const { sessionId } = await harness.conn.send('Target.attachToTarget', { targetId: target, flatten: true })
        try {
            for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
                await harness.conn.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, sessionId)
        } finally { await harness.conn.send('Target.detachFromTarget', { sessionId }).catch(() => undefined) }
    }
    /** Bootstrap, then the scoped capability; resolves once the first frame is on screen. */
    async function openRemote(): Promise<string> {
        const target = await harness.openFrontTab(`${origin}/console?remotePage=1&agentSessionId=${SESSION}&lang=en`)
        await until(() => harness.evaluate(target, 'window.__abpPageView'), (v) => v === 1)
        await hand(target, bootstrap('boot'))
        expect(await until(() => harness.evaluate(target, 'window.__abpPageViewBinding'), (v) => v === BINDING)).toBe(BINDING)
        await hand(target, scoped('scoped'))
        await until(() => harness.evaluate(target, `!document.getElementById('page').hidden`), Boolean, 10_000)
        return target
    }

    it('remote console: bootstrap only learns the binding, the scoped capability opens and shows the task page', async () => {
        ops.length = 0; leaseOwner = { kind: 'none' }
        const target = await openRemote()
        try {
            expect(ops.find((o) => o.op === 'pageViewInfo')).toMatchObject({ bearer: expect.stringMatching(/\.sig-boot$/), body: { schemaVersion: 1, profileId: 'profile-a' } })
            expect(ops.filter((o) => o.bearer.endsWith('.sig-boot')).map((o) => o.op)).toEqual(['pageViewInfo'])
            expect(ops.find((o) => o.op === 'openPageView')?.body).toEqual({ schemaVersion: 1, agentSessionId: SESSION, runtimeBindingId: BINDING, taskId: 'task-1', tabId: 'tab-1' })
            expect(await until(() => harness.evaluate(target, `document.getElementById('status').textContent`), (s) => s === 'Observing')).toBe('Observing')
        } finally { await harness.closeTarget(target) }
    })

    it('remote console: a click on the page reaches dispatchPageInput only while this viewer holds the lease', async () => {
        ops.length = 0; leaseOwner = { kind: 'none' }
        const target = await openRemote()
        try {
            const box = JSON.parse(await harness.evaluate(target, `JSON.stringify(document.getElementById('page').getBoundingClientRect())`))
            await click(target, box.x + box.width / 2, box.y + box.height / 2)
            await harness.evaluate(target, 'new Promise(r => setTimeout(r, 600))')
            expect(ops.filter((o) => o.op === 'dispatchPageInput')).toEqual([])
            leaseOwner = { kind: 'user', principalId: 'user-1', viewerSessionId: 'viewer-this' }
            await until(() => harness.evaluate(target, `document.getElementById('status').textContent`), (s) => s === 'You have control', 10_000)
            await click(target, box.x + box.width / 2, box.y + box.height / 2)
            const sent = await until(() => ops.filter((o) => o.op === 'dispatchPageInput'), (list) => list.some((o) => o.body.event.type === 'mouseReleased'))
            const press = sent.find((o) => o.body.event.type === 'mousePressed')!
            expect(press.body).toMatchObject({ schemaVersion: 1, leaseEpoch: 4, frameId: expect.stringMatching(/^frame-/), event: { kind: 'pointer', button: 'left' } })
            expect(press.body.event.x).toBeCloseTo(320, -1)
            expect(press.body.event.y).toBeCloseTo(240, -1)
            expect(sent.map((o) => o.body.sequence)).toEqual(sent.map((_o, i) => i + 1))
        } finally { await harness.closeTarget(target) }
    })

    const frameReads = (after: number) => ops.filter((o) => o.op === 'getPageFrame' && !o.body.statusOnly && o.at >= after).map((o) => o.at)
    const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i])
    const wait = (target: string, ms: number) => harness.evaluate(target, `new Promise(r => setTimeout(r, ${ms}))`)

    it('remote console: frame reads keep to the Runtime interval, 500 ms while observing and 200 ms with control', async () => {
        ops.length = 0; leaseOwner = { kind: 'none' }
        const target = await openRemote()
        try {
            const observing = Date.now()
            await wait(target, 2500)
            const observed = frameReads(observing)
            expect(observed.length).toBeGreaterThanOrEqual(3)
            expect(Math.min(...gaps(observed))).toBeGreaterThanOrEqual(450)
            leaseOwner = { kind: 'user', principalId: 'user-1', viewerSessionId: 'viewer-this' }
            await until(() => harness.evaluate(target, `document.getElementById('status').textContent`), (s) => s === 'You have control', 10_000)
            const controlling = Date.now()
            await wait(target, 1500)
            const controlled = gaps(frameReads(controlling))
            expect(Math.min(...controlled)).toBeGreaterThanOrEqual(180)
            expect(controlled.some((gap) => gap < 450)).toBe(true)
        } finally { await harness.closeTarget(target) }
    })

    it('remote console: a rate-limited frame read waits a second before the next one', async () => {
        ops.length = 0; leaseOwner = { kind: 'none' }
        const target = await openRemote()
        try {
            await wait(target, 600)
            const refusedAt = Date.now()
            refuseFrames = 1
            await until(() => refuseFrames, (n) => n === 0, 5_000)
            const reads = frameReads(refusedAt)
            await wait(target, 1500)
            const after = frameReads(refusedAt)
            expect(after.length).toBeGreaterThan(reads.length)
            expect(after[1] - after[0]).toBeGreaterThanOrEqual(950)
        } finally { refuseFrames = 0; await harness.closeTarget(target) }
    })
    /** The personal PC's own console in a conversation: bootstrap, then the scoped capability; resolves once the page is on screen. */
    async function openLocal(lang = 'en'): Promise<string> {
        const target = await harness.openFrontTab(`${origin}/console?agentSessionId=${SESSION}&lang=${lang}`)
        await until(() => harness.evaluate(target, 'window.__abpPageView'), (v) => v === 1)
        await hand(target, bootstrap('local-boot'))
        expect(await until(() => harness.evaluate(target, 'window.__abpPageViewBinding'), (v) => v === BINDING)).toBe(BINDING)
        await hand(target, scoped('local-scoped'))
        await until(() => harness.evaluate(target, `!document.getElementById('page').hidden`), Boolean, 10_000)
        return target
    }

    it('local console: the scoped capability shows the task page in the screen area and keeps the task controls', async () => {
        for (const lang of ['ko', 'en']) {
            ops.length = 0; leaseOwner = { kind: 'none' }
            const target = await openLocal(lang)
            try {
                // The bootstrap only learned the binding; it never listed tasks or became the console's authority.
                expect(ops.filter((o) => o.bearer.endsWith('.sig-local-boot')).map((o) => o.op)).toEqual(['pageViewInfo'])
                expect(ops.find((o) => o.op === 'openPageView')?.body).toEqual({ schemaVersion: 1, agentSessionId: SESSION, runtimeBindingId: BINDING, taskId: 'task-1', tabId: 'tab-1' })
                expect(ops.filter((o) => o.op === 'viewerTicket')).toEqual([])
                const state = JSON.parse(await harness.evaluate(target, `JSON.stringify({
                    page: !!document.getElementById('page').getClientRects().length,
                    guide: !!document.getElementById('screenEmpty').getClientRects().length,
                    sizes: !!document.getElementById('viewGroup').getClientRects().length,
                    spaces: !!document.getElementById('spaceToggle').getClientRects().length,
                    reconnect: !!document.getElementById('pageRetry').getClientRects().length,
                    controls: ['takeOver', 'release', 'resume', 'stop', 'autoMode'].every(id => !!document.getElementById(id).getClientRects().length),
                    hint: document.getElementById('screenHintText').textContent })`))
                // Reconnect is offered only after a failure or an input receipt check, not while the page is live.
                expect(state).toMatchObject({ page: true, guide: false, sizes: true, spaces: false, reconnect: false, controls: true })
                expect(state.hint).toBe(lang === 'ko' ? '페이지를 보고 있어요. 직접 조작하려면 제어권을 가져오세요.' : 'Observing the page. Take over to use it.')
            } finally { await harness.closeTarget(target) }
        }
    })

    it('local console: input reaches the page only with control, and release reopens the view', async () => {
        ops.length = 0; leaseOwner = { kind: 'none' }
        const target = await openLocal()
        try {
            const box = JSON.parse(await harness.evaluate(target, `JSON.stringify(document.getElementById('page').getBoundingClientRect())`))
            await click(target, box.x + box.width / 2, box.y + box.height / 2)
            await wait(target, 600)
            expect(ops.filter((o) => o.op === 'dispatchPageInput')).toEqual([])
            leaseOwner = { kind: 'user', principalId: 'user-1', viewerSessionId: 'viewer-this' }
            await harness.evaluate(target, `document.getElementById('refreshTasks').click()`)
            await until(() => harness.evaluate(target, `!!document.querySelector('#tasks button[data-task="task-1"]')`), Boolean, 5_000)
            await harness.evaluate(target, `document.querySelector('#tasks button[data-task="task-1"]').click()`)
            await until(() => harness.evaluate(target, `document.getElementById('screenHintText').textContent`), (s) => s === 'You have control. Input reaches the page.', 10_000)
            await click(target, box.x + box.width / 2, box.y + box.height / 2)
            const sent = await until(() => ops.filter((o) => o.op === 'dispatchPageInput'), (list) => list.some((o) => o.body.event.type === 'mouseReleased'))
            expect(sent[0].body).toMatchObject({ leaseEpoch: 4, frameId: expect.stringMatching(/^frame-/), event: { kind: 'pointer' } })
            const opened = ops.filter((o) => o.op === 'openPageView').length
            await harness.evaluate(target, `document.getElementById('release').click()`)
            await until(() => ops.filter((o) => o.op === 'openPageView').length, (n) => n > opened, 10_000)
            const order = ops.map((o) => o.op).filter((op) => ['releaseControl', 'closePageView', 'openPageView'].includes(op))
            expect(order.slice(order.lastIndexOf('releaseControl'))).toEqual(['releaseControl', 'closePageView', 'openPageView'])
        } finally { await harness.closeTarget(target) }
    })

    it('local console: a refused view offers Reconnect, which reopens the view', async () => {
        ops.length = 0; leaseOwner = { kind: 'none' }
        const target = await openLocal()
        try {
            frameError = 'SCOPE_DENIED'
            await until(() => harness.evaluate(target, `!!document.getElementById('pageRetry').getClientRects().length`), Boolean, 5_000)
            expect(await harness.evaluate(target, `document.getElementById('screenHintText').textContent`)).toBe('This conversation cannot access the page.')
            frameError = null
            const opened = ops.filter((o) => o.op === 'openPageView').length
            await harness.evaluate(target, `document.getElementById('pageRetry').click()`)
            // Reconnect goes back to the host: a new bootstrap, then the scoped capability, before the view reopens.
            await until(() => harness.evaluate(target, 'window.__abpPageViewBinding'), (v) => v === null, 5_000)
            await hand(target, bootstrap('retry-boot'))
            await until(() => harness.evaluate(target, 'window.__abpPageViewBinding'), (v) => v === BINDING, 5_000)
            await hand(target, scoped('retry-scoped'))
            await until(() => ops.filter((o) => o.op === 'openPageView').length, (n) => n > opened, 5_000)
            await until(() => harness.evaluate(target, `document.getElementById('screenHintText').textContent`), (s) => s === 'Observing the page. Take over to use it.', 5_000)
            expect(await harness.evaluate(target, `!!document.getElementById('pageRetry').getClientRects().length`)).toBe(false)
        } finally { frameError = null; await harness.closeTarget(target) }
    })

    /** The local console with this viewer holding the shown task's tab; resolves once it says so. */
    async function controlLocal(): Promise<{ target: string; x: number; y: number }> {
        leaseOwner = { kind: 'user', principalId: 'user-1', viewerSessionId: 'viewer-this' }
        const target = await openLocal()
        await until(() => harness.evaluate(target, `document.getElementById('screenHintText').textContent`), (s) => s === 'You have control. Input reaches the page.', 10_000)
        const box = JSON.parse(await harness.evaluate(target, `JSON.stringify(document.getElementById('page').getBoundingClientRect())`))
        return { target, x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    const inputs = () => ops.filter((o) => o.op === 'dispatchPageInput')

    it('local console: an input whose answer is lost is never sent again, and Reconnect is offered', async () => {
        ops.length = 0
        const { target, x, y } = await controlLocal()
        try {
            dropInput = true
            await click(target, x, y)
            await until(() => harness.evaluate(target, `document.getElementById('screenHintText').textContent`), (s) => s === 'Checking input receipt. Do not repeat the input.', 5_000)
            await wait(target, 1500)
            // One press reached the Runtime; neither it nor the release queued behind it was sent again.
            // One input left the console. Chrome itself may replay a POST whose connection dropped unanswered (the same body,
            // which the Runtime answers from its receipt); the console never sent a new sequence or the rest of the click.
            expect(new Set(inputs().map((o) => JSON.stringify(o.body))).size).toBe(1)
            expect(inputs()[0]!.body).toMatchObject({ sequence: 1, event: { type: 'mouseMoved' } })
            expect(ops.some((o) => o.op === 'getPageFrame' && o.body.statusOnly)).toBe(true)
            expect(await harness.evaluate(target, `!!document.getElementById('pageRetry').getClientRects().length`)).toBe(true)
            await click(target, x, y)
            await wait(target, 600)
            expect(new Set(inputs().map((o) => o.body.sequence))).toEqual(new Set([1]))
        } finally { dropInput = false; await harness.closeTarget(target) }
    })

    it('local console: input queued for one task never reaches the page of the task switched to', async () => {
        ops.length = 0; secondTask = true
        const { target, x, y } = await controlLocal()
        try {
            inputDelayMs = 800
            await click(target, x, y)
            await until(() => inputs().length, (n) => n === 1, 5_000)
            const first = inputs()[0]!.body.viewId
            await until(() => harness.evaluate(target, `!!document.querySelector('#tasks button[data-task="task-2"]')`), Boolean, 20_000)
            await harness.evaluate(target, `document.querySelector('#tasks button[data-task="task-2"]').click()`)
            const switched = await until(() => ops.find((o) => o.op === 'openPageView' && o.body.taskId === 'task-2'), Boolean, 5_000)
            await wait(target, 1500)
            // The press in flight finished on its own view; the rest of that click died with the view.
            expect(inputs().map((o) => o.body.viewId)).toEqual([first])
            expect(ops.filter((o) => o.op === 'closePageView').map((o) => o.body.viewId)).toContain(first)
            expect(switched!.body.tabId).toBe('tab-1')
        } finally { inputDelayMs = 0; secondTask = false; await harness.closeTarget(target) }
    })

    it('local console: leaving the page for another control or window ends its input', async () => {
        ops.length = 0
        const { target, x, y } = await controlLocal()
        try {
            await click(target, x, y)
            await until(() => inputs().length, (n) => n >= 3, 5_000)
            const viewId = inputs()[0]!.body.viewId
            expect(await harness.evaluate(target, `document.activeElement && document.activeElement.id`)).toBe('pageInput')
            await harness.evaluate(target, `document.getElementById('takeOver').focus()`)
            await until(() => ops.filter((o) => o.op === 'closePageView').map((o) => o.body.viewId), (ids) => ids.includes(viewId), 5_000)
            const sent = inputs().length
            await harness.evaluate(target, `document.getElementById('pageInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))`)
            await wait(target, 400)
            expect(inputs().filter((o) => o.body.viewId === viewId)).toHaveLength(sent)
        } finally { await harness.closeTarget(target) }
    })

    it('local console: a renewed capability reopens the view, which would otherwise end with the old one', async () => {
        ops.length = 0; leaseOwner = { kind: 'none' }
        const target = await openLocal()
        try {
            await hand(target, scoped('local-renewed'))
            await until(() => ops.find((o) => o.op === 'openPageView' && o.bearer.endsWith('.sig-local-renewed')), Boolean, 5_000)
            expired.add(ops.find((o) => o.op === 'openPageView')!.bearer)
            const after = ops.length
            await wait(target, 1500)
            expect(ops.slice(after).filter((o) => o.op === 'getPageFrame' && !o.body.statusOnly).every((o) => o.bearer.endsWith('.sig-local-renewed'))).toBe(true)
            expect(await harness.evaluate(target, `document.getElementById('screenHintText').textContent`)).toBe('Observing the page. Take over to use it.')
        } finally { expired.clear(); await harness.closeTarget(target) }
    })

    it('local console: Reconnect learns the runtime binding again after the browser was relaunched', async () => {
        ops.length = 0; leaseOwner = { kind: 'none' }
        const target = await openLocal()
        try {
            binding = 'binding-2'
            await until(() => harness.evaluate(target, `!!document.getElementById('pageRetry').getClientRects().length`), Boolean, 5_000)
            await harness.evaluate(target, `document.getElementById('pageRetry').click()`)
            // Back to the host for a new bootstrap: the learned binding is gone.
            await until(() => harness.evaluate(target, 'window.__abpPageViewBinding'), (v) => v === null, 5_000)
            await hand(target, bootstrap('relaunch-boot'))
            await until(() => harness.evaluate(target, 'window.__abpPageViewBinding'), (v) => v === 'binding-2', 5_000)
            await hand(target, scoped('relaunch-scoped', 'binding-2'))
            await until(() => ops.find((o) => o.op === 'openPageView' && o.body.runtimeBindingId === 'binding-2'), Boolean, 5_000)
            await until(() => harness.evaluate(target, `document.getElementById('screenHintText').textContent`), (s) => s === 'Observing the page. Take over to use it.', 5_000)
            // No view was opened with an empty or stale binding while the new one was being learned.
            expect(ops.filter((o) => o.op === 'openPageView').map((o) => o.body.runtimeBindingId).every((b) => b === BINDING || b === 'binding-2')).toBe(true)
        } finally { binding = BINDING; await harness.closeTarget(target) }
    })

    it('local console: a capability without the page scope keeps the Chrome window guidance and the spaces', async () => {
        ops.length = 0; leaseOwner = { kind: 'none' }
        const target = await harness.openFrontTab(`${origin}/console?agentSessionId=${SESSION}&lang=en`)
        try {
            await hand(target, capability('broad', {}))
            await until(() => harness.evaluate(target, `document.getElementById('detailId').textContent`), (id) => id === 'task-1')
            await wait(target, 600)
            expect(ops.filter((o) => ['pageViewInfo', 'openPageView', 'getPageFrame'].includes(o.op))).toEqual([])
            expect(JSON.parse(await harness.evaluate(target, `JSON.stringify({ title: document.querySelector('#screenEmpty b').textContent,
                spaces: !!document.getElementById('spaceToggle').getClientRects().length, page: !!document.getElementById('page').getClientRects().length })`)))
                .toEqual({ title: 'View in Chrome on the task PC', spaces: true, page: false })
        } finally { await harness.closeTarget(target) }
    })

    it('local console: a Runtime without the page view does not offer it', async () => {
        const target = await harness.openFrontTab(`${origin}/console?agentSessionId=${SESSION}&lang=en&pageView=0`)
        try {
            await wait(target, 300)
            expect(await harness.evaluate(target, 'window.__abpPageView')).toBeUndefined()
        } finally { await harness.closeTarget(target) }
    })
})
