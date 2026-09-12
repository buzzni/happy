/**
 * The runtime-scoped grant snapshot: what the parent said, and nothing more.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
    canonicalManagedPayloadDigest,
    parseManagedVerifierKey,
} from '@/daemon/managedDispatchToken';
import { createManagedRuntimeGrantSnapshot } from './managedRuntimeGrantSnapshot';

const keys = generateKeyPairSync('ed25519');
const verifier = parseManagedVerifierKey(
    keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer,
);
const NOW = 1_800_000_000_000;

const AUTHORITY = {
    verifier,
    runtimeId: 'runtime-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    keyId: 'kid-1',
    provisioningOperationId: 'op-1',
};

/**
 * The parent's own request-key shape for a runtime lease:
 * `<provisioningOperationId>:<epoch>:<op>`, with **no id tail** - unlike a
 * checkpoint's (`cloudRuntimeReadinessPorts.ts:298`).
 */
const requestKeyFor = (epoch: number) => `op-1:${epoch}:runtime-lease`;

const params = (requestedMs = 60_000) => ({ requestedMs });

function mint(over: Record<string, unknown> = {}, signParams: unknown = params()) {
    const digest = canonicalManagedPayloadDigest(signParams);
    const epoch = (over.epoch as number) ?? 3;
    const body = Buffer.from(JSON.stringify({
        v: 1, kid: 'kid-1', aud: 'runtime-1', op: 'runtime-lease',
        workspaceId: 'ws-1', projectId: 'proj-1', provisioningOperationId: 'op-1',
        requestKey: requestKeyFor(epoch), epoch,
        renewalSeq: 4, leaseMs: 60_000, absoluteExpiry: NOW + 60_000,
        payloadDigest: digest, iat: NOW, exp: NOW + 60_000,
        ...over,
    }), 'utf8').toString('base64url');
    return `${body}.${sign(null, Buffer.from(body, 'utf8'), keys.privateKey).toString('base64url')}`;
}

function snapshot(clock: { wall: number; mono: number } = { wall: NOW + 1_000, mono: 5_000 }) {
    const state = { ...clock };
    const store = createManagedRuntimeGrantSnapshot({
        authority: AUTHORITY,
        now: () => state.wall,
        monotonicNow: () => state.mono,
    });
    return { store, state };
}

const admit = (store: ReturnType<typeof snapshot>['store'], over = {}, p: unknown = params()) =>
    store.admit({ dispatchToken: mint(over), rawParams: p as Record<string, unknown> });

