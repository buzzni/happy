/**
 * Guards the parts of the browser-setup RPC contract the app depends on.
 * apiMachine wires these together; here we pin the decisions themselves so a
 * refactor there cannot quietly turn a failure into a success.
 */
import { describe, expect, it } from 'vitest'
import { buildChromeLaunchArgs, planChromeInstall, resolveProfileUserDataDir } from './browserSetup'

describe('install button contract', () => {
    it('never reports an install it cannot perform', () => {
        // The app renders plan.action verbatim. If a no-sudo machine got
        // 'run' here the UI would claim Chrome was installed while nothing
        // was placed, and the user would chase a missing binary.
        const plan = planChromeInstall({ chromePath: null, canSudo: false, platform: 'linux' })

        expect(plan.action).not.toBe('run')
        expect(plan.action).toBe('manual')
    })

    it('hands back a command the user can paste verbatim', () => {
        const plan = planChromeInstall({ chromePath: null, canSudo: false, platform: 'linux' })

        expect(plan.command).toContain('wget')
        expect(plan.command).toContain('apt-get install')
    })
})

describe('launch button contract', () => {
    it('keeps two profiles on separate data dirs and ports', () => {
        const root = '/home/u/.happy/chrome-profiles'
        const alice = resolveProfileUserDataDir(root, 'alice')
        const bob = resolveProfileUserDataDir(root, 'bob')

        // Distinct dirs are what make "각 사용자별 별도 로그인" true; sharing
        // one dir means the second Chrome refuses to start or overwrites the
        // first profile's cookies.
        expect(alice).not.toBe(bob)
        expect(buildChromeLaunchArgs({ userDataDir: alice, cdpPort: 9222 }))
            .toContain(`--user-data-dir=${alice}`)
        expect(buildChromeLaunchArgs({ userDataDir: bob, cdpPort: 9223 }))
            .toContain('--remote-debugging-port=9223')
    })

    it('always ships the flag that makes CDP extension injection legal', () => {
        for (const headless of [true, false]) {
            const args = buildChromeLaunchArgs({ userDataDir: '/p/a', cdpPort: 9222, headless })
            expect(args).toContain('--enable-unsafe-extension-debugging')
        }
    })
})
