/**
 * Verification of server-signed managed dispatch tokens.
 *
 * The runtime holds only a public verifier key, so a token cannot be minted
 * inside the runtime even by code that reads every byte of the daemon's memory.
 * That is the whole reason this is asymmetric: an HMAC secret placed here would
 * be inherited by every agent child (see `resolveInheritedSpawnEnvironment`,
 * which passes the daemon's entire `process.env` through on the default path)
 * and would hand arbitrary project code the authority to dispatch runs.
 *
 * This module verifies a signature and a set of bounded claims. It is not an
 * attestation of runtime identity — anyone holding the public key can verify
 * the same token. Runtime identity comes from provisioning (see
 * `managedRuntimeIdentity.ts`) and from the transport the token arrived on.
 */

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/** Ed25519 signatures are always 64 bytes; anything else is malformed input. */
const ED25519_SIGNATURE_BYTES = 64;
const MAX_TOKEN_BYTES = 4096;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_TOKEN_TTL_MS = 120_000;
const MAX_LEASE_MS = 300_000;
const MAX_ID_LENGTH = 200;

export const MANAGED_PROTOCOL_VERSION = 1;

export const MANAGED_OPS = ['spawn', 'stop', 'query', 'lease'] as const;
export type ManagedOp = (typeof MANAGED_OPS)[number];

export type ManagedTokenClaims = {
    v: number;
    kid: string;
    aud: string;
    op: ManagedOp;
    workspaceId: string;
    projectId: string;
    runId: string;
    attemptId: string;
    requestKey: string;
    epoch: number;
    payloadDigest: string;
    iat: number;
    exp: number;
    /** lease tokens only — monotonically increasing renewal counter. */
    renewalSeq?: number;
    leaseMs?: number;
    absoluteExpiry?: number;
};

export type ManagedTokenFailure =
    | 'malformed'
    | 'bad-signature'
    | 'wrong-audience'
    | 'wrong-workspace'
    | 'wrong-op'
    | 'expired'
    | 'clock-skew'
    | 'ttl-too-long'
    | 'stale-epoch'
    | 'epoch-mismatch'
    | 'payload-mismatch';

export type ManagedTokenResult =
    | { ok: true; claims: ManagedTokenClaims }
    | { ok: false; reason: ManagedTokenFailure };

/**
 * A misconfigured verifier key is an operator error, not an attacker: it must
 * surface as a thrown startup failure rather than blend into `bad-signature`,
 * where it would read as "someone tried to forge a token".
 */
export function parseManagedVerifierKey(der: Buffer): KeyObject {
    let key: KeyObject;
    try {
        key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    } catch (error) {
        throw new Error(`managed verifier key is not a DER SPKI public key: ${(error as Error).message}`);
    }
    if (key.asymmetricKeyType !== 'ed25519') {
        throw new Error(`managed verifier key must be ed25519, got ${key.asymmetricKeyType}`);
    }
    return key;
}

/**
 * Stable digest of the dispatch parameters.
 *
 * Keys are sorted because the token travels through the happy-server relay and
 * a JSON round-trip there must not change the digest — otherwise a legitimate
 * dispatch fails as `payload-mismatch` for a reason no log would explain.
 */
export function canonicalManagedPayloadDigest(value: unknown): string {
    return createHash('sha256').update(canonicalize(value)).digest('base64url');
}

function canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
}

/**
 * `typeof NaN === 'number'` and every comparison against NaN is false, so a
 * plain `if (exp <= now) reject` lets `exp: NaN` through as a valid token. The
 * same holds for a missing field, which arrives as `undefined`. Both are
 * rejected here rather than at each use site.
 */
function readInt(value: unknown, min: number, max: number): number | null {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
    return value >= min && value <= max ? value : null;
}

function readId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_ID_LENGTH) return null;
    return trimmed;
}

function readOp(raw: unknown): ManagedOp | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const op = (raw as Record<string, unknown>).op;
    return typeof op === 'string' && MANAGED_OPS.includes(op as ManagedOp) ? (op as ManagedOp) : null;
}

