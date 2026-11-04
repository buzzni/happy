import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { personalRuntimePaths } from '@/browserRuntime/personalDesktopRuntime'
import { readPersonalBrowserRuntime, watchPersonalBrowserRuntime } from './personalBrowserRuntime'

const issuer = generateKeyPairSync('ed25519')
const publicKeyPem = issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString()
function signedCommand(expiresAtMs: number, issuedAtMs = 0, signingKey = issuer.privateKey) {
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'k', typ: 'abp-native-command' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ kind: 'native-command', iss: 'saycode-server',
        aud: 'machine-1', machineId: 'machine-1', workspaceId: 'personal:user-1', principalId: 'user-1',
        generation: 'g'.repeat(43), requestId: randomUUID(), method: 'POST', path: '/v1/sessions/register',
        bodySha256: createHash('sha256').update('{}').digest('hex'), issuedAtMs, expiresAtMs })).toString('base64url')
    const content = `abp2.${header}.${payload}`
    return `${content}.${sign(null, Buffer.from(content), signingKey).toString('base64url')}`
}
const env = { HOME: '/Users/u', TMPDIR: '/tmp/u', HAPPY_SERVER_URL: 'https://s', HAPPY_ACCESS_KEY: 'secret', ANTHROPIC_API_KEY: 'secret' }
const paths = personalRuntimePaths('darwin', env, '/Users/u')
const config = (overrides: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 2, authMode: 'production', machineId: 'machine-1', workspaceId: 'personal:user-1',
    runtimeHost: '127.0.0.1', runtimePort: 38787, profiles: [{ profileId: 'profile-1', principalId: 'user-1', assignmentId: '0123456789abcdef0123456789abcdef' }],
    trustedIssuers: [{ kid: 'k', publicKeyPem }], personalDesktop: { platform: 'darwin', browserExecutable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, ...overrides })

function fakeChild() {
    return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
}
const base = (overrides: Record<string, unknown> = {}) => ({ platform: 'darwin' as const, env: { ...env }, home: '/Users/u', machineId: 'machine-1', studioOrigin: 'https://studio.example',
    token: () => 'user-token', log: vi.fn(), readConfig: (path: string) => { expect(path).toBe(paths.configFile); return config() }, ...overrides })

