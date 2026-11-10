/**
 * The conversation console against the real Runtime, its page views and a real Chrome page (no fake receipts): an
 * input whose answer never reaches the console. Once Runtime says every input it accepted has an outcome and none is
 * unknown, the console carries on by itself on a new view; the input is never sent again.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CdpDriver } from './drivers/cdpDriver'
import { HarnessCdp, eventually, findChrome, launchChrome, startSite, type LaunchedChrome, type Site } from './drivers/pocTestKit'
import { TaskStore } from './taskStore'
import { BrowserRuntime } from './runtime'
import { startRuntimeServer, type RuntimeServer } from './server'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import { AGENT_OPERATIONS, type AgentGrant, type AuthContext, type InteractiveCapability } from './contracts'

const SESSION = 'session-1'
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[2]!, 'base64url').toString())
const capability = (tag: string, extra: Partial<InteractiveCapability> = {}) => `abp2.${b64({ alg: 'none' })}.${b64({ kind: 'interactive', capabilityId: tag,
    principalId: 'u', workspaceId: 'w', machineId: 'm', viewerSessionId: 'viewer-1', profileId: 'main', operations: ['pageViewInfo'],
    issuedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 600_000, ...extra })}.sig`
async function until<T>(fn: () => T | Promise<T>, ok: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
    const value = await eventually(fn, ok, timeoutMs)
    if (!ok(value)) throw new Error(`condition not met within ${timeoutMs} ms; last value: ${JSON.stringify(value)?.slice(0, 300)}`)
    return value
}

describe.skipIf(!findChrome())('page view input recovery (real Runtime and Chrome page, real console)', () => {
    let pageChrome: LaunchedChrome, consoleChrome: LaunchedChrome, site: Site, driver: CdpDriver, consoleCdp: HarnessCdp, pageCdp: HarnessCdp
    let store: TaskStore, runtime: BrowserRuntime, server: RuntimeServer, dir = ''
    /** Inputs whose answer the transport holds past the console's own 6 s request timeout (Runtime has applied them). */
    let slowAnswers = 0
    const dispatched: Array<{ viewId: string; sequence: number; type: string }> = []

    beforeAll(async () => {
        pageChrome = await launchChrome(); consoleChrome = await launchChrome()
        site = await startSite('a.poc-one.test')
        site.route('/page', '<title>page</title><style>body{margin:0}button{position:absolute;left:40px;top:40px;width:240px;height:80px}</style>'
            + '<button id="btn" onclick="window.clicks=(window.clicks||0)+1">press</button>')
        driver = new CdpDriver({ browserWsUrl: pageChrome.browserWsUrl, browserInstanceIdProvider: async () => 'browser-1' as never, setAllowedOrigins: () => {} })
        await driver.connect()
        dir = await mkdtemp(join(tmpdir(), 'page-view-recovery-'))
        store = await TaskStore.open(dir)
        runtime = new BrowserRuntime({ store, drivers: { main: driver }, sites: fixtureSitePolicies([site.origin]), pageViewEnabled: true })
        const api = new Proxy(runtime, { get(target, prop) {
            const value = (target as any)[prop]
            if (prop !== 'dispatchPageInput') return typeof value === 'function' ? value.bind(target) : value
            return async (auth: AuthContext, req: any) => {
                const receipt = await target.dispatchPageInput(auth, req)
                dispatched.push({ viewId: req.viewId, sequence: req.sequence, type: req.event.type ?? req.event.kind })
                if (req.event.type === 'mouseReleased' && slowAnswers > 0) { slowAnswers--; await new Promise((r) => setTimeout(r, 7_000)) }
                return receipt
            }
        } })
        server = await startRuntimeServer({ api: api as never, port: 0, host: '127.0.0.1', health: () => ({}), consoleScreenMode: 'native-window', consolePageView: true,
            verifyToken: (bearer) => ({ credential: claims(bearer), verifiedAtMs: Date.now() }) })
        consoleCdp = await HarnessCdp.connect(consoleChrome.browserWsUrl)
        pageCdp = await HarnessCdp.connect(pageChrome.browserWsUrl)
    }, 60_000)
    afterAll(async () => {
        consoleCdp?.close(); pageCdp?.close()
        await server?.close(); await driver?.close(); await store?.close(); await site?.close()
        await pageChrome?.stop(); await consoleChrome?.stop()
        if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('an input whose answer is lost is never sent again, and input goes on once Runtime confirms nothing is pending', async () => {
        const grant: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'u' as never, machineId: 'm' as never, workspaceId: 'w' as never, profileId: 'main' as never,
            agentSessionId: SESSION as never, operations: [...AGENT_OPERATIONS], allowedOrigins: [site.origin], taskSpaceIds: [], issuedAtMs: Date.now(), expiresAtMs: Date.now() + 3_600_000 }
        const agent = { credential: grant, verifiedAtMs: Date.now() }
        const space = await runtime.createSpace(agent, { profileId: 'main' as never, requestId: 'space' as never })
        const task = await runtime.createTask(agent, { taskSpaceId: space.taskSpaceId, requestId: 'task' as never })
        await runtime.openPage(agent, { taskId: task.taskId, url: site.url('/page'), requestId: 'open' as never })
        const { runtimeBindingId } = await runtime.pageViewInfo({ credential: claims(capability('info')), verifiedAtMs: Date.now() }, { schemaVersion: 1, profileId: 'main' as never })

        const target = await consoleCdp.openFrontTab(`${server.url}/console?agentSessionId=${SESSION}&lang=en`)
        const inConsole = (expression: string) => consoleCdp.evaluate(target, expression)
        const hand = (token: string) => inConsole(`window.postMessage({ type: 'abp-capability', token: ${JSON.stringify(token)}, expiresAtMs: Date.now() + 600_000 }, location.origin)`)
        const hint = () => inConsole(`document.getElementById('screenHintText').textContent`)
        const reconnectShown = () => inConsole(`!!document.getElementById('pageRetry').getClientRects().length`)
        const page = (await pageCdp.targets()).find((t) => t.type === 'page' && t.url.startsWith(site.origin))!
        const clicks = () => pageCdp.evaluate(page.targetId, 'window.clicks || 0')
        const click = async () => {
            const box = JSON.parse(await inConsole(`JSON.stringify(document.getElementById('page').getBoundingClientRect())`))
            const size = JSON.parse(await pageCdp.evaluate(page.targetId, 'JSON.stringify([innerWidth, innerHeight])'))
            const x = box.x + 160 / size[0] * box.width, y = box.y + 80 / size[1] * box.height
            const { sessionId } = await consoleCdp.conn.send('Target.attachToTarget', { targetId: target, flatten: true })
            try {
                for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
                    await consoleCdp.conn.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, sessionId)
            } finally { await consoleCdp.conn.send('Target.detachFromTarget', { sessionId }).catch(() => undefined) }
        }
        try {
            await until(() => inConsole('window.__abpPageView'), (v) => v === 1)
            await hand(capability('boot'))
            await until(() => inConsole('window.__abpPageViewBinding'), (v) => v === runtimeBindingId)
            await hand(capability('scoped', { operations: ['listTasks', 'getTask', 'takeOver', 'releaseControl', 'resume', 'cancel', 'approve', 'subscribe',
                'openPageView', 'getPageFrame', 'dispatchPageInput', 'closePageView'] as never, pageViewScope: { schemaVersion: 1, agentSessionId: SESSION, runtimeBindingId } }))
            await until(() => inConsole(`!document.getElementById('page').hidden`), Boolean, 15_000)
            await inConsole(`document.getElementById('takeOver').click()`)
            await until(hint, (s) => s === 'You have control. Input reaches the page.', 10_000)

            slowAnswers = 1
            await click()
            await until(clicks, (n) => n === 1, 5_000)
            // The release's answer never arrives in time: the console checks the receipt instead of sending it again...
            await until(hint, (s) => s !== 'You have control. Input reaches the page.', 10_000)
            // ...and, with nothing pending or unknown, goes on by itself on a new view. No Reconnect needed.
            await until(hint, (s) => s === 'You have control. Input reaches the page.', 15_000)
            expect(await reconnectShown()).toBe(false)
            const views = [...new Set(dispatched.map((d) => d.viewId))]
            expect(views).toHaveLength(1)
            await click()
            await until(clicks, (n) => n === 2, 10_000)
            // The second click went to a new view; no input of the first view was sent twice.
            expect(new Set(dispatched.map((d) => d.viewId)).size).toBe(2)
            const sent = dispatched.map((d) => `${d.viewId}#${d.sequence}`)
            expect(new Set(sent).size).toBe(sent.length)
        } finally { slowAnswers = 0; await consoleCdp.closeTarget(target) }
    }, 90_000)
})