describe('admitting a runtime-lease grant', () => {
    it('shouldRecordWhatTheParentSignedAndNothingMore', () => {
        const { store } = snapshot();
        expect(store.current()).toEqual({ kind: 'absent' });
        expect(admit(store)).toEqual({ ok: true });
        const current = store.current();
        expect(current.kind).toBe('present');
        if (current.kind !== 'present') return;
        expect(current.epoch).toBe(3);
        expect(current.renewalSeq).toBe(4);
        // Its own window, from its own clocks: wall decides how much is left,
        // monotonic measures elapsed. Never the daemon's arithmetic.
        expect(current.deadlineMonotonic).toBe(5_000 + 59_000);
    });

    it('shouldRefuseATokenForAnotherIdentity', () => {
        for (const [over, reason] of [
            [{ aud: 'runtime-2' }, 'wrong-audience'],
            [{ workspaceId: 'ws-2' }, 'wrong-workspace'],
            [{ provisioningOperationId: 'op-2' }, 'wrong-operation'],
            [{ projectId: 'proj-2' }, 'wrong-project'],
            [{ kid: 'kid-2' }, 'wrong-key'],
        ] as const) {
            const { store } = snapshot();
            expect(admit(store, over)).toEqual({ ok: false, reason });
            expect(store.current()).toEqual({ kind: 'absent' });
        }
    });

    it('shouldRefuseTheCheckpointRequestKeyShape', () => {
        /*
         * A runtime lease's key has no id tail. Reusing C1's checkpoint
         * expression here would refuse every real grant, so the two shapes are
         * pinned apart rather than shared.
         */
        const { store } = snapshot();
        expect(admit(store, { requestKey: 'op-1:3:checkpoint:abc' }))
            .toEqual({ ok: false, reason: 'request-key-mismatch' });
        expect(admit(store, { requestKey: 'op-2:3:runtime-lease' }))
            .toEqual({ ok: false, reason: 'request-key-mismatch' });
        expect(admit(store, { epoch: 5, requestKey: requestKeyFor(3) }))
            .toEqual({ ok: false, reason: 'request-key-mismatch' });
    });

    it('shouldRefuseParamsMutatedAfterSigning', () => {
        const { store } = snapshot();
        expect(store.admit({ dispatchToken: mint(), rawParams: { requestedMs: 300_000 } }))
            .toEqual({ ok: false, reason: 'payload-mismatch' });
        expect(store.current()).toEqual({ kind: 'absent' });
    });

    it('shouldRefuseParamsThatDisagreeWithTheSignedLease', () => {
        // The parent builds both from one number; a token whose `leaseMs` and
        // params disagree was not built by that path.
        const { store } = snapshot();
        const p = { requestedMs: 30_000 };
        expect(store.admit({ dispatchToken: mint({}, p), rawParams: p }))
            .toEqual({ ok: false, reason: 'grant-malformed' });
    });

    it('shouldRefuseAnExpiredTokenByItsOwnClock', () => {
        const { store } = snapshot({ wall: NOW + 60_001, mono: 5_000 });
        expect(admit(store)).toEqual({ ok: false, reason: 'expired' });
    });

    it('shouldRejudgeExpiryOnTheSampleTheWindowIsComputedFrom', () => {
        /*
         * The verification reads a clock, and the window is computed from a
         * second, fresh read. If the token ages out between them, storing a
         * window measured from the later instant while the admission decision
         * was made at the earlier one records a grant that was already dead.
         *
         * Driven with a clock that advances on every read - which is what a
         * real clock does, and what a fixture holding one value cannot show.
         */
        let reads = 0;
        const store = createManagedRuntimeGrantSnapshot({
            authority: AUTHORITY,
            // First read: inside the token's life. Second: past it.
            now: () => (reads++ === 0 ? NOW + 59_999 : NOW + 60_001),
            monotonicNow: () => 5_000,
        });
        expect(store.admit({ dispatchToken: mint(), rawParams: params() }))
            .toEqual({ ok: false, reason: 'expired' });
        expect(store.current()).toEqual({ kind: 'absent' });
    });

    it('shouldRefuseAWindowWithNothingLeftInIt', () => {
        // A token still fresh whose lease window has closed: admitting it would
        // store a deadline already in the past.
        const { store } = snapshot({ wall: NOW + 59_999, mono: 5_000 });
        expect(store.admit({
            dispatchToken: mint({ absoluteExpiry: NOW + 59_999 }), rawParams: params(),
        })).toEqual({ ok: false, reason: 'grant-window-exhausted' });
        expect(store.current()).toEqual({ kind: 'absent' });
    });

    it('shouldNotWidenTheWindowBeyondWhatTheParentSigned', () => {
        /*
         * `min(leaseMs, absoluteExpiry - now)`. An absurd `absoluteExpiry`
         * cannot widen it because `leaseMs` is already bounded by the token
         * parser (`readInt(record.leaseMs, 1, MAX_LEASE_MS)`), so no separate
         * ceiling rule is needed here.
         */
        const { store } = snapshot();
        expect(store.admit({
            dispatchToken: mint({ absoluteExpiry: NOW + 86_400_000 }), rawParams: params(),
        })).toEqual({ ok: true });
        const current = store.current();
        if (current.kind !== 'present') throw new Error('expected present');
        expect(current.deadlineMonotonic).toBe(5_000 + 60_000);
    });
});

