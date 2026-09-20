import { describe, expect, it } from 'vitest'
import { selectLegacyBrowserViewerPids } from './legacyBrowserViewerDrain'

describe('legacy browser viewer drain', () => {
    const profile = '/root/.happy/chrome-profiles/default'
    const complete = [
        { pid: 10, cmdline: ['Xvfb', ':99', '-screen', '0', '1920x1080x24'].join('\0') },
        { pid: 11, cmdline: ['x11vnc', '-display', ':99', '-rfbport', '5900'].join('\0') },
        { pid: 12, cmdline: ['/usr/bin/python3', '/usr/bin/websockify', '--web', '/usr/share/novnc', '127.0.0.1:6080', '127.0.0.1:5900'].join('\0') },
        { pid: 13, cmdline: ['chrome', '--display=:99', `--user-data-dir=${profile}`].join('\0') },
    ]

    it('selects the exact complete legacy singleton signature', () => {
        expect(selectLegacyBrowserViewerPids(complete, profile)).toEqual([10, 11, 12, 13])
    })

    it('refuses a partial signature or a per-user profile', () => {
        expect(selectLegacyBrowserViewerPids(complete.slice(0, 3), profile)).toEqual([])
        expect(selectLegacyBrowserViewerPids([
            ...complete.slice(0, 3),
            { pid: 14, cmdline: ['chrome', '--display=:99', '--user-data-dir=/root/.happy/browser-viewers/bv1_x/chrome-profile'].join('\0') },
        ], profile)).toEqual([])
    })
})

describe('legacy browser viewer drain across display servers', () => {
    const profile = '/root/.happy/chrome-profiles/default'
    const shared = [
        { pid: 20, cmdline: ['/usr/bin/Xvnc', ':99', '-geometry', '1920x1080', '-rfbport', '5900'].join('\0') },
        { pid: 21, cmdline: ['/usr/bin/python3', '/usr/bin/websockify', '--web', '/root/.happy/browser-viewers/novnc-web/remote', '127.0.0.1:6080', '127.0.0.1:5900'].join('\0') },
        { pid: 22, cmdline: ['chrome', '--display=:99', `--user-data-dir=${profile}`].join('\0') },
    ]

    // An Xvnc-backed shared viewer holds exactly the ports the broker's first
    // per-user slot needs, so failing to recognise it leaks that slot.
    it('drains a shared viewer whose display server is Xvnc', () => {
        expect(selectLegacyBrowserViewerPids(shared, profile)).toEqual([20, 21, 22])
    })

    it('still refuses a partial Xvnc signature', () => {
        expect(selectLegacyBrowserViewerPids(shared.slice(0, 2), profile)).toEqual([])
    })
})
