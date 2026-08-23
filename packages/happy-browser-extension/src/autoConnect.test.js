import { describe, it, expect } from 'vitest'
import { parseAutoConnectParams } from './autoConnect.js'

describe('parseAutoConnectParams', () => {
    it('reads token and port from the query string', () => {
        expect(parseAutoConnectParams('?token=abc123&port=41777')).toEqual({
            token: 'abc123',
            port: 41777,
        })
    })

    it('defaults the port when the link omits it', () => {
        expect(parseAutoConnectParams('?token=abc123')).toEqual({
            token: 'abc123',
            port: 41777,
        })
    })

    it('returns null when there is no token — an ordinary options page visit', () => {
        expect(parseAutoConnectParams('')).toBeNull()
        expect(parseAutoConnectParams('?port=41777')).toBeNull()
    })

    it('returns null for a blank token', () => {
        expect(parseAutoConnectParams('?token=%20%20')).toBeNull()
    })

    it('reads an explicit debugger tier opt-in', () => {
        expect(parseAutoConnectParams('?token=abc123&debugger=1')).toEqual({
            token: 'abc123',
            port: 41777,
            debuggerTier: true,
        })
    })

    it('reads an explicit debugger tier opt-out', () => {
        expect(parseAutoConnectParams('?token=abc123&debugger=0')).toEqual({
            token: 'abc123',
            port: 41777,
            debuggerTier: false,
        })
    })

    it('omits debuggerTier entirely when the link does not mention it, so an existing setting is left alone', () => {
        const parsed = parseAutoConnectParams('?token=abc123')
        expect('debuggerTier' in parsed).toBe(false)
    })

    // Pointing this machine's Chrome at a remote happy session's bridge.
    it('reads an explicit host for a remote daemon', () => {
        expect(parseAutoConnectParams('?token=abc123&host=happy.example.com').host).toBe('happy.example.com')
    })

    // Same contract as debuggerTier, and for the same reason: a user paired
    // against a remote daemon who re-pairs from a link that says nothing
    // about the host must not be silently dropped back to loopback.
    it('omits host entirely when the link does not mention it, so an existing setting is left alone', () => {
        const parsed = parseAutoConnectParams('?token=abc123')
        expect('host' in parsed).toBe(false)
    })

    it('reads an exact profile name when the pairing link pins one', () => {
        expect(parseAutoConnectParams('?token=abc123&profile=viewer-9222').profile).toBe('viewer-9222')
    })

    it('omits profile when the link does not mention it, preserving the existing name', () => {
        const parsed = parseAutoConnectParams('?token=abc123')
        expect('profile' in parsed).toBe(false)
    })
})
