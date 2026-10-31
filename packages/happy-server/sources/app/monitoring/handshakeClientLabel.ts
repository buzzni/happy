const KNOWN_CLIENT_TYPES = new Set(['session-scoped', 'user-scoped', 'machine-scoped']);
const MAX_CLIENT_LABEL = 64;

/**
 * Who a rejected socket handshake claims to be, for the auth-failure log line.
 *
 * Both values come from the client and are not trusted: the client type is
 * reduced to a known value or `other`, and the client label to a short run of
 * label-safe characters, so neither can forge or flood a log line. Never
 * include the token or anything derived from it — the log must not reveal
 * *why* authentication failed.
 */
export function rejectedHandshakeLogLabel(handshake: {
    auth: Record<string, unknown>;
    headers: Record<string, string | string[] | undefined>;
}): string {
    const rawType = handshake.auth.clientType;
    const clientType = typeof rawType !== 'string' || rawType === ''
        ? 'unknown'
        : KNOWN_CLIENT_TYPES.has(rawType) ? rawType : 'other';
    const header = handshake.headers['x-happy-client'];
    const rawClient = typeof handshake.auth.happyClient === 'string' && handshake.auth.happyClient
        ? handshake.auth.happyClient
        : typeof header === 'string' ? header : '';
    const client = rawClient.replace(/[^A-Za-z0-9._\/-]/g, '').slice(0, MAX_CLIENT_LABEL) || 'unknown';
    return `clientType=${clientType} client=${client}`;
}
