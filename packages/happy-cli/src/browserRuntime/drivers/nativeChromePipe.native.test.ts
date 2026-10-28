import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import { expect, it } from 'vitest'
import { CdpConnection } from './cdpConnection'

// This is an actual macOS Chrome acceptance check, not the Windows pipe contract.
// Never point it at a user's profile or pass --no-sandbox.
it.skipIf(process.platform !== 'darwin')('drives an isolated Chrome through inherited pipes without a debugging port', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'abp-pipe-chrome-'))
    const chrome = process.env.SAYCODE_NATIVE_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    const child = spawn(chrome, [
        '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
        '--disable-crash-reporter', '--disable-breakpad', `--crash-dumps-dir=${profile}/crashes`,
        '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        '--disable-background-networking', '--disable-sync', '--disable-component-update',
        '--password-store=basic', '--use-mock-keychain', '--host-resolver-rules=MAP * ~NOTFOUND', 'about:blank',
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
    } catch (error) {
        throw new Error(`Isolated Chrome check failed (exit=${child.exitCode}, signal=${child.signalCode}, spawn=${spawnError?.message ?? 'ok'}): ${diagnostics}`, { cause: error })
    } finally {
        connection.close()
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited
        await rm(profile, { recursive: true, force: true })
    }
}, 15_000)
