import { describe, expect, it } from 'vitest'
import {
    VIEWER_WEB_PORTS,
    decideViewerBrowserAction,
    decideViewerStackAction,
    buildWebsockifyArgs,
    buildX11vncArgs,
    buildXvfbArgs,
    planViewerInstall,
    VIEWER_TOOLS,
} from './remoteViewer'

describe('buildXvfbArgs', () => {
    it('creates a screen on the requested display', () => {
        const args = buildXvfbArgs({ display: ':99', width: 1920, height: 1080 })

        expect(args[0]).toBe(':99')
        expect(args).toContain('-screen')
        expect(args.join(' ')).toContain('1920x1080x24')
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
        const plan = planViewerInstall({ missing: VIEWER_TOOLS.slice(), canSudo: false, platform: 'linux' })

        expect(plan.action).toBe('manual')
        expect(plan.command).toContain('sudo')
        expect(plan.reason).toBeTruthy()
    })

    it('does not offer an apt command on a non-Linux machine', () => {
        const plan = planViewerInstall({ missing: ['x11vnc'], canSudo: false, platform: 'darwin' })

        expect(plan.command ?? '').not.toContain('apt-get')
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

describe('decideViewerBrowserAction', () => {
    it('launches a browser when the display has none', () => {
        // A viewer with no browser on it is a black screen — exactly what the
        // "원격 브라우저 화면 열기" button produced: the open flow started
        // Xvfb/x11vnc/websockify and never put anything on the display.
        const decision = decideViewerBrowserAction({ liveCdpPort: null })

        expect(decision).toEqual({ action: 'launch' })
    })

    it('reuses the browser already on the display instead of stacking another', () => {
        // Every click would otherwise pile one more Chrome onto the same
        // Xvfb, each grabbing the next CDP port.
        const decision = decideViewerBrowserAction({ liveCdpPort: 9222 })

        expect(decision).toEqual({ action: 'reuse', cdpPort: 9222 })
    })
})
