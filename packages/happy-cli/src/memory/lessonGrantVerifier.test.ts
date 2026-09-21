import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign as signEd25519 } from 'node:crypto';

import {
    LESSON_GRANT_PROTOCOL,
    canonicalLessonDigest,
    lessonGrantAudience,
    createLessonGrantVerifier,
    type LessonCapability,
} from './lessonGrantVerifier';

const LESSON_GRANT_AUDIENCE = lessonGrantAudience('https://studio.example');

const snapshot = { version: 1, projectId: 'p1', requestId: 'r1', operation: 'snapshot' };
const approve = {
    version: 1, projectId: 'p1', requestId: 'r2', operation: 'approve',
    candidateId: 'c1', expectedRevision: 1, payloadHash: 'c'.repeat(64),
};

function issuer() {
    const pair = generateKeyPairSync('ed25519');
    const publicKeyBase64 = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const sign = (claims: Record<string, unknown>) => {
        const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
        const signature = signEd25519(null, Buffer.from(payload, 'utf8'), pair.privateKey).toString('base64url');
        return `${payload}.${signature}`;
    };
    return { publicKeyBase64, sign };
}

function claimsFor(request: unknown, overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        aud: LESSON_GRANT_AUDIENCE,
        op: (request as { operation: string }).operation,
        digest: canonicalLessonDigest(request),
        userId: 'u1',
        projectId: 'p1',
        machineId: 'm1',
        workspaceDir: '/ws/p1',
        capabilities: ['lesson.read', 'lesson.manage'] as LessonCapability[],
        iat: 1_000,
        expiresAt: 61_000,
        ...overrides,
    };
}

function verifierFor(publicKeyBase64: string, now = 1_500) {
    return createLessonGrantVerifier({ publicKeyBase64, machineId: 'm1', audience: LESSON_GRANT_AUDIENCE, now: () => now });
}

describe('canonicalLessonDigest', () => {
    it('matches the minting side byte for byte', () => {
        // The studio computes sha256 over the same canonical form; this pins the
        // shape rather than re-deriving it, so a drift on either side fails here.
        const expected = createHash('sha256')
            .update('{"operation":"snapshot","projectId":"p1","requestId":"r1","version":1}')
            .digest('hex');
        expect(canonicalLessonDigest(snapshot)).toBe(expected);
    });

    it('is unchanged by key order', () => {
        expect(canonicalLessonDigest({ b: 1, a: 2 })).toBe(canonicalLessonDigest({ a: 2, b: 1 }));
    });
});

