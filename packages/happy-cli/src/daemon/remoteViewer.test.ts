import { describe, expect, it } from 'vitest'
import {
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
