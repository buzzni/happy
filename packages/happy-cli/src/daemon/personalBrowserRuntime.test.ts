import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { personalRuntimePaths } from '@/browserRuntime/personalDesktopRuntime'
import { readPersonalBrowserRuntime } from './personalBrowserRuntime'

const publicKeyPem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
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
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: 'signed', expiresAtMs: 123 }), { status: 200 }))
        const runtime = readPersonalBrowserRuntime(base({ fetchImpl }))!
        const command = { generation: 'g'.repeat(43), method: 'POST' as const, path: '/v1/sessions/register', body: '{"schemaVersion":1}' }
        expect(await runtime.native.issue(command)).toEqual({ token: 'signed', expiresAtMs: 123 })
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit]
        expect(url.toString()).toBe('https://studio.example/api/machines/machine-1/agent-browser/native-command')
        expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer user-token' } })
        expect(JSON.parse(init.body as string)).toEqual(command)
        const denied = readPersonalBrowserRuntime(base({ fetchImpl: async () => new Response('{}', { status: 403 }) }))!
        await expect(denied.native.issue(command)).rejects.toThrow('NATIVE_AUTHORIZATION_DENIED')
        const malformed = readPersonalBrowserRuntime(base({ fetchImpl: async () => new Response('{"token":1}', { status: 200 }) }))!
        await expect(malformed.native.issue(command)).rejects.toThrow('NATIVE_AUTHORIZATION_UNAVAILABLE')
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