describe('createLessonGrantVerifier', () => {
    it('accepts a well-formed grant and reports its capabilities', () => {
        const { publicKeyBase64, sign } = issuer();
        const result = verifierFor(publicKeyBase64).verify({
            envelope: sign(claimsFor(snapshot)), request: snapshot,
        });
        expect(result).toMatchObject({
            ok: true, claims: { userId: 'u1', capabilities: ['lesson.read', 'lesson.manage'] },
        });
    });

    it('refuses a grant for another operation', () => {
        const { publicKeyBase64, sign } = issuer();
        const envelope = sign(claimsFor(snapshot));
        expect(verifierFor(publicKeyBase64).verify({ envelope, request: approve }))
            .toEqual({ ok: false, reason: 'wrong-operation' });
    });

    it('refuses a payload altered after signing', () => {
        const { publicKeyBase64, sign } = issuer();
        const envelope = sign(claimsFor(approve));
        expect(verifierFor(publicKeyBase64).verify({ envelope, request: { ...approve, expectedRevision: 9 } }))
            .toEqual({ ok: false, reason: 'payload-mismatch' });
    });

    it('refuses a grant minted for another machine', () => {
        const { publicKeyBase64, sign } = issuer();
        const envelope = sign(claimsFor(snapshot, { machineId: 'other' }));
        expect(verifierFor(publicKeyBase64).verify({ envelope, request: snapshot }))
            .toEqual({ ok: false, reason: 'wrong-machine' });
    });

    it('refuses a grant minted by another deployment of the same protocol', () => {
        const { publicKeyBase64, sign } = issuer();
        const staging = lessonGrantAudience('https://staging.example');
        expect(staging.startsWith(LESSON_GRANT_PROTOCOL)).toBe(true);
        const envelope = sign(claimsFor(snapshot, { aud: staging }));
        expect(verifierFor(publicKeyBase64).verify({ envelope, request: snapshot }))
            .toEqual({ ok: false, reason: 'wrong-audience' });
    });

    it('refuses a forged signature', () => {
        const { sign } = issuer();
        const envelope = sign(claimsFor(snapshot));
        expect(verifierFor(issuer().publicKeyBase64).verify({ envelope, request: snapshot }))
            .toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('refuses at the expiry boundary', () => {
        const { publicKeyBase64, sign } = issuer();
        const envelope = sign(claimsFor(snapshot));
        expect(verifierFor(publicKeyBase64, 61_000).verify({ envelope, request: snapshot }))
            .toEqual({ ok: false, reason: 'expired' });
    });

    it('refuses a grant that claims a longer life than the contract allows', () => {
        const { publicKeyBase64, sign } = issuer();
        const envelope = sign(claimsFor(snapshot, { expiresAt: 1_000 + 10 * 60_000 }));
        expect(verifierFor(publicKeyBase64).verify({ envelope, request: snapshot }))
            .toEqual({ ok: false, reason: 'lifetime-too-long' });
    });

    it('refuses an unrecognised capability rather than dropping it', () => {
        const { publicKeyBase64, sign } = issuer();
        const envelope = sign(claimsFor(snapshot, { capabilities: ['lesson.read', 'lesson.everything'] }));
        expect(verifierFor(publicKeyBase64).verify({ envelope, request: snapshot }))
            .toEqual({ ok: false, reason: 'malformed' });
    });

    it('refuses a non-canonical identifier rather than trimming it', () => {
        const { publicKeyBase64, sign } = issuer();
        const envelope = sign(claimsFor(snapshot, { userId: ' u1' }));
        expect(verifierFor(publicKeyBase64).verify({ envelope, request: snapshot }))
            .toEqual({ ok: false, reason: 'malformed' });
    });

    it('refuses a request whose project disagrees with the grant', () => {
        const { publicKeyBase64, sign } = issuer();
        const foreign = { ...snapshot, projectId: 'p2' };
        const envelope = sign(claimsFor(foreign, { projectId: 'p1', digest: canonicalLessonDigest(foreign) }));
        expect(verifierFor(publicKeyBase64).verify({ envelope, request: foreign }))
            .toEqual({ ok: false, reason: 'wrong-project' });
    });

    it('refuses an envelope that is not exactly payload and signature', () => {
        const { publicKeyBase64, sign } = issuer();
        expect(verifierFor(publicKeyBase64).verify({ envelope: `${sign(claimsFor(snapshot))}.extra`, request: snapshot }))
            .toEqual({ ok: false, reason: 'malformed' });
    });

    it.each([91, 5_000])('accepts a signed issue time %i ms ahead without extending its expiry', (offset) => {
        const { publicKeyBase64, sign } = issuer();
        const iat = 1_500 + offset;
        const expiresAt = iat + 60_000;
        const envelope = sign(claimsFor(snapshot, { iat, expiresAt }));
        expect(verifierFor(publicKeyBase64).verify({ envelope, request: snapshot }))
            .toMatchObject({ ok: true, claims: { iat, expiresAt } });
        expect(verifierFor(publicKeyBase64, expiresAt).verify({ envelope, request: snapshot }))
            .toEqual({ ok: false, reason: 'expired' });
    });

    it('bounds future clock skew and retains the maximum signed lifetime', () => {
        const { publicKeyBase64, sign } = issuer();
        const future = sign(claimsFor(snapshot, { iat: 6_501, expiresAt: 66_501 }));
        expect(verifierFor(publicKeyBase64).verify({ envelope: future, request: snapshot }))
            .toEqual({ ok: false, reason: 'malformed' });
        const overlong = sign(claimsFor(snapshot, { iat: 6_500, expiresAt: 66_501 }));
        expect(verifierFor(publicKeyBase64).verify({ envelope: overlong, request: snapshot }))
            .toEqual({ ok: false, reason: 'lifetime-too-long' });
    });

    it('refuses a grant issued in the future or with no window', () => {
        const { publicKeyBase64, sign } = issuer();
        const future = sign(claimsFor(snapshot, { iat: 9_000, expiresAt: 69_000 }));
        expect(verifierFor(publicKeyBase64).verify({ envelope: future, request: snapshot }))
            .toEqual({ ok: false, reason: 'malformed' });
        const inverted = sign(claimsFor(snapshot, { iat: 1_000, expiresAt: 1_000 }));
        expect(verifierFor(publicKeyBase64).verify({ envelope: inverted, request: snapshot }))
            .toEqual({ ok: false, reason: 'malformed' });
    });

    it('refuses a grant with no workspace claim, or a relative one', () => {
        const { publicKeyBase64, sign } = issuer();
        for (const workspaceDir of [undefined, '', 'relative/path', ' /ws/p1']) {
            const envelope = sign(claimsFor(snapshot, { workspaceDir }));
            expect(verifierFor(publicKeyBase64).verify({ envelope, request: snapshot }))
                .toEqual({ ok: false, reason: 'malformed' });
        }
    });

    it('carries the signed workspace through, since it decides which store opens', () => {
        const { publicKeyBase64, sign } = issuer();
        const result = verifierFor(publicKeyBase64)
            .verify({ envelope: sign(claimsFor(snapshot)), request: snapshot });
        expect(result.ok && result.claims.workspaceDir).toBe('/ws/p1');
    });

    it('refuses a non-string envelope', () => {
        const { publicKeyBase64 } = issuer();
        expect(verifierFor(publicKeyBase64).verify({ envelope: { a: 1 }, request: snapshot }))
            .toEqual({ ok: false, reason: 'malformed' });
    });

    describe('consume', () => {
        it('burns a grant so one click cannot act twice', () => {
            const { publicKeyBase64, sign } = issuer();
            const verifier = verifierFor(publicKeyBase64);
            const envelope = sign(claimsFor(approve, { op: 'approve', capabilities: ['lesson.manage'] }));
            expect(verifier.consume({ envelope, request: approve }).ok).toBe(true);
            expect(verifier.consume({ envelope, request: approve }))
                .toEqual({ ok: false, reason: 'replayed' });
        });

        it('lets a second click through, because it carries a new grant', () => {
            const { publicKeyBase64, sign } = issuer();
            const verifier = verifierFor(publicKeyBase64);
            const first = sign(claimsFor(approve, { op: 'approve', capabilities: ['lesson.manage'] }));
            const second = sign(claimsFor(approve, { op: 'approve', capabilities: ['lesson.manage'], iat: 1_200 }));
            expect(verifier.consume({ envelope: first, request: approve }).ok).toBe(true);
            expect(verifier.consume({ envelope: second, request: approve }).ok).toBe(true);
        });

        it('refuses rather than forgetting a live grant when the table is full', () => {
            const { publicKeyBase64, sign } = issuer();
            const verifier = createLessonGrantVerifier({
                publicKeyBase64, machineId: 'm1', audience: LESSON_GRANT_AUDIENCE,
                now: () => 1_500, maxSpentEntries: 1,
            });
            const first = sign(claimsFor(approve, { op: 'approve', capabilities: ['lesson.manage'] }));
            expect(verifier.consume({ envelope: first, request: approve }).ok).toBe(true);
            const second = sign(claimsFor(approve, { op: 'approve', capabilities: ['lesson.manage'], iat: 1_200 }));
            expect(verifier.consume({ envelope: second, request: approve }))
                .toEqual({ ok: false, reason: 'busy' });
            // The first grant is still spent — capacity never resurrected it.
            expect(verifier.consume({ envelope: first, request: approve }))
                .toEqual({ ok: false, reason: 'replayed' });
        });

        it('remembers a spent grant for its whole signed lifetime', () => {
            const { publicKeyBase64, sign } = issuer();
            let clock = 1_500;
            const verifier = createLessonGrantVerifier({
                publicKeyBase64, machineId: 'm1', audience: LESSON_GRANT_AUDIENCE, now: () => clock,
            });
            const envelope = sign(claimsFor(approve, { op: 'approve', capabilities: ['lesson.manage'] }));
            expect(verifier.consume({ envelope, request: approve }).ok).toBe(true);
            // One instant before the signed expiry the envelope must still be spent.
            clock = 60_999;
            expect(verifier.consume({ envelope, request: approve }))
                .toEqual({ ok: false, reason: 'replayed' });
        });

        it('does not burn anything when verification fails', () => {
            const { publicKeyBase64, sign } = issuer();
            const verifier = verifierFor(publicKeyBase64);
            const envelope = sign(claimsFor(approve, { op: 'approve' }));
            expect(verifier.consume({ envelope, request: snapshot }).ok).toBe(false);
            // The same envelope, now presented with its real request, still works.
            expect(verifier.consume({ envelope, request: approve }).ok).toBe(true);
        });
    });
});
