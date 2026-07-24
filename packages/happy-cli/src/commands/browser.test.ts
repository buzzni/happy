import { describe, it, expect } from 'vitest'
import { formatBrowserStatus } from './browser'

const base = {
    token: 'a'.repeat(64),
    extensionDir: '/repo/packages/happy-browser-extension',
    bridgePort: 41777,
}

describe('formatBrowserStatus', () => {
    it('shows the token so the user can paste it into the extension', () => {
        const out = formatBrowserStatus({ ...base, daemonRunning: true, connections: [] })
        expect(out).toContain('a'.repeat(64))
    })

    it('reports connected profiles when the extension is paired', () => {
        const out = formatBrowserStatus({ ...base, daemonRunning: true, connections: [{ profile: 'work' }] })
        expect(out).toContain('work')
        expect(out).toMatch(/연결됨|connected/i)
    })

    it('says no extension is connected, with the setup steps, when unpaired', () => {
        const out = formatBrowserStatus({ ...base, daemonRunning: true, connections: [] })
        expect(out).toContain('chrome://extensions')
        expect(out).toContain(base.extensionDir)
    })

    it('drops the setup walkthrough once an extension is connected', () => {
        // Re-printing install steps to someone already set up is noise that
        // buries the part they came for (the status).
        const out = formatBrowserStatus({ ...base, daemonRunning: true, connections: [{ profile: 'default' }] })
        expect(out).not.toContain('chrome://extensions')
    })

    it('leads with the daemon being down, since nothing else can work then', () => {
        const out = formatBrowserStatus({ ...base, daemonRunning: false, connections: [] })
        expect(out).toMatch(/데몬|daemon/i)
        expect(out).toContain('happy daemon start')
    })

    it('mentions the port the extension must be pointed at', () => {
        const out = formatBrowserStatus({ ...base, daemonRunning: true, connections: [] })
        expect(out).toContain('41777')
    })

    it('lists every connected profile', () => {
        const out = formatBrowserStatus({
            ...base,
            daemonRunning: true,
            connections: [{ profile: 'work' }, { profile: 'personal' }],
        })
        expect(out).toContain('work')
        expect(out).toContain('personal')
    })
})
