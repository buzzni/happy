import { describe, it, expect } from 'vitest'
import { parsePairArgs, buildPairUrl, formatPairOutcome, pickTierProbeProfile, DEFAULT_CDP_PORT } from './browserPair'

describe('parsePairArgs', () => {
    it('defaults to Chrome\'s conventional debugging port and leaves the debugger tier alone', () => {
        expect(parsePairArgs([])).toEqual({ cdpPort: DEFAULT_CDP_PORT })
    })

    it('reads --cdp-port in both spellings', () => {
        expect(parsePairArgs(['--cdp-port', '9333']).cdpPort).toBe(9333)
        expect(parsePairArgs(['--cdp-port=9333']).cdpPort).toBe(9333)
    })

    it('reads the debugger tier opt-in and opt-out', () => {
        expect(parsePairArgs(['--debugger']).debuggerTier).toBe(true)
        expect(parsePairArgs(['--no-debugger']).debuggerTier).toBe(false)
    })

    it('rejects a port that is not a port, rather than silently using the default', () => {
        expect(() => parsePairArgs(['--cdp-port', 'abc'])).toThrow(/--cdp-port/)
        expect(() => parsePairArgs(['--cdp-port', '0'])).toThrow(/--cdp-port/)
    })

    it('rejects an unknown flag instead of ignoring a typo', () => {
        expect(() => parsePairArgs(['--debuger'])).toThrow(/--debuger/)
    })
})

describe('buildPairUrl', () => {
    const base = { extensionId: 'abcdef', token: 'tok+en/1', bridgePort: 41777 }

    it('points at the extension options page with the token and port', () => {
        expect(buildPairUrl(base)).toBe(
            'chrome-extension://abcdef/src/options.html?token=tok%2Ben%2F1&port=41777&host=127.0.0.1',
        )
    })

    it('omits the debugger parameter when it was not asked for, so an existing setting survives', () => {
        expect(buildPairUrl(base)).not.toContain('debugger')
    })

    // Unlike the debugger tier, host is pinned rather than left alone: pair
    // drives a Chrome on this machine against this machine's daemon, so a
    // remote host left over from an earlier pairing would make the extension
    // dial somewhere else and this run fail for no visible reason.
    it('pins the host to loopback, since pair is a same-machine operation', () => {
        expect(buildPairUrl(base)).toContain('host=127.0.0.1')
    })

    it('carries an explicit debugger decision', () => {
        expect(buildPairUrl({ ...base, debuggerTier: true })).toContain('&debugger=1')
        expect(buildPairUrl({ ...base, debuggerTier: false })).toContain('&debugger=0')
    })
})

