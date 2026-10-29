import { generateKeyPairSync } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { parseRuntimeConfig } from './runtimeConfig'
import { bootstrapPersonalDesktopRuntime, personalRuntimePaths, type PersonalDesktopRuntimeDependencies } from './personalDesktopRuntime'

const publicKeyPem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const config = () => parseRuntimeConfig({ schemaVersion: 2, authMode: 'production', machineId: 'm', workspaceId: 'w', runtimeHost: '127.0.0.1',
    profiles: [{ profileId: 'p', principalId: 'u', assignmentId: '0123456789abcdef0123456789abcdef' }], trustedIssuers: [{ kid: 'k', publicKeyPem }],
    personalDesktop: { platform: 'darwin', browserExecutable: CHROME } })
const paths = personalRuntimePaths('darwin', {}, '/Users/u')

function harness(overrides: Record<string, unknown> = {}) {
    const events: string[] = []
    const parent = new PassThrough()
    const session = { driver: {}, stopped: new Promise(() => {}), check: vi.fn(), close: vi.fn(async () => { events.push('session.close'); return { terminated: true } }) }
    const deps = {
        platform: 'darwin' as const, uid: 501, home: '/Users/u', parent,
        env: { ABP_CONFIG_FILE: paths.configFile, HOME: '/Users/u', HAPPY_ACCESS_KEY: 'secret' },
        prepareDirectory: vi.fn(async (path: string) => { events.push(`dir ${path}`) }),
        lock: vi.fn(async () => { events.push('lock'); return { close: async () => { events.push('unlock') } } }),
        verifyExecutable: vi.fn(async () => { events.push('verify') }),
        launch: vi.fn(async () => { events.push('launch'); return { pid: 900, input: new PassThrough(), output: new PassThrough(), terminate: vi.fn(async () => { events.push('terminate') }) } }),
        readOwner: vi.fn(() => ({ bootId: 'b', pid: 900, pidStartTime: '1' })),
        openSession: vi.fn(async () => { events.push('session'); return session }),
        ...overrides,
    }
    return { deps: deps as typeof deps & PersonalDesktopRuntimeDependencies, events, parent, session }
}

