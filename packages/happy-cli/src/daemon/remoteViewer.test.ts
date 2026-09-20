import { describe, expect, it } from 'vitest'
import {
    VIEWER_SLOTS,
    VIEWER_WEB_PORTS,
    decideViewerBrowserAction,
    decideViewerStackAction,
    summariseViewerBrowser,
    buildWebsockifyArgs,
    buildX11vncArgs,
    buildXvfbArgs,
    planViewerInstall,
    VIEWER_SCREEN,
    readDisplayFromEnviron,
    readFlagFromCmdline,
    viewerProcessMatchesLease,
    resolveViewerProfileDir,
    selectViewerSlot,
    validateViewerKey,
    selectViewerBackend,
    missingViewerTools,
    desiredViewerTools,
    buildXvncArgs,
    buildOpenboxArgs,
    buildOpenboxConfig,
    buildVncConfigArgs,
} from './remoteViewer'

describe('buildXvfbArgs', () => {
    it('creates a screen on the requested display', () => {
        const args = buildXvfbArgs({ display: ':99', width: 1920, height: 1080 })

        expect(args[0]).toBe(':99')
        expect(args).toContain('-screen')
        expect(args.join(' ')).toContain('1920x1080x24')
    })
})

describe('VIEWER_SCREEN', () => {
    it('is the geometry Xvfb actually creates', () => {
        // One source of truth on purpose: the browser window is sized from
        // this same constant, and a screen that drifts from the window size
        // is exactly the half-black remote screen this constant exists to
        // prevent.
        const args = buildXvfbArgs({ display: ':99', ...VIEWER_SCREEN })

        expect(args.join(' ')).toContain(`${VIEWER_SCREEN.width}x${VIEWER_SCREEN.height}x24`)
    })
})

describe('buildX11vncArgs', () => {
    it('serves the same display Xvfb created', () => {
        const args = buildX11vncArgs({ display: ':99', vncPort: 5900 })

        expect(args).toContain('-display')
        expect(args).toContain(':99')
        expect(args).toContain('-rfbport')
        expect(args).toContain('5900')
    })

    it('binds VNC to loopback only', () => {
        // The relay reaches it through the daemon on 127.0.0.1. Binding
        // wider would expose an unauthenticated screen+input channel to the
        // whole network — VNC itself carries no auth here.
        const args = buildX11vncArgs({ display: ':99', vncPort: 5900 })

        expect(args).toContain('-localhost')
    })

    it('keeps serving after the first client disconnects', () => {
        // Without -forever x11vnc exits when the viewer closes the tab, and
        // the next "open screen" click would find nothing listening.
        const args = buildX11vncArgs({ display: ':99', vncPort: 5900 })

        expect(args).toContain('-forever')
    })
})

describe('buildWebsockifyArgs', () => {
    it('bridges the web port to the VNC port', () => {
        const args = buildWebsockifyArgs({ webPort: 6080, vncPort: 5900, webRoot: '/usr/share/novnc' })

        expect(args.join(' ')).toContain('6080')
        expect(args.join(' ')).toContain('5900')
    })

    it('serves the noVNC web assets so the browser has a client to load', () => {
        const args = buildWebsockifyArgs({ webPort: 6080, vncPort: 5900, webRoot: '/usr/share/novnc' })

        expect(args).toContain('--web')
        expect(args).toContain('/usr/share/novnc')
    })

    it('binds to loopback so only the daemon relay can reach it', () => {
        const args = buildWebsockifyArgs({ webPort: 6080, vncPort: 5900, webRoot: '/usr/share/novnc' })

        expect(args.join(' ')).toContain('127.0.0.1:6080')
    })
})