describe('formatPairOutcome', () => {
    const base = {
        cdpPort: 9222,
        extensionDir: '/opt/happy/browser-extension',
        daemonRunning: true,
        cdpReachable: true,
        extensionLoaded: true,
        pageOpened: true,
        connections: [{ profile: 'headless-1' }],
        freshProfiles: ['headless-1'],
    }

    it('succeeds and names the connected profile', () => {
        const outcome = formatPairOutcome(base)
        expect(outcome.ok).toBe(true)
        expect(outcome.text).toContain('headless-1')
    })

    it('leads with the daemon when it is not running — nothing below it can work', () => {
        const outcome = formatPairOutcome({ ...base, daemonRunning: false, connections: [] })
        expect(outcome.ok).toBe(false)
        expect(outcome.text).toContain('happy daemon start')
    })

    it('names the CDP port when Chrome is not listening on it', () => {
        const outcome = formatPairOutcome({ ...base, cdpReachable: false, connections: [] })
        expect(outcome.ok).toBe(false)
        expect(outcome.text).toContain('--remote-debugging-port=9222')
    })

    it('names the extension directory when Chrome is up but the extension was never loaded', () => {
        const outcome = formatPairOutcome({ ...base, extensionLoaded: false, connections: [] })
        expect(outcome.ok).toBe(false)
        expect(outcome.text).toContain('--load-extension=/opt/happy/browser-extension')
        expect(outcome.text).toContain('--disable-extensions-except')
    })

    // Reached the page and the extension is there, but no socket arrived: a
    // stale token or a bridge port mismatch, which the other branches would
    // mislabel as "extension missing".
    it('distinguishes "opened the page but nothing connected" from the extension being absent', () => {
        const outcome = formatPairOutcome({ ...base, connections: [] })
        expect(outcome.ok).toBe(false)
        expect(outcome.text).not.toContain('--load-extension')
        expect(outcome.text).toContain('happy browser')
    })

    // Chrome answered on /json/list but refused /json/new. Without its own
    // branch this fell through to a message that claims the page WAS opened,
    // pointing the user at a token mismatch that is not the problem.
    it('reports that the page could not be opened at all', () => {
        const outcome = formatPairOutcome({ ...base, pageOpened: false, connections: [] })
        expect(outcome.ok).toBe(false)
        expect(outcome.text).toContain('/json/new')
        expect(outcome.text).not.toContain('happy browser')
    })

    // The whole point of --debugger is that the user cannot check the toggle
    // themselves on a headless box, so reporting success without verifying it
    // is the one lie this command must not tell. An already-connected profile
    // makes the connection poll return before the page has even loaded.
    it('refuses to call it done when the requested debugger tier did not take', () => {
        const outcome = formatPairOutcome({ ...base, debuggerTierRequested: true, debuggerTierActual: false })
        expect(outcome.ok).toBe(false)
        expect(outcome.text).toContain('정밀 제어')
    })

    it('confirms the debugger tier when it did take', () => {
        const outcome = formatPairOutcome({ ...base, debuggerTierRequested: true, debuggerTierActual: true })
        expect(outcome.ok).toBe(true)
        expect(outcome.text).toContain('정밀 제어')
    })

    it('says nothing about the debugger tier when it was not asked for', () => {
        const outcome = formatPairOutcome(base)
        expect(outcome.ok).toBe(true)
        expect(outcome.text).not.toContain('정밀 제어')
    })

    // A profile that was already connected before pair started proves nothing
    // about the Chrome we just drove. When the CDP Chrome demonstrably has no
    // extension, a bystander connection must not turn into "pairing done".
    it('reports the unloaded extension instead of success when only a bystander is connected', () => {
        const outcome = formatPairOutcome({
            ...base,
            extensionLoaded: false,
            connections: [{ profile: 'desktop' }],
            freshProfiles: [],
        })
        expect(outcome.ok).toBe(false)
        expect(outcome.text).toContain('--load-extension')
    })

    // A re-pair of an already-working profile produces no new connection —
    // that is a fine outcome, but it must be described as what it is, not as
    // a fresh pairing that this run performed.
    it('describes an unchanged existing connection as such, not as a fresh pairing', () => {
        const outcome = formatPairOutcome({ ...base, freshProfiles: [] })
        expect(outcome.ok).toBe(true)
        expect(outcome.text).not.toContain('페어링 완료')
        expect(outcome.text).toContain('headless-1')
    })

    it('leads the success message with the profile this run actually connected', () => {
        const outcome = formatPairOutcome({
            ...base,
            connections: [{ profile: 'desktop' }, { profile: 'headless-1' }],
            freshProfiles: ['headless-1'],
        })
        expect(outcome.ok).toBe(true)
        expect(outcome.text).toContain('headless-1')
    })
})

// The daemon refuses a profile-less request outright when several profiles
// are connected (AMBIGUOUS_PROFILE), so the tier probe must name its target —
// and skip the probe honestly when the target cannot be determined, instead
// of polling into guaranteed rejections and then blaming the extension.
describe('pickTierProbeProfile', () => {
    it('picks the profile that appeared after the page was opened', () => {
        expect(pickTierProbeProfile(['desktop'], [{ profile: 'desktop' }, { profile: 'headless-1' }]))
            .toBe('headless-1')
    })

    it('picks the only connection on a re-pair, where nothing new appears', () => {
        expect(pickTierProbeProfile(['headless-1'], [{ profile: 'headless-1' }])).toBe('headless-1')
    })

    it('gives up when several profiles are connected and none is new', () => {
        expect(pickTierProbeProfile(['a', 'b'], [{ profile: 'a' }, { profile: 'b' }])).toBeUndefined()
    })

    it('gives up when several new profiles appeared at once', () => {
        expect(pickTierProbeProfile([], [{ profile: 'a' }, { profile: 'b' }])).toBeUndefined()
    })
})