describe('personal desktop runtime bootstrap', () => {
    it('keeps every file in the user Saycode directory', () => {
        expect(paths).toMatchObject({ root: '/Users/u/Library/Application Support/Saycode/browser-runtime',
            stateDir: '/Users/u/Library/Application Support/Saycode/browser-runtime/state',
            brokerSocket: '/Users/u/Library/Application Support/Saycode/browser-runtime/run/broker.sock' })
        expect(personalRuntimePaths('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }).profileDir).toBe('C:\\Users\\u\\AppData\\Local\\Saycode\\browser-runtime\\profile')
        expect(() => personalRuntimePaths('win32', {})).toThrow(/application directory/)
        const windows = personalRuntimePaths('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })
        expect(windows.brokerSocket).toMatch(/^\\\\\.\\pipe\\saycode-browser-runtime-[0-9a-f]{16}-broker$/)
        expect(windows.adminSocket).toBe(windows.brokerSocket.replace(/-broker$/, '-admin'))
        expect(personalRuntimePaths('win32', { LOCALAPPDATA: 'C:\\Users\\other\\AppData\\Local' }).brokerSocket).not.toBe(windows.brokerSocket)
    })

    it('runs a Windows browser as the runtime token user, with named pipes and no POSIX ownership checks', async () => {
        const windowsPaths = personalRuntimePaths('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })
        const windowsConfig = { ...config(), personalDesktop: { platform: 'win32' as const, browserExecutable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' } }
        const { deps } = harness({ platform: 'win32', uid: undefined, identity: 'S-1-5-21-1-2-3-1001',
            env: { ABP_CONFIG_FILE: windowsPaths.configFile, LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } })
        const runtime = await bootstrapPersonalDesktopRuntime(windowsConfig, windowsPaths.stateDir, deps)
        expect(runtime.sockets).toEqual({ broker: windowsPaths.brokerSocket, admin: windowsPaths.adminSocket })
        expect(deps.prepareDirectory).toHaveBeenCalledWith(windowsPaths.profileDir, undefined)
        expect(deps.openSession).toHaveBeenCalledWith(expect.objectContaining({ protection: { mode: 'basic', identity: 'S-1-5-21-1-2-3-1001' } }))
    })

    it('prepares private directories, verifies the browser, locks, then opens a same-user session on the dedicated profile', async () => {
        const { deps, events } = harness()
        const runtime = await bootstrapPersonalDesktopRuntime(config(), paths.stateDir, deps)
        expect(events).toEqual([`dir ${paths.root}`, `dir ${paths.stateDir}`, `dir ${paths.profileDir}`, `dir ${paths.runDir}`, 'verify', 'lock', 'launch', 'session'])
        expect(deps.launch).toHaveBeenCalledWith(expect.objectContaining({ platform: 'darwin', executable: CHROME, profileDir: paths.profileDir }))
        expect(deps.openSession).toHaveBeenCalledWith(expect.objectContaining({ protection: { mode: 'basic', identity: '501' }, owner: { bootId: 'b', pid: 900, pidStartTime: '1' } }))
        expect(runtime.sockets).toEqual({ broker: paths.brokerSocket, admin: paths.adminSocket })
        await runtime.close()
        expect(events.slice(-2)).toEqual(['session.close', 'unlock'])
    })

    it('refuses root, another platform, a foreign config file or harness inputs before touching any file', async () => {
        for (const overrides of [{ uid: 0 }, { platform: 'win32' }, { env: { ABP_CONFIG_FILE: '/etc/abp/runtime.json' } },
            { env: { ABP_CONFIG_FILE: paths.configFile, ABP_KEYS_FILE: '/k' } }, { env: { ABP_CONFIG_FILE: paths.configFile, ABP_PROFILES: '[]' } }]) {
            const { deps, events } = harness(overrides)
            await expect(bootstrapPersonalDesktopRuntime(config(), paths.stateDir, deps)).rejects.toThrow(/ABP personal runtime/)
            expect(events).toEqual([])
        }
        const { deps } = harness()
        await expect(bootstrapPersonalDesktopRuntime(config(), '/tmp/state', deps)).rejects.toThrow(/fixed user configuration/)
        const protectedConfig = { ...config(), personalDesktop: undefined }
        await expect(bootstrapPersonalDesktopRuntime(protectedConfig, paths.stateDir, harness().deps)).rejects.toThrow(/signed-in user/)
    })

    it('does not lock or launch when the browser is not the signed Google Chrome', async () => {
        const { deps, events } = harness({ verifyExecutable: vi.fn(async () => { throw new Error('ABP personal browser is not a signed Google Chrome') }) })
        await expect(bootstrapPersonalDesktopRuntime(config(), paths.stateDir, deps)).rejects.toThrow(/signed Google Chrome/)
        expect(events).not.toContain('lock')
        expect(events).not.toContain('launch')
    })

    it('terminates the browser and releases the lock when the session cannot open', async () => {
        const { deps, events } = harness({ openSession: vi.fn(async () => { throw new Error('RUNTIME_UNAVAILABLE') }) })
        await expect(bootstrapPersonalDesktopRuntime(config(), paths.stateDir, deps)).rejects.toThrow('RUNTIME_UNAVAILABLE')
        expect(events).toContain('terminate')
        expect(events).toContain('unlock')
    })

    it('reports the parent pipe end once, also to a listener added after it', async () => {
        const { deps, parent } = harness()
        const runtime = await bootstrapPersonalDesktopRuntime(config(), paths.stateDir, deps)
        const early = vi.fn(), late = vi.fn()
        runtime.onParentLost(early)
        parent.end()
        await new Promise(resolve => setImmediate(resolve))
        parent.destroy()
        await new Promise(resolve => setImmediate(resolve))
        runtime.onParentLost(late)
        expect(early).toHaveBeenCalledTimes(1)
        expect(late).toHaveBeenCalledTimes(1)
    })

    it('reports an unconfirmed browser termination as a failed close', async () => {
        const { deps, session } = harness()
        session.close.mockResolvedValueOnce({ terminated: false })
        const runtime = await bootstrapPersonalDesktopRuntime(config(), paths.stateDir, deps)
        await expect(runtime.close()).rejects.toThrow(/unconfirmed/)
    })
})
