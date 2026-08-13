import { describe, expect, it } from 'vitest'
import { buildChromeLaunchArgs, planChromeInstall, resolveProfileUserDataDir } from './browserSetup'

describe('buildChromeLaunchArgs', () => {
    it('includes --enable-unsafe-extension-debugging', () => {
        // Chrome 137+ ignores --load-extension, so `happy browser pair`
        // injects the extension over CDP instead. Chrome only permits that
        // call when started with this flag — without it pairing fails with
        // "확장을 Chrome에 넣지 못했습니다" and nothing else explains why.
        const args = buildChromeLaunchArgs({ userDataDir: '/p/alice', cdpPort: 9222 })

        expect(args).toContain('--enable-unsafe-extension-debugging')
    })

    it('points the debugging port at the requested port', () => {
        const args = buildChromeLaunchArgs({ userDataDir: '/p/alice', cdpPort: 9333 })

        expect(args).toContain('--remote-debugging-port=9333')
    })

    it('pins the user data dir so logins survive restarts', () => {
        const args = buildChromeLaunchArgs({ userDataDir: '/p/alice', cdpPort: 9222 })

        expect(args).toContain('--user-data-dir=/p/alice')
    })

    it('uses --headless=new, never bare --headless', () => {
        // Old headless (`--headless` == `--headless=old`) has no extension
        // support at all, so pairing can never succeed there.
        const args = buildChromeLaunchArgs({ userDataDir: '/p/a', cdpPort: 9222, headless: true })

        expect(args).toContain('--headless=new')
        expect(args).not.toContain('--headless')
    })

    it('omits headless entirely when running under a display', () => {
        const args = buildChromeLaunchArgs({ userDataDir: '/p/a', cdpPort: 9222, headless: false })

        expect(args.some((arg) => arg.startsWith('--headless'))).toBe(false)
    })
})

describe('resolveProfileUserDataDir', () => {
    it('gives each profile its own directory', () => {
        // A shared --user-data-dir means the second Chrome either refuses to
        // start or clobbers the first profile's cookies. Separate logins are
        // the whole point of naming profiles.
        const alice = resolveProfileUserDataDir('/root', 'alice')
        const bob = resolveProfileUserDataDir('/root', 'bob')

        expect(alice).not.toBe(bob)
    })

    it('is stable across calls so a relaunch reuses the same login', () => {
        expect(resolveProfileUserDataDir('/root', 'alice')).toBe(resolveProfileUserDataDir('/root', 'alice'))
    })

    it('refuses a profile name that would escape the root directory', () => {
        expect(() => resolveProfileUserDataDir('/root', '../../etc')).toThrow()
    })
})

describe('planChromeInstall', () => {
    it('skips installing when Chrome is already present', () => {
        const plan = planChromeInstall({ chromePath: '/usr/bin/google-chrome', canSudo: false })

        expect(plan.action).toBe('already-installed')
    })

    it('installs directly when passwordless sudo is available', () => {
        const plan = planChromeInstall({ chromePath: null, canSudo: true, platform: 'linux' })

        expect(plan.action).toBe('run')
        expect(plan.command).toContain('google-chrome')
    })

    it('does not offer an apt command on a non-Linux machine', () => {
        // The machine screen is shown for every machine, including the
        // user's own Mac, where Chrome lives in /Applications and is absent
        // from PATH. Offering `apt-get install` there sends the user to run
        // a command their OS does not have.
        const plan = planChromeInstall({ chromePath: null, canSudo: false, platform: 'darwin' })

        expect(plan.command ?? '').not.toContain('apt-get')
    })

    it('reports a manual command instead of claiming success without sudo', () => {
        // Chrome needs system shared libraries (libnss3, libgbm1, ...) that
        // cannot be installed without root, so there is no honest unattended
        // path here. Returning "manual" keeps the button from reporting a
        // success the machine never had.
        const plan = planChromeInstall({ chromePath: null, canSudo: false, platform: 'linux' })

        expect(plan.action).toBe('manual')
        expect(plan.command).toContain('sudo')
        expect(plan.reason).toBeTruthy()
    })
})
