/**
 * The credential a browser uses to open its sync socket.
 *
 * ## Why it is not the account bearer
 *
 * A browser used to carry the account bearer itself. That bearer is one value
 * per account, shared with the CLI, the desktop app and the phone, and nothing
 * here can withdraw it — so "log this browser out" had no way to mean anything
 * on the socket. Ending the browser's access meant ending everyone's.
 *
 * This credential names the account the browser acts as and nothing else. It is
 * short-lived on purpose: the web app's server reissues it only while that
 * browser's own login session is still live, so a logout stops the reissue and
 * the socket falls off within one lifetime. That is the whole revocation story
 * — deliberately, because putting a revocation row here would mean two places
 * disagree about whether a browser is still logged in, and the logout would
 * depend on a call across services that can fail halfway.
 *
 * ## What the lifetime actually bounds — and what it does not
 *
 * The credential itself stops working at `BROWSER_SYNC_MAX_TTL_MS`, and both
 * enforcement points hold that line: REST verifies expiry per request, and the
 * socket layer ends a connection that is already open (including one restored
 * by connection state recovery, which skips the auth middleware — see
 * `armBrowserSyncDeadline`).
 *
 * It does **not** follow that everything reachable with this credential dies
 * with it. A route that hands back something with its own lifetime hands back
 * that lifetime, not this one. Two kinds of route are therefore refused
 * outright, via `requireAccountPrincipal`:
 *
 *   - routes that issue a longer-lived credential — `/v1/auth/browser-sync`
 *     (it would renew itself, and logout would stop cutting anything off) and
 *     the two auth-approval routes, whose collection endpoints answer with
 *     `auth.createToken(...)`;
 *   - routes that hand back a stored external secret (`/v1/connect/tokens`
 *     and the two per-vendor `token` reads) or grant another account standing
 *     authority (project member invite and role change).
 *
 * Known and **not** bounded by this credential's expiry, reviewed 2026-09-19
 * and left as they are because each is already bounded on its own and capping
 * them needs the expiry carried through every derivation:
 *
 *   - `/v1/preview-token` signs for 60 minutes;
 *   - S3 upload/download signatures are 900 seconds from the call;
 *   - the GitHub OAuth `state` is 5 minutes.
 *
 * Anything added here that issues or returns a credential must decide which of
 * those two lists it belongs to.
 *
 * The service name is bound into privacy-kit's signature, so a token issued
 * here cannot be presented as an account bearer or a daemon credential even
 * though all three are derived from the same seed.
 */
import * as privacyKit from 'privacy-kit';

/** Bound into the signature: a different purpose is a different service. */
export const BROWSER_SYNC_TOKEN_SERVICE = 'happy-browser-sync';

const BROWSER_SYNC_TOKEN_VERSION = 1;
const MAX_ID_LENGTH = 200;

/**
 * The longest a browser sync credential may live.
 *
 * The window between the web app refusing to reissue and the socket actually
 * falling off. Renewal is how a browser stays connected, not a long lifetime.
 * It bounds the credential, not every credential derived through it — see the
 * two lists above.
 */
export const BROWSER_SYNC_MAX_TTL_MS = 15 * 60 * 1000;

/**
 * Everything the token asserts.
 *
 * No session, grant or machine: naming one would invite something to read it
 * as authority over that object, and this credential authorises none of it. It
 * also does not name the web app's login session — this server cannot check
 * that row, and an identifier nobody verifies is one somebody eventually
 * assumes is enforced.
 */
export type BrowserSyncClaims = {
    v: number;
    /** The account this browser acts as — personal, or a company identity. */
    accountId: string;
    expiresAt: number;
};

export type BrowserSyncMintResult =
    | { ok: true; token: string }
    | { ok: false; reason: 'malformed' | 'expired' | 'ttl-too-long' };

export type BrowserSyncVerifyResult =
    | { ok: true; claims: BrowserSyncClaims }
    | { ok: false; reason: 'bad-signature' | 'malformed' | 'expired' };

export type BrowserSyncTokenIssuer = {
    mint: (claims: BrowserSyncClaims, now: number) => Promise<BrowserSyncMintResult>;
    verify: (token: string, now: number) => Promise<BrowserSyncVerifyResult>;
};

function readId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= MAX_ID_LENGTH ? trimmed : null;
}

export function parseBrowserSyncClaims(raw: unknown): BrowserSyncClaims | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (record.v !== BROWSER_SYNC_TOKEN_VERSION) return null;

    const accountId = readId(record.accountId);
    if (!accountId) return null;

    const expiresAt = record.expiresAt;
    if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < 0) {
        return null;
    }

    // Anything shaped like another credential is refused rather than ignored:
    // a token that carried one would be read as one by something eventually.
    if (record.sessionId !== undefined
        || record.grantId !== undefined
        || record.machineId !== undefined
        || record.runId !== undefined) {
        return null;
    }

    return { v: BROWSER_SYNC_TOKEN_VERSION, accountId, expiresAt };
}

export async function createBrowserSyncTokenIssuer(input: {
    seed: string;
}): Promise<BrowserSyncTokenIssuer> {
    const generator = await privacyKit.createPersistentTokenGenerator({
        service: BROWSER_SYNC_TOKEN_SERVICE,
        seed: input.seed,
    });
    const verifier = await privacyKit.createPersistentTokenVerifier({
        service: BROWSER_SYNC_TOKEN_SERVICE,
        publicKey: Uint8Array.from(generator.publicKey),
    });

    return {
        async mint(claims, now) {
            // Minting applies exactly what verification will apply: a token
            // this issuer would refuse must never leave it, or the failure
            // surfaces in the browser as an opaque rejection of a credential
            // the web app believed it had issued.
            const parsed = parseBrowserSyncClaims(claims);
            if (!parsed) return { ok: false, reason: 'malformed' };
            if (now >= parsed.expiresAt) return { ok: false, reason: 'expired' };
            if (parsed.expiresAt - now > BROWSER_SYNC_MAX_TTL_MS) {
                return { ok: false, reason: 'ttl-too-long' };
            }
            // `user` is left empty deliberately: anything reaching for it finds
            // nothing to mistake for an account principal.
            return { ok: true, token: await generator.new({ extras: parsed }) };
        },
        async verify(token, now) {
            let verified: unknown;
            try {
                verified = await verifier.verify(token);
            } catch {
                return { ok: false, reason: 'bad-signature' };
            }
            if (!verified) return { ok: false, reason: 'bad-signature' };
            const parsed = parseBrowserSyncClaims((verified as { extras?: unknown }).extras);
            if (!parsed) return { ok: false, reason: 'malformed' };
            if (now >= parsed.expiresAt) return { ok: false, reason: 'expired' };
            return { ok: true, claims: parsed };
        },
    };
}
