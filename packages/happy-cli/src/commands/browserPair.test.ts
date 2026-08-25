import { describe, it, expect } from 'vitest'
import {
    parsePairArgs,
    buildPairUrl,
    formatPairOutcome,
    extensionAvailableAfterLoad,
    loadUnpackedExtension,
    pairingConnectionArrived,
    pickTierProbeProfile,
    shouldLoadUnpackedExtension,
    DEFAULT_CDP_PORT,
} from './browserPair'

describe('loadUnpackedExtension', () => {
    it('sends the unsafe command through the launch-time debugging pipe', async () => {
        const request = async (method: string, params?: Record<string, unknown>) => {
            expect(method).toBe('Extensions.loadUnpacked')
            expect(params).toEqual({ path: '/opt/happy/browser-extension' })
            return { id: 'extension-id' }
        }

        await expect(loadUnpackedExtension(request, '/opt/happy/browser-extension')).resolves.toBe(true)
    })

    it('reports that loading is unavailable when this process does not own the debugging pipe', async () => {
        await expect(loadUnpackedExtension(undefined, '/opt/happy/browser-extension')).resolves.toBe(false)
    })
})

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

    // Pinning loopback is only right while the daemon actually listens there.
    // Bound to one specific interface (HAPPY_BROWSER_BRIDGE_HOST=192.168.1.5),
    // nothing answers on 127.0.0.1 — the extension saved a dead address and
    // the failure got blamed on the token. The interface's own address is
    // reachable from this machine, so pin that instead.
    it('pins the bind address when the daemon listens on one specific interface', () => {
        expect(buildPairUrl({ ...base, bridgeHost: '192.168.1.5' })).toContain('host=192.168.1.5')
    })

    it('still pins loopback for a wildcard bind, which loopback always reaches', () => {
        expect(buildPairUrl({ ...base, bridgeHost: '0.0.0.0' })).toContain('host=127.0.0.1')
    })

    it('carries an explicit debugger decision', () => {
        expect(buildPairUrl({ ...base, debuggerTier: true })).toContain('&debugger=1')
        expect(buildPairUrl({ ...base, debuggerTier: false })).toContain('&debugger=0')
    })

    it('carries a pairing id without overwriting the target Chrome profile', () => {
        const url = buildPairUrl({ ...base, pairingId: 'viewer-9222' })
        expect(url).toContain('&pairingId=viewer-9222')
        expect(url).not.toContain('&profile=')
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

    it('does not accept an unrelated connection when an exact pairing id was requested', () => {
        const outcome = formatPairOutcome({
            ...base,
            targetPairingId: 'viewer-9222',
            connections: [{ profile: 'unrelated-headless', pairingId: 'other-run' }],
            freshProfiles: [],
        })

        expect(outcome.ok).toBe(false)
        expect(outcome.text).toContain('viewer-9222')
    })

    it('explains a failed extension refresh when the old visible bundle cannot emit the target marker', () => {
        const outcome = formatPairOutcome({
            ...base,
            loadUnpackedFailed: true,
            targetPairingId: 'viewer-9222',
            connections: [{ profile: 'work' }],
            freshProfiles: [],
        })

        expect(outcome.ok).toBe(false)
        expect(outcome.text).toContain('--enable-unsafe-extension-debugging')
        expect(outcome.text).toContain('fd 3/4')
        expect(outcome.text).toContain('머신 관리')
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
        expect(outcome.text).toContain('머신 관리')
        expect(outcome.text).not.toContain('google-chrome')
    })

    // Verified against Chrome 151: --load-extension is ignored outright
    // (a minimal probe extension does not load either), and neither
    // --enable-unsafe-extension-debugging nor
    // --disable-features=DisableLoadExtensionCommandLineSwitch revives it.
    // Printing that flag sends the user down a path that cannot work.
    it('does not tell the user to use --load-extension, which modern Chrome ignores', () => {
        const outcome = formatPairOutcome({ ...base, extensionLoaded: false, loadUnpackedFailed: true, connections: [] })
        // Naming it as the thing that stopped working is fine; handing it to
        // the user as the fix is not.
        expect(outcome.text).not.toContain(`--load-extension=${base.extensionDir}`)
        expect(outcome.text).toMatch(/--load-extension은 무시/)
    })

    // pair loads the extension through the launch owner's CDP pipe. A direct
    // shell invocation cannot retrofit fd 3/4 onto an already-running Chrome,
    // so recovery has to name the machine-managed restart path.
    it('names the flag CDP loading needs when it could not load the extension', () => {
        const outcome = formatPairOutcome({ ...base, extensionLoaded: false, loadUnpackedFailed: true, connections: [] })
        expect(outcome.ok).toBe(false)
        expect(outcome.text).toContain('--enable-unsafe-extension-debugging')
        expect(outcome.text).toContain('--remote-debugging-pipe')
        expect(outcome.text).toContain('/opt/happy/browser-extension')
        expect(outcome.text).toContain('머신 관리')
        expect(outcome.text).not.toContain('google-chrome')
    })

    // Reached the page and the extension is there, but no socket arrived: a
    // stale token or a bridge port mismatch, which the other branches would
    // mislabel as "extension missing".
    it('distinguishes "opened the page but nothing connected" from the extension being absent', () => {
        const outcome = formatPairOutcome({ ...base, connections: [] })
        expect(outcome.ok).toBe(false)
        expect(outcome.text).not.toContain('--enable-unsafe-extension-debugging')
        expect(outcome.text).toContain('happy browser')
    })

    // The daemon already knows which of the two it was — it reports
    // hasRecentAuthFailure. Guessing "token or port" while holding the answer
    // is exactly the ambiguity this command exists to remove.
    it('names a rejected token outright when the daemon saw the rejection', () => {
        const outcome = formatPairOutcome({ ...base, connections: [], authRejected: true })
        expect(outcome.ok).toBe(false)
        expect(outcome.text).toMatch(/거부/)
        // A rejection proves the extension reached the bridge, so the address
        // is right and suggesting otherwise sends the user the wrong way.
        expect(outcome.text).not.toMatch(/포트가 어긋|주소/)
    })

    it('says the extension never reached the bridge when no rejection was seen', () => {
        const outcome = formatPairOutcome({ ...base, connections: [], authRejected: false })
        expect(outcome.ok).toBe(false)
        expect(outcome.text).toMatch(/닿지 못했/)
        // Points at the address/port, not at the token — the opposite remedy
        // from the rejected-token branch.
        expect(outcome.text).toMatch(/주소|포트/)
        expect(outcome.text).not.toMatch(/토큰이 거부/)
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
            loadUnpackedFailed: true,
            connections: [{ profile: 'desktop' }],
            freshProfiles: [],
        })
        expect(outcome.ok).toBe(false)
        expect(outcome.text).toContain('--enable-unsafe-extension-debugging')
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

describe('pairingConnectionArrived', () => {
    it('keeps waiting when a bystander connects before the exact target', () => {
        expect(pairingConnectionArrived(
            [{ profile: 'desktop' }, { profile: 'bystander', pairingId: 'other-run' }],
            ['desktop'],
            'viewer-9222',
        )).toBe(false)
    })

    it('finishes when the exact pairing id reconnects under an existing profile', () => {
        expect(pairingConnectionArrived(
            [{ profile: 'desktop', pairingId: 'viewer-9222' }],
            ['desktop'],
            'viewer-9222',
        )).toBe(true)
    })
})

describe('extension load policy', () => {
    it('refreshes a visible extension for marker pairing so an old bundle cannot miss the protocol', () => {
        expect(shouldLoadUnpackedExtension(true, 'viewer-9222')).toBe(true)
    })

    it('keeps the ordinary pairing path from reloading an already visible extension', () => {
        expect(shouldLoadUnpackedExtension(true)).toBe(false)
    })

    it('loads the extension when Chrome has no visible extension target', () => {
        expect(shouldLoadUnpackedExtension(false)).toBe(true)
    })

    it('keeps an existing extension available when Chrome refuses the refresh', () => {
        expect(extensionAvailableAfterLoad(true, false)).toBe(true)
    })

    it('does not invent an extension when neither the old target nor the load succeeded', () => {
        expect(extensionAvailableAfterLoad(false, false)).toBe(false)
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
