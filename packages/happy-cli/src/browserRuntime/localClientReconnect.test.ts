/** Reconnect failure paths exercise the real private descriptor and kernel lock on Linux. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { reconnectLocalClient } from './localClientReconnect'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function harness() {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'reconnect-client-'))); dirs.push(cwd)
    const file = join(cwd, 'connection.json')
    const options = { cwd, socketPath: '/broker.sock', sessionSecret: 'owner-secret', profileId: 'p' }
    const descriptor = { schemaVersion: 2, brokerSocket: options.socketPath, runtimeUrl: 'http://127.0.0.1:38700',
        clientSecret: 'old-client-secret', clientSessionId: 'old-client', profileId: 'p', taskSpaceId: 'space',
        expiresAtMs: Date.now() + 60_000, appId: 'app-test', appSecret: 'a'.repeat(43), projectRoot: cwd, outFile: file,
        origins: ['https://fixture.test'], name: 'Dashboard', maxLeaseMinutes: 60 }
    await writeFile(file, JSON.stringify(descriptor), { mode: 0o600 })
    const call = vi.fn(async (_socket: string, action: string, _secret: string, _body: unknown): Promise<Record<string, any>> =>
        action === 'v2:connect-app' ? { clientSessionId: 'new-client', clientSecret: 'new-client-secret', expiresAtMs: Date.now() + 60_000 } : { revoked: true })
    return { cwd, file, options, descriptor, call }
}
it.skipIf(process.platform !== 'linux')('revokes the replacement when cancellation arrives during old-client retirement', async () => {
    const h = await harness(), controller = new AbortController()
    const invoke = h.call.getMockImplementation()!
    h.call.mockImplementation(async (...args) => {
        if (args[1] === 'v2:revoke' && args[2] === 'old-client-secret') controller.abort(new Error('late cancellation'))
        return invoke(...args)
    })
    await expect(reconnectLocalClient(h.options, h.file, 15, controller.signal, h.call)).rejects.toThrow('late cancellation')
    expect(h.call).toHaveBeenLastCalledWith('/broker.sock', 'v2:revoke', 'new-client-secret', { schemaVersion: 2 })
    // The app proof remains available so a cancelled descriptor can be reconnected later.
    expect(JSON.parse(await readFile(h.file, 'utf8')).appSecret).toBe(h.descriptor.appSecret)
    await expect(reconnectLocalClient(h.options, h.file, 15, undefined, h.call)).resolves.toMatchObject({ ok: true })
})
it.skipIf(process.platform !== 'linux')('rejects an unignored secret temporary path before asking the broker to connect', async () => {
    const h = await harness()
    await promisify(execFile)('git', ['init', '-q', h.cwd])
    await writeFile(join(h.cwd, '.gitignore'), 'connection.json\n')
    await expect(reconnectLocalClient(h.options, h.file, 15, undefined, h.call)).rejects.toThrow('temporary files must be ignored')
    expect(h.call).not.toHaveBeenCalled()
})
it.skipIf(process.platform !== 'linux')('a killed reconnect process releases its lock for a later issuer', async () => {
    const h = await harness()
    const source = `import { reconnectLocalClient } from ${JSON.stringify(new URL('./localClientReconnect.ts', import.meta.url).href)};
        await reconnectLocalClient(${JSON.stringify(h.options)}, ${JSON.stringify(h.file)}, 15, undefined,
            async () => { process.stdout.write('broker-entered\\n'); return new Promise(() => {}); });`
    const worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostics = ''
    worker.stderr.on('data', chunk => { diagnostics += chunk })
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Worker did not acquire lock: ${diagnostics}`)), 5000)
            worker.once('exit', () => { clearTimeout(timer); reject(new Error(`Worker exited: ${diagnostics}`)) })
            worker.stdout.on('data', chunk => { if (chunk.toString().includes('broker-entered')) { clearTimeout(timer); resolve() } })
        })
        await expect(reconnectLocalClient(h.options, h.file, 15, undefined, h.call)).rejects.toThrow('Reconnect already running')
        const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()))
        worker.kill('SIGKILL'); await exited
        // The helper releases on stdin EOF. Retry only lock acquisition while its exit is scheduled.
        await expect.poll(async () => {
            try { return await reconnectLocalClient(h.options, h.file, 15, undefined, h.call) }
            catch (error) { if (String(error).includes('Reconnect already running')) return null; throw error }
        }, { timeout: 3000 }).toMatchObject({ ok: true })
    } finally { worker.kill('SIGKILL') }
})