function parseClaims(raw: unknown): ManagedTokenClaims | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;

    if (readInt(record.v, MANAGED_PROTOCOL_VERSION, MANAGED_PROTOCOL_VERSION) === null) return null;
    if (typeof record.op !== 'string' || !MANAGED_OPS.includes(record.op as ManagedOp)) return null;

    const ids = {
        kid: readId(record.kid),
        aud: readId(record.aud),
        workspaceId: readId(record.workspaceId),
        projectId: readId(record.projectId),
        runId: readId(record.runId),
        attemptId: readId(record.attemptId),
        requestKey: readId(record.requestKey),
        payloadDigest: readId(record.payloadDigest),
    };
    for (const value of Object.values(ids)) {
        if (value === null) return null;
    }

    const epoch = readInt(record.epoch, 0, Number.MAX_SAFE_INTEGER);
    const iat = readInt(record.iat, 0, Number.MAX_SAFE_INTEGER);
    const exp = readInt(record.exp, 0, Number.MAX_SAFE_INTEGER);
    if (epoch === null || iat === null || exp === null) return null;

    const claims: ManagedTokenClaims = {
        v: MANAGED_PROTOCOL_VERSION,
        op: record.op as ManagedOp,
        kid: ids.kid!,
        aud: ids.aud!,
        workspaceId: ids.workspaceId!,
        projectId: ids.projectId!,
        runId: ids.runId!,
        attemptId: ids.attemptId!,
        requestKey: ids.requestKey!,
        payloadDigest: ids.payloadDigest!,
        epoch,
        iat,
        exp,
    };

    if (claims.op === 'lease') {
        // A lease without a sequence could be replayed forever to hold the
        // runtime's write deadline open; without an absolute expiry the server
        // could not bound a lease it already regrets issuing.
        const renewalSeq = readInt(record.renewalSeq, 0, Number.MAX_SAFE_INTEGER);
        const leaseMs = readInt(record.leaseMs, 1, MAX_LEASE_MS);
        const absoluteExpiry = readInt(record.absoluteExpiry, 0, Number.MAX_SAFE_INTEGER);
        if (renewalSeq === null || leaseMs === null || absoluteExpiry === null) return null;
        claims.renewalSeq = renewalSeq;
        claims.leaseMs = leaseMs;
        claims.absoluteExpiry = absoluteExpiry;
    }

    return claims;
}

export function verifyManagedDispatchToken(input: {
    token: string;
    verifier: KeyObject;
    runtimeId: string;
    workspaceId: string;
    op: ManagedOp;
    paramsDigest: string;
    currentEpoch: number;
    now: number;
}): ManagedTokenResult {
    if (typeof input.token !== 'string' || input.token.length > MAX_TOKEN_BYTES) {
        return { ok: false, reason: 'malformed' };
    }
    const separator = input.token.indexOf('.');
    if (separator <= 0 || separator === input.token.length - 1) {
        return { ok: false, reason: 'malformed' };
    }
    const body = input.token.slice(0, separator);
    const signature = Buffer.from(input.token.slice(separator + 1), 'base64url');
    if (signature.length !== ED25519_SIGNATURE_BYTES) {
        return { ok: false, reason: 'bad-signature' };
    }

    // Ed25519 takes the message directly: the algorithm argument must be null.
    // Passing 'sha512' throws ERR_OSSL_INVALID_DIGEST even for a valid pair.
    let signatureValid: boolean;
    try {
        signatureValid = cryptoVerify(null, Buffer.from(body, 'utf8'), input.verifier, signature);
    } catch {
        return { ok: false, reason: 'bad-signature' };
    }
    if (!signatureValid) return { ok: false, reason: 'bad-signature' };

    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    // The op is read before the full parse so a token minted for another
    // operation reports `wrong-op` instead of `malformed` — the op-specific
    // required fields differ, and "malformed" would hide a replay attempt.
    const declaredOp = readOp(parsed);
    if (declaredOp !== null && declaredOp !== input.op) return { ok: false, reason: 'wrong-op' };

    const claims = parseClaims(parsed);
    if (!claims) return { ok: false, reason: 'malformed' };

    if (claims.aud !== input.runtimeId) return { ok: false, reason: 'wrong-audience' };
    if (claims.op !== input.op) return { ok: false, reason: 'wrong-op' };
    if (claims.workspaceId !== input.workspaceId) return { ok: false, reason: 'wrong-workspace' };
    if (claims.iat - input.now > MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'clock-skew' };
    if (claims.exp <= input.now) return { ok: false, reason: 'expired' };
    if (claims.exp < claims.iat || claims.exp - claims.iat > MAX_TOKEN_TTL_MS) {
        return { ok: false, reason: 'ttl-too-long' };
    }
    // Epoch rules differ by operation, and collapsing them is a fencing hole.
    //
    // Work operations (spawn/stop/query) must match the epoch this runtime
    // currently holds *exactly*. Accepting a higher epoch here would let a
    // freshly signed token start work in a new generation while the previous
    // generation's children are still running and still writing — the server
    // would have "raised the epoch" without any old writer having been fenced.
    //
    // Only a lease renewal may carry a higher epoch, because that is the one
    // path that performs the fence (and refuses to persist the new epoch unless
    // every prior-generation process is provably gone).
    if (claims.epoch < input.currentEpoch) return { ok: false, reason: 'stale-epoch' };
    if (input.op !== 'lease' && claims.epoch !== input.currentEpoch) {
        return { ok: false, reason: 'epoch-mismatch' };
    }
    if (claims.payloadDigest !== input.paramsDigest) return { ok: false, reason: 'payload-mismatch' };

    return { ok: true, claims };
}
