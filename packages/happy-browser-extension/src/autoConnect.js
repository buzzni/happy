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
    return {
        token,
        port: Number.isFinite(port) && port > 0 ? port : 41777,
    }
}
