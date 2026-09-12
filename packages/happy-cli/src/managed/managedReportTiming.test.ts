/**
 * Reporting the verdict before the provider has finished exiting.
 *
 * Observed in a deployed runtime: the child reported `provider-exit-unclean`
 * and the gate refused `eof-unverified`, for a provider that exited cleanly
 * a quarter of a second later. `claudeRemote` returns when its message loop
 * ends; the SDK child exits after that. Reading the observer at that instant
 * is a race, and the race always resolves against the run.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { createProviderExitObserver, waitForObservedExit } from './managedProviderExitObserver';

/** The verdict the launcher reports, given a generation record. */
function verdict(record: { inputExhausted: boolean; observer: ReturnType<typeof createProviderExitObserver> }) {
    return record.inputExhausted && record.observer.exitedCleanly()
        ? 'exhausted-clean'
        : record.inputExhausted ? 'provider-exit-unclean' : 'input-not-exhausted';
}

describe('waiting for the provider to be seen leaving', () => {
    it('shouldReportCleanForAProviderThatExitsJustAfterTheLoopEnds', async () => {
        const child = new EventEmitter();
        const observer = createProviderExitObserver();
        observer.watch(child as never);
        const record = { inputExhausted: true, observer };

        // The race as it actually happened: the loop is over, the child has
        // not exited yet.
        expect(verdict(record)).toBe('provider-exit-unclean');

        setTimeout(() => child.emit('exit', 0, null), 5);
        await waitForObservedExit(observer, 1_000);

        expect(verdict(record)).toBe('exhausted-clean');
    });

    it('shouldGiveUpAtTheBudgetWithoutInventingAnExit', async () => {
        // A provider that never leaves is not a provider that left. The
        // observer still says "not seen", and the verdict is built from that.
        const observer = createProviderExitObserver();
        observer.watch(new EventEmitter() as never);

        await waitForObservedExit(observer, 30);

        expect(observer.observed()).toBeNull();
        expect(verdict({ inputExhausted: true, observer })).toBe('provider-exit-unclean');
    });

    it('shouldReturnImmediatelyWhenTheExitWasAlreadySeen', async () => {
        const child = new EventEmitter();
        const observer = createProviderExitObserver();
        observer.watch(child as never);
        child.emit('exit', 0, null);

        let waits = 0;
        await waitForObservedExit(observer, 10_000, { wait: async () => { waits += 1; } });

        expect(waits).toBe(0);
    });

    it('shouldNotTurnAWaitedForKillIntoACleanExit', async () => {
        // Waiting longer must not change what the exit was.
        const child = new EventEmitter();
        const observer = createProviderExitObserver();
        observer.watch(child as never);

        setTimeout(() => child.emit('exit', 137, 'SIGKILL'), 5);
        await waitForObservedExit(observer, 1_000);

        expect(verdict({ inputExhausted: true, observer })).toBe('provider-exit-unclean');
    });
});
