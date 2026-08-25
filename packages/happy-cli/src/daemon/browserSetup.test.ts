import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { buildChromeLaunchArgs, launchChrome, planChromeInstall, resolveChromeDisplay, resolveProfileUserDataDir } from './browserSetup'

const { mkdirSyncMock, spawnMock } = vi.hoisted(() => ({
    mkdirSyncMock: vi.fn(),
    spawnMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('node:fs', () => ({ mkdirSync: mkdirSyncMock }))

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

    it('keeps an official debugging pipe open for unsafe extension commands', () => {
        // Chrome 151 terminates when Extensions.loadUnpacked is sent over the
        // port WebSocket. Chromium only supports that unsafe command from a
        // client attached through --remote-debugging-pipe, while the port is
        // still needed by the viewer and browser tools.
        const args = buildChromeLaunchArgs({ userDataDir: '/p/alice', cdpPort: 9222 })

        expect(args).toContain('--remote-debugging-pipe')
        expect(args).toContain('--remote-debugging-port=9222')
    })

    it('keeps Chrome shared files out of a constrained shared-memory mount', () => {
        // The remote Linux machines expose a 64 MB /dev/shm. Chrome 151 can
        // otherwise terminate nondeterministically after loading the bridge
        // with font_data_service_impl.cc: No space left on device.
        const args = buildChromeLaunchArgs({ userDataDir: '/p/alice', cdpPort: 9222 })

        expect(args).toContain('--disable-dev-shm-usage')
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

    it('keeps the sandbox on by default', () => {
        // This browser holds the user's logged-in sessions, so the renderer
        // sandbox stays on unless the kernel refuses to allow it.
        const args = buildChromeLaunchArgs({ userDataDir: '/p/a', cdpPort: 9222 })

        expect(args).not.toContain('--no-sandbox')
    })

    it('can drop the sandbox when the kernel blocks user namespaces', () => {
        // Ubuntu 23.10+ restricts unprivileged user namespaces by default and
        // containers often do the same; Chrome then dies at startup with
        // "Failed to move to new namespace" and never opens its CDP port.
        // Verified in an Ubuntu 22.04 container on 2026-08-13.
        const args = buildChromeLaunchArgs({ userDataDir: '/p/a', cdpPort: 9222, noSandbox: true })

        expect(args).toContain('--no-sandbox')
    })

    it('omits headless entirely when running under a display', () => {
        const args = buildChromeLaunchArgs({ userDataDir: '/p/a', cdpPort: 9222, headless: false })

        expect(args.some((arg) => arg.startsWith('--headless'))).toBe(false)
    })

    it('keeps the viewer display in the process arguments after Chrome sanitizes its environment', () => {
        const args = buildChromeLaunchArgs({
            userDataDir: '/p/a',
            cdpPort: 9222,
            headless: false,
            display: ':99',
        })

        expect(args).toContain('--display=:99')
    })
})

describe('launchChrome', () => {
    it('returns the live fd 3/4 debugging pipe owned by the launched Chrome', () => {
        const chromeInput = new PassThrough()
        const chromeOutput = new PassThrough()
        spawnMock.mockReturnValue({
            pid: 1234,
            stdio: [null, null, null, chromeInput, chromeOutput],
            unref: vi.fn(),
        })

        const launched = launchChrome('/usr/bin/google-chrome', {
            userDataDir: '/p/alice',
            cdpPort: 9222,
        })

        expect(spawnMock.mock.calls[0]?.[2]?.stdio).toEqual(['ignore', 'ignore', 'ignore', 'pipe', 'pipe'])
        expect(launched).toMatchObject({ pid: 1234, cdpPipe: expect.any(Object) })
        launched.cdpPipe.close()
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

    it('refreshes the package list before installing the .deb', () => {
        // Installing a local .deb still resolves its dependencies from the
        // apt index, so a machine whose package list was never refreshed
        // fails with a wall of "Depends: libX but it is not installable" and
        // leaves Chrome absent. Reproduced in a container with the index
        // emptied (2026-08-17): 12 unmet deps, `which google-chrome` empty.
        const plan = planChromeInstall({ chromePath: null, canSudo: true, platform: 'linux' })

        const command = plan.command ?? ''
        expect(command).toContain('apt-get update')
        expect(command.indexOf('apt-get update')).toBeLessThan(command.indexOf('apt-get install'))
    })
})

describe('resolveChromeDisplay', () => {
    it('runs headful on the viewer display when the caller asks for the viewer', () => {
        // specs/browser-remote-login/ — the whole point of pairing "launch"
        // with the noVNC viewer is that the same Chrome the user logs into
        // is the one that gets paired. It must be headful on the viewer's
        // Xvfb display, not off on its own headless instance.
        const result = resolveChromeDisplay({ wantsViewer: true, viewerDisplay: ':99', daemonDisplayEnv: undefined })

        expect(result).toEqual({ headless: false, display: ':99' })
    })

    it('refuses when the viewer was requested but is not running', () => {
        // Launching headless anyway would silently give the user a browser
        // they cannot see or log into — worse than an error.
        const result = resolveChromeDisplay({ wantsViewer: true, viewerDisplay: null, daemonDisplayEnv: undefined })

        expect(result).toEqual({ headless: null, display: null })
    })

    it('falls back to the pre-existing headless-unless-DISPLAY rule when no viewer is requested', () => {
        expect(resolveChromeDisplay({ wantsViewer: false, viewerDisplay: ':99', daemonDisplayEnv: undefined }))
            .toEqual({ headless: true, display: undefined })
        expect(resolveChromeDisplay({ wantsViewer: false, viewerDisplay: null, daemonDisplayEnv: ':0' }))
            .toEqual({ headless: false, display: ':0' })
    })
})
