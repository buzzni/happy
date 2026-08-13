import { describe, it, expect } from 'vitest'
import { parsePairArgs, buildPairUrl, formatPairOutcome, DEFAULT_CDP_PORT } from './browserPair'

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
            'chrome-extension://abcdef/src/options.html?token=tok%2Ben%2F1&port=41777',
        )
    })

    it('omits the debugger parameter when it was not asked for, so an existing setting survives', () => {
        expect(buildPairUrl(base)).not.toContain('debugger')
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
        connections: [{ profile: 'headless-1' }],
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
})
