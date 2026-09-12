/**
 * Every case here is a way a process that did not finish could be read as one
 * that did.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { createProviderExitObserver } from './managedProviderExitObserver';

function watched() {
    const child = new EventEmitter();
    const observer = createProviderExitObserver();
    observer.watch(child as never);
    return { child, observer, exit: (code: number | null, signal: string | null) => child.emit('exit', code, signal) };
}

describe('createProviderExitObserver', () => {
    it('shouldCountAZeroExitWithNoSignalAsFinishedOnItsOwn', () => {
        const { observer, exit } = watched();
        exit(0, null);
        expect(observer.observed()).toEqual({ code: 0, signal: null, forced: false });
        expect(observer.exitedCleanly()).toBe(true);
    });

    it('shouldSayNothingWasSeenBeforeTheProcessLeft', () => {
        // `null` is "not seen", which is not "did not finish cleanly" — the
        // gate turns the first into `exit-unobserved`.
        const { observer } = watched();
        expect(observer.observed()).toBeNull();
        expect(observer.exitedCleanly()).toBe(false);
    });

    it('shouldNeverCallASignalledExitClean', () => {
        const { observer, exit } = watched();
        exit(137, 'SIGKILL');
        expect(observer.exitedCleanly()).toBe(false);
    });

    it('shouldNeverCallANonZeroExitClean', () => {
        const { observer, exit } = watched();
        exit(1, null);
        expect(observer.exitedCleanly()).toBe(false);
    });

    it('shouldDisqualifyAnExitFromAProcessNodeSawSignalled', () => {
        /*
         * The case a signal field cannot catch: the child installs a handler,
         * exits 0, and the kernel reports no signal. Node still recorded that
         * a signal was delivered, and that is read here rather than taken on
         * trust from whoever sent it — a kill nobody announced is still a kill.
         */
        const child = new EventEmitter() as EventEmitter & { killed?: boolean };
        const observer = createProviderExitObserver();
        observer.watch(child as never);
        child.killed = true;
        child.emit('exit', 0, null);

        expect(observer.observed()).toMatchObject({ code: 0, signal: null, forced: true });
        expect(observer.exitedCleanly()).toBe(false);
    });

    it('shouldDisqualifyAnExitThatSomethingAskedForEvenIfItLooksClean', () => {
        /*
         * The race that reads exactly like a graceful end: a kill is
         * requested, and the process exits 0 on its own before the signal
         * lands. The kernel reports no signal, so only the request itself
         * distinguishes them.
         */
        const { observer, exit } = watched();
        observer.markForced();
        exit(0, null);
        expect(observer.observed()).toMatchObject({ code: 0, signal: null, forced: true });
        expect(observer.exitedCleanly()).toBe(false);
    });

    it('shouldDisqualifyAnExitWhenTheKillWasRequestedAfterItWasSeen', () => {
        // Shutdown ordering is not fixed: the request can land after the exit
        // event, and the exit was still not one this process chose.
        const { observer, exit } = watched();
        exit(0, null);
        observer.markForced();
        expect(observer.exitedCleanly()).toBe(false);
    });

    it('shouldKeepTheFirstExitTheKernelReported', () => {
        const { observer, exit } = watched();
        exit(0, null);
        exit(137, 'SIGKILL');
        expect(observer.observed()).toMatchObject({ code: 0, signal: null });
    });
});

describe('one observer per generation, never one reused across them', () => {
    it('shouldKeepAnsweringForTheProcessItFirstSawWhenReused', () => {
        /*
         * Astra's warning, pinned as behaviour rather than left implicit: the
         * observer keeps the first exit it sees, so watching a second process
         * with the same observer answers for the first one.
         *
         * That is the right behaviour for one generation — a process ends
         * once — and the wrong answer across two. The fix is a fresh observer
         * per generation, which is what `claudeRemoteLauncher` does; this test
         * exists so that reusing one can never look correct.
         */
        const first = new EventEmitter();
        const second = new EventEmitter();
        const observer = createProviderExitObserver();
        observer.watch(first as never);
        observer.watch(second as never);

        first.emit('exit', 0, null);
        second.emit('exit', 137, 'SIGKILL');

        // The second generation's kill is invisible here. Reuse is the bug.
        expect(observer.observed()).toMatchObject({ code: 0, signal: null });
        expect(observer.exitedCleanly()).toBe(true);
    });

    it('shouldGiveEachGenerationItsOwnAnswerWhenEachHasItsOwnObserver', () => {
        const first = new EventEmitter();
        const second = new EventEmitter();
        const forFirst = createProviderExitObserver();
        const forSecond = createProviderExitObserver();
        forFirst.watch(first as never);
        forSecond.watch(second as never);

        first.emit('exit', 0, null);
        second.emit('exit', 137, 'SIGKILL');

        expect(forFirst.exitedCleanly()).toBe(true);
        expect(forSecond.exitedCleanly()).toBe(false);
    });
});
