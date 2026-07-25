import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { formatBrowserStatus, resolveExtensionDir, resolveExtensionId } from './browser'
import { projectPath } from '@/projectPath'

const base = {
    token: 'a'.repeat(64),
    extensionDir: '/repo/packages/happy-browser-extension',
    bridgePort: 41777,
    extensionId: 'emaponnolfbhnoaabgiebjmbdlmoifke',
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

    it('offers an auto-connect link that fills the token in for the user', () => {
        // The extension id is fixed (manifest.json "key"), so the CLI can
        // build this link without the extension ever having reported its id.
        const out = formatBrowserStatus({ ...base, daemonRunning: true, connections: [] })
        expect(out).toContain(`chrome-extension://${base.extensionId}/src/options.html?token=${base.token}&port=${base.bridgePort}`)
    })

    it('drops the auto-connect link once an extension is connected', () => {
        const out = formatBrowserStatus({ ...base, daemonRunning: true, connections: [{ profile: 'default' }] })
        expect(out).not.toContain('chrome-extension://')
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

describe('resolveExtensionDir', () => {
    // An installed happy-cli has no sibling packages/ directory at all — the
    // sibling fallback existing is what the pre-fix bug relied on without
    // that being true outside this monorepo. These tests exercise the real
    // filesystem (not a fake) because the bug was entirely about a real path
    // not existing; a mock would not have caught it.
    const bundledDir = path.join(projectPath(), 'browser-extension')

    afterEach(() => {
        rmSync(bundledDir, { recursive: true, force: true })
    })

    it('prefers the bundled copy (what a real install has) when present', () => {
        mkdirSync(bundledDir, { recursive: true })
        writeFileSync(path.join(bundledDir, 'manifest.json'), '{}')

        expect(resolveExtensionDir()).toBe(bundledDir)
    })

    it('falls back to the monorepo sibling package when there is no bundled copy', () => {
        expect(existsSync(bundledDir)).toBe(false)

        const result = resolveExtensionDir()

        expect(result).not.toBe(bundledDir)
        // The fallback must point somewhere real, in this checkout — the bug
        // this guards against is exactly "the printed path doesn't exist".
        expect(existsSync(path.join(result, 'manifest.json'))).toBe(true)
    })
})

describe('resolveExtensionId', () => {
    it('derives the id from the real monorepo manifest\'s pinned key', () => {
        // Ground truth for this id: real Chrome load, see
        // browserExtensionId.test.ts.
        const extensionDir = path.join(projectPath(), '..', 'happy-browser-extension')
        expect(resolveExtensionId(extensionDir)).toBe('emaponnolfbhnoaabgiebjmbdlmoifke')
    })
})
