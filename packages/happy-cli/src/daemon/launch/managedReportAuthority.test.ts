/**
 * Who may report, and for how long.
 *
 * Two failures this covers, both found in review rather than by a test:
 * a fixed window that cut every activity report after it, and a revocation
 * keyed on the pid while most stops name only a generation.
 */
import { describe, expect, it } from 'vitest';

import { createManagedReportAuthority } from './managedReportCredential';

const KEY = { runId: 'run-1', attemptId: 'attempt-1', epoch: 3 };
const OTHER = { runId: 'run-2', attemptId: 'attempt-2', epoch: 3 };

function authority() {
    const discarded: string[] = [];
    return { discarded, subject: createManagedReportAuthority({ discard: (id) => { discarded.push(id); } }) };
}

describe('createManagedReportAuthority', () => {
    it('shouldRevokeByGenerationBecauseMostStopsNeverMentionAPid', () => {
        const { discarded, subject } = authority();
        subject.grant({ key: KEY, pid: 4242, launchId: 'launch-a' });

        // `managed:stop` and lease maintenance address a run/attempt/epoch.
        expect(subject.revoke(KEY)).toBe('launch-a');
        expect(discarded).toEqual(['launch-a']);
        // And the pid alias goes with it, so nothing can report through it.
        expect(subject.launchIdForPid(4242)).toBeNull();
    });

    it('shouldSayNothingWasRevokedForAGenerationItNeverGranted', () => {
        const { discarded, subject } = authority();
        expect(subject.revoke(KEY)).toBeNull();
        expect(discarded).toEqual([]);
    });

    it('shouldRenewOnlyTheNamedGenerationForARunScopedLease', () => {
        const { subject } = authority();
        subject.grant({ key: KEY, pid: 1, launchId: 'launch-a' });
        subject.grant({ key: OTHER, pid: 2, launchId: 'launch-b' });

        expect(subject.launchIdsFor(KEY)).toEqual(['launch-a']);
    });

    it('shouldRenewEveryGenerationForARuntimeLeaseThatNamesNoRun', () => {
        const { subject } = authority();
        subject.grant({ key: KEY, pid: 1, launchId: 'launch-a' });
        subject.grant({ key: OTHER, pid: 2, launchId: 'launch-b' });

        /*
         * A runtime lease has no run — it is renewed before one exists — and it
         * widens the write window for every generation. Returning nothing here
         * would let every report authority lapse while the runtime still held
         * the right to write.
         */
        expect(subject.launchIdsFor({ epoch: 3 }).sort()).toEqual(['launch-a', 'launch-b']);
    });

    it('shouldNotRenewAGenerationThatWasAlreadyRevoked', () => {
        const { subject } = authority();
        subject.grant({ key: KEY, pid: 1, launchId: 'launch-a' });
        subject.revoke(KEY);
        expect(subject.launchIdsFor(KEY)).toEqual([]);
        expect(subject.launchIdsFor({ epoch: 3 })).toEqual([]);
    });
});
