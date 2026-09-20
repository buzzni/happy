import { describe, expect, it } from 'vitest';
import {
    RECONNECT_BASE_DELAY_MS,
    RECONNECT_MAX_DELAY_MS,
    reconnectDelayMs,
} from './reconnectCadence';

/*
 * specs/machine-socket-duplicate-registration/ — the old cadence dialled every
 * 3s regardless of whether the previous dial had resolved, so a slow handshake
 * collected several overlapping dials and several of them completed. The
 * backoff is half of the repair; the single-flight guard in apiMachine /
 * apiSession is the other half.
 */
describe('reconnectDelayMs', () => {
    /** Jitter pinned to its extremes, so the bounds are exact rather than flaky. */
    const shortest = () => 0;
    const longest = () => 1;

    it('shouldKeepTheFirstDialAtAboutASecondSoOrdinaryBlipsStillRecoverFast', () => {
        expect(reconnectDelayMs(0, longest)).toBe(RECONNECT_BASE_DELAY_MS);
        expect(reconnectDelayMs(0, shortest)).toBe(RECONNECT_BASE_DELAY_MS / 2);
    });

    it('shouldDoubleWithEachConsecutiveAttempt', () => {
        expect(reconnectDelayMs(1, longest)).toBe(2_000);
        expect(reconnectDelayMs(2, longest)).toBe(4_000);
        expect(reconnectDelayMs(3, longest)).toBe(8_000);
    });

    it('shouldStopGrowingAtTheCeiling', () => {
        expect(reconnectDelayMs(10, longest)).toBe(RECONNECT_MAX_DELAY_MS);
        expect(reconnectDelayMs(100, longest)).toBe(RECONNECT_MAX_DELAY_MS);
    });

    it('shouldNeverExceedTheNominalDelaySoTheCeilingIsARealCeiling', () => {
        for (let attempts = 0; attempts <= 12; attempts++) {
            expect(reconnectDelayMs(attempts, longest)).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS);
        }
    });

    it('shouldStillBackOffAtItsShortestJitter', () => {
        // Half-range jitter: a later attempt is never quicker than an earlier
        // one, which is what keeps the backoff a backoff.
        expect(reconnectDelayMs(2, shortest)).toBeGreaterThanOrEqual(reconnectDelayMs(1, longest));
    });

    it('shouldTreatNonsenseAttemptCountsAsTheFirstDial', () => {
        expect(reconnectDelayMs(-5, longest)).toBe(RECONNECT_BASE_DELAY_MS);
        expect(reconnectDelayMs(0.7, longest)).toBe(RECONNECT_BASE_DELAY_MS);
    });

    it('shouldProduceRealJitterWithTheDefaultSource', () => {
        const seen = new Set<number>();
        for (let i = 0; i < 50; i++) seen.add(reconnectDelayMs(5));
        expect(seen.size).toBeGreaterThan(1);
    });
});