describe('planViewerInstall', () => {
    it('is a no-op when every tool is present', () => {
        const plan = planViewerInstall({ missing: [], canSudo: false, platform: 'linux' })

        expect(plan.action).toBe('already-installed')
    })

    it('installs directly when passwordless sudo is available', () => {
        const plan = planViewerInstall({ missing: ['x11vnc'], canSudo: true, platform: 'linux' })

        expect(plan.action).toBe('run')
        expect(plan.command).toContain('x11vnc')
    })

    it('names only the missing tools in the command', () => {
        // Re-installing what is already there is slow and can surprise the
        // operator by upgrading unrelated packages.
        const plan = planViewerInstall({ missing: ['websockify'], canSudo: true, platform: 'linux' })

        expect(plan.command).toContain('websockify')
        expect(plan.command).not.toContain('x11vnc')
    })

    it('reports a manual command rather than claiming success without sudo', () => {
        const plan = planViewerInstall({ missing: ['Xvnc', 'websockify'], canSudo: false, platform: 'linux' })

        expect(plan.action).toBe('manual')
        expect(plan.command).toContain('sudo')
        expect(plan.reason).toBeTruthy()
    })

    it('does not offer an apt command on a non-Linux machine', () => {
        const plan = planViewerInstall({ missing: ['x11vnc'], canSudo: false, platform: 'darwin' })

        expect(plan.command ?? '').not.toContain('apt-get')
    })

    it('refreshes the package list before installing', () => {
        // 실측(2026-08-17, coder-ceb52f63): apt update 없이 install 만
        // 실행하면 캐시가 비어 있는 머신에서 "Unable to locate package"로
        // 항상 실패한다. Chrome install 은 .deb 파일을 직접 잡아 이 문제가
        // 없지만, 저장소 패키지로 까는 뷰어 도구는 이 경로를 반드시 탄다.
        const plan = planViewerInstall({ missing: ['x11vnc'], canSudo: true, platform: 'linux' })

        const command = plan.command ?? ''
        expect(command).toContain('apt-get update')
        expect(command.indexOf('apt-get update')).toBeLessThan(command.indexOf('apt-get install'))
    })
})

describe('decideViewerStackAction', () => {
    it('reuses the cached stack while its port is still serving', () => {
        const decision = decideViewerStackAction({
            cached: { webPort: 6080 },
            cachedAlive: true,
            adoptable: null,
        })

        expect(decision).toEqual({ action: 'reuse', webPort: 6080 })
    })

    it('starts fresh when the cached stack has died', () => {
        // The cache was assign-only and never probed, so a crashed x11vnc left
        // `ready: true` going out forever and every retry handed back the same
        // dead port — the feature could not recover without a daemon restart.
        const decision = decideViewerStackAction({
            cached: { webPort: 6080 },
            cachedAlive: false,
            adoptable: null,
        })

        expect(decision).toEqual({ action: 'start' })
    })

    it('adopts a stack that outlived the daemon instead of spawning a second one', () => {
        // Xvfb/x11vnc/websockify are spawned detached, so a daemon restart
        // leaves them running while the in-memory cache is empty. Starting
        // again would bind the next port and leak a whole second stack; a few
        // restarts exhaust the candidate list and the feature dies with
        // "포트를 찾지 못했습니다".
        const decision = decideViewerStackAction({
            cached: null,
            cachedAlive: false,
            adoptable: { webPort: 6080 },
        })

        expect(decision).toEqual({ action: 'adopt', webPort: 6080 })
    })

    it('prefers adopting over starting when the cached entry is stale', () => {
        const decision = decideViewerStackAction({
            cached: { webPort: 6081 },
            cachedAlive: false,
            adoptable: { webPort: 6080 },
        })

        expect(decision).toEqual({ action: 'adopt', webPort: 6080 })
    })

    it('starts fresh when nothing is cached and nothing is already serving', () => {
        const decision = decideViewerStackAction({ cached: null, cachedAlive: false, adoptable: null })

        expect(decision).toEqual({ action: 'start' })
    })
})

describe('VIEWER_WEB_PORTS as the single source of truth', () => {
    it('is what both the start path and the adoption scan use', () => {
        // The adoption scan and pickFreePort each had their own literal list.
        // Adding a port to one and not the other silently breaks adoption:
        // a stack on the new port would never be found and a duplicate would
        // be spawned beside it.
        expect(VIEWER_WEB_PORTS.length).toBeGreaterThan(0)
        expect([...VIEWER_WEB_PORTS]).toEqual([6080, 6081, 6082])
    })
})

