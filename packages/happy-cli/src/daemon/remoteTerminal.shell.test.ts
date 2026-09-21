import { afterEach, describe, expect, it, vi } from 'vitest'
import * as pty from 'node-pty'

vi.mock('node-pty', () => ({
    spawn: vi.fn(() => ({ pid: 12345, onExit: vi.fn() })),
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    vi.resetModules()
})

async function loadFor(platform: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: platform })
    vi.stubEnv('SHELL', '')
    return import('./remoteTerminal')
}

describe('remote terminal shell startup', () => {
    it('opens the default Windows PowerShell without a Unix login argument', async () => {
        const { createPtySession } = await loadFor('win32')
        createPtySession({ userId: 'user' })
        expect(vi.mocked(pty.spawn).mock.calls.map(([shell, args]) => [shell, args])).toEqual([['powershell.exe', []]])
    })

    it.each(['darwin', 'linux'] as const)('keeps the default login shell on %s', async (platform) => {
        const { createPtySession } = await loadFor(platform)
        createPtySession({ userId: 'user' })
        expect(vi.mocked(pty.spawn).mock.calls.map(([shell, args]) => [shell, args])).toEqual([['/bin/bash', ['-l']]])
    })

    it('preserves the environment shell on POSIX', async () => {
        const { createPtySession } = await loadFor('linux')
        vi.stubEnv('SHELL', '/bin/zsh')
        createPtySession({ userId: 'user' })
        expect(vi.mocked(pty.spawn).mock.calls.map(([shell, args]) => [shell, args])).toEqual([['/bin/zsh', ['-l']]])
    })

    it.each(['powershell.exe', 'pwsh.exe', 'cmd.exe'])('opens explicit Windows %s without a Unix login argument', async (shell) => {
        const { createPtySession } = await loadFor('win32')
        createPtySession({ userId: 'user', shell })
        expect(vi.mocked(pty.spawn).mock.calls.map(([shell, args]) => [shell, args])).toEqual([[shell, []]])
    })

    it.each(['win32', 'linux'] as const)('preserves explicit arguments including an empty array on %s', async (platform) => {
        const { createPtySession } = await loadFor(platform)
        for (const args of [[], ['-NoLogo'], ['-l']]) {
            createPtySession({ userId: 'user', shell: 'custom-shell', args })
            expect(vi.mocked(pty.spawn).mock.calls.at(-1)?.slice(0, 2)).toEqual(['custom-shell', args])
        }
    })
})