describe('the snapshot only moves forward', () => {
    const seeded = () => {
        const s = snapshot();
        expect(s.store.admit({
            dispatchToken: mint({ epoch: 3, renewalSeq: 4 }), rawParams: params(),
        })).toEqual({ ok: true });
        return s;
    };

    it('shouldRefuseAnEqualSequence', () => {
        /*
         * Strictly. The parent never reuses a sequence - a retry takes a new
         * higher one - so an equal sequence is a replay or a resend, and
         * accepting one would let a resend move the deadline.
         */
        const { store } = seeded();
        expect(store.admit({ dispatchToken: mint({ epoch: 3, renewalSeq: 4 }), rawParams: params() }))
            .toEqual({ ok: false, reason: 'grant-stale-renewal' });
    });

    it('shouldRefuseALowerSequenceOrEpoch', () => {
        const { store } = seeded();
        expect(store.admit({ dispatchToken: mint({ epoch: 3, renewalSeq: 3 }), rawParams: params() }))
            .toEqual({ ok: false, reason: 'grant-stale-renewal' });
        expect(store.admit({
            dispatchToken: mint({ epoch: 2, renewalSeq: 9, requestKey: requestKeyFor(2) }),
            rawParams: params(),
        })).toEqual({ ok: false, reason: 'grant-stale-epoch' });
    });

    it('shouldAcceptAHigherSequenceOrEpoch', () => {
        const { store } = seeded();
        expect(store.admit({ dispatchToken: mint({ epoch: 3, renewalSeq: 5 }), rawParams: params() }))
            .toEqual({ ok: true });
        expect(store.admit({
            dispatchToken: mint({ epoch: 4, renewalSeq: 0, requestKey: requestKeyFor(4) }),
            rawParams: params(),
        })).toEqual({ ok: true });
        const current = store.current();
        if (current.kind !== 'present') throw new Error('expected present');
        // A raised epoch resets the sequence - it is the parent's later
        // statement, and sequences are allocated per epoch.
        expect(current).toMatchObject({ epoch: 4, renewalSeq: 0 });
    });

    it('shouldLeaveTheSnapshotUntouchedWhenAdmissionRefuses', () => {
        const { store } = seeded();
        store.admit({ dispatchToken: mint({ epoch: 3, renewalSeq: 4 }), rawParams: params() });
        expect(store.current()).toMatchObject({ epoch: 3, renewalSeq: 4 });
    });

    it('shouldOrderTwoGrantsRatherThanExcludeTheSecond', () => {
        /*
         * Two grants in flight is ordinary, not an error: admission is a
         * synchronous compare-and-set, so the second is *judged against* the
         * first rather than refused for being concurrent. Only equal or lower
         * refuses.
         */
        const { store } = seeded();
        const first = store.admit({ dispatchToken: mint({ epoch: 3, renewalSeq: 5 }), rawParams: params() });
        const second = store.admit({ dispatchToken: mint({ epoch: 3, renewalSeq: 6 }), rawParams: params() });
        expect([first, second]).toEqual([{ ok: true }, { ok: true }]);
        expect(store.current()).toMatchObject({ epoch: 3, renewalSeq: 6 });
    });
});

describe('the snapshot a reader gets back is a copy', () => {
    it('shouldNotLetAReaderEditTheStateAdmissionJudgesAgainst', () => {
        /*
         * `current()` is an observation. Handing back the held object makes it
         * an accessor: a reader writing to it would move the sequence that the
         * next admission compares against, and a replay refused a moment ago
         * would then be admitted. Every field is primitive, so one shallow copy
         * closes it.
         */
        const { store } = snapshot();
        expect(store.admit({
            dispatchToken: mint({ epoch: 3, renewalSeq: 4 }), rawParams: params(),
        })).toEqual({ ok: true });

        const observed = store.current();
        if (observed.kind !== 'present') throw new Error('expected present');
        (observed as { epoch: number }).epoch = 99;
        (observed as { renewalSeq: number }).renewalSeq = 99;
        (observed as { deadlineMonotonic: number }).deadlineMonotonic = 99;

        // The edit reached nothing: a replay at the original sequence is still
        // refused, and a fresh read still describes what was admitted.
        expect(store.admit({
            dispatchToken: mint({ epoch: 3, renewalSeq: 4 }), rawParams: params(),
        })).toEqual({ ok: false, reason: 'grant-stale-renewal' });
        expect(store.admit({
            dispatchToken: mint({ epoch: 3, renewalSeq: 3 }), rawParams: params(),
        })).toEqual({ ok: false, reason: 'grant-stale-renewal' });
        expect(store.current()).toMatchObject({ epoch: 3, renewalSeq: 4 });
    });

    it('shouldHandBackADistinctObjectEachTime', () => {
        const { store } = snapshot();
        admit(store);
        expect(store.current()).not.toBe(store.current());
        expect(store.current()).toEqual(store.current());
    });
});

describe('clearing the snapshot', () => {
    it('shouldReturnToUnknownRatherThanRevoked', () => {
        // `absent` means unknown. It is not a revocation and not a refusal that
        // anything else may read as one.
        const { store } = snapshot();
        expect(admit(store)).toEqual({ ok: true });
        store.clear();
        expect(store.current()).toEqual({ kind: 'absent' });
    });

    it('shouldAcceptTheSameSequenceAgainAfterClearing', () => {
        // Nothing is remembered across a clear: the monotonicity is against the
        // snapshot in hand, not a ledger.
        const { store } = snapshot();
        expect(admit(store)).toEqual({ ok: true });
        store.clear();
        expect(admit(store)).toEqual({ ok: true });
    });
});
