/**
 * Short-lived signed token for remote preview URLs.
 *
 * Browsers load iframe resources via GET and cannot attach an Authorization
 * header, so we sign the (userId, machineId, port) triple into a URL-safe
 * token that the preview route verifies on every request.
 *
 * Format: `{base64url(json_payload)}.{base64url(hmac_sha256(payload))}`
 *
 * The shared secret is `HANDY_MASTER_SECRET` (same as auth). Verification uses
 * a constant-time compare.
 */

import crypto from 'node:crypto';

/**
 * specs/runtime-isolation-hardening (H3) — the runtime binding a token is
 * good for. `userId` above is the *happy account* that owns the machine and
 * is only used to find the daemon socket; a company-owned shared machine
 * mints every member's token under the same account. `studioUserId` is the
 * studio identity that actually asked, and `projectId`/`leaseId` pin the
 * token to one project's currently-running dev server. They are deliberately
 * separate claims — treating the happy account as the studio user is what let
 * any holder of a company happy token reach any project on the machine.
 */
export interface PreviewProjectBinding {
    projectId: string;
    studioUserId: string;
    /** Daemon-computed digest of the runtime actually listening on `port`. */
    leaseId: string;
}

/**
 * specs/runtime-isolation-hardening (H3 viewer purpose) — the machine's remote
 * browser screen. It has no project by design; what it is bound to is one
 * user's viewer runtime on one machine.
 *
 * `viewerKey` is derived by the studio from its own secret plus the machine
 * and the *authenticated* user — never accepted from the browser, never
 * inferred from the port. The daemon looks the lease up **by this key** and
 * then proves the port is that lease's runtime; looking it up by port first
 * would hand user A the viewer of user B on a machine both may reach, which
 * the machine ACL alone cannot prevent.
 */
export interface PreviewViewerBinding {
    purpose: 'viewer';
    studioUserId: string;
    viewerKey: string;
    /** Daemon-computed digest of the viewer runtime actually serving `port`. */
    leaseId: string;
}

export type PreviewTokenBinding = PreviewProjectBinding | PreviewViewerBinding;

export function isViewerBinding(bind: PreviewTokenBinding): bind is PreviewViewerBinding {
    return (bind as PreviewViewerBinding).purpose === 'viewer';
}

/** Same shape the studio derives and the daemon registry validates. */
const VIEWER_KEY_PATTERN = /^bv1_[A-Za-z0-9_-]{32}$/;

export function isViewerKeyShape(value: unknown): value is string {
    return typeof value === 'string' && VIEWER_KEY_PATTERN.test(value);
}

export interface PreviewTokenPayload {
    userId: string;
    machineId: string;
    port: number;
    /** Absent on legacy (unbound) tokens — see PREVIEW_RUNTIME_BINDING_POLICY. */
    bind?: PreviewTokenBinding;
}

export interface VerifiedPreviewToken extends PreviewTokenPayload {
    /** Unix ms — when the signed token expires. Matches the `expiresAt` that
     *  signPreviewToken returned at mint time. Exposed so callers (e.g. the
     *  `/v1/preview` route setting a companion cookie) can derive Max-Age. */
    exp: number;
}

export interface SignedPreviewToken {
    token: string;
    expiresAt: number;
}

export interface PreviewTokenOptions {
    secret?: string;
    ttlMs?: number;
}

// 60 minutes — bumped from 10m in specs/remote-preview-relay Phase 10a.
// Web-ui's in-iframe refresh only fires while PreviewPanel is mounted, so
// users who copied the preview URL via 'URL 복사' (PreviewPanel.handleCopyUrl)
// and opened it in a fresh tab had no recovery path before the token expired.
// Longer TTL widens the recovery window; Phase 10c adds an HTML fallback
// that lets the page re-mint client-side when this TTL still elapses.
const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface EncodedPayload extends PreviewTokenPayload {
    exp: number;
}

/**
 * Strictly disjoint: a binding is read as exactly one variant or not at all.
 *
 * `purpose` absent is the project variant — that is the encoding every token
 * already in circulation uses, so it keeps working unchanged. `'viewer'` is
 * the viewer variant. **Everything else is a hard failure**, including the
 * literal `'project'`: a second way to spell the same claim is a second thing
 * to keep in step, and nothing mints it.
 *
 * A variant carrying the other variant's fields is refused too. Accepting a
 * mixed claim would let one token be read as a project binding on one code
 * path and a viewer binding on another, which is precisely the confusion
 * purpose-binding exists to remove.
 */