describe('per-user viewer slots', () => {
    it('keeps display, VNC, and web ports in one atomic slot definition', () => {
        expect(VIEWER_SLOTS).toEqual([
            { slot: 0, display: ':99', vncPort: 5900, webPort: 6080 },
            { slot: 1, display: ':100', vncPort: 5901, webPort: 6081 },
            { slot: 2, display: ':101', vncPort: 5902, webPort: 6082 },
        ])
        expect(VIEWER_WEB_PORTS).toEqual(VIEWER_SLOTS.map((entry) => entry.webPort))
    })

    it('selects the first unoccupied slot without stealing another viewer lease', () => {
        expect(selectViewerSlot(new Set([0, 2]))).toEqual(VIEWER_SLOTS[1])
        expect(selectViewerSlot(new Set([0, 1, 2]))).toBeNull()
    })

    it('accepts only opaque viewer keys safe for filesystem paths', () => {
        expect(validateViewerKey('bv1_abcdefghijklmnopqrstuvwxyz012345')).toBe(true)
        expect(validateViewerKey('../alice')).toBe(false)
        expect(validateViewerKey('alice')).toBe(false)
    })

    it('resolves a dedicated profile directory for each viewer key', () => {
        expect(resolveViewerProfileDir('/home/coder/.happy', 'bv1_abcdefghijklmnopqrstuvwxyz012345'))
            .toBe('/home/coder/.happy/browser-viewers/bv1_abcdefghijklmnopqrstuvwxyz012345/chrome-profile')
    })
})

describe('decideViewerBrowserAction', () => {
    it('defers to the profile launch caller instead of occupying its CDP port', () => {
        const decision = decideViewerBrowserAction({
            liveCdpPort: null,
            callerWillLaunchBrowser: true,
        })

        expect(decision).toEqual({ action: 'defer' })
    })

    it('launches a browser when the display has none', () => {
        // A viewer with no browser on it is a black screen — exactly what the
        // "원격 브라우저 화면 열기" button produced: the open flow started
        // Xvfb/x11vnc/websockify and never put anything on the display.
        const decision = decideViewerBrowserAction({ liveCdpPort: null, callerWillLaunchBrowser: false })

        expect(decision).toEqual({ action: 'launch' })
    })

    it('reuses the browser already on the display instead of stacking another', () => {
        // Every click would otherwise pile one more Chrome onto the same
        // Xvfb, each grabbing the next CDP port.
        const decision = decideViewerBrowserAction({ liveCdpPort: 9222, callerWillLaunchBrowser: false })

        expect(decision).toEqual({ action: 'reuse', cdpPort: 9222 })
    })
})

describe('summariseViewerBrowser', () => {
    it('reports that the screen will be blank when Chrome is missing', () => {
        // 실측(2026-08-15, dev): 뷰어 스택은 다 떠 있는데 Chrome 이 설치돼
        // 있지 않아 화면이 검게 나왔다. ensureViewerBrowser 가 조용히
        // return 하는 바람에 사용자는 원인을 알 방법이 없었다.
        const summary = summariseViewerBrowser({ chromeInstalled: false, cdpPort: null })

        expect(summary).toEqual({ browserReady: false, reason: 'chrome-not-installed' })
    })

    it('reports not-ready when Chrome exists but never came up', () => {
        const summary = summariseViewerBrowser({ chromeInstalled: true, cdpPort: null })

        expect(summary).toEqual({ browserReady: false, reason: 'browser-failed' })
    })

    it('reports ready with the port once a browser is on the display', () => {
        const summary = summariseViewerBrowser({ chromeInstalled: true, cdpPort: 9222 })

        expect(summary).toEqual({ browserReady: true, cdpPort: 9222 })
    })
})

describe('viewer Chrome process facts', () => {
    it('distinguishes the viewer display from a headless process', () => {
        expect(readDisplayFromEnviron('PATH=/usr/bin\0DISPLAY=:99\0HOME=/home/coder')).toBe(':99')
        expect(readDisplayFromEnviron('PATH=/usr/bin\0HOME=/home/coder')).toBeNull()
        expect(readDisplayFromEnviron('WAYLAND_DISPLAY=wayland-0')).toBeNull()
    })

    it('reads only whole Chrome flag arguments', () => {
        const chrome = '/usr/bin/google-chrome\0--remote-debugging-port=9222\0--user-data-dir=/x'
        const shell = '/bin/sh\0-c\0pgrep -f -- "--remote-debugging-port=9222"'

        expect(readFlagFromCmdline(chrome, '--remote-debugging-port')).toBe('9222')
        expect(readFlagFromCmdline(chrome, '--user-data-dir')).toBe('/x')
        expect(readFlagFromCmdline(shell, '--remote-debugging-port')).toBeNull()
    })

    it('reads flags after Chrome rewrites cmdline into one space-separated argument', () => {
        const chrome = '/opt/google/chrome/chrome --remote-debugging-port=9222 '
            + '--user-data-dir=/home/walter/.happy/chrome-profiles/default --display=:99\0'

        expect(readFlagFromCmdline(chrome, '--remote-debugging-port')).toBe('9222')
        expect(readFlagFromCmdline(chrome, '--user-data-dir')).toBe('/home/walter/.happy/chrome-profiles/default')
        expect(readFlagFromCmdline(chrome, '--display')).toBe(':99')
    })
})

