import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { launchPersonalBrowser, personalBrowserArgs, personalBrowserEnv, processGroupTree, type PersonalProcessTree } from './personalBrowserProcess'

function fakeChild(pid: number | undefined) {
    const child = Object.assign(new EventEmitter(), { pid, stdio: [null, null, null, new PassThrough(), new PassThrough()] })
    queueMicrotask(() => child.emit(pid ? 'spawn' : 'error', new Error('ENOENT')))
    return child
}

describe('personal browser launch', () => {
    it('passes the browser only allow-listed OS variables, never Saycode or provider secrets', () => {
        const source = { HOME: '/Users/u', TMPDIR: '/tmp/u', LANG: 'ko_KR.UTF-8', PATH: '/opt/evil:/usr/bin',
            HAPPY_ACCESS_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', NODE_OPTIONS: '--require /tmp/x.js', HTTPS_PROXY: 'http://p' }
        expect(personalBrowserEnv('darwin', source)).toEqual({ HOME: '/Users/u', TMPDIR: '/tmp/u', LANG: 'ko_KR.UTF-8', PATH: '/usr/bin:/bin' })
        const windows = personalBrowserEnv('win32', { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', HAPPY_SERVER_URL: 'x', Path: 'C:\\evil' })
        expect(windows).toEqual({ SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', PATH: 'C:\\Windows\\System32;C:\\Windows' })
    })

    it('uses the dedicated profile over CDP pipes without a debugging port or headless mode', () => {
        const args = personalBrowserArgs('darwin', '/p/profile')
        expect(args).toContain('--remote-debugging-pipe')
        expect(args).toContain('--user-data-dir=/p/profile')
        expect(args.some(arg => arg.startsWith('--remote-debugging-port') || arg.startsWith('--headless'))).toBe(false)
    })

    it('spawns detached with fd 3/4 pipes and the filtered environment', async () => {
        const spawn = vi.fn(() => fakeChild(4242))
        const browser = await launchPersonalBrowser({ platform: 'darwin', executable: '/c/chrome', profileDir: '/p', env: { HOME: '/h', SECRET: 's' } },
            { spawn: spawn as never, tree: () => ({ signal() {}, alive: () => false }) })
        expect(browser.pid).toBe(4242)
        const [, , options] = spawn.mock.calls[0] as unknown as [string, string[], { detached: boolean; env: Record<string, string>; stdio: unknown[] }]
        expect(options.detached).toBe(true)
        expect(options.env).toEqual({ HOME: '/h', PATH: '/usr/bin:/bin' })
        expect(options.stdio).toEqual(['ignore', 'ignore', 'ignore', 'pipe', 'pipe'])
    })

    it('fails the launch when the executable cannot start', async () => {
        await expect(launchPersonalBrowser({ platform: 'darwin', executable: '/missing', profileDir: '/p', env: {} }, { spawn: (() => fakeChild(undefined)) as never }))
            .rejects.toThrow('ENOENT')
    })

    it('escalates to killing the tree and reports an unconfirmed termination instead of success', async () => {
        const signals: string[] = []
        let alive = true
        const tree: PersonalProcessTree = { signal: (signal) => { signals.push(signal); if (signal === 'SIGKILL') alive = false }, alive: () => alive }
        const browser = await launchPersonalBrowser({ platform: 'darwin', executable: '/c', profileDir: '/p', env: {}, termGraceMs: 20, killGraceMs: 20 },
            { spawn: (() => fakeChild(7)) as never, tree: () => tree, pollMs: 5 })
        await browser.terminate()
        expect(signals).toEqual(['SIGTERM', 'SIGKILL'])

        const stuck = await launchPersonalBrowser({ platform: 'darwin', executable: '/c', profileDir: '/p', env: {}, termGraceMs: 10, killGraceMs: 10 },
            { spawn: (() => fakeChild(8)) as never, tree: () => ({ signal() {}, alive: () => true }), pollMs: 5 })
        await expect(stuck.terminate()).rejects.toThrow('PERSONAL_BROWSER_TERMINATION_UNKNOWN')
        // One termination per lifetime: a second call reports the same outcome.
        await expect(stuck.terminate()).rejects.toThrow('PERSONAL_BROWSER_TERMINATION_UNKNOWN')
    })

    it('reads the group as gone only after the leader was reaped and the group answers ESRCH', () => {
        const fail = (code: string) => (() => { throw Object.assign(new Error(code), { code }) }) as never
        expect(processGroupTree(10, () => true, fail('ESRCH')).alive()).toBe(false)
        // Darwin: EPERM for a group whose only member is an unreaped zombie; never read as gone.
        expect(processGroupTree(10, () => true, fail('EPERM')).alive()).toBe(true)
        const kill = vi.fn()
        expect(processGroupTree(10, () => false, kill as never).alive()).toBe(true)
        expect(kill).not.toHaveBeenCalled()
        processGroupTree(10, () => false, kill as never).signal('SIGTERM')
        expect(kill).toHaveBeenCalledWith(-10, 'SIGTERM')
        expect(() => processGroupTree(10, () => true, fail('EPERM')).signal('SIGKILL')).not.toThrow()
        expect(() => processGroupTree(10, () => true, fail('EINVAL')).signal('SIGKILL')).toThrow('EINVAL')
        expect(() => processGroupTree(1, () => true)).toThrow('PERSONAL_BROWSER_EXITED')
    })

    it('does not start on a platform whose process-tree custody is not wired yet', async () => {
        await expect(launchPersonalBrowser({ platform: 'win32', executable: 'C:\\c.exe', profileDir: 'C:\\p', env: {} }, { spawn: vi.fn() as never }))
            .rejects.toThrow('PERSONAL_BROWSER_UNSUPPORTED')
    })
})
