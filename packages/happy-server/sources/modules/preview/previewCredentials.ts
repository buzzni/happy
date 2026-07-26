/**
 * Credential pass-through for the remote preview relay.
 *
 * The relay is supposed to be a transparent reverse proxy in front of a
 * developer's dev server. It was not: `filterForwardedHeaders` dropped both
 * `Authorization` and `Cookie` on the way in, and the response path
 * overwrote the upstream's `Set-Cookie` with the relay's own preview cookie.
 * The net effect is that *every* authenticated request made by the previewed
 * app arrived unauthenticated. Dev servers answer that with a 401/redirect,
 * and SPA dev servers (Expo Router, Vite, Next) answer the follow-up with
 * their history fallback — so the app's `res.json()` receives `index.html`
 * and renders raw HTML where data was expected.
 *
 * These helpers make the relay credential-transparent while keeping the
 * relay's *own* secret (the signed ptoken, carried in `happy_preview_*`
 * cookies) from ever reaching the previewed app.
 *
 * Pure functions, no fastify plumbing, so they unit-test without a harness.
 */

/**
 * Every cookie the relay itself owns starts with this. They carry the signed
 * ptoken — a bearer credential for the relay — and must never be forwarded to
 * the previewed app, which is arbitrary user code.
 *
 * Deliberately a prefix match rather than an exact `cookieName(mid, port)`
 * match: a browser sends every `happy_preview_*` cookie whose path matches,
 * so a viewer with several previews open on the studio origin would otherwise
 * leak *other* previews' tokens to this one's dev server.
 */
const PREVIEW_COOKIE_PREFIX = 'happy_preview_';

function cookiePairName(pair: string): string {
    const eq = pair.indexOf('=');
    return (eq === -1 ? pair : pair.slice(0, eq)).trim();
}

/**
 * Strip the relay's own cookies out of a browser `Cookie` header, leaving the
 * previewed app's cookies intact.
 *
 * Returns `null` when nothing survives, so the caller can omit the header
 * entirely instead of forwarding an empty one.
 */
export function filterUpstreamCookieHeader(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) return null;
    const kept = cookieHeader
        .split(';')
        .map((pair) => pair.trim())
        .filter((pair) => pair.length > 0)
        .filter((pair) => !cookiePairName(pair).startsWith(PREVIEW_COOKIE_PREFIX));
    return kept.length > 0 ? kept.join('; ') : null;
}

// A comma inside `Expires=Wed, 21 Oct 2015 07:28:00 GMT` is *not* a separator;
// a comma that introduces the next cookie is always followed by a cookie-name
// token and `=`. RFC 6265 cookie-name is an RFC 7230 token.
const SET_COOKIE_SEPARATOR = /,\s*(?=[A-Za-z0-9!#$%&'*+\-.^_`|~]+=)/;

/**
 * Normalize the daemon's `set-cookie` value into one entry per cookie.
 *
 * Current daemons send an array (one element per upstream `Set-Cookie`) —
 * that form is already unambiguous, so each element passes through verbatim.
 * Older daemons flattened the array with `', '`, which is ambiguous with the
 * comma inside an `Expires` date — only that legacy string form goes through
 * the token-aware split. Never re-split array elements: a cookie value that
 * happens to contain `,name=` (non-RFC but seen in the wild) would be torn
 * into two broken cookies. Both shapes must keep working: the daemon runs on
 * the user's machine and updates independently of the server.
 */
export function splitSetCookieValues(value: string | string[] | undefined): string[] {
    if (value === undefined) return [];
    const raw = Array.isArray(value)
        ? value.map(String)
        : String(value).split(SET_COOKIE_SEPARATOR);
    return raw
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

export interface RewriteSetCookieOptions {
    /** `/v1/preview/{machineId}/{port}` in path-prefix mode, `''` in subdomain mode. */
    prefix: string;
    /** True when the browser reached the relay over HTTPS. */
    secure: boolean;
}

/**
 * Make an upstream `Set-Cookie` storable by a browser that is rendering the
 * preview in a cross-site iframe served from the relay origin.
 *
 * Three things have to change, none of which the app can do for itself:
 *
 * - `Domain=` is dropped. Upstream emits its own host (`localhost`,
 *   `app.internal`), which does not domain-match the relay origin, so the
 *   browser rejects the entire cookie.
 * - `Path=` is moved under the relay prefix in path-prefix mode, otherwise
 *   the cookie is scoped to the relay root and never sent back for preview
 *   requests. (No-op in subdomain mode, where the prefix is empty.)
 * - `SameSite=None; Secure` is forced on HTTPS. The preview iframe is a
 *   third-party context relative to the desktop/studio top-level document,
 *   so a `Lax`/`Strict`/unset cookie is dropped on arrival.
 */
export function rewriteSetCookieForPreview(
    setCookie: string,
    options: RewriteSetCookieOptions,
): string {
    const { prefix, secure } = options;
    const segments = setCookie.split(';');
    const nameValue = segments[0]?.trim() ?? '';
    if (!nameValue) return setCookie;

    const attributes: string[] = [];
    let sawSameSite = false;
    let sawSecure = false;

    for (const segment of segments.slice(1)) {
        const attribute = segment.trim();
        if (!attribute) continue;
        const eq = attribute.indexOf('=');
        const key = (eq === -1 ? attribute : attribute.slice(0, eq)).trim().toLowerCase();
        const value = eq === -1 ? '' : attribute.slice(eq + 1).trim();

        if (key === 'domain') continue;

        if (key === 'path') {
            attributes.push(`Path=${prefixCookiePath(value, prefix)}`);
            continue;
        }

        if (key === 'samesite') {
            sawSameSite = true;
            attributes.push(secure ? 'SameSite=None' : attribute);
            continue;
        }

        if (key === 'secure') {
            sawSecure = true;
            attributes.push(attribute);
            continue;
        }

        attributes.push(attribute);
    }

    if (secure) {
        if (!sawSameSite) attributes.push('SameSite=None');
        if (!sawSecure) attributes.push('Secure');
    }

    return [nameValue, ...attributes].join('; ');
}

function prefixCookiePath(path: string, prefix: string): string {
    if (!prefix) return path || '/';
    if (!path.startsWith('/')) return path;
    // Idempotent — a retried/echoed cookie must not accumulate prefixes.
    if (path === prefix || path.startsWith(`${prefix}/`)) return path;
    return `${prefix}${path}`;
}
