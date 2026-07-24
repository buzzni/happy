import { describe, it, expect } from 'vitest'
import { parseAllowlist, isUrlAllowed } from './allowlist.js'

describe('parseAllowlist', () => {
    it('splits on newlines and commas, trimming blanks', () => {
        expect(parseAllowlist(' example.com,\n  *.test.io \n\n')).toEqual(['example.com', '*.test.io'])
    })

    it('ignores comment lines so users can annotate their list', () => {
        expect(parseAllowlist('# work sites\nexample.com')).toEqual(['example.com'])
    })

    it('treats an empty or whitespace-only value as no patterns', () => {
        expect(parseAllowlist('')).toEqual([])
        expect(parseAllowlist('   \n ')).toEqual([])
        expect(parseAllowlist(undefined)).toEqual([])
    })
})

describe('isUrlAllowed', () => {
    it('allows everything when no patterns are configured', () => {
        // Empty list means "unrestricted" rather than "deny all": the bridge is
        // already loopback- and token-gated, and a default-deny here would
        // silently break every existing pairing on upgrade.
        expect(isUrlAllowed('https://anything.com/x', [])).toBe(true)
    })

    it('matches an exact host', () => {
        expect(isUrlAllowed('https://example.com/path', ['example.com'])).toBe(true)
        expect(isUrlAllowed('https://other.com/path', ['example.com'])).toBe(false)
    })

    it('does not treat a suffix match as a host match', () => {
        // notexample.com must not be allowed by the pattern example.com
        expect(isUrlAllowed('https://notexample.com/', ['example.com'])).toBe(false)
        expect(isUrlAllowed('https://example.com.evil.tld/', ['example.com'])).toBe(false)
    })

    it('matches subdomains only with an explicit wildcard', () => {
        expect(isUrlAllowed('https://app.example.com/', ['example.com'])).toBe(false)
        expect(isUrlAllowed('https://app.example.com/', ['*.example.com'])).toBe(true)
    })

    it('lets a wildcard pattern also match the bare domain', () => {
        expect(isUrlAllowed('https://example.com/', ['*.example.com'])).toBe(true)
    })

    it('honours a scheme when the pattern gives one', () => {
        expect(isUrlAllowed('http://example.com/', ['https://example.com'])).toBe(false)
        expect(isUrlAllowed('https://example.com/', ['https://example.com'])).toBe(true)
    })

    it('ignores scheme when the pattern omits it', () => {
        expect(isUrlAllowed('http://example.com/', ['example.com'])).toBe(true)
    })

    it('honours a port when the pattern gives one', () => {
        expect(isUrlAllowed('http://localhost:3000/', ['localhost:3000'])).toBe(true)
        expect(isUrlAllowed('http://localhost:4000/', ['localhost:3000'])).toBe(false)
        expect(isUrlAllowed('http://localhost:4000/', ['localhost'])).toBe(true)
    })

    it('allows a url matching any one of several patterns', () => {
        expect(isUrlAllowed('https://b.com/', ['a.com', 'b.com'])).toBe(true)
    })

    it('is case-insensitive about the host', () => {
        expect(isUrlAllowed('https://EXAMPLE.com/', ['example.com'])).toBe(true)
    })

    it('supports a lone * as allow-everything', () => {
        expect(isUrlAllowed('https://whatever.com/', ['*'])).toBe(true)
    })

    it('rejects a url it cannot parse rather than letting it through', () => {
        expect(isUrlAllowed('not a url', ['example.com'])).toBe(false)
        expect(isUrlAllowed(undefined, ['example.com'])).toBe(false)
    })

    it('still allows an unparseable url when there are no patterns', () => {
        expect(isUrlAllowed(undefined, [])).toBe(true)
    })
})