describe('personal browser runtime (daemon side)', () => {
    it('uses only Desktop signatures and fd3, never a daemon bearer or device fallback', async () => {
        const root = await mkdtemp(join(tmpdir(), 'pbr-login-'))
        const descriptor = { protocol: 1, machineId: 'machine-1', workspaceId: 'personal:user-1', principalId: 'user-1', profileId: 'profile-1',
            socketPath: process.platform === 'win32' ? '\\\\.\\pipe\\saycode-browser-login-' + createHash('sha256').update(randomUUID()).digest('hex') : join(root, 'issuer.sock'), secret: 's'.repeat(43), loginId: 'l'.repeat(43) }
        let permitted = true
        const server = createServer((req, res) => {
            expect(req.headers['x-saycode-browser-login']).toBe(descriptor.secret)
            const expiresAtMs = Date.now() + 60000
            res.writeHead(permitted ? 200 : 403); res.end(JSON.stringify({ token: signedCommand(expiresAtMs), expiresAtMs }))
        })
        await new Promise<void>(r => server.listen(descriptor.socketPath, r))
        const fetchImpl = vi.fn(), deviceProof = vi.fn(), token = vi.fn(() => { throw Error('org bearer must not be used') })
        const child = Object.assign(fakeChild(), { stdio: [null, null, null, new PassThrough()] })
        let pipe = ''; child.stdio[3]!.on('data', chunk => { pipe += chunk })
        const spawnImpl = vi.fn((..._args: Parameters<typeof import('node:child_process').spawn>) => child)
        const runtime = readPersonalBrowserRuntime(base({ desktopLogin: () => descriptor, token, fetchImpl, deviceProof, spawnImpl }))!
        try {
            await runtime.native.issue({ generation: 'g', method: 'GET', path: '/v1/sessions', body: '' })
            permitted = false
            await expect(runtime.native.issue({ generation: 'g', method: 'GET', path: '/v1/sessions', body: '' })).rejects.toThrow('LOGIN_REQUIRED')
            expect(fetchImpl).not.toHaveBeenCalled(); expect(deviceProof).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled()
            const process = runtime.start()
            expect(JSON.parse(pipe)).toEqual(descriptor)
            expect(JSON.stringify(runtime.sessionEnv)).not.toContain(descriptor.secret)
            expect(JSON.stringify(spawnImpl.mock.calls[0])).not.toContain(descriptor.secret)
            expect(spawnImpl.mock.calls[0][2]).toMatchObject({ env: { ABP_DESKTOP_BROWSER_LOGIN_FD: '3' }, stdio: ['pipe', 'ignore', 'pipe', 'pipe'] })
            child.emit('exit', 0); await process.stop()
        } finally { await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }) }
    })

    it('sends a device proof for organization runtime requests and never falls back without approval', async () => {
        const proof = vi.fn(async () => 'signed-proof'), fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: signedCommand(1000), expiresAtMs: 1000 })))
        fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 401 }))
        const runtime = readPersonalBrowserRuntime(base({ readConfig: () => config({ workspaceId: 'co' }), deviceProof: proof, fetchImpl }))!
        const command = { generation: 'g', method: 'POST' as const, path: '/v1/sessions/register', body: '{}' }
        await runtime.native.issue(command)
        expect(proof).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1', workspaceId: 'co', body: JSON.stringify(command) }))
        expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ headers: expect.objectContaining({ 'X-Saycode-Browser-Device-Proof': 'signed-proof' }) }))
        fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 401 }))
        proof.mockRejectedValueOnce(new Error('NATIVE_DEVICE_APPROVAL_REQUIRED'))
        await expect(runtime.native.issue(command)).rejects.toThrow('NATIVE_DEVICE_APPROVAL_REQUIRED')
        expect(fetchImpl).toHaveBeenCalledTimes(3)
    })

    it('preserves personal bearer authentication even in an organization workspace without a device pin', async () => {
        const proof = vi.fn(async () => { throw new Error('NATIVE_DEVICE_APPROVAL_REQUIRED') })
        const token = signedCommand(1000)
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token, expiresAtMs: 1000 })))
        const runtime = readPersonalBrowserRuntime(base({ readConfig: () => config({ workspaceId: 'co' }), deviceProof: proof, fetchImpl }))!
        await expect(runtime.native.issue({ generation: 'g', method: 'POST', path: '/v1/sessions/register', body: '{}' })).resolves.toEqual({ token, expiresAtMs: 1000 })
        expect(proof).not.toHaveBeenCalled()
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('points sessions at the installed runtime and its broker socket', () => {
        // HOME decides the macOS user directory.
        const runtime = readPersonalBrowserRuntime(base())!
        expect(runtime.sessionEnv).toEqual({ HAPPY_BROWSER_TASK_RUNTIME_URL: 'http://127.0.0.1:38787', HAPPY_BROWSER_TASK_BROKER_SOCKET: paths.brokerSocket,
            HAPPY_BROWSER_TASK_PROFILE_ID: 'profile-1', HAPPY_BROWSER_TASK_TENANCY: 'dedicated', HAPPY_BROWSER_TASK_HOST_MODE: 'dedicated-host' })
        expect(runtime.native).toMatchObject({ socketPath: paths.brokerSocket, machineId: 'machine-1', workspaceId: 'personal:user-1' })
    })

    it('stays off without an installation, on Linux, for another machine, an invalid file or no trusted Studio', () => {
        const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
        expect(readPersonalBrowserRuntime(base({ readConfig: () => { throw missing } }))).toBeUndefined()
        expect(readPersonalBrowserRuntime(base({ platform: 'linux' }))).toBeUndefined()
        expect(readPersonalBrowserRuntime(base({ machineId: 'machine-2' }))).toBeUndefined()
        expect(readPersonalBrowserRuntime(base({ readConfig: () => '{' }))).toBeUndefined()
        expect(readPersonalBrowserRuntime(base({ readConfig: () => config({ personalDesktop: undefined, daemonTokenSha256: 'a'.repeat(64) }) }))).toBeUndefined()
        expect(readPersonalBrowserRuntime(base({ studioOrigin: null }))).toBeUndefined()
    })

    it('has Studio sign each exact command with the user token and reports a refusal as denied', async () => {
        const token = signedCommand(123)
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token, expiresAtMs: 123 }), { status: 200 }))
        const runtime = readPersonalBrowserRuntime(base({ fetchImpl }))!
        const command = { generation: 'g'.repeat(43), method: 'POST' as const, path: '/v1/sessions/register', body: '{"schemaVersion":1}' }
        expect(await runtime.native.issue(command)).toEqual({ token, expiresAtMs: 123 })
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit]
        expect(url.toString()).toBe('https://studio.example/api/machines/machine-1/agent-browser/native-command')
        expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer user-token' } })
        expect(JSON.parse(init.body as string)).toEqual(command)
        const denied = readPersonalBrowserRuntime(base({ fetchImpl: async () => new Response('{}', { status: 403 }) }))!
        await expect(denied.native.issue(command)).rejects.toThrow('NATIVE_AUTHORIZATION_DENIED')
        const malformed = readPersonalBrowserRuntime(base({ fetchImpl: async () => new Response('{"token":1}', { status: 200 }) }))!
        await expect(malformed.native.issue(command)).rejects.toThrow('NATIVE_AUTHORIZATION_UNAVAILABLE')
    })

    it.each([17, 30000])('waits for a trusted native command with an issuer clock %ims ahead', async aheadMs => {
        vi.useFakeTimers()
        try {
            vi.setSystemTime(100000)
            const token = signedCommand(160000, 100000 + aheadMs)
            const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token, expiresAtMs: 160000 })))
            const runtime = readPersonalBrowserRuntime(base({ fetchImpl }))!
            const ready = vi.fn()
            const pending = runtime.native.issue({ generation: 'g', method: 'GET', path: '/v1/sessions', body: '' }).then(ready)
            await vi.advanceTimersByTimeAsync(0)
            expect(ready).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(aheadMs - 1)
            expect(ready).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(2)
            await pending
            expect(ready).toHaveBeenCalledWith({ token, expiresAtMs: 160000 })
            expect(fetchImpl).toHaveBeenCalledTimes(1)
        } finally { vi.useRealTimers() }
    })

    it('refuses untrusted commands and clock differences beyond the bounded wait', async () => {
        const command = { generation: 'g', method: 'GET' as const, path: '/v1/sessions', body: '' }
        for (const token of [signedCommand(160000, 130001), signedCommand(160000, -1), signedCommand(160000, 100000.5),
            signedCommand(160001, 100000), signedCommand(160000, 100017, generateKeyPairSync('ed25519').privateKey), 'malformed']) {
            const runtime = readPersonalBrowserRuntime(base({ now: () => 100000,
                fetchImpl: async () => new Response(JSON.stringify({ token, expiresAtMs: 160000 })) }))!
            await expect(runtime.native.issue(command)).rejects.toThrow('NATIVE_AUTHORIZATION_UNAVAILABLE')
        }
    })

    it('refuses dispatch when the local clock moves backwards during the bounded wait', async () => {
        vi.useFakeTimers()
        try {
            vi.setSystemTime(100000)
            const token = signedCommand(160000, 100017)
            const runtime = readPersonalBrowserRuntime(base({
                fetchImpl: async () => new Response(JSON.stringify({ token, expiresAtMs: 160000 })) }))!
            const pending = expect(runtime.native.issue({ generation: 'g', method: 'GET', path: '/v1/sessions', body: '' }))
                .rejects.toThrow('NATIVE_AUTHORIZATION_UNAVAILABLE')
            await vi.advanceTimersByTimeAsync(0)
            vi.setSystemTime(99900)
            await vi.advanceTimersByTimeAsync(18)
            await pending
        } finally { vi.useRealTimers() }
    })

    it.each(['issuance', 'clock-wait'])('cancels a native command promptly during %s', async stage => {
        vi.useFakeTimers()
        try {
            vi.setSystemTime(100000)
            const token = signedCommand(160000, 130000)
            const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
                if (stage === 'issuance') await new Promise<void>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
                })
                return new Response(JSON.stringify({ token, expiresAtMs: 160000 }))
            })
            const runtime = readPersonalBrowserRuntime(base({ fetchImpl }))!
            const controller = new AbortController()
            let rejected = false
            const pending = runtime.native.issue({ generation: 'g', method: 'GET', path: '/v1/sessions', body: '' }, controller.signal)
                .catch(() => { rejected = true })
            await vi.advanceTimersByTimeAsync(0)
            controller.abort()
            await vi.advanceTimersByTimeAsync(1)
            expect(rejected).toBe(true)
            await pending
            expect(fetchImpl).toHaveBeenCalledTimes(1)
        } finally { vi.useRealTimers() }
    })

    it('starts the runtime with its own two variables and OS basics only, never daemon credentials', () => {
        const child = fakeChild()
        const spawnImpl = vi.fn(() => child)
        readPersonalBrowserRuntime(base({ spawnImpl, runtimeEntry: '/pkg/dist/browserRuntime/runtimeMain.mjs' }))!.start()
        const [, args, options] = spawnImpl.mock.calls[0] as unknown as [string, string[], { env: Record<string, string>; stdio: unknown[] }]
        expect(args).toEqual(['/pkg/dist/browserRuntime/runtimeMain.mjs'])
        expect(options.stdio).toEqual(['pipe', 'ignore', 'pipe'])
        expect(options.env).toEqual({ HOME: '/Users/u', TMPDIR: '/tmp/u', PATH: '/usr/bin:/bin', ABP_CONFIG_FILE: paths.configFile, ABP_STATE_DIR: paths.stateDir })
    })

    it('restarts a crashed runtime with backoff, gives up on a crash loop, and stops it through its pipe', async () => {
        const children: ReturnType<typeof fakeChild>[] = []
        const timers: Array<{ work: () => void; ms: number }> = []
        const log = vi.fn()
        let clock = 0
        const runtime = readPersonalBrowserRuntime(base({ log, now: () => clock, spawnImpl: () => { const c = fakeChild(); children.push(c); return c },
            setTimer: (work: () => void, ms: number) => { timers.push({ work, ms }) } }))!
        const process = runtime.start()
        for (let attempt = 0; attempt < 6; attempt++) {
            children.at(-1)!.emit('exit', 1)
            const timer = timers.shift()
            if (attempt < 5) { expect(timer?.ms).toBe([1_000, 5_000, 30_000, 60_000, 120_000][attempt]); timer!.work() }
            else expect(timer).toBeUndefined()
        }
        expect(log).toHaveBeenCalledWith(expect.stringContaining('keeps exiting'))
        expect(children).toHaveLength(6)

        // A run of five minutes resets the backoff.
        const healthy = readPersonalBrowserRuntime(base({ now: () => clock, spawnImpl: () => { const c = fakeChild(); children.push(c); return c },
            setTimer: (work: () => void, ms: number) => { timers.push({ work, ms }) } }))!.start()
        clock += 5 * 60_000
        children.at(-1)!.emit('exit', 1)
        const restart = timers.shift()!
        expect(restart.ms).toBe(1_000)
        restart.work()

        const live = children.at(-1)!
        const ended = vi.fn()
        live.stdin.on('finish', ended)
        const stopping = healthy.stop()
        await new Promise(resolve => setImmediate(resolve))
        expect(ended).toHaveBeenCalled()
        live.emit('exit', 0)
        await stopping
        expect(timers.filter(timer => timer.ms !== 15_000)).toEqual([])
        await process.stop()
    })
})

