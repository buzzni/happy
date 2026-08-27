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
