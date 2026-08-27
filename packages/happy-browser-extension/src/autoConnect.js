/**
 * Parses the token/port `happy browser`'s auto-connect link puts on the
 * options page URL, so opening that link can skip the manual copy/paste.
 * Pure string parsing (no DOM) so this is testable without jsdom and safe to
 * call from a plain <script>.
 */
export function parseAutoConnectParams(search) {
    const params = new URLSearchParams(search)
    const token = (params.get('token') ?? '').trim()
    if (!token) return null

    const port = Number(params.get('port'))
    const result = {
        token,
        port: Number.isFinite(port) && port > 0 ? port : 41777,
    }

    // Absent must stay absent, exactly as for debuggerTier below: a profile
    // paired against a remote daemon would otherwise be silently dropped back
    // to loopback by any link that happens not to mention a host.
    const host = (params.get('host') ?? '').trim()
    if (host) result.host = host

    // An opaque per-run marker lets the daemon prove which Chrome loaded the
    // link without replacing the user's stable bridge profile name.
    const pairingId = (params.get('pairingId') ?? '').trim()
    if (pairingId) result.pairingId = pairingId

    const viewerKey = (params.get('viewerKey') ?? '').trim()
    if (viewerKey) result.viewerKey = viewerKey

    // Absent must stay absent rather than becoming `false`: a machine that
    // re-pairs (new token, same profile) would otherwise silently switch the
    // debugger tier back off for a user who had turned it on.
    const debuggerParam = params.get('debugger')
    if (debuggerParam !== null) {
        result.debuggerTier = debuggerParam === '1' || debuggerParam === 'true'
    }
    return result
}
