import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { formatBrowserStatus, resolveExtensionDir, resolveExtensionId, bridgeProbeHost } from './browser'
import { projectPath } from '@/projectPath'

const base = {
    token: 'a'.repeat(64),
    extensionDir: '/repo/packages/happy-browser-extension',
    bridgePort: 41777,
    extensionId: 'emaponnolfbhnoaabgiebjmbdlmoifke',
    hasRecentAuthFailure: false,
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

    it('warns about a stale token even when another profile is connected fine', () => {
        // Ground truth: an already-paired extension whose stored token
        // predates the daemon's token file being regenerated retries forever
        // and fails silently — the "확장 연결됨" branch used to return before
        // ever looking at this, so a healthy second profile hid the problem.
        const out = formatBrowserStatus({
            ...base,
            daemonRunning: true,
            connections: [{ profile: 'default' }],
            hasRecentAuthFailure: true,
        })
        expect(out).toContain('확장 연결됨')
        expect(out).toMatch(/토큰|재연결/)
        expect(out).toContain(`chrome-extension://${base.extensionId}/src/options.html?token=${base.token}&port=${base.bridgePort}`)
    })

    it('distinguishes "never connected" from "rejected for a bad token" when nothing is connected', () => {
        const out = formatBrowserStatus({
            ...base,
            daemonRunning: true,
            connections: [],
            hasRecentAuthFailure: true,
        })
        expect(out).not.toContain('연결된 확장이 없습니다')
        expect(out).toMatch(/토큰|재연결/)
    })

    it('leads with the daemon being down, since nothing else can work then', () => {
        const out = formatBrowserStatus({ ...base, daemonRunning: false, connections: [] })
        expect(out).toMatch(/데몬|daemon/i)
        expect(out).toContain('happy daemon start')
    })

    it('says another install holds the bridge instead of "start the daemon"', () => {
        // Ground truth: a daemon started with HAPPY_HOME_DIR set owns port
        // 41777, so this install's state file says "not running" while the
        // bridge is very much up. Telling the user to start a daemon here is
        // useless — the second one cannot bind the port.
        const out = formatBrowserStatus({
            ...base,
            daemonRunning: false,
            bridgePortInUse: true,
            connections: [],
        })
        expect(out).toContain('41777')
        expect(out).toMatch(/다른 happy|다른 데몬/)
        expect(out).toContain('happy daemon stop')
        expect(out).not.toMatch(/데몬이 실행 중이 아닙니다/)
    })

    it('does not claim nothing is connected when it could not ask', () => {
        // Connections are read from this install's daemon. When another
        // install owns the bridge we never reached anyone to ask, so "연결된
        // 확장이 없습니다" would be an unverified claim — and a misleading one,
        // since an extension may well be connected to that other daemon.
        const out = formatBrowserStatus({
            ...base,
            daemonRunning: false,
            bridgePortInUse: true,
            connections: [],
        })
        expect(out).not.toContain('연결된 확장이 없습니다')
        expect(out).toMatch(/확인할 수 없|알 수 없/)
    })

    it('flags a running daemon that never got the bridge port', () => {
        // run.ts logs a bind failure to debug only and comes up without a
        // bridge. From the user's side that is indistinguishable from "the
        // extension is not set up" — the port being free while our daemon
        // runs is the one observable signal that this happened.
        const out = formatBrowserStatus({
            ...base,
            daemonRunning: true,
            bridgePortInUse: false,
            connections: [],
        })
        expect(out).toMatch(/잡지 못했/)
        expect(out).toContain('41777')
        expect(out).toContain('happy daemon stop')
    })

    it('still tells the user to start the daemon when nothing holds the bridge', () => {
        const out = formatBrowserStatus({
            ...base,
            daemonRunning: false,
            bridgePortInUse: false,
            connections: [],
        })
        expect(out).toMatch(/데몬이 실행 중이 아닙니다/)
        expect(out).toContain('happy daemon start')
    })

    describe('remote host', () => {
        it('says nothing about a remote host when the bridge is loopback-only', () => {
            const out = formatBrowserStatus({ ...base, daemonRunning: true, connections: [], bridgeHost: '127.0.0.1' })
            expect(out).not.toContain('host=')
            expect(out).not.toMatch(/평문|공인/)
        })

        // The bridge can bind 0.0.0.0 without the user ever setting a public
        // host to hand their own PC's Chrome — those are two separate env
        // vars on purpose (NAT/port-forwarding means the bind address and the
        // address a remote client dials are often different).
        it('warns about the exposure once the bridge is bound off loopback, even with no public host to print a link for', () => {
            const out = formatBrowserStatus({ ...base, daemonRunning: true, connections: [], bridgeHost: '0.0.0.0' })
            expect(out).toMatch(/평문|암호화되지 않|토큰.*유일/)
            expect(out).not.toContain('host=')
        })

        // The liveness probe used to be hardcoded to loopback. A daemon bound
        // to one specific interface is then unreachable at 127.0.0.1, so the
        // probe came back false and formatBrowserStatus printed "브리지 포트를
        // 잡지 못했습니다" plus a restart that changes nothing — for a bridge
        // that was working fine.
        it('probes the interface the bridge is actually bound to', () => {
            expect(bridgeProbeHost('192.168.1.5')).toBe('192.168.1.5')
            expect(bridgeProbeHost('::1')).toBe('::1')
        })

        it('probes loopback for a wildcard bind, which a wildcard always covers', () => {
            expect(bridgeProbeHost('0.0.0.0')).toBe('127.0.0.1')
            expect(bridgeProbeHost('::')).toBe('127.0.0.1')
            expect(bridgeProbeHost('127.0.0.1')).toBe('127.0.0.1')
        })

        // '::1' is as loopback-only as 127.0.0.1 — warning that the machine
        // is reachable from outside, and softening the auth-failure wording
        // to "maybe a scanner", would both be wrong there.
        it('treats the IPv6 loopback like 127.0.0.1: no exposure warning', () => {
            const out = formatBrowserStatus({ ...base, daemonRunning: true, connections: [], bridgeHost: '::1' })
            expect(out).not.toMatch(/평문|밖에서도/)
        })

        // On a public bind any internet scanner touching 41777 trips
        // hasRecentAuthFailure, so the loopback-era wording ("your other
        // extension is retrying with an old token") becomes a guess that
        // sends the user re-pairing something that was never broken.
        it('does not blame a stale extension for a rejected attempt when anyone can reach the port', () => {
            const out = formatBrowserStatus({
                ...base,
                daemonRunning: true,
                connections: [],
                hasRecentAuthFailure: true,
                bridgeHost: '0.0.0.0',
            })
            expect(out).toMatch(/외부|스캔|확장이 아닐/)
        })

        it('still names the stale-token cause plainly when only loopback can reach the port', () => {
            const out = formatBrowserStatus({
                ...base,
                daemonRunning: true,
                connections: [],
                hasRecentAuthFailure: true,
                bridgeHost: '127.0.0.1',
            })
            expect(out).not.toMatch(/외부|스캔/)
            expect(out).toMatch(/토큰/)
        })

        it('adds &host= to the auto-connect link when a public host is given', () => {
            const out = formatBrowserStatus({ ...base, daemonRunning: true, connections: [], bridgeHost: '0.0.0.0', publicHost: 'happy.example.com' })
            expect(out).toContain(`chrome-extension://${base.extensionId}/src/options.html?token=${base.token}&port=${base.bridgePort}&host=happy.example.com`)
        })

        // PUBLIC_HOST without BRIDGE_HOST hands out a link pointing at this
        // machine while the daemon still listens on loopback only. The remote
        // extension then dials a port nothing answers on, and neither side
        // shows a cause — this status output is the one place that can see
        // both halves of the mismatch.
        it('flags a public link handed out while the bridge only listens on loopback', () => {
            const out = formatBrowserStatus({ ...base, daemonRunning: true, connections: [], bridgeHost: '127.0.0.1', publicHost: 'happy.example.com' })
            expect(out).toMatch(/HAPPY_BROWSER_BRIDGE_HOST/)
        })

        it('does not flag the pairing link when the bridge actually listens beyond loopback', () => {
            const out = formatBrowserStatus({ ...base, daemonRunning: true, connections: [], bridgeHost: '0.0.0.0', publicHost: 'happy.example.com' })
            expect(out).not.toMatch(/HAPPY_BROWSER_BRIDGE_HOST/)
        })
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