function decodeBinding(raw: unknown): PreviewTokenBinding | null {
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as Record<string, unknown>;
    const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

    if (!nonEmpty(candidate.studioUserId) || !nonEmpty(candidate.leaseId)) return null;

    if (candidate.purpose === 'viewer') {
        if (candidate.projectId !== undefined) return null;
        if (!isViewerKeyShape(candidate.viewerKey)) return null;
        return {
            purpose: 'viewer',
            studioUserId: candidate.studioUserId,
            viewerKey: candidate.viewerKey,
            leaseId: candidate.leaseId,
        };
    }

    if (candidate.purpose !== undefined) return null;
    if (candidate.viewerKey !== undefined) return null;
    if (!nonEmpty(candidate.projectId)) return null;
    return {
        projectId: candidate.projectId,
        studioUserId: candidate.studioUserId,
        leaseId: candidate.leaseId,
    };
}

function getSecret(override?: string): string {
    const secret = override ?? process.env.HANDY_MASTER_SECRET;
    if (!secret) {
        throw new Error('previewToken: HANDY_MASTER_SECRET is not set');
    }
    return secret;
}

function sign(payloadB64: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function encodePayload(payload: EncodedPayload): string {
    return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

function decodePayload(encoded: string): EncodedPayload | null {
    try {
        const json = Buffer.from(encoded, 'base64url').toString('utf-8');
        const parsed = JSON.parse(json);
        if (
            parsed &&
            typeof parsed === 'object' &&
            typeof parsed.userId === 'string' &&
            typeof parsed.machineId === 'string' &&
            Number.isInteger(parsed.port) &&
            Number.isInteger(parsed.exp)
        ) {
            if (parsed.bind === undefined) {
                return parsed as EncodedPayload;
            }
            const bind = decodeBinding(parsed.bind);
            // A bind claim we cannot read is a hard failure, never a fallback
            // to "unbound": silently dropping it would downgrade a bound token
            // into one the relay stops enforcing.
            if (!bind) return null;
            return { ...(parsed as EncodedPayload), bind };
        }
        return null;
    } catch {
        return null;
    }
}

export function signPreviewToken(
    payload: PreviewTokenPayload,
    options: PreviewTokenOptions = {},
): SignedPreviewToken {
    const secret = getSecret(options.secret);
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const expiresAt = Date.now() + ttlMs;

    const payloadB64 = encodePayload({ ...payload, exp: expiresAt });
    const sig = sign(payloadB64, secret);
    return { token: `${payloadB64}.${sig}`, expiresAt };
}

export function verifyPreviewToken(
    token: string,
    options: PreviewTokenOptions = {},
): VerifiedPreviewToken | null {
    return readPreviewToken(token, options, { allowExpired: false });
}

/**
 * specs/runtime-isolation-hardening (H3, P4) — read the token a re-mint is
 * replacing, expiry included.
 *
 * Recovery needs to know what the previous token was bound to, and by the
 * time the page re-mints that token is usually expired. This is deliberately
 * a separate function rather than a flag on `verifyPreviewToken`: nothing on
 * a request path can reach it by passing an option, and the signature is
 * still required, so an expired token describes the session being replaced
 * without ever authorizing anything.
 */
export function verifyExpiredPreviewTokenForRecovery(
    token: string,
    options: PreviewTokenOptions = {},
): VerifiedPreviewToken | null {
    return readPreviewToken(token, options, { allowExpired: true });
}

function readPreviewToken(
    token: string,
    options: PreviewTokenOptions,
    mode: { allowExpired: boolean },
): VerifiedPreviewToken | null {
    const secret = getSecret(options.secret);

    if (typeof token !== 'string' || !token.includes('.')) {
        return null;
    }

    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig) {
        return null;
    }

    const expected = sign(payloadB64, secret);
    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(sig);
    if (expectedBuf.length !== actualBuf.length) {
        return null;
    }
    if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
        return null;
    }

    const payload = decodePayload(payloadB64);
    if (!payload) {
        return null;
    }
    if (!mode.allowExpired && payload.exp <= Date.now()) {
        return null;
    }

    return {
        userId: payload.userId,
        machineId: payload.machineId,
        port: payload.port,
        exp: payload.exp,
        ...(payload.bind ? { bind: payload.bind } : {}),
    };
}
