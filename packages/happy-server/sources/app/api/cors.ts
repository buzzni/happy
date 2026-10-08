import { parsePreviewHost } from '@/modules/preview/parsePreviewHost';

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

export function fastifyCorsOrigin(
    origin: string | undefined,
    callback: (error: Error | null, value: string | boolean) => void,
): void {
    callback(null, isAllowedCorsOrigin(origin) && origin ? origin : false);
}

export function socketCorsOrigin(
    origin: string | undefined,
    callback: (error: Error | null, allowed?: boolean) => void,
): void {
    callback(null, isAllowedCorsOrigin(origin));
}
