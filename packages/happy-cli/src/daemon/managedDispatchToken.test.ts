import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
    canonicalManagedPayloadDigest,
    parseManagedVerifierKey,
    verifyManagedDispatchToken,
    type ManagedTokenClaims,
} from './managedDispatchToken';

const keys = generateKeyPairSync('ed25519');
const publicKeyDer = keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
const verifier = parseManagedVerifierKey(publicKeyDer);

const NOW = 1_800_000_000_000;

function claims(overrides: Partial<ManagedTokenClaims> = {}): Record<string, unknown> {
    return {
        v: 1,
        kid: 'test-kid',
        aud: 'runtime-1',
        op: 'spawn',
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        runId: 'run-1',
        attemptId: 'attempt-1',
        requestKey: 'req-1',
        epoch: 3,
        payloadDigest: canonicalManagedPayloadDigest({ b: 2, a: 1 }),
        iat: NOW,
        exp: NOW + 60_000,
        ...overrides,
    };
}

function mint(body: Record<string, unknown>, signWith = keys.privateKey): string {
    const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    // Ed25519 hashes internally; the digest argument must be null (a named
    // digest throws ERR_OSSL_INVALID_DIGEST even for a valid signature).
    const signature = sign(null, Buffer.from(encoded, 'utf8'), signWith);
    return `${encoded}.${signature.toString('base64url')}`;
}

function verify(token: string, overrides: Partial<Parameters<typeof verifyManagedDispatchToken>[0]> = {}) {
    return verifyManagedDispatchToken({
        token,
        verifier,
        runtimeId: 'runtime-1',
        workspaceId: 'ws-1',
        op: 'spawn',
        paramsDigest: canonicalManagedPayloadDigest({ a: 1, b: 2 }),
        currentEpoch: 3,
        now: NOW + 1_000,
        ...overrides,
    });
}

