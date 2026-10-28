import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import { expect, it } from 'vitest'
import { CdpConnection } from './cdpConnection'
import { CdpDriver } from './cdpDriver'
import { readNativeSessionOwner } from '../nativeHostPrimitives'
import type { BrowserInstanceId } from '../contracts'

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
        const driver = new CdpDriver({ connectPipe: async () => ({ connection, browserInstanceId: instance }) })
        expect(await driver.connect()).toBe(instance)
        const tab = await driver.openTab(origin, [origin], { timeoutMs: 5000 })
        const observation = await driver.observe(tab.tabId, [origin], { timeoutMs: 5000 })
        expect(JSON.stringify(observation)).toContain('Native driver canary')
        expect(await driver.closeTab(tab.tabId, { timeoutMs: 5000 })).toEqual({ closed: true })
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