describe('viewer process ownership', () => {
    const lease = { display: ':99', vncPort: 5900, webPort: 6080 }

    it('matches only the process signature owned by the lease slot', () => {
        expect(viewerProcessMatchesLease(
            'xvfb',
            ['/usr/bin/Xvfb', ':99', '-screen', '0', '1920x1080x24', ''].join('\0'),
            lease,
        )).toBe(true)
        expect(viewerProcessMatchesLease(
            'x11vnc',
            ['/usr/bin/x11vnc', '-display', ':99', '-rfbport', '5900', ''].join('\0'),
            lease,
        )).toBe(true)
        expect(viewerProcessMatchesLease(
            'websockify',
            ['/usr/bin/python3', '/usr/bin/websockify', '--web', '/usr/share/novnc', '127.0.0.1:6080', '127.0.0.1:5900', ''].join('\0'),
            lease,
        )).toBe(true)
    })

    it('rejects a reused pid whose process belongs to another slot or program', () => {
        expect(viewerProcessMatchesLease(
            'xvfb',
            ['/usr/bin/node', 'server.js', ':99', ''].join('\0'),
            lease,
        )).toBe(false)
        expect(viewerProcessMatchesLease(
            'x11vnc',
            ['/usr/bin/x11vnc', '-display', ':100', '-rfbport', '5901', ''].join('\0'),
            lease,
        )).toBe(false)
        expect(viewerProcessMatchesLease(
            'websockify',
            ['/usr/bin/websockify', '127.0.0.1:6081', '127.0.0.1:5901', ''].join('\0'),
            lease,
        )).toBe(false)
    })
})

describe('selectViewerBackend', () => {
    const none = {
        hasXvnc: false,
        hasXvfb: false,
        hasX11vnc: false,
        hasWebsockify: false,
        hasWindowManager: false,
        hasVncConfig: false,
    }

    it('fills the window exactly when the server can resize and a WM can refit the browser', () => {
        const backend = selectViewerBackend({
            ...none, hasXvnc: true, hasWebsockify: true, hasWindowManager: true,
        })

        expect(backend).toEqual({ kind: 'xvnc', resizeMode: 'remote', windowManager: true })
    })

    // Resizing the desktop under a browser window nothing can re-maximize
    // trades letterboxing for a window that no longer covers the screen —
    // strictly worse than scaling the whole screen down.
    it('scales instead of resizing when no window manager can follow the change', () => {
        const backend = selectViewerBackend({ ...none, hasXvnc: true, hasWebsockify: true })

        expect(backend).toEqual({ kind: 'xvnc', resizeMode: 'scale', windowManager: false })
    })

    it('keeps working on machines that only have the Xvfb/x11vnc pair', () => {
        const backend = selectViewerBackend({
            ...none, hasXvfb: true, hasX11vnc: true, hasWebsockify: true, hasWindowManager: true,
        })

        // x11vnc has no SetDesktopSize hook at all, so asking for a remote
        // resize there would leave the original clipping in place.
        expect(backend).toEqual({ kind: 'xvfb-x11vnc', resizeMode: 'scale', windowManager: true })
    })

    it('prefers the resizable server when a machine has both stacks', () => {
        const backend = selectViewerBackend({
            hasXvnc: true, hasXvfb: true, hasX11vnc: true, hasWebsockify: true, hasWindowManager: true,
            hasVncConfig: true,
        })

        expect(backend?.kind).toBe('xvnc')
    })

    it('has no backend at all when no display server is installed', () => {
        expect(selectViewerBackend({ ...none, hasWebsockify: true })).toBeNull()
        expect(selectViewerBackend({ ...none, hasXvfb: true, hasWebsockify: true })).toBeNull()
    })
})

