import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import { expect, it } from 'vitest'
import { CdpConnection } from './cdpConnection'
import { CdpDriver } from './cdpDriver'
import { openNativeBrowserSession } from '../nativeBrowserSession'
import { readNativeSessionOwner } from '../nativeHostPrimitives'
import { personalBrowserArgs } from '../personalBrowserProcess'
import type { BrowserInstanceId } from '../contracts'
import { delay } from './pocTestKit'

// This is an actual macOS Chrome acceptance check, not the Windows pipe contract.
// Never point it at a user's profile or pass --no-sandbox.
it.skipIf(process.platform !== 'darwin')('drives an isolated Chrome through inherited pipes without a debugging port', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'abp-pipe-chrome-'))
    const site = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Native pipe</title><p>Native driver canary</p><button>Continue</button>') })
    await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`
    const chrome = process.env.SAYCODE_NATIVE_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    const child = spawn(chrome, [
        '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
        '--disable-crash-reporter', '--disable-breakpad', `--crash-dumps-dir=${profile}/crashes`,
        '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        '--disable-background-networking', '--disable-sync', '--disable-component-update',
        '--password-store=basic', '--use-mock-keychain', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
    let spawnError: Error | undefined
    let diagnostics = ''
    child.stderr!.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4096) })
    child.once('error', error => { spawnError = error })
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
    const connection = CdpConnection.fromPipe(child.stdio[3] as Writable, child.stdio[4] as Readable, { timeoutMs: 8000 })
    try {
        const version = await connection.send('Browser.getVersion')
        expect(version.product).toMatch(/Chrome/)
        const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' })
        const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })
        const result = await connection.send('Runtime.evaluate', { expression: '21 * 2', returnByValue: true }, sessionId)
        expect(result.result.value).toBe(42)
        await connection.send('Target.closeTarget', { targetId })
        expect(spawnError).toBeUndefined()
        const owner = readNativeSessionOwner(child.pid!)
        expect(owner).toBeDefined()
        const instance = `native-${owner!.bootId}-${owner!.pid}-${owner!.pidStartTime}` as BrowserInstanceId
        let egress: readonly string[] = []
        const driver = new CdpDriver({ connectPipe: async () => ({ connection, browserInstanceId: instance }), setAllowedOrigins: origins => { egress = origins } })
        expect(await driver.connect()).toBe(instance)
        const tab = await driver.openTab(origin, [origin], { timeoutMs: 5000 })
        expect(egress).toEqual([origin])
        const second = await driver.openTab(origin, [origin], { timeoutMs: 5000 })
        const observation = await driver.observe(tab.tabId, [origin], { timeoutMs: 5000 })
        expect(JSON.stringify(observation)).toContain('Native driver canary')
        expect(await driver.closeTab(tab.tabId, { timeoutMs: 5000 })).toEqual({ closed: true })
        expect(egress).toEqual([origin])
        await driver.closeTab(second.tabId, { timeoutMs: 5000 })
        expect(egress).toEqual([])
        await driver.close()
        expect(driver.isConnected()).toBe(false)
    } catch (error) {
        throw new Error(`Isolated Chrome check failed (exit=${child.exitCode}, signal=${child.signalCode}, spawn=${spawnError?.message ?? 'ok'}): ${diagnostics}`, { cause: error })
    } finally {
        connection.close()
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited
        await rm(profile, { recursive: true, force: true })
        await new Promise<void>(resolve => site.close(() => resolve()))
    }
}, 15_000)


it.skipIf(process.platform !== 'darwin')('opens a real basic browser session without a Guard provider', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'abp-basic-chrome-'))
    const site = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Basic mode</title><p>Basic mode canary</p>') })
    await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`
    const chrome = process.env.SAYCODE_NATIVE_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    const child = spawn(chrome, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
        '--disable-sync', '--disable-component-update', '--password-store=basic', '--use-mock-keychain',
        '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', 'about:blank'],
        { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
    let session: Awaited<ReturnType<typeof openNativeBrowserSession>> | undefined
    try {
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
        const owner = readNativeSessionOwner(child.pid!)
        expect(owner).toBeDefined()
        session = await openNativeBrowserSession({ owner: owner!, input: child.stdio[3] as Writable, output: child.stdio[4] as Readable,
            protection: { mode: 'basic', identity: String(process.getuid!()) },
            terminate: async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited },
            checkTimeoutMs: 10000 })
        const tab = await session.driver.openTab(origin, [origin], { timeoutMs: 5000 })
        expect(JSON.stringify(await session.driver.observe(tab.tabId, [origin], { timeoutMs: 5000 }))).toContain('Basic mode canary')
        await session.check()
        expect(await session.close()).toEqual({ terminated: true })
        expect(session.driver.isConnected()).toBe(false)
    } finally {
        await session?.close()
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited
        await rm(profile, { recursive: true, force: true })
        await new Promise<void>(resolve => site.close(() => resolve()))
    }
}, 20000)

