import { parsePreviewHost } from '@/modules/preview/parsePreviewHost';
import { LOCALHOST_PREVIEW_HEADER, LOCALHOST_PREVIEW_VERSION } from '@/modules/preview/localhostPreviewResponse';

const FIXED_ORIGINS = new Set([
    'https://saycode.ai',
    'https://dev-studio.preview.saycode.ai',
]);
const PREVIEW_ORIGIN_HOST_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d{1,5}\.preview\.saycode\.ai$/i;

function isLocalDevelopmentOrigin(url: URL): boolean {
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
        return false;
    }
    const port = Number.parseInt(url.port, 10);
    return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isPreviewOrigin(url: URL): boolean {
    if (url.protocol !== 'https:' || !PREVIEW_ORIGIN_HOST_RE.test(url.hostname)) {
        return false;
    }
    return parsePreviewHost(url.hostname) !== null;
}

/**
 * CORS is an origin allow-list. Requests without an Origin header are still
 * allowed by the HTTP server; this function only controls whether a browser
 * origin receives CORS response headers.
 */
export function isAllowedCorsOrigin(origin: string | undefined): boolean {
    if (!origin || origin === 'null') return false;

    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        return false;
    }

    // An Origin header is a serialized origin, never a path or query. Checking
    // this also prevents accepting values such as `https://saycode.ai/path`.
    if (url.origin !== origin) return false;

    return FIXED_ORIGINS.has(url.origin)
        || isLocalDevelopmentOrigin(url)
        || isPreviewOrigin(url);
}

const API_CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/**
 * Origins of the packaged desktop renderer, matched as exact strings.
 *
 * `null` is the renderer served from file://. `app://renderer` is the renderer served from the
 * standard `app://` scheme (desktop ADR 062-renderer-app-scheme-code-cache). A custom scheme has an
 * opaque WHATWG origin (`new URL('app://renderer').origin === 'null'`), so it can never pass the
 * URL-based allow-list above and must be matched before any parsing.
 */
const DESKTOP_RENDERER_ORIGINS = new Set(['null', 'app://renderer']);
/** Chromium's ceiling. Without it a preflight is remembered for 5s and every Bearer request pays an OPTIONS round trip. */
const DESKTOP_RENDERER_PREFLIGHT_MAX_AGE_SECONDS = 7200;

/**
 * Per-request CORS options for the HTTP API.
 *
 * Allowed studio origins get credentialed CORS. The packaged desktop renderer origins get CORS
 * without credentials. The API authenticates with Bearer tokens, so a response read through those
 * origins carries no ambient authority. Everything else gets no CORS headers.
 */
export function fastifyCorsDelegate(
    request: { url?: string; headers: { origin?: string | string[]; [LOCALHOST_PREVIEW_HEADER]?: string | string[] } },
    callback: (error: Error | null, options: { origin: string | boolean; credentials?: boolean; methods: string[]; maxAge?: number }) => void,
): void {
    if (request.url?.startsWith('/v1/preview/') && request.headers[LOCALHOST_PREVIEW_HEADER] === LOCALHOST_PREVIEW_VERSION) {
        callback(null, { origin: false, methods: API_CORS_METHODS });
        return;
    }
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
    if (origin && isAllowedCorsOrigin(origin)) {
        callback(null, { origin, credentials: true, methods: API_CORS_METHODS });
    } else if (origin && DESKTOP_RENDERER_ORIGINS.has(origin)) {
        callback(null, { origin, credentials: false, methods: API_CORS_METHODS, maxAge: DESKTOP_RENDERER_PREFLIGHT_MAX_AGE_SECONDS });
    } else {
        callback(null, { origin: false, methods: API_CORS_METHODS });
    }
}

export function socketCorsOrigin(
    origin: string | undefined,
    callback: (error: Error | null, allowed?: boolean) => void,
): void {
    callback(null, isAllowedCorsOrigin(origin));
}