describe('watching for the personal runtime installation', () => {
    it('activates once when Desktop writes the installation, logs a repeated diagnostic once, and stops the runtime', async () => {
        vi.useFakeTimers()
        try {
            let installed: string | undefined
            const log = vi.fn()
            const activate = vi.fn(() => true)
            const child = fakeChild()
            const watch = watchPersonalBrowserRuntime({ ...base({ log, spawnImpl: () => child,
                readConfig: () => { if (installed === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return installed } }), intervalMs: 1000, activate })
            installed = config({ machineId: 'machine-2' })
            await vi.advanceTimersByTimeAsync(3000)
            expect(log.mock.calls.filter(([message]) => String(message).includes('another machine'))).toHaveLength(1)
            expect(activate).not.toHaveBeenCalled()
            installed = config()
            await vi.advanceTimersByTimeAsync(1000)
            expect(activate).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(5000)
            expect(activate).toHaveBeenCalledTimes(1)
            const stopping = watch.stop()
            await vi.advanceTimersByTimeAsync(0)
            child.emit('exit', 0)
            await stopping
        } finally { vi.useRealTimers() }
    })

    it('keeps checking while the daemon cannot use an installation', async () => {
        vi.useFakeTimers()
        try {
            const activate = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
            const spawnImpl = vi.fn(() => fakeChild())
            const watch = watchPersonalBrowserRuntime({ ...base({ spawnImpl }), intervalMs: 1000, activate })
            expect(spawnImpl).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(1000)
            expect(activate).toHaveBeenCalledTimes(2)
            expect(spawnImpl).toHaveBeenCalledTimes(1)
            void watch.stop()
        } finally { vi.useRealTimers() }
    })
})