// A personal PC gives each owned tab its own headful window, which the user usually leaves behind Saycode or
// minimizes. A command left unanswered past the connection timeout closes the whole connection and with it the
// browser session, so page capture and input must keep answering in those window states (the driver's focus
// emulation on every owned page is what keeps such a page painting).
it.skipIf(process.platform !== 'darwin')('keeps page capture and input answering while an owned headful window is covered or minimized', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'abp-covered-chrome-'))
    const site = createServer((_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end('<title>Covered window</title><style>body{margin:0}input{position:absolute;left:20px;top:20px;width:200px;height:40px}</style>'
            + '<input id="field" oninput="document.getElementById(\'typed\').textContent=\'typed:\'+this.value"><p id="typed" style="margin-top:80px"></p><p id="tick">0</p>'
            + '<script>let n=0;setInterval(()=>{document.getElementById("tick").textContent=String(++n)},100)</script>')
    })
    await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`
    const chrome = process.env.SAYCODE_NATIVE_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    const child = spawn(chrome, personalBrowserArgs('darwin', profile), { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
    const connection = CdpConnection.fromPipe(child.stdio[3] as Writable, child.stdio[4] as Readable, { timeoutMs: 8000 })
    const driver = new CdpDriver({ connectPipe: async () => ({ connection, browserInstanceId: 'native-covered-window' as BrowserInstanceId }) })
    try {
        await driver.connect()
        const tab = await driver.openTab(origin, [origin], { timeoutMs: 5000 })
        const cover = await driver.openTab(origin, [origin], { timeoutMs: 5000 })
        const windowOf = async (targetId: string) => (await connection.send('Browser.getWindowForTarget', { targetId })).windowId as number
        const shown = await windowOf(tab.targetId), covering = await windowOf(cover.targetId)
        await connection.send('Browser.setWindowBounds', { windowId: shown, bounds: { left: 60, top: 60, width: 640, height: 480, windowState: 'normal' } })
        const answersIn = async (state: string, text: string, typed: string) => {
            const frames = []
            for (let i = 0; i < 4; i++) {
                const started = Date.now()
                frames.push(await driver.pageView.capture(tab.tabId, () => {}, 55, 1280))
                expect(Date.now() - started, `${state} capture ${i}`).toBeLessThan(2000)
                await delay(250)
            }
            // The ticking counter is repainted between captures: the page is not frozen on its last frame.
            expect(new Set(frames.map(frame => frame.data)).size, `${state} repaint`).toBeGreaterThan(1)
            const frame = frames[frames.length - 1]
            const pointer = { kind: 'pointer' as const, x: 80, y: 40, button: 'left' as const, buttons: 1, clickCount: 1, modifiers: 0 }
            await driver.pageView.input(tab.tabId, frame, { ...pointer, type: 'mousePressed' }, () => {})
            await driver.pageView.input(tab.tabId, frame, { ...pointer, buttons: 0, type: 'mouseReleased' }, () => {})
            await driver.pageView.input(tab.tabId, frame, { kind: 'text', text }, () => {})
            await driver.pageView.release(tab.tabId)
            expect(JSON.stringify(await driver.observe(tab.tabId, [origin], { timeoutMs: 5000 })), `${state} input`).toContain(`typed:${typed}`)
        }
        await connection.send('Browser.setWindowBounds', { windowId: covering, bounds: { left: 0, top: 0, width: 900, height: 700, windowState: 'normal' } })
        await delay(500)
        await answersIn('covered', '가', '가')
        await connection.send('Browser.setWindowBounds', { windowId: shown, bounds: { windowState: 'minimized' } })
        await delay(500)
        await answersIn('minimized', '나', '가나')
        expect(connection.closed).toBe(false)
    } finally {
        await driver.close().catch(() => undefined)
        connection.close()
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited
        await rm(profile, { recursive: true, force: true })
        await new Promise<void>(resolve => site.close(() => resolve()))
    }
}, 40_000)
