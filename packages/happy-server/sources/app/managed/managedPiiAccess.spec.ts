import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionScopedClaims } from '@/app/auth/sessionScopedToken';
const tx = vi.hoisted(() => ({
    managedSessionGrant: { findUnique: vi.fn() },
    session: { findUnique: vi.fn() },
    managedReadAclWatermark: { findUnique: vi.fn() },
}));
vi.mock('@/storage/inTx', () => ({ inTx: async (fn: (value: typeof tx) => unknown) => fn(tx) }));
vi.mock('@/storage/db', () => ({ db: {} }));
import { resolveLiveGrant } from './managedSessionGrant';

const claims = {
    grantId: 'grant', sessionId: 'protected', accountId: 'owner',
    purpose: 'transcript-read', expiresAt: 2000,
} as SessionScopedClaims;
beforeEach(() => {
    vi.clearAllMocks();
    tx.managedSessionGrant.findUnique.mockResolvedValue({
        grantId: 'grant', sessionId: 'protected', accountId: 'owner',
        purpose: 'transcript-read', expiresAt: 2000n, revokedAt: null,
        runId: null, attemptId: null, viewerAccountId: null, tombstone: false,
    });
    tx.session.findUnique.mockResolvedValue({ accountId: 'owner', piiProtection: false });
});
describe('managed protection admission', () => {
    it.each(['transcript-read', 'runner', 'approval-control'] as const)(
        'refuses protected %s before attachment, socket or RPC delivery',
        async (purpose) => {
            tx.session.findUnique.mockResolvedValue({ accountId: 'owner', piiProtection: true });
            const result = await resolveLiveGrant({ claims: { ...claims, purpose }, now: 1000 });
            expect(result).toEqual({ ok: false, reason: 'session-unknown' });
        },
    );
    it('retains ordinary transcript read', async () => {
        expect((await resolveLiveGrant({ claims, now: 1000 })).ok).toBe(true);
    });
    it('rejects a missing session even with a live read grant', async () => {
        tx.session.findUnique.mockResolvedValue(null);
        expect(await resolveLiveGrant({ claims, now: 1000 }))
            .toEqual({ ok: false, reason: 'session-unknown' });
    });
    it('retains authoritative owner checks for transcript reads', async () => {
        tx.session.findUnique.mockResolvedValue({ accountId: 'other', piiProtection: false });
        expect(await resolveLiveGrant({ claims, now: 1000 }))
            .toEqual({ ok: false, reason: 'session-owner-changed' });
    });
});
