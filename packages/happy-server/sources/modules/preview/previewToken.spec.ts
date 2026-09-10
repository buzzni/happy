import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { signPreviewToken, verifyPreviewToken } from '@/modules/preview/previewToken';

const SECRET = 'test-secret-0123456789abcdef';

describe('previewToken', () => {
    it('round-trips a payload through sign and verify', () => {
        const signed = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET },
        );
        const payload = verifyPreviewToken(signed.token, { secret: SECRET });
        // exp is exposed so Phase 9 cookie issuance can derive Max-Age.
        expect(payload).toEqual({ userId: 'u1', machineId: 'm1', port: 3000, exp: signed.expiresAt });
    });

    it('returns expiresAt roughly ttlMs in the future', () => {
        const before = Date.now();
        const signed = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET, ttlMs: 60_000 },
        );
        const after = Date.now();
        expect(signed.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
        expect(signed.expiresAt).toBeLessThanOrEqual(after + 60_000);
    });

    it('returns null when the token has expired', () => {
        const signed = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET, ttlMs: -1000 }, // already expired
        );
        expect(verifyPreviewToken(signed.token, { secret: SECRET })).toBeNull();
    });

    it('returns null when the signature does not match', () => {
        const signed = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET },
        );
        expect(verifyPreviewToken(signed.token, { secret: 'different-secret' })).toBeNull();
    });

    it('returns null when the payload has been tampered with', () => {
        const signed = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET },
        );
        // Replace the payload segment with another valid base64url value but keep
        // the original signature — verify should reject.
        const [, sig] = signed.token.split('.');
        const forgedPayload = Buffer
            .from(JSON.stringify({ userId: 'attacker', machineId: 'm1', port: 3000, exp: Date.now() + 60_000 }))
            .toString('base64url');
        const forged = `${forgedPayload}.${sig}`;
        expect(verifyPreviewToken(forged, { secret: SECRET })).toBeNull();
    });

    it('returns null for a malformed token', () => {
        expect(verifyPreviewToken('not-a-token', { secret: SECRET })).toBeNull();
        expect(verifyPreviewToken('', { secret: SECRET })).toBeNull();
        expect(verifyPreviewToken('only-one-segment.', { secret: SECRET })).toBeNull();
    });

    it('rejects a signature with the wrong length (length-safe compare)', () => {
        const signed = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET },
        );
        const [payload] = signed.token.split('.');
        // Truncated signature
        const truncated = `${payload}.shortsig`;
        expect(verifyPreviewToken(truncated, { secret: SECRET })).toBeNull();
    });

    it('default TTL is 60 minutes (specs/remote-preview-relay Phase 10a)', () => {
        const before = Date.now();
        const signed = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET },
        );
        const after = Date.now();
        const sixtyMinMs = 60 * 60 * 1000;
        expect(signed.expiresAt).toBeGreaterThanOrEqual(before + sixtyMinMs);
        expect(signed.expiresAt).toBeLessThanOrEqual(after + sixtyMinMs);
    });

    it('binds token to the exact (userId, machineId, port) triple', () => {
        const forUser1 = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET },
        );
        // Same token cannot be repurposed for another (userId, machineId, port)
        // — the payload is signed as-is, so a different triple yields a
        // different signed token.
        const forUser2 = signPreviewToken(
            { userId: 'u2', machineId: 'm1', port: 3000 },
            { secret: SECRET },
        );
        expect(forUser1.token).not.toBe(forUser2.token);
        expect(verifyPreviewToken(forUser1.token, { secret: SECRET })?.userId).toBe('u1');
        expect(verifyPreviewToken(forUser2.token, { secret: SECRET })?.userId).toBe('u2');
    });
});

describe('previewToken runtime binding claims (specs/runtime-isolation-hardening H3)', () => {
    const bind = {
        projectId: 'proj-1',
        studioUserId: 'studio-user-1',
        leaseId: 'lease-abc',
    };

    it('round-trips the bind claim alongside the legacy claims', () => {
        const signed = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000, bind },
            { secret: SECRET },
        );
        expect(verifyPreviewToken(signed.token, { secret: SECRET })).toEqual({
            userId: 'u1',
            machineId: 'm1',
            port: 3000,
            exp: signed.expiresAt,
            bind,
        });
    });

    it('keeps studioUserId separate from the happy account userId', () => {
        // The happy `userId` is the machine-owning account used for socket
        // routing; the studio user is who actually asked. Conflating them is
        // what let a company account stand in for any studio member.
        const signed = signPreviewToken(
            { userId: 'company-account', machineId: 'm1', port: 3000, bind },
            { secret: SECRET },
        );
        const claims = verifyPreviewToken(signed.token, { secret: SECRET });
        expect(claims?.userId).toBe('company-account');
        expect(claims?.bind?.studioUserId).toBe('studio-user-1');
    });

    it('verifies legacy tokens minted without a bind claim', () => {
        const signed = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET },
        );
        const claims = verifyPreviewToken(signed.token, { secret: SECRET });
        expect(claims).not.toBeNull();
        expect(claims?.bind).toBeUndefined();
    });

    it('rejects a token whose bind claim is malformed instead of silently dropping it', () => {
        // Dropping an unreadable bind claim would turn a bound token back into
        // a legacy one — exactly the downgrade this claim exists to prevent.
        const secret = SECRET;
        const payloadB64 = Buffer
            .from(JSON.stringify({
                userId: 'u1',
                machineId: 'm1',
                port: 3000,
                exp: Date.now() + 60_000,
                bind: { projectId: 'proj-1' },
            }))
            .toString('base64url');
        const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
        expect(verifyPreviewToken(`${payloadB64}.${sig}`, { secret })).toBeNull();
    });

    it('does not accept a bound token as its unbound twin (signature covers bind)', () => {
        const bound = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000, bind },
            { secret: SECRET },
        );
        const unbound = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET },
        );
        expect(bound.token).not.toBe(unbound.token);
    });
});
