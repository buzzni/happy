/**
 * D12 console page in a real Chrome: the capability arrives in the URL fragment,
 * leaves the address bar at once and is never stored; tasks are listed without a
 * pasted id; renewal is requested before expiry and only a host answer
 * (window.parent, same origin) replaces the token.
 */
import { existsSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderConsolePage } from './consolePage'
import { HarnessCdp, eventually, findChrome, launchChrome, type LaunchedChrome } from './drivers/pocTestKit'
import { serveViewerAsset } from './viewerProxy'

const chromePath = findChrome()
/** The distro noVNC client the Runtime serves at /viewer/ (fit/actual size drives its real RFB object). */
const novncDir = process.env.ABP_VIEWER_ASSETS_DIR ?? '/usr/share/novnc'
const hasNovnc = existsSync(`${novncDir}/vnc_lite.html`)
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = (tag: string, expiresAtMs: number) =>
    `abp2.${b64({ alg: 'EdDSA', kid: 'k', typ: 'abp-cap' })}.${b64({ kind: 'interactive', profileId: 'profile-a', capabilityId: tag, expiresAtMs })}.sig-${tag}`

describe.skipIf(!chromePath)('console page (real Chrome)', () => {
    let chrome: LaunchedChrome
    let harness: HarnessCdp
    let server: http.Server
    let origin = ''
    const port = () => (server.address() as AddressInfo).port
    const ops: Array<{ op: string; bearer: string; body: Record<string, unknown> }> = []
    const defaultTasks = () => [{ taskId: 'task-1', status: 'awaiting-user', pauseReason: 'awaiting-user', tabs: ['tab-1'], updatedAtMs: Date.now() }]
    /** A long poll that does not answer within the test, as a quiet task does. */
    let holdSubscribe = false
    let listedTasks: Array<Record<string, unknown>> = defaultTasks()
    let taskDetail: Record<string, unknown> | undefined
    /** Per-task getTask answers, ahead of taskDetail (a list whose tasks the detail must agree with). */
    let taskDetails: Record<string, Record<string, unknown>> = {}
    /** When set, listTasks answers this error (a capability the Runtime no longer accepts, say). */
    let listTasksError: { code: string; message: string } | null = null
    /** What releaseControl answers: the task as the Runtime reports it after the lease is gone. */
    let releasedTask: Record<string, unknown> | undefined

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            if (url.pathname === '/console') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(renderConsolePage()); return }
            if (url.pathname.startsWith('/viewer/')) {
                // The real noVNC client, as the Runtime serves it; its WebSocket finds no upstream here and just disconnects.
                serveViewerAsset(novncDir, url.pathname, res).then((served) => { if (!served) { res.writeHead(404); res.end() } })
                return
            }
            if (url.pathname === '/console-hosted') {
                // Studio web opens the console in a new window: the host is window.opener on another origin.
                const hostOrigins = url.searchParams.get('trust') === 'none' ? ['http://studio.poc-three.test'] : [`http://studio.poc-one.test:${port()}`]
                res.writeHead(200, { 'content-type': 'text/html' }); res.end(renderConsolePage({ hostOrigins })); return
            }
            if (url.pathname === '/studio') {
                // The opener answers each capability request with the next token in line.
                res.writeHead(200, { 'content-type': 'text/html' })
                res.end(`<!doctype html><script>window.__requests = 0; window.addEventListener('message', (e) => {
                    if (!e.data || e.data.type !== 'abp-capability-request' || e.source !== window.__console) return
                    window.__requests++; window.__requestOrigin = e.origin
                    e.source.postMessage({ type: 'abp-capability', token: window.__tokens.shift(), expiresAtMs: Date.now() + 600_000 }, e.origin)
                })</script>`)
                return
            }
            if (url.pathname === '/forge') {
                // A same-origin frame posting from its own script context: event.source is this frame, not window.parent.
                res.writeHead(200, { 'content-type': 'text/html' })
                res.end(`<!doctype html><script>parent.postMessage({ type: 'abp-capability', token: ${JSON.stringify(token('forged', Date.now() + 600_000))}, expiresAtMs: Date.now() + 600_000 }, location.origin)</script>`)
                return
            }
            const m = /^\/v1\/ops\/(\w+)$/.exec(url.pathname)
            if (!m) { res.writeHead(404); res.end(); return }
            let raw = ''
            req.on('data', (chunk) => { raw += chunk })
            req.on('end', () => {
                const body = JSON.parse(raw || '{}')
                ops.push({ op: m[1], bearer: String(req.headers.authorization ?? '').replace(/^Bearer /, ''), body })
                const result = m[1] === 'listTasks'
                    ? { tasks: listedTasks }
                    : m[1] === 'getTask'
                        ? taskDetails[String(body.taskId)] ?? taskDetail ?? { taskId: body.taskId || 'task-1', status: 'paused', stateVersion: 3, tabs: ['tab-1', 'tab-2'], uncertainActions: [], cancelRequested: false,
                            tabLeases: [{ tabId: 'tab-1', leaseEpoch: 7, owner: { kind: 'none' } }, { tabId: 'tab-2', leaseEpoch: 2, owner: { kind: 'none' } }] }
                        : m[1] === 'subscribe'
                            ? { kind: 'events', events: [{ seq: 1, type: 'state-changed', leaseEpoch: 11, data: {} }] }
                            : m[1] === 'viewerTicket' ? { ticket: `ticket-${ops.filter((entry) => entry.op === 'viewerTicket').length}`, expiresAtMs: Date.now() + 30_000 }
                                : m[1] === 'releaseControl' && releasedTask ? { owner: 'none', task: releasedTask } : {}
                const error = m[1] === 'listTasks' ? listTasksError : null
                // A slow task answers late, after the user may have picked another one.
                // A screen ticket answers after a moment, so a renewal can arrive while the first one is in flight.
                const delay = m[1] === 'getTask' && body.taskId === 'task-slow' ? 800 : m[1] === 'subscribe' && holdSubscribe ? 5_000 : m[1] === 'viewerTicket' ? 300 : 0
                setTimeout(() => {
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify(error ? { ok: false, error } : { ok: true, result }))
                }, delay)
            })
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        chrome = await launchChrome()
        harness = await HarnessCdp.connect(chrome.browserWsUrl)
    }, 60_000)

    afterAll(async () => {
        harness?.close()
        await chrome?.stop()
        await new Promise<void>((resolve) => server?.close(() => resolve()))
    })

    it('uses the fragment capability, strips it, stores nothing, and lists tasks', async () => {
        const first = token('first', Date.now() + 10 * 60_000)
        const target = await harness.openFrontTab(`${origin}/console#abp-cap=${first}&abp-exp=${Date.now() + 10 * 60_000}`)
        const listed = await eventually(() => ops.find((entry) => entry.op === 'listTasks'), Boolean, 10_000)
        expect(listed).toMatchObject({ bearer: first, body: { profileId: 'profile-a' } })
        expect(await harness.evaluate(target, 'location.hash + "|" + sessionStorage.length + "|" + localStorage.length')).toBe('|0|0')
        expect(await harness.evaluate(target, 'document.getElementById("tasks").textContent')).toContain('task-1')
        await harness.closeTarget(target)
    }, 30_000)

    it('asks its host for renewal before expiry and accepts only the host answer', async () => {
        ops.length = 0
        const first = token('renew-1', Date.now() + 61_500)
        const target = await harness.openFrontTab(`${origin}/console#abp-cap=${first}&abp-exp=${Date.now() + 61_500}`)
        await eventually(() => ops.some((entry) => entry.op === 'listTasks'), Boolean, 10_000)
        await harness.evaluate(target, `window.__requests = 0; window.addEventListener('message', (e) => { if (e.data && e.data.type === 'abp-capability-request') window.__requests++ })`)
        expect(await eventually(() => harness.evaluate(target, 'window.__requests'), (count) => count >= 1, 15_000)).toBeGreaterThanOrEqual(1)

        // A same-origin frame is not the host: its answer is ignored.
        await harness.evaluate(target, `new Promise((resolve) => { const f = document.createElement('iframe'); f.src = '/forge'; f.onload = () => resolve(true); document.body.appendChild(f) })`)
        await harness.evaluate(target, `window.postMessage({ type: 'abp-capability', token: 42, expiresAtMs: 1 }, location.origin)`)
        await harness.evaluate(target, `new Promise((r) => setTimeout(r, 200))`)
        ops.length = 0
        await harness.evaluate(target, `document.getElementById('refreshTasks').click()`)
        expect((await eventually(() => ops.find((entry) => entry.op === 'listTasks'), Boolean, 5_000))?.bearer).toBe(first)

        // The host answer (posted into the page itself: webview without preload) replaces the token.
        const renewed = token('renew-2', Date.now() + 600_000)
        await harness.evaluate(target, `window.postMessage({ type: 'abp-capability', token: ${JSON.stringify(renewed)}, expiresAtMs: Date.now() + 600_000 }, location.origin)`)
        await harness.evaluate(target, `new Promise((r) => setTimeout(r, 200))`)
        ops.length = 0
        await harness.evaluate(target, `document.getElementById('refreshTasks').click()`)
        expect((await eventually(() => ops.find((entry) => entry.op === 'listTasks'), Boolean, 5_000))?.bearer).toBe(renewed)
        await harness.closeTarget(target)
    }, 40_000)

    it('asks its host for a capability right away when loaded without one (reload, restore)', async () => {
        ops.length = 0
        const target = await harness.openFrontTab(`${origin}/console`)
        await harness.evaluate(target, `window.__requests = 0; window.addEventListener('message', (e) => { if (e.data && e.data.type === 'abp-capability-request') window.__requests++ })`)
        // The listener is installed after load, so it usually misses the first request and sees the retry
        // (every 10 s): leave room for one retry on a loaded machine.
        expect(await eventually(() => harness.evaluate(target, 'window.__requests'), (count) => count >= 1, 25_000)).toBeGreaterThanOrEqual(1)
        const cap = token('boot', Date.now() + 600_000)
        await harness.evaluate(target, `window.postMessage({ type: 'abp-capability', token: ${JSON.stringify(cap)}, expiresAtMs: Date.now() + 600_000 }, location.origin)`)
        expect((await eventually(() => ops.find((entry) => entry.op === 'listTasks'), Boolean, 5_000))?.bearer).toBe(cap)
        await harness.closeTarget(target)
    }, 45_000)

    it("takes over with the selected tab's own lease epoch", async () => {
        ops.length = 0
        const cap = token('epoch', Date.now() + 600_000)
        const target = await harness.openFrontTab(`${origin}/console#abp-cap=${cap}&abp-exp=${Date.now() + 600_000}`)
        await eventually(() => ops.some((entry) => entry.op === 'listTasks'), Boolean, 10_000)
        await harness.evaluate(target, `document.getElementById('taskId').value = 'task-1'; document.getElementById('connect').click()`)
        await eventually(() => ops.some((entry) => entry.op === 'subscribe'), Boolean, 5_000)
        // This page's own task (with its tab leases) is shown: a subscribe still arriving from the previous test's page says nothing about it.
        await eventually(() => harness.evaluate(target, `(document.getElementById('detailId') || {}).textContent`), (id) => id === 'task-1', 5_000)
        await harness.evaluate(target, `document.getElementById('tabId').value = 'tab-2'; document.getElementById('takeOver').click()`)
        expect((await eventually(() => ops.find((entry) => entry.op === 'takeOver'), Boolean, 5_000))?.body).toMatchObject({ tabId: 'tab-2', expectedEpoch: 2 })
        await harness.closeTarget(target)
    }, 30_000)

    it('reconnects an open screen with a fresh ticket when the capability is renewed', async () => {
        ops.length = 0
        const cap = token('screen-renew', Date.now() + 600_000)
        const target = await harness.openFrontTab(`${origin}/console#abp-cap=${cap}&abp-exp=${Date.now() + 600_000}`)
        await eventually(() => ops.some((entry) => entry.op === 'listTasks'), Boolean, 10_000)
        await harness.evaluate(target, `document.getElementById('openScreen').click()`)
        await eventually(() => ops.filter((entry) => entry.op === 'viewerTicket').length === 1, Boolean, 5_000)
        const renewed = token('screen-renew-2', Date.now() + 900_000)
        await harness.evaluate(target, `window.postMessage({ type: 'abp-capability', token: ${JSON.stringify(renewed)}, expiresAtMs: Date.now() + 900_000 }, location.origin)`)
        const second = await eventually(() => ops.filter((entry) => entry.op === 'viewerTicket')[1], Boolean, 5_000)
        expect(second?.bearer).toBe(renewed)
        // The fake server records the request before the page has applied its reply to the iframe.
        expect(await eventually(() => harness.evaluate(target, `document.getElementById('screen').src`), (src) => String(src).includes(encodeURIComponent('ticket=ticket-2')), 5_000))
            .toContain(encodeURIComponent('ticket=ticket-2'))
        await harness.closeTarget(target)
    }, 30_000)

    it('switches to a capability given by a later fragment change, and strips it again', async () => {
        ops.length = 0
        const first = token('hash-1', Date.now() + 600_000)
        const target = await harness.openFrontTab(`${origin}/console#abp-cap=${first}&abp-exp=${Date.now() + 600_000}`)
        await eventually(() => ops.some((entry) => entry.op === 'listTasks'), Boolean, 10_000)
        ops.length = 0
        const second = token('hash-2', Date.now() + 600_000)
        await harness.evaluate(target, `location.hash = 'abp-cap=${second}&abp-exp=${Date.now() + 600_000}'`)
        expect((await eventually(() => ops.find((entry) => entry.op === 'listTasks'), Boolean, 5_000))?.bearer).toBe(second)
        expect(await harness.evaluate(target, 'location.hash')).toBe('')
        await harness.closeTarget(target)
    }, 30_000)

    it('lists the tasks waiting for the user first and folds the other open tasks away', async () => {
        ops.length = 0
        const now = Date.now()
        listedTasks = [
            { taskId: 'task-idle', status: 'paused', pauseReason: 'awaiting-agent', tabs: [], updatedAtMs: now },
            { taskId: 'task-approval', status: 'paused', pauseReason: 'awaiting-user', pendingApproval: { approvalId: 'a' }, tabs: [], updatedAtMs: now },
            { taskId: 'task-login', status: 'awaiting-user', waitReason: 'handoff', tabs: [], updatedAtMs: now },
            { taskId: 'task-running', status: 'running', tabs: [], updatedAtMs: now },
            // The chat turn ended during a login wait (its grant revoked): still the user's move.
            { taskId: 'task-login-parked', status: 'paused', pauseReason: 'grant-expired', waitReason: 'login', tabs: [], updatedAtMs: now },
            // A stale approval on a task being cancelled is nothing to act on.
            { taskId: 'task-cancelling', status: 'paused', pauseReason: 'cancelled-with-unknown-effect', cancelRequested: true, pendingApproval: { approvalId: 'old' }, tabs: [], updatedAtMs: now },
        ]
        // The task that opens by itself answers getTask as the list described it (the badge follows the shown task's state).
        taskDetails = { 'task-approval': { ...listedTasks[1], stateVersion: 1, uncertainActions: [], cancelRequested: false, tabLeases: [],
            pendingApproval: { approvalId: 'a', description: 'Open the site', origin: 'https://site.test', expiresAtMs: now + 60_000, bindingHash: 'h' } } }
        try {
            const cap = token('fold', Date.now() + 600_000)
            // The language is explicit: the page otherwise follows the browser's.
            const target = await harness.openFrontTab(`${origin}/console?lang=en#abp-cap=${cap}&abp-exp=${Date.now() + 600_000}`)
            await eventually(() => harness.evaluate(target, `document.querySelectorAll('#tasks button').length`), (n) => n === 6, 10_000)
            const layout = await harness.evaluate(target, `JSON.stringify({
                top: [...document.querySelectorAll('#tasks > button')].map((b) => b.textContent.split(' ')[0]),
                folded: [...document.querySelectorAll('#tasks details button')].map((b) => b.textContent.split(' ')[0]),
                open: document.querySelector('#tasks details').open,
                summary: document.querySelector('#tasks summary').textContent })`)
            expect(JSON.parse(String(layout))).toEqual({
                top: ['task-approval', 'task-login', 'task-login-parked'], folded: ['task-idle', 'task-running', 'task-cancelling'], open: false, summary: '3 other open tasks',
            })
            await harness.closeTarget(target)
            const korean = await harness.openFrontTab(`${origin}/console?lang=ko#abp-cap=${token('fold-ko', Date.now() + 600_000)}&abp-exp=${Date.now() + 600_000}`)
            expect(await eventually(() => harness.evaluate(korean, `(document.querySelector('#tasks summary') || {}).textContent`), Boolean, 10_000)).toBe('다른 작업 3개')
            expect(await harness.evaluate(korean, 'document.documentElement.lang')).toBe('ko')
            await harness.closeTarget(korean)
        } finally { listedTasks = defaultTasks(); holdSubscribe = false; taskDetails = {} }
    }, 30_000)

    it("keeps the task the user picked when the automatically opened one answers late", async () => {
        listedTasks = [{ taskId: 'task-slow', status: 'awaiting-user', tabs: ['tab-1'], updatedAtMs: Date.now() }]
        holdSubscribe = true
        try {
            const cap = token('race', Date.now() + 600_000)
            const target = await harness.openFrontTab(`${origin}/console?lang=en#abp-cap=${cap}&abp-exp=${Date.now() + 600_000}`)
            await eventually(() => ops.some((entry) => entry.op === 'getTask' && entry.body.taskId === 'task-slow'), Boolean, 10_000)
            await harness.evaluate(target, `document.getElementById('taskId').value = 'task-1'; document.getElementById('connect').click()`)
            await harness.evaluate(target, `new Promise((r) => setTimeout(r, 1500))`)
            expect(await harness.evaluate(target, `document.getElementById('detailId').textContent`)).toBe('task-1')
            await harness.closeTarget(target)
        } finally { listedTasks = defaultTasks() }
    }, 30_000)

    it('tells the user to resume after they released control, though the wait reason stays recorded', async () => {
        const now = Date.now()
        // The Runtime keeps waitReason on the task after release (user-input-complete) and after the wait expired.
        const released = { taskId: 'task-released', status: 'paused', pauseReason: 'user-input-complete', waitReason: 'login', tabs: ['tab-1'], updatedAtMs: now }
        listedTasks = [
            released,
            { taskId: 'task-login-parked', status: 'paused', pauseReason: 'grant-expired', waitReason: 'login', tabs: [], updatedAtMs: now },
            { taskId: 'task-expired', status: 'paused', pauseReason: 'user-wait-expired', waitReason: 'login', tabs: [], updatedAtMs: now },
        ]
        taskDetail = { ...released, stateVersion: 4, uncertainActions: [], cancelRequested: false, tabLeases: [{ tabId: 'tab-1', leaseEpoch: 2, owner: { kind: 'none' } }] }
        try {
            const target = await harness.openFrontTab(`${origin}/console?lang=en#abp-cap=${token('released', Date.now() + 600_000)}&abp-exp=${Date.now() + 600_000}`)
            await eventually(() => harness.evaluate(target, `document.querySelectorAll('#tasks button').length`), (n) => n === 3, 10_000)
            const chips = await harness.evaluate(target, `JSON.stringify(Object.fromEntries([...document.querySelectorAll('#tasks button')]
                .map((b) => [b.getAttribute('data-task'), b.querySelector('.chip').textContent])))`)
            expect(JSON.parse(String(chips))).toEqual({ 'task-released': 'Released', 'task-login-parked': 'Login needed', 'task-expired': 'Paused' })
            await harness.evaluate(target, `document.querySelector('[data-task="task-released"]').click()`)
            await eventually(() => harness.evaluate(target, `(() => { const d = document.getElementById('detail'); return !!d && !d.hidden })()`), Boolean, 10_000)
            const detail = await harness.evaluate(target, `JSON.stringify({ title: document.getElementById('detailTitle').textContent,
                reason: document.getElementById('detailReason').textContent, takeOver: document.getElementById('takeOver').className,
                resume: document.getElementById('resume').className })`)
            expect(JSON.parse(String(detail))).toEqual({ title: 'Released', reason: 'Resume to hand the page back to the agent, or wait for it to continue.', takeOver: '', resume: 'primary' })
            await harness.closeTarget(target)
        } finally { listedTasks = defaultTasks(); taskDetail = undefined }
    }, 30_000)

    it('opens the screen through a one-time viewer ticket for the capability profile', async () => {
        ops.length = 0
        const cap = token('screen', Date.now() + 600_000)
        const target = await harness.openFrontTab(`${origin}/console#abp-cap=${cap}&abp-exp=${Date.now() + 600_000}`)
        await eventually(() => ops.some((entry) => entry.op === 'listTasks'), Boolean, 10_000)
        await harness.evaluate(target, `document.getElementById('openScreen').click()`)
        expect(await eventually(() => ops.find((entry) => entry.op === 'viewerTicket'), Boolean, 5_000)).toMatchObject({ bearer: cap, body: { profileId: 'profile-a' } })
        // Also kept on the console window: a preview relay strips the frame's query (vnc_lite.html restores it from here).
        expect(await eventually(() => harness.evaluate(target, 'window.__abpViewerPath'), Boolean, 5_000)).toMatch(/^v1\/viewer\/websockify\?ticket=ticket-/)
        await harness.closeTarget(target)
    }, 30_000)

    const withSession = async <T>(targetId: string, fn: (sessionId: string) => Promise<T>): Promise<T> => {
        const { sessionId } = await harness.conn.send('Target.attachToTarget', { targetId, flatten: true })
        try { return await fn(sessionId) } finally { await harness.conn.send('Target.detachFromTarget', { sessionId }).catch(() => undefined) }
    }
    /** A real key press (CDP input), as the keyboard reaches the page; synthetic events do not toggle a <details>. */
    const pressKey = (targetId: string, key: string, code: string, keyCode: number) => withSession(targetId, async (sessionId) => {
        await harness.conn.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text: key === 'Enter' ? '\r' : undefined }, sessionId)
        await harness.conn.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode }, sessionId)
    })
    /** The page in a window of this width (CDP emulation, for the time of the callback). */
    const atWidth = (targetId: string, width: number, expression: string) => withSession(targetId, async (sessionId) => {
        await harness.conn.send('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 1, mobile: false }, sessionId)
        try {
            const result = await harness.conn.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
            if (result.exceptionDetails) throw new Error(`harness evaluate failed: ${result.exceptionDetails.text}`)
            return result.result?.value
        } finally { await harness.conn.send('Emulation.clearDeviceMetricsOverride', {}, sessionId).catch(() => undefined) }
    })

    it('gives the screen the console width and the remaining height, with no fixed task column', async () => {
        ops.length = 0
        const target = await harness.openFrontTab(`${origin}/console?lang=en#abp-cap=${token('layout', Date.now() + 600_000)}&abp-exp=${Date.now() + 600_000}`)
        await eventually(() => harness.evaluate(target, `(() => { const d = document.getElementById('detail'); return !!d && !d.hidden })()`), Boolean, 10_000)
        await harness.evaluate(target, `document.getElementById('openScreen').click()`)
        await eventually(() => harness.evaluate(target, `!document.getElementById('screenBox').hidden`), Boolean, 5_000)
        const layout = JSON.parse(String(await harness.evaluate(target, `(() => { const box = document.getElementById('screenBox').getBoundingClientRect();
            const head = document.querySelector('.screen-head').getBoundingClientRect();
            return JSON.stringify({ aside: !!document.querySelector('aside'), maxWidth: getComputedStyle(document.querySelector('main')).maxWidth,
                width: box.width / document.documentElement.clientWidth, bottomGap: window.innerHeight - box.bottom, height: box.height,
                // What is left under the screen's head line (12px gap above, 12px page padding below) is the screen's.
                remaining: window.innerHeight - head.bottom - 24,
                menuAbove: document.getElementById('taskMenu').getBoundingClientRect().bottom <= box.top,
                controlsAbove: document.getElementById('takeOver').getBoundingClientRect().bottom <= box.top,
                brandClear: document.querySelector('header h1').getBoundingClientRect().right <= document.getElementById('taskMenu').getBoundingClientRect().left }) })()`)))
        expect(layout.aside).toBe(false)
        expect(layout.maxWidth).toBe('none')
        expect(layout.width).toBeGreaterThanOrEqual(0.9)
        expect(layout.bottomGap).toBeLessThanOrEqual(24)
        expect(layout.height).toBeGreaterThanOrEqual(layout.remaining - 1)
        expect(layout.height).toBeGreaterThanOrEqual(240)
        expect(layout.menuAbove).toBe(true)
        expect(layout.controlsAbove).toBe(true)
        expect(layout.brandClear).toBe(true)
        await harness.closeTarget(target)
    }, 30_000)

    it('offers the tasks in a top menu that keeps the number of tasks needing the user in view', async () => {
        const now = Date.now()
        listedTasks = [
            { taskId: 'task-idle', status: 'paused', pauseReason: 'awaiting-agent', tabs: [], updatedAtMs: now },
            { taskId: 'task-approval', status: 'paused', pauseReason: 'awaiting-user', pendingApproval: { approvalId: 'a' }, tabs: [], updatedAtMs: now },
            { taskId: 'task-login', status: 'awaiting-user', waitReason: 'login', tabs: [], updatedAtMs: now },
        ]
        // getTask agrees with the list (the badge follows the task's own state once it is shown).
        taskDetails = {
            'task-approval': { ...listedTasks[1], stateVersion: 1, uncertainActions: [], cancelRequested: false, tabLeases: [],
                pendingApproval: { approvalId: 'a', description: 'Open the site', origin: 'https://site.test', expiresAtMs: now + 60_000, bindingHash: 'h' } },
            'task-login': { ...listedTasks[2], stateVersion: 1, uncertainActions: [], cancelRequested: false, tabLeases: [] },
        }
        try {
            const target = await harness.openFrontTab(`${origin}/console?lang=en#abp-cap=${token('menu', Date.now() + 600_000)}&abp-exp=${Date.now() + 600_000}`)
            await eventually(() => harness.evaluate(target, `document.querySelectorAll('#tasks button').length`), (n) => n === 3, 10_000)
            // The first task needing the user opens by itself; the menu stays closed and still says how many need the user.
            await eventually(() => harness.evaluate(target, `document.getElementById('detailId').textContent`), (id) => id === 'task-approval', 10_000)
            // The menu names the selected task as the detail does (the fake getTask answers a plain paused task).
            const closed = JSON.parse(String(await harness.evaluate(target, `JSON.stringify({ open: document.getElementById('taskMenu').open,
                count: document.getElementById('needCount').textContent, label: document.getElementById('taskMenuLabel').textContent,
                name: document.getElementById('taskMenuButton').getAttribute('aria-label'), title: document.getElementById('detailTitle').textContent,
                button: document.getElementById('taskMenuButton').tagName, focusable: document.getElementById('taskMenuButton').tabIndex >= 0,
                expanded: document.getElementById('taskMenuButton').getAttribute('aria-expanded'),
                folded: ['eventsPanel', 'advanced'].map((id) => document.getElementById(id).hidden) })`)))
            expect(closed).toEqual({ open: false, count: '2', label: 'Needs your approval · task-approval', name: 'Needs your approval · task-approval, 2 tasks need you', title: 'Needs your approval',
                button: 'SUMMARY', focusable: true, expanded: 'false', folded: [true, true] })
            // Opened from the keyboard it lists the tasks (those needing the user first, as before); picking one closes it and shows that task.
            await harness.evaluate(target, `document.getElementById('taskMenuButton').focus()`)
            await pressKey(target, 'Enter', 'Enter', 13)
            // aria-expanded follows the <details> toggle event, which is dispatched asynchronously after `open` changes.
            expect(await eventually(() => harness.evaluate(target, `document.getElementById('taskMenuButton').getAttribute('aria-expanded')`), (v) => v === 'true', 5_000)).toBe('true')
            expect(await harness.evaluate(target, `JSON.stringify({ open: document.getElementById('taskMenu').open,
                top: [...document.querySelectorAll('#tasks > button')].map((b) => b.getAttribute('data-task')) })`)).toBe(JSON.stringify({ open: true, top: ['task-approval', 'task-login'] }))
            await harness.evaluate(target, `document.querySelector('[data-task="task-login"]').click()`)
            await eventually(() => harness.evaluate(target, `document.getElementById('detailId').textContent`), (id) => id === 'task-login', 10_000)
            expect(await harness.evaluate(target, `JSON.stringify({ open: document.getElementById('taskMenu').open, label: document.getElementById('taskMenuLabel').textContent, focus: document.activeElement.id })`))
                .toBe(JSON.stringify({ open: false, label: 'Login needed · task-login', focus: 'taskMenuButton' }))
            // In a narrow window the open panel stays inside the viewport (slid left of its button, 12px from the edge at most).
            // (The <details> toggle event, which places the panel, is dispatched asynchronously: measure after it.)
            const narrow = JSON.parse(String(await atWidth(target, 360, `new Promise((resolve) => { document.getElementById('taskMenu').open = true; setTimeout(() => {
                const p = document.querySelector('#taskMenu .menu-panel').getBoundingClientRect(), b = document.getElementById('taskMenuButton').getBoundingClientRect();
                document.getElementById('taskMenu').open = false;
                resolve(JSON.stringify({ left: p.left, right: Math.round(p.right), width: Math.round(p.width), under: p.top >= b.bottom, viewport: document.documentElement.clientWidth })) }, 100) })`)))
            expect(narrow.viewport).toBe(360)
            expect(narrow.left).toBeGreaterThanOrEqual(12)
            expect(narrow.right).toBeLessThanOrEqual(360 - 12)
            expect(narrow.width).toBe(360 - 24)
            expect(narrow.under).toBe(true)
            // Escape closes an open menu and returns focus to its button.
            await harness.evaluate(target, `document.getElementById('taskMenuButton').click()`)
            await eventually(() => harness.evaluate(target, `document.getElementById('taskMenu').open`), Boolean, 5_000)
            await pressKey(target, 'Escape', 'Escape', 27)
            expect(await eventually(() => harness.evaluate(target, `document.getElementById('taskMenu').open`), (open) => open === false, 5_000)).toBe(false)
            expect(await harness.evaluate(target, `document.activeElement.id`)).toBe('taskMenuButton')
            await harness.closeTarget(target)
        } finally { listedTasks = defaultTasks(); taskDetails = {} }
    }, 30_000)

    it.skipIf(!hasNovnc)('switches the open screen between fit and actual size in place, and keeps the choice across a reconnect', async () => {
        ops.length = 0
        const cap = token('fit', Date.now() + 600_000)
        const target = await harness.openFrontTab(`${origin}/console?lang=en#abp-cap=${cap}&abp-exp=${Date.now() + 600_000}`)
        await eventually(() => ops.some((entry) => entry.op === 'listTasks'), Boolean, 10_000)
        await harness.evaluate(target, `document.getElementById('openScreen').click()`)
        const rfb = `document.getElementById('screen').contentWindow.__abpRfb`
        // Fit is the default: noVNC's own scaleViewport on its RFB object (input coordinates follow), never a CSS transform.
        expect(await eventually(() => harness.evaluate(target, `(() => { try { return (${rfb} || {}).scaleViewport } catch (e) { return e.message } })()`), (v) => v === true, 10_000)).toBe(true)
        expect(await harness.evaluate(target, `document.getElementById('fitToggle').getAttribute('aria-pressed')`)).toBe('true')
        const src = await harness.evaluate(target, `document.getElementById('screen').src`)
        const pressed = `[document.getElementById('fitToggle'), document.getElementById('actualSize')].map((b) => b.getAttribute('aria-pressed'))`
        expect(await harness.evaluate(target, `JSON.stringify(${pressed})`)).toBe(JSON.stringify(['true', 'false']))
        await harness.evaluate(target, `document.getElementById('actualSize').click()`)
        expect(await eventually(() => harness.evaluate(target, `${rfb}.scaleViewport`), (v) => v === false, 5_000)).toBe(false)
        // Actual size is a display change only: same frame, same ticket, and the remote resolution is never requested to change.
        expect(await harness.evaluate(target, `JSON.stringify({ pressed: ${pressed}, src: document.getElementById('screen').src, resize: ${rfb}.resizeSession })`))
            .toBe(JSON.stringify({ pressed: ['false', 'true'], src, resize: false }))
        expect(ops.filter((entry) => entry.op === 'viewerTicket').length).toBe(1)
        // A renewal reconnects the screen (new frame, new ticket): it starts in the mode the user chose.
        await harness.evaluate(target, `document.getElementById('screen').contentWindow.__abpOldFrame = true`)
        const renewed = token('fit-2', Date.now() + 900_000)
        await harness.evaluate(target, `window.postMessage({ type: 'abp-capability', token: ${JSON.stringify(renewed)}, expiresAtMs: Date.now() + 900_000 }, location.origin)`)
        await eventually(() => ops.filter((entry) => entry.op === 'viewerTicket').length, (n) => n === 2, 5_000)
        const fresh = `(() => { const w = document.getElementById('screen').contentWindow; return !w.__abpOldFrame && w.__abpRfb ? w.__abpRfb.scaleViewport : 'pending' })()`
        expect(await eventually(() => harness.evaluate(target, fresh), (v) => v !== 'pending', 10_000)).toBe(false)
        expect(await harness.evaluate(target, `JSON.stringify(${pressed})`)).toBe(JSON.stringify(['false', 'true']))
        // Back to fit, still in place on the reconnected frame.
        await harness.evaluate(target, `document.getElementById('fitToggle').click()`)
        expect(await eventually(() => harness.evaluate(target, `${rfb}.scaleViewport`), (v) => v === true, 5_000)).toBe(true)
        expect(await harness.evaluate(target, `JSON.stringify(${pressed})`)).toBe(JSON.stringify(['true', 'false']))
        expect(ops.filter((entry) => entry.op === 'viewerTicket').length).toBe(2)
        await harness.closeTarget(target)
    }, 40_000)

    it('shows a task list failure above the task with a retry, not only inside the closed menu', async () => {
        listTasksError = { code: 'UNAUTHORIZED', message: 'capability rejected' }
        try {
            const target = await harness.openFrontTab(`${origin}/console?lang=en#abp-cap=${token('list-fail', Date.now() + 600_000)}&abp-exp=${Date.now() + 600_000}`)
            await eventually(() => harness.evaluate(target, `!document.getElementById('notice').hidden`), Boolean, 10_000)
            const shown = JSON.parse(String(await harness.evaluate(target, `(() => { const n = document.getElementById('notice'), r = n.getBoundingClientRect();
                return JSON.stringify({ role: n.getAttribute('role'), text: document.getElementById('noticeText').textContent, visible: r.width > 0 && r.height > 0,
                    menuOpen: document.getElementById('taskMenu').open, inMenu: !!n.closest('#taskMenu') }) })()`)))
            expect(shown).toEqual({ role: 'alert', text: 'Could not load the tasks · UNAUTHORIZED: capability rejected', visible: true, menuOpen: false, inMenu: false })
            // Retry from the notice; once the list answers, the notice goes away.
            listTasksError = null
            ops.length = 0
            await harness.evaluate(target, `document.getElementById('noticeRetry').click()`)
            await eventually(() => ops.some((entry) => entry.op === 'listTasks'), Boolean, 5_000)
            await eventually(() => harness.evaluate(target, `document.getElementById('notice').hidden`), Boolean, 5_000)
            expect(await harness.evaluate(target, `document.getElementById('tasks').textContent`)).toContain('task-1')
            await harness.closeTarget(target)
        } finally { listTasksError = null }
    }, 30_000)

    it("updates the number of tasks needing the user from the task's own state changes, not only from a list refresh", async () => {
        const now = Date.now()
        const holding = { taskId: 'task-a', status: 'paused', pauseReason: 'user-control', stateVersion: 4, tabs: ['tab-1'], updatedAtMs: now, uncertainActions: [], cancelRequested: false,
            tabLeases: [{ tabId: 'tab-1', leaseEpoch: 7, owner: { kind: 'user' } }] }
        const released = { ...holding, pauseReason: 'user-input-complete', stateVersion: 5, tabLeases: [{ tabId: 'tab-1', leaseEpoch: 8, owner: { kind: 'none' } }] }
        listedTasks = [holding]; taskDetail = holding; releasedTask = released
        try {
            const target = await harness.openFrontTab(`${origin}/console?lang=en#abp-cap=${token('badge', Date.now() + 600_000)}&abp-exp=${Date.now() + 600_000}`)
            await eventually(() => harness.evaluate(target, `(document.getElementById('detailId') || {}).textContent`), (id) => id === 'task-a', 10_000)
            const badge = `JSON.stringify({ count: document.getElementById('needCount').textContent, hidden: document.getElementById('needCount').hidden,
                name: document.getElementById('taskMenuButton').getAttribute('aria-label'), top: [...document.querySelectorAll('#tasks > button')].map((b) => b.getAttribute('data-task')) })`
            expect(await harness.evaluate(target, badge)).toBe(JSON.stringify({ count: '1', hidden: false, name: 'You have control · task-a, 1 task needs you', top: ['task-a'] }))
            ops.length = 0
            taskDetail = released
            await harness.evaluate(target, `document.getElementById('release').click()`)
            await eventually(() => ops.some((entry) => entry.op === 'releaseControl'), Boolean, 5_000)
            // The answer carries the task: the bar, the badge and the list follow it without another listTasks.
            await eventually(() => harness.evaluate(target, `document.getElementById('detailTitle').textContent`), (title) => title === 'Released', 5_000)
            expect(await harness.evaluate(target, badge)).toBe(JSON.stringify({ count: '0', hidden: true, name: 'Released · task-a', top: [] }))
            expect(ops.filter((entry) => entry.op === 'listTasks').length).toBe(0)
            await harness.closeTarget(target)
        } finally { listedTasks = defaultTasks(); taskDetail = undefined; releasedTask = undefined }
    }, 30_000)

    it('closes the task menu on a click into the screen frame and when the window loses focus', async () => {
        ops.length = 0
        const target = await harness.openFrontTab(`${origin}/console?lang=en#abp-cap=${token('menu-frame', Date.now() + 600_000)}&abp-exp=${Date.now() + 600_000}`)
        await eventually(() => ops.some((entry) => entry.op === 'listTasks'), Boolean, 10_000)
        await harness.evaluate(target, `document.getElementById('openScreen').click()`)
        // The frame's own document (not the initial about:blank one), loaded: the console arms it on load.
        await eventually(() => harness.evaluate(target, `(() => { try { const w = document.getElementById('screen').contentWindow; return !!w && w.location.pathname.indexOf('/viewer/') === 0 && w.document.readyState === 'complete' } catch (e) { return false } })()`), Boolean, 10_000)
        // A pointer down inside the frame's document (where the parent sees no event) closes the menu.
        await harness.evaluate(target, `document.getElementById('taskMenu').open = true`)
        await eventually(() => harness.evaluate(target, `document.getElementById('taskMenuButton').getAttribute('aria-expanded')`), (v) => v === 'true', 5_000)
        await harness.evaluate(target, `document.getElementById('screen').contentDocument.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
        expect(await eventually(() => harness.evaluate(target, `document.getElementById('taskMenu').open`), (open) => open === false, 5_000)).toBe(false)
        // So does the window losing focus (to the frame, or to anything else).
        await harness.evaluate(target, `document.getElementById('taskMenu').open = true`)
        await eventually(() => harness.evaluate(target, `document.getElementById('taskMenu').open`), Boolean, 5_000)
        await harness.evaluate(target, `window.dispatchEvent(new Event('blur'))`)
        expect(await eventually(() => harness.evaluate(target, `document.getElementById('taskMenu').open`), (open) => open === false, 5_000)).toBe(false)
        await harness.closeTarget(target)
    }, 30_000)

    /** The opener page, once its script has run (openFrontTab does not wait for the load). */
    const openStudio = async () => {
        const studio = await harness.openFrontTab(`http://studio.poc-one.test:${port()}/studio`)
        await eventually(() => harness.evaluate(studio, 'typeof window.__requests'), (type) => type === 'number', 10_000)
        return studio
    }

    it('takes its capability from the Studio window that opened it, and only from a trusted origin', async () => {
        ops.length = 0
        const cap = token('opener', Date.now() + 600_000)
        const studio = await openStudio()
        await harness.evaluate(studio, `window.__tokens = [${JSON.stringify(cap)}]; window.__console = window.open(${JSON.stringify(`${origin}/console-hosted`)}); !!window.__console`, { userGesture: true })
        expect((await eventually(() => ops.find((entry) => entry.op === 'listTasks'), Boolean, 10_000))?.bearer).toBe(cap)
        expect(await harness.evaluate(studio, 'window.__requestOrigin')).toBe(origin)
        await harness.evaluate(studio, 'window.__console.close()')
        await harness.closeTarget(studio)
    }, 30_000)

    it('ignores an opener whose origin is not a configured host', async () => {
        ops.length = 0
        const studio = await openStudio()
        await harness.evaluate(studio, `window.__tokens = [${JSON.stringify(token('untrusted', Date.now() + 600_000))}]; window.__console = window.open(${JSON.stringify(`${origin}/console-hosted?trust=none`)}); !!window.__console`, { userGesture: true })
        await new Promise((resolve) => setTimeout(resolve, 3_000))
        // The request is addressed to the configured origin only, so this opener never hears it.
        expect(await harness.evaluate(studio, 'window.__requests')).toBe(0)
        // Nor is a capability it pushes unasked accepted: the answer must come from a configured origin.
        await harness.evaluate(studio, `window.__console.postMessage({ type: 'abp-capability', token: ${JSON.stringify(token('pushed', Date.now() + 600_000))}, expiresAtMs: Date.now() + 600_000 }, '*')`)
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        expect(ops.some((entry) => entry.op === 'listTasks')).toBe(false)
        await harness.evaluate(studio, 'window.__console.close()')
        await harness.closeTarget(studio)
    }, 30_000)
})