describe('viewer tool requirements', () => {
    const legacyMachine = {
        hasXvnc: false,
        hasXvfb: true,
        hasX11vnc: true,
        hasWebsockify: true,
        hasWindowManager: false,
        hasVncConfig: false,
    }

    it('blocks the screen only on what it cannot run without', () => {
        expect(missingViewerTools(legacyMachine)).toEqual([])
        expect(missingViewerTools({ ...legacyMachine, hasWebsockify: false })).toEqual(['websockify'])
    })

    it('asks for the resizable server when no display server exists', () => {
        const missing = missingViewerTools({
            hasXvnc: false, hasXvfb: false, hasX11vnc: false, hasWebsockify: false, hasWindowManager: false,
            hasVncConfig: false,
        })

        expect(missing).toContain('Xvnc')
        expect(missing).toContain('websockify')
        expect(missing).not.toContain('Xvfb')
    })

    // A machine whose screen already works must not be told it is broken —
    // but installing is exactly when it should be upgraded to exact fill.
    it('upgrades a working legacy machine only when the user installs', () => {
        expect(desiredViewerTools(legacyMachine)).toEqual(['Xvnc', 'openbox', 'vncconfig'])
        expect(desiredViewerTools({
            ...legacyMachine, hasXvnc: true, hasWindowManager: true, hasVncConfig: true,
        })).toEqual([])
    })

    it('maps the upgrade tools onto packages that actually provide them', () => {
        const plan = planViewerInstall({ missing: ['Xvnc', 'openbox'], canSudo: true, platform: 'linux' })

        expect(plan.command).toContain('tigervnc-standalone-server')
        expect(plan.command).toContain('openbox')
        expect(plan.command).not.toContain(' Xvnc')
    })
})

describe('buildXvncArgs', () => {
    it('serves the display it creates, on loopback only', () => {
        const args = buildXvncArgs({ display: ':100', vncPort: 5901, width: 1920, height: 1080 })

        expect(args[0]).toBe(':100')
        expect(args).toContain('-rfbport')
        expect(args[args.indexOf('-rfbport') + 1]).toBe('5901')
        expect(args).toContain('-localhost')
        expect(args.join(' ')).toContain('-geometry 1920x1080')
    })

    it('accepts client resize requests — the whole point of this backend', () => {
        const args = buildXvncArgs({ display: ':99', vncPort: 5900, width: 1920, height: 1080 })

        expect(args).toContain('-AcceptSetDesktopSize=1')
    })

    // Xvnc's default security type needs a password file the daemon never
    // creates; without this it exits at startup and the screen never opens.
    it('runs without VNC authentication, as the relay is the only way in', () => {
        const args = buildXvncArgs({ display: ':99', vncPort: 5900, width: 1920, height: 1080 })

        expect(args.join(' ')).toContain('-SecurityTypes=None')
    })
})

describe('window manager for the viewer display', () => {
    it('keeps every window maximized and undecorated', () => {
        const config = buildOpenboxConfig()

        expect(config).toContain('<maximized>yes</maximized>')
        expect(config).toContain('<decor>no</decor>')
    })

    it('runs against our own config rather than whatever the machine has', () => {
        const args = buildOpenboxArgs({ configPath: '/home/u/.happy/browser-viewers/openbox.xml' })

        expect(args).toContain('--config-file')
        expect(args[args.indexOf('--config-file') + 1]).toBe('/home/u/.happy/browser-viewers/openbox.xml')
        expect(args).toContain('--sm-disable')
    })
})

describe('Xvnc process ownership', () => {
    it('matches only the Xvnc that serves this lease', () => {
        const lease = { display: ':100', vncPort: 5901, webPort: 6081 }

        expect(viewerProcessMatchesLease(
            'xvnc',
            ['/usr/bin/Xvnc', ':100', '-geometry', '1920x1080', '-rfbport', '5901', ''].join('\0'),
            lease,
        )).toBe(true)
        expect(viewerProcessMatchesLease(
            'xvnc',
            ['/usr/bin/Xvnc', ':99', '-geometry', '1920x1080', '-rfbport', '5900', ''].join('\0'),
            lease,
        )).toBe(false)
    })
})

describe('TigerVNC clipboard helper', () => {
    // Without vncconfig the paste reaches Xvnc and stops there — measured:
    // no owner for the X CLIPBOARD selection at all, so xclip reports the
    // target as unavailable while the viewer believes it pasted.
    it('runs headless so the helper window never sits on the user\'s screen', () => {
        expect(buildVncConfigArgs()).toEqual(['-nowin'])
    })
})
