/**
 * Optional per-site restriction on what the agent may touch.
 *
 * The bridge is already loopback-only and token-gated, so this is a second
 * fence for the case the user cares about most: keeping an agent away from
 * tabs it has no business in (banking, personal mail) even when it is
 * otherwise authorised. Enforced in protocol.js, configured in the options
 * page — the extension is the right place for it because it is the only
 * component that can see the real tab URLs.
 */

export function parseAllowlist(raw) {
    return (raw ?? '')
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '' && !entry.startsWith('#'))
}

function parsePattern(pattern) {
    let rest = pattern.trim().toLowerCase()
    let scheme = null

    const schemeMatch = rest.match(/^([a-z][a-z0-9+.-]*):\/\//)
    if (schemeMatch) {
        scheme = schemeMatch[1]
        rest = rest.slice(schemeMatch[0].length)
    }

    rest = rest.replace(/\/.*$/, '')

    let port = null
    const portMatch = rest.match(/:(\d+)$/)
    if (portMatch) {
        port = portMatch[1]
        rest = rest.slice(0, -portMatch[0].length)
    }

    return { scheme, host: rest, port }
}

function hostMatches(host, patternHost) {
    if (patternHost === '*') return true
    if (patternHost.startsWith('*.')) {
        const bare = patternHost.slice(2)
        // A wildcard covers the bare domain too — `*.example.com` allowing
        // example.com is what people mean, and requiring both entries is a
        // footgun that shows up as a confusing denial.
        return host === bare || host.endsWith(`.${bare}`)
    }
    return host === patternHost
}

export function isUrlAllowed(url, patterns) {
    if (!patterns || patterns.length === 0) return true

    let parsed
    try {
        parsed = new URL(url)
    } catch {
        // Unparseable (or missing) URL with a restriction in force: deny.
        // Failing open here would let anything through by simply not having
        // a URL to check.
        return false
    }

    const host = parsed.hostname.toLowerCase()
    const scheme = parsed.protocol.replace(/:$/, '')
    const port = parsed.port

    return patterns.some((pattern) => {
        const wanted = parsePattern(pattern)
        if (!hostMatches(host, wanted.host)) return false
        if (wanted.scheme !== null && wanted.scheme !== scheme) return false
        if (wanted.port !== null && wanted.port !== port) return false
        return true
    })
}
