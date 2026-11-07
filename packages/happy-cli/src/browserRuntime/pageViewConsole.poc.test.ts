/**
 * The page view in the consoles, in a real Chrome against a fake Runtime: the host first hands over a pageViewInfo-only
 * bootstrap, the console publishes the runtime binding, and only the conversation/binding-scoped capability opens the
 * page. A frame is shown; input reaches dispatchPageInput only while this viewer holds the tab's lease.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderRemoteConsolePage } from './remoteConsolePage'
import { HarnessCdp, eventually, findChrome, launchChrome, type LaunchedChrome } from './drivers/pocTestKit'

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const SESSION = 'session-1'
const BINDING = 'binding-1'
const identity = { kind: 'interactive', profileId: 'profile-a', principalId: 'user-1', viewerSessionId: 'viewer-this' }
const capability = (tag: string, claims: Record<string, unknown>) =>
    `abp2.${b64({ alg: 'EdDSA', kid: 'k', typ: 'abp-cap' })}.${b64({ ...identity, capabilityId: tag, expiresAtMs: Date.now() + 600_000, ...claims })}.sig-${tag}`
const bootstrap = (tag: string) => capability(tag, { operations: ['pageViewInfo'] })
const scoped = (tag: string) => capability(tag, { operations: ['listTasks', 'getTask', 'takeOver', 'releaseControl', 'resume', 'cancel', 'approve', 'subscribe',
    'openPageView', 'getPageFrame', 'dispatchPageInput', 'closePageView'], pageViewScope: { schemaVersion: 1, agentSessionId: SESSION, runtimeBindingId: BINDING } })

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
    const task = () => ({ taskId: 'task-1', agentSessionId: SESSION, status: 'paused', pauseReason: 'user-control', stateVersion: 3, tabs: ['tab-1'],
        uncertainActions: [], cancelRequested: false, updatedAtMs: Date.now(), tabLeases: [{ tabId: 'tab-1', leaseEpoch: 4, owner: leaseOwner }] })

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            if (url.pathname === '/console') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(renderRemoteConsolePage()); return }
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
                const result = m[1] === 'pageViewInfo' ? { schemaVersion: 1, supported: true, input: true, runtimeBindingId: BINDING }
                    : m[1] === 'listTasks' ? { tasks: [task()] }
                        : m[1] === 'getTask' ? task()
                            : m[1] === 'openPageView' ? { schemaVersion: 1, viewId: 'view-' + ops.length, expiresAtMs: Date.now() + 600_000, input: true }
                                : m[1] === 'getPageFrame' ? body.statusOnly ? { schemaVersion: 1, status } : { schemaVersion: 1, status, frame: {
                                    data: jpeg, mimeType: 'image/jpeg', pixelWidth: 64, pixelHeight: 48, frameId: 'frame-' + ++frames, ageMs: 0, capturedAtMs: Date.now(), captureDurationMs: 1,
                                    documentGeneration: 1, viewport: { width: 640, height: 480, offsetX: 0, offsetY: 0, scale: 1 } } }
                                    : m[1] === 'dispatchPageInput' ? { sequence: body.sequence, state: 'applied' }
                                        : m[1] === 'closePageView' ? status : {}
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: true, result }))
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
        await eventually(() => harness.evaluate(target, 'window.__abpPageView'), (v) => v === 1)
        await hand(target, bootstrap('boot'))
        expect(await eventually(() => harness.evaluate(target, 'window.__abpPageViewBinding'), (v) => v === BINDING)).toBe(BINDING)
        await hand(target, scoped('scoped'))
        await eventually(() => harness.evaluate(target, `!document.getElementById('page').hidden`), Boolean, 10_000)
        return target
    }

    it('remote console: bootstrap only learns the binding, the scoped capability opens and shows the task page', async () => {
        ops.length = 0; leaseOwner = { kind: 'none' }
        const target = await openRemote()
        try {
            expect(ops.find((o) => o.op === 'pageViewInfo')).toMatchObject({ bearer: expect.stringMatching(/\.sig-boot$/), body: { schemaVersion: 1, profileId: 'profile-a' } })
            expect(ops.filter((o) => o.bearer.endsWith('.sig-boot')).map((o) => o.op)).toEqual(['pageViewInfo'])
            expect(ops.find((o) => o.op === 'openPageView')?.body).toEqual({ schemaVersion: 1, agentSessionId: SESSION, runtimeBindingId: BINDING, taskId: 'task-1', tabId: 'tab-1' })
            expect(await eventually(() => harness.evaluate(target, `document.getElementById('status').textContent`), (s) => s === 'Observing')).toBe('Observing')
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
            await eventually(() => harness.evaluate(target, `document.getElementById('status').textContent`), (s) => s === 'You have control', 10_000)
            await click(target, box.x + box.width / 2, box.y + box.height / 2)
            const sent = await eventually(() => ops.filter((o) => o.op === 'dispatchPageInput'), (list) => list.some((o) => o.body.event.type === 'mouseReleased'))
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
            await eventually(() => harness.evaluate(target, `document.getElementById('status').textContent`), (s) => s === 'You have control', 10_000)
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
            await eventually(() => refuseFrames, (n) => n === 0, 5_000)
            const reads = frameReads(refusedAt)
            await wait(target, 1500)
            const after = frameReads(refusedAt)
            expect(after.length).toBeGreaterThan(reads.length)
            expect(after[1] - after[0]).toBeGreaterThanOrEqual(950)
        } finally { refuseFrames = 0; await harness.closeTarget(target) }
    })
})