describe('verifyManagedDispatchToken', () => {
    it('accepts a token signed with the provisioned key', () => {
        const result = verify(mint(claims()));
        expect(result).toMatchObject({ ok: true });
        if (result.ok) {
            expect(result.claims.requestKey).toBe('req-1');
            expect(result.claims.runId).toBe('run-1');
        }
    });

    it('rejects a signature produced by a different key', () => {
        const other = generateKeyPairSync('ed25519');
        expect(verify(mint(claims(), other.privateKey)))
            .toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('rejects a tampered payload that keeps a well-formed signature', () => {
        const token = mint(claims());
        const [body, signature] = token.split('.');
        const forged = Buffer.from(JSON.stringify(claims({ requestKey: 'req-2' })), 'utf8')
            .toString('base64url');
        expect(verify(`${forged}.${signature}`))
            .toEqual({ ok: false, reason: 'bad-signature' });
        expect(body).not.toBe(forged);
    });

    it('rejects a truncated signature without throwing', () => {
        const token = mint(claims());
        const truncated = `${token.split('.')[0]}.${token.split('.')[1]!.slice(0, 40)}`;
        expect(verify(truncated)).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('separates a malformed verifier key from a bad signature', () => {
        expect(() => parseManagedVerifierKey(Buffer.from('not-a-key')))
            .toThrowError(/managed verifier key/);
    });

    it('rejects a token minted for another runtime', () => {
        expect(verify(mint(claims({ aud: 'runtime-2' }))))
            .toEqual({ ok: false, reason: 'wrong-audience' });
    });

    it('rejects a token minted for another workspace', () => {
        expect(verify(mint(claims({ workspaceId: 'ws-2' }))))
            .toEqual({ ok: false, reason: 'wrong-workspace' });
    });

    it('rejects a lease token replayed as a spawn token', () => {
        expect(verify(mint(claims({ op: 'lease' }))))
            .toEqual({ ok: false, reason: 'wrong-op' });
    });

    it('rejects an expired token', () => {
        expect(verify(mint(claims()), { now: NOW + 61_000 }))
            .toEqual({ ok: false, reason: 'expired' });
    });

    it('rejects a token issued too far in the future', () => {
        expect(verify(mint(claims({ iat: NOW + 300_000, exp: NOW + 330_000 }))))
            .toEqual({ ok: false, reason: 'clock-skew' });
    });

    it('rejects a token whose lifetime exceeds the cap', () => {
        expect(verify(mint(claims({ exp: NOW + 30 * 60_000 }))))
            .toEqual({ ok: false, reason: 'ttl-too-long' });
    });

    it('rejects an epoch older than the runtime fencing token', () => {
        expect(verify(mint(claims({ epoch: 2 }))))
            .toEqual({ ok: false, reason: 'stale-epoch' });
    });

    it('refuses a spawn whose epoch is ahead of the runtime', () => {
        // A higher epoch means the server intends a new generation. Letting a
        // spawn ride that intent would start work while the previous
        // generation's children are still writing — the epoch may only be
        // raised by a lease renewal that first fences them.
        expect(verify(mint(claims({ epoch: 4 }))))
            .toEqual({ ok: false, reason: 'epoch-mismatch' });
    });

    it('refuses a stop or query whose epoch is ahead of the runtime', () => {
        for (const op of ['stop', 'query'] as const) {
            expect(verify(mint(claims({ op, epoch: 4 })), { op }))
                .toEqual({ ok: false, reason: 'epoch-mismatch' });
        }
    });

    it('accepts a lease renewal carrying a higher epoch, which is the fence path', () => {
        const token = mint(claims({
            op: 'lease', epoch: 4, renewalSeq: 1, leaseMs: 60_000, absoluteExpiry: NOW + 600_000,
        }));
        expect(verify(token, { op: 'lease' })).toMatchObject({ ok: true });
    });

    it('rejects params that do not match the signed digest', () => {
        expect(verify(mint(claims()), {
            paramsDigest: canonicalManagedPayloadDigest({ a: 1, b: 3 }),
        })).toEqual({ ok: false, reason: 'payload-mismatch' });
    });

    describe('strict field parsing', () => {
        const cases: Array<[string, Record<string, unknown>]> = [
            ['NaN exp', { exp: Number.NaN }],
            ['missing exp', { exp: undefined }],
            ['Infinity iat', { iat: Number.POSITIVE_INFINITY }],
            ['fractional epoch', { epoch: 1.5 }],
            ['negative epoch', { epoch: -1 }],
            ['string epoch', { epoch: '3' }],
            ['unsafe integer exp', { exp: Number.MAX_SAFE_INTEGER + 2 }],
            ['empty requestKey', { requestKey: '' }],
            ['non-string requestKey', { requestKey: 7 }],
            ['missing workspaceId', { workspaceId: undefined }],
            ['wrong version', { v: 2 }],
            ['unknown op', { op: 'delete-everything' }],
        ];
        for (const [name, override] of cases) {
            it(`rejects ${name}`, () => {
                expect(verify(mint(claims(override)))).toEqual({ ok: false, reason: 'malformed' });
            });
        }
    });

    it('requires a lease sequence only on lease tokens', () => {
        const leaseToken = mint(claims({ op: 'lease', renewalSeq: 5, leaseMs: 60_000, absoluteExpiry: NOW + 600_000 }));
        expect(verify(leaseToken, { op: 'lease' })).toMatchObject({ ok: true });
        const missingSeq = mint(claims({ op: 'lease', leaseMs: 60_000, absoluteExpiry: NOW + 600_000 }));
        expect(verify(missingSeq, { op: 'lease' })).toEqual({ ok: false, reason: 'malformed' });
    });

    it('rejects a lease token whose leaseMs exceeds the cap', () => {
        const token = mint(claims({
            op: 'lease', renewalSeq: 5, leaseMs: 60 * 60_000, absoluteExpiry: NOW + 600_000,
        }));
        expect(verify(token, { op: 'lease' })).toEqual({ ok: false, reason: 'malformed' });
    });
});

describe('canonicalManagedPayloadDigest', () => {
    it('is stable across key order so relay reserialization does not break dispatch', () => {
        expect(canonicalManagedPayloadDigest({ a: 1, b: { c: 2, d: 3 } }))
            .toBe(canonicalManagedPayloadDigest({ b: { d: 3, c: 2 }, a: 1 }));
    });

    it('distinguishes different values', () => {
        expect(canonicalManagedPayloadDigest({ a: 1 }))
            .not.toBe(canonicalManagedPayloadDigest({ a: 2 }));
    });

    it('distinguishes an absent key from an explicit undefined-like null', () => {
        expect(canonicalManagedPayloadDigest({ a: 1 }))
            .not.toBe(canonicalManagedPayloadDigest({ a: 1, b: null }));
    });
});

describe('parseManagedVerifierKey', () => {
    it('accepts a DER SPKI ed25519 key', () => {
        expect(parseManagedVerifierKey(publicKeyDer).asymmetricKeyType).toBe('ed25519');
    });

    it('rejects a non-ed25519 key', () => {
        const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const der = rsa.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
        expect(() => parseManagedVerifierKey(der)).toThrowError(/ed25519/);
    });
});
